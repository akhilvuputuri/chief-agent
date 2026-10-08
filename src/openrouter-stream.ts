/** Assemble an entire generation before exposing any tool action to the worker. */
export class StreamFailure extends Error {
  constructor(
    readonly code: "disconnected" | "malformed" | "provider",
    readonly httpStatus?: number,
  ) {
    super("Model stream did not complete");
  }
}
export type StreamProgress = {
  responseId?: string;
  provider?: string;
  bytes: number;
};

export async function readGenerationStream(
  response: Response,
  signal: AbortSignal,
  progress?: (value: StreamProgress) => Promise<void> | void,
): Promise<any> {
  if (!response.body) throw new StreamFailure("disconnected");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    frame: string[] = [],
    done = false,
    finish: string | undefined;
  let bytes = 0;
  const data: any = {
    choices: [{ message: { role: "assistant", content: "" } }],
  };
  const message = data.choices[0].message;
  const calls = new Map<number, any>();
  const reasoning = new Map<string, { value: any; index?: number }>();
  const mergeReasoning = (block: any, position = 0) => {
    if (!block || typeof block !== "object" || Array.isArray(block))
      throw new StreamFailure("malformed");
    const index = block.index;
    if (
      index !== undefined &&
      (!Number.isSafeInteger(index) || index < 0 || index > 100)
    )
      throw new StreamFailure("malformed");
    const key =
      index !== undefined
        ? `index:${index}`
        : typeof block.id === "string"
          ? `id:${block.id}`
          : `type:${block.type}:${position}`;
    const current = reasoning.get(key)?.value ?? Object.create(null);
    for (const [key, value] of Object.entries(block)) {
      if (
        ["text", "data", "summary"].includes(key) &&
        typeof value === "string"
      )
        current[key] = (current[key] ?? "") + value;
      else if (
        current[key] !== undefined &&
        JSON.stringify(current[key]) !== JSON.stringify(value)
      )
        throw new StreamFailure("malformed");
      else current[key] = value;
    }
    if (reasoning.size >= 100 && !reasoning.has(key))
      throw new StreamFailure("malformed");
    reasoning.set(key, { value: current, index });
  };
  const consume = async () => {
    if (!frame.length) return;
    const payload = frame.join("\n");
    frame = [];
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    if (done) throw new StreamFailure("malformed");
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new StreamFailure("malformed");
    }
    if (chunk?.error)
      throw new StreamFailure(
        "provider",
        Number.isInteger(chunk.error.code) ? chunk.error.code : undefined,
      );
    if (!chunk || typeof chunk !== "object")
      throw new StreamFailure("malformed");
    for (const key of ["id", "provider", "model"])
      if (typeof chunk[key] === "string") {
        if (data[key] && data[key] !== chunk[key])
          throw new StreamFailure("malformed");
        data[key] = chunk[key];
      }
    if (chunk.usage) data.usage = chunk.usage;
    if (chunk.choices !== undefined && !Array.isArray(chunk.choices))
      throw new StreamFailure("malformed");
    let advanced = false;
    for (const choice of chunk.choices ?? []) {
      const alreadyFinished = !!finish;
      if ((choice.index ?? 0) !== 0) throw new StreamFailure("malformed");
      const delta = choice.delta ?? {};
      if (delta.role && delta.role !== "assistant")
        throw new StreamFailure("malformed");
      if (typeof delta.content === "string" && delta.content) {
        message.content += delta.content;
        advanced = true;
      }
      for (const [position, block] of (
        delta.reasoning_details ?? []
      ).entries()) {
        mergeReasoning(block, position);
        advanced = true;
      }
      // Some providers use the plaintext reasoning field instead of details.
      if (
        !delta.reasoning_details?.length &&
        typeof delta.reasoning === "string" &&
        delta.reasoning
      ) {
        mergeReasoning({
          index: 0,
          type: "reasoning.text",
          text: delta.reasoning,
        });
        advanced = true;
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index;
        if (!Number.isSafeInteger(index) || index < 0 || index >= 20)
          throw new StreamFailure("malformed");
        const current = calls.get(index) ?? {
          index,
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (call.type && call.type !== "function")
          throw new StreamFailure("malformed");
        if (call.id) {
          if (current.id && current.id !== call.id)
            throw new StreamFailure("malformed");
          current.id = call.id;
        }
        if (typeof call.function?.name === "string")
          current.function.name += call.function.name;
        if (typeof call.function?.arguments === "string")
          current.function.arguments += call.function.arguments;
        calls.set(index, current);
        advanced = true;
      }
      if (alreadyFinished && advanced) throw new StreamFailure("malformed");
      if (choice.finish_reason) {
        if (finish && finish !== choice.finish_reason)
          throw new StreamFailure("malformed");
        finish = choice.finish_reason;
      }
    }
    if (advanced)
      await progress?.({ responseId: data.id, provider: data.provider, bytes });
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1600000) throw new StreamFailure("malformed");
      buffer += decoder.decode(next.value, { stream: true });
      let index: number;
      while ((index = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[index] === "\r" && index === buffer.length - 1) break;
        const width =
          buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + width);
        if (!line) await consume();
        else if (line.startsWith("data:"))
          frame.push(line.slice(5).replace(/^ /, ""));
        // SSE comments are transport keepalives, not model progress.
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) frame.push(buffer.slice(5).trim());
    await consume();
    if (signal.aborted) throw signal.reason;
    if (!done || !finish || finish === "error")
      throw new StreamFailure("disconnected");
    if (calls.size)
      message.tool_calls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => ({ ...v }));
    if (reasoning.size) {
      const blocks = [...reasoning.values()];
      if (blocks.every((block) => block.index !== undefined))
        blocks.sort((a, b) => a.index! - b.index!);
      message.reasoning_details = blocks.map((block) => ({ ...block.value }));
    }
    data.choices[0].finish_reason = finish;
    return data;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
