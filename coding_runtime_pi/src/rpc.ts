import type { Readable, Writable } from "node:stream";
import type { CodingRuntime } from "./runtime.js";
import type { StartRequest } from "./types.js";

/** LF-delimited client transport; its process/pipe owner supplies authorization. */
export async function serveRpc(
  runtime: CodingRuntime,
  input: Readable,
  output: Writable,
) {
  const send = (id: string | null, result: unknown, error?: string) =>
    output.write(
      JSON.stringify({ id, ...(error ? { error } : { result }) }) + "\n",
    );
  const inFlight = new Set<Promise<void>>();
  const dispatch = async (line: string) => {
    let id: string | null = null;
    try {
      if (Buffer.byteLength(line) > 128000)
        throw new Error("Request exceeds the transport bound");
      const request = JSON.parse(line) as {
        id?: unknown;
        method?: unknown;
        params?: Record<string, unknown>;
      };
      if (
        typeof request.id !== "string" ||
        request.id.length > 100 ||
        typeof request.method !== "string"
      )
        throw new Error("Invalid request envelope");
      id = request.id;
      const p = request.params ?? {};
      const taskId = () => {
        if (typeof p.id !== "string") throw new Error("Task identity required");
        return p.id;
      };
      let result: unknown;
      switch (request.method) {
        case "start":
          if (
            typeof p.workspace !== "string" ||
            typeof p.objective !== "string" ||
            (p.intent !== undefined &&
              p.intent !== "learn" &&
              p.intent !== "plan")
          )
            throw new Error("Invalid start request");
          result = await runtime.start(p as unknown as StartRequest);
          break;
        case "run":
          result = await runtime.run(taskId());
          break;
        case "inspect":
          result = await runtime.inspect(taskId());
          break;
        case "events": {
          const task = await runtime.inspect(taskId());
          const after = Number(p.after ?? 0);
          if (!Number.isSafeInteger(after) || after < 0)
            throw new Error("Invalid event cursor");
          result = {
            events: task.events.filter((e) => e.sequence > after),
            gap: after > 0 && (task.events[0]?.sequence ?? 0) > after + 1,
          };
          break;
        }
        case "approve":
          if (typeof p.hash !== "string" || !Number.isSafeInteger(p.revision))
            throw new Error("Exact plan identity required");
          result = await runtime.approve(taskId(), Number(p.revision), p.hash);
          break;
        case "reply":
          if (
            typeof p.message !== "string" ||
            !Number.isSafeInteger(p.revision)
          )
            throw new Error("Revision and reply required");
          result = await runtime.reply(taskId(), Number(p.revision), p.message);
          break;
        case "resume":
          result = await runtime.resume(taskId());
          break;
        case "cancel":
          await runtime.cancel(taskId());
          result = { accepted: true };
          break;
        default:
          throw new Error("Unknown runtime operation");
      }
      send(id, result);
    } catch (error) {
      send(
        id,
        null,
        error instanceof Error ? error.message : "Runtime request failed",
      );
    }
  };
  let buffer = "";
  input.setEncoding("utf8");
  for await (const chunk of input) {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const work = dispatch(line);
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
      if (inFlight.size >= 32) await Promise.race(inFlight);
    }
    if (Buffer.byteLength(buffer) > 128000) {
      send(null, null, "Request exceeds the transport bound");
      break;
    }
  }
  if (buffer.trim()) await dispatch(buffer);
  await Promise.all(inFlight);
}
