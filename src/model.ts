import { spending } from "./spending.js";
import {
  readGenerationStream,
  StreamFailure,
  type StreamProgress,
} from "./openrouter-stream.js";
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_details?: unknown[];
};
/** OpenAI-style multimodal parts. Only the current turn's model input carries them; persisted history stays text. */
export type ContentPart =
  // cache_control is a wire-only provider prompt-cache marker (see cacheHints).
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image_url"; image_url: { url: string } };
export type ModelMessage = Omit<Message, "content"> & {
  content: string | ContentPart[] | null;
};
/** Per-image input allowance used for cost estimates; providers bill roughly this order for a phone photo. */
export const IMAGE_TOKEN_ALLOWANCE = 1600;
/** Byte size for estimates: base64 image data is replaced by a fixed token allowance. */
export function estimateInputBytes(messages: ModelMessage[]) {
  let images = 0;
  const text = JSON.stringify(messages, (key, value) =>
    key === "image_url" && value && typeof value === "object"
      ? (images++, {})
      : value,
  );
  return Buffer.byteLength(text) + images * IMAGE_TOKEN_ALLOWANCE * 4;
}
export type ToolCall = {
  id: string;
  type: "function";
  /** Optional provider ordering metadata, preserved across tool continuation. */
  index?: number;
  function: { name: string; arguments: string };
};
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type Generation = {
  message: Message;
  provider?: string;
  usage?: Record<string, unknown>;
  model?: string;
};
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export interface ModelAdapter {
  readonly model?: string;
  generate(input: {
    messages: ModelMessage[];
    tools: ToolDefinition[];
    reasoning: ReasoningEffort;
    signal: AbortSignal;
    sessionId?: string;
    /** Sent as OpenRouter session_id instead of sessionId; prompt caches are partitioned by it. */
    cacheKey?: string;
    /** Coding opt-in: accept only confirmed complete provider responses. */
    requireComplete?: boolean;
    /** Trusted per-request output allowance; ordinary callers retain 8,000. */
    maxOutputTokens?: number;
    /** Coding-only opt-in. Ordinary assistant requests keep their existing path. */
    stream?: boolean;
    onProgress?: (value: StreamProgress) => Promise<void> | void;
  }): Promise<Generation>;
}
/** Mark one message for prompt caching; text content becomes a single marked text block. */
function marked(message: ModelMessage): ModelMessage | undefined {
  const cache_control = { type: "ephemeral" as const };
  if (typeof message.content === "string" && message.content)
    return {
      ...message,
      content: [{ type: "text", text: message.content, cache_control }],
    };
  const last = Array.isArray(message.content)
    ? message.content.at(-1)
    : undefined;
  if (last?.type === "text")
    return {
      ...message,
      content: [
        ...(message.content as ContentPart[]).slice(0, -1),
        { ...last, cache_control },
      ],
    };
  return undefined;
}
/**
 * Provider prompt-cache hints (journal 100), measured on OpenRouter on 19 October 2026 with
 * synthetic Chief-shaped requests:
 * - Anthropic models cache nothing unmarked. A top-level marker alone re-read only the opening
 *   prefix, because its automatic breakpoint lands on the per-call state message at the end.
 *   An extra marker on the last message before that state message also caches the growing
 *   in-turn history.
 * - Gemini Flash keeps an explicit cache on the opening system message although the request
 *   tail changes; Argon's implicit cache never hit with a changing tail.
 * Other providers cache automatically, so their requests are unchanged. Wire-only: callers'
 * messages, journals and hashes keep the original content.
 */
export function cacheHints(model: string, messages: ModelMessage[]) {
  const at = (index: number) => {
    const message = index >= 0 ? messages[index] : undefined;
    const replacement = message && marked(message);
    return replacement
      ? messages.map((m, i) => (i === index ? replacement : m))
      : undefined;
  };
  if (model.startsWith("anthropic/")) {
    const end =
      messages.at(-1)?.role === "system" && messages.length > 1
        ? messages.length - 2
        : messages.length - 1;
    let index = end;
    while (index >= 0 && !marked(messages[index]!)) index--;
    // The owner's current message never changes during a turn. In production (20 October)
    // later calls missed entirely after a mid-turn tool load; the hypothesis (journal 104)
    // is that removing the previous step's reasoning broke the only entry each call wrote.
    // A fixed mark here keeps tools, instructions, history and the message readable.
    const owner = messages.findLastIndex(
      (m, i) => m.role === "user" && i <= end && i !== index && !!marked(m),
    );
    let hinted = at(index) ?? messages;
    if (owner >= 0)
      hinted = hinted.map((m, i) => (i === owner ? marked(m)! : m));
    // The opening system message (instructions and memories) also gets an entry, reusable
    // across turns with the same tools and whenever later messages change. That is four
    // breakpoints with the top-level one, Anthropic's maximum.
    if (
      messages[0]?.role === "system" &&
      index !== 0 &&
      owner !== 0 &&
      marked(messages[0])
    )
      hinted = hinted.map((m, i) => (i === 0 ? marked(m)! : m));
    return { cache_control: { type: "ephemeral" as const }, messages: hinted };
  }
  if (model.startsWith("google/") && messages[0]?.role === "system")
    return { messages: at(0) ?? messages };
  return { messages };
}
export class ModelError extends Error {
  constructor(
    message: string,
    readonly transient = false,
    readonly diagnostics: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export class OpenRouter implements ModelAdapter {
  constructor(
    private key: string,
    readonly model = "openai/gpt-5.6-sol",
    private inputPrice = 2,
    private outputPrice = 10,
    private transport: typeof fetch = fetch,
  ) {
    if (![inputPrice, outputPrice].every((n) => Number.isFinite(n) && n > 0))
      throw new Error("Provider price ceilings must be positive");
  }
  async generate(
    input: Parameters<ModelAdapter["generate"]>[0],
  ): Promise<Generation> {
    const maxOutputTokens = input.maxOutputTokens ?? 8000;
    if (
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 16000
    )
      throw new Error("Invalid model output allowance");
    const ledger = spending.getStore();
    const estimate =
      ((estimateInputBytes(input.messages) +
        Buffer.byteLength(JSON.stringify(input.tools)) +
        4096) *
        this.inputPrice *
        1.25) /
        1e6 +
      (maxOutputTokens * this.outputPrice) / 1e6;
    const charge = await ledger?.begin("openrouter-main", estimate);
    let response: Response;
    try {
      response = await this.transport(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          signal: input.signal,
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            ...((input.cacheKey ?? input.sessionId)
              ? { session_id: input.cacheKey ?? input.sessionId }
              : {}),
            ...cacheHints(this.model, input.messages),
            tools: input.tools.map((f) => ({ type: "function", function: f })),
            reasoning: { enabled: true, effort: input.reasoning },
            // No price sort: OpenRouter's default routing avoids providers with recent
            // outages while still preferring cheaper ones under the max_price ceilings.
            provider: {
              max_price: {
                prompt: this.inputPrice,
                completion: this.outputPrice,
              },
              require_parameters: true,
            },
            max_tokens: maxOutputTokens,
            stream: input.stream ?? false,
          }),
        },
      );
    } catch (error) {
      if (!input.stream) throw error;
      if (input.signal.aborted) throw input.signal.reason;
      throw new ModelError("Model transport failed", true, {
        failureCode: "transport",
      });
    }
    if (!response.ok)
      throw new ModelError(
        response.status === 404
          ? "No eligible provider is available within the configured price and parameter limits."
          : `Model request failed (HTTP ${response.status}); price limits remain enforced.`,
        response.status === 429 || response.status >= 500,
        { httpStatus: response.status },
      );
    let data: any;
    try {
      data = input.stream
        ? await readGenerationStream(
            response,
            input.signal,
            input.onProgress,
            // Pi complete-response requests may contain one SSE envelope per
            // token. Bound transport overhead separately from report content.
            input.requireComplete
              ? Math.max(1600000, maxOutputTokens * 1024)
              : undefined,
          )
        : await response.json();
    } catch (error) {
      if (!input.stream) throw error;
      if (input.signal.aborted) throw input.signal.reason;
      if (error instanceof StreamFailure)
        throw new ModelError(
          "Model stream failed",
          error.code === "disconnected" ||
            (error.code === "provider" &&
              (error.providerTransient ||
                error.httpStatus === 429 ||
                (error.httpStatus !== undefined &&
                  error.httpStatus >= 500 &&
                  error.httpStatus <= 599))),
          {
            failureCode: error.code,
            ...(error.finishReason ? { finishReason: error.finishReason } : {}),
            ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
          },
        );
      throw new ModelError("Model response transport failed", true, {
        failureCode: "transport",
      });
    }
    if (charge) await ledger!.settle(charge, data?.usage);
    const choice = data?.choices?.[0];
    const m = choice?.message;
    // Keep structural diagnostics only; never log response text or provider raw errors.
    const diagnostics = {
      provider:
        typeof data?.provider === "string" ? data.provider.slice(0, 100) : null,
      responseId: typeof data?.id === "string" ? data.id.slice(0, 160) : null,
      finishReason:
        typeof choice?.finish_reason === "string"
          ? choice.finish_reason.slice(0, 60)
          : null,
      errorCode: Number.isInteger(Number(data?.error?.code))
        ? Number(data.error.code)
        : null,
      hasUsage: !!data?.usage,
    };
    if (data?.error) {
      const code = diagnostics.errorCode;
      throw new ModelError(
        "The model provider could not complete the request. Please try again shortly.",
        code === 429 || (code !== null && code >= 500 && code <= 599),
        diagnostics,
      );
    }
    if (
      input.requireComplete &&
      !["stop", "tool_calls"].includes(choice?.finish_reason)
    )
      throw new ModelError(
        "The model response did not finish completely; no output was accepted.",
        false,
        { ...diagnostics, failureCode: "incomplete" },
      );
    const hasText =
      typeof m?.content === "string" && m.content.trim().length > 0;
    const hasTools = Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;
    if (!hasText && !hasTools)
      throw new ModelError(
        "The model provider returned an empty response. Please try again shortly.",
        !["length", "content_filter"].includes(choice?.finish_reason),
        { ...diagnostics, failureCode: "empty" },
      );
    if (
      m.tool_calls &&
      !m.tool_calls.every(
        (t: any) =>
          typeof t.id === "string" &&
          t.type === "function" &&
          typeof t.function?.name === "string" &&
          typeof t.function?.arguments === "string",
      )
    )
      throw new ModelError("Invalid model tool calls");
    return {
      message: {
        role: "assistant",
        content: m.content ?? null,
        ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
        ...(m.reasoning_details
          ? { reasoning_details: m.reasoning_details }
          : {}),
      },
      provider: data.provider,
      model: data.model ?? this.model,
      usage: data.usage,
    };
  }
}
