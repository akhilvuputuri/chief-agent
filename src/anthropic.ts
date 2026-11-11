import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  estimateInputBytes,
  MAX_OUTPUT_TOKENS,
  ModelError,
  type Generation,
  type ModelAdapter,
  type ModelMessage,
  type ToolCall,
} from "./model.js";
import { spending } from "./spending.js";

/** USD per million tokens. */
export type AnthropicPrices = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Request choices per native model, kept in one place: Anthropic models differ in thinking,
 * effort, system-message, fallback and preserved-thinking support, so unlisted models are refused.
 */
const PROFILES: Record<string, { fallbacks?: "default" }> = {
  // Adaptive thinking only (disabled/budget_tokens are 400s), output_config.effort, no
  // forced tool_choice or prefill, mid-conversation system messages, the history check
  // enforced for new accounts, and server-side refusal fallback opted in by default.
  "claude-opus-5-5": { fallbacks: "default" },
};
const BETAS = {
  binding: "thinking-binding-controls-2026-08-01",
  fallback: "server-side-fallback-2026-07-01",
} as const;

const TAG = "anthropic.thinking";
const FORMAT = "anthropic-direct-v1";
/** Native blocks a direct turn stores in reasoning_details and replays verbatim. */
const NATIVE = new Set(["thinking", "redacted_thinking", "fallback"]);
export type AnthropicDirectReasoning = {
  type: typeof TAG;
  format: typeof FORMAT;
  block: Record<string, unknown>;
};
/** True for reasoning entries produced by the direct Anthropic route (bound to that account). */
export function isAnthropicDirectReasoning(
  entry: unknown,
): entry is AnthropicDirectReasoning {
  const e = entry as Partial<AnthropicDirectReasoning> | null;
  return (
    !!e &&
    typeof e === "object" &&
    e.type === TAG &&
    e.format === FORMAT &&
    !!e.block &&
    typeof e.block === "object" &&
    !Array.isArray(e.block)
  );
}
/** Remove direct-route reasoning, e.g. before a conversation is sent to OpenRouter. */
export function stripAnthropicDirectReasoning<
  T extends { reasoning_details?: unknown[] },
>(messages: T[]): T[] {
  return messages.map((message) => {
    if (!message.reasoning_details?.some(isAnthropicDirectReasoning))
      return message;
    const { reasoning_details, ...rest } = message;
    const kept = reasoning_details.filter(
      (e) => !isAnthropicDirectReasoning(e),
    );
    return (kept.length ? { ...rest, reasoning_details: kept } : rest) as T;
  });
}

type Block = Record<string, any> & { type: string };
type Entry = { role: "user" | "assistant" | "system"; content: Block[] };
const cacheable = (block: Block) => !NATIVE.has(block.type);

function plain(content: ModelMessage["content"]) {
  return typeof content === "string"
    ? content
    : (content ?? [])
        .flatMap((p) => (p.type === "text" ? [p.text] : []))
        .join("\n");
}
function image(url: string): Block {
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(url);
  if (data)
    return {
      type: "image",
      source: { type: "base64", media_type: data[1], data: data[2] },
    };
  if (/^https:\/\//i.test(url))
    return { type: "image", source: { type: "url", url } };
  return {
    type: "text",
    text: "[An image in an unsupported form was omitted.]",
  };
}
/** Text and image blocks; empty text is a 400, and wire-only cache_control is not copied. */
function blocks(content: ModelMessage["content"], images = true): Block[] {
  if (typeof content === "string")
    return content.trim() ? [{ type: "text", text: content }] : [];
  return (content ?? []).flatMap((p): Block[] =>
    p.type === "text"
      ? p.text.trim()
        ? [{ type: "text", text: p.text }]
        : []
      : images
        ? [image(p.image_url.url)]
        : [],
  );
}
function toolInput(value: string) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
  } catch {}
  // tool_use input must be an object; the paired tool result reports the invalid call.
  return {};
}
const reminder = (text: string): Block => ({
  type: "text",
  text: `<system-reminder>\n${text}\n</system-reminder>`,
});

/** Chief's OpenAI-style conversation as an Anthropic request (system, messages, cache marks). */
function translate(messages: ModelMessage[]) {
  let start = 0;
  const system: Block[] = [];
  for (; messages[start]?.role === "system"; start++) {
    const text = plain(messages[start]!.content);
    if (text.trim()) system.push({ type: "text", text });
  }
  // Chief appends a per-call state message; it changes every call, so no mark covers it.
  const state =
    messages.length - 1 >= start && messages.at(-1)?.role === "system"
      ? messages.length - 1
      : -1;
  const volatile = new Set<Block>();
  let owner: Block | undefined;
  const entries: Entry[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!;
    let content: Block[];
    if (m.role === "user") {
      content = blocks(m.content);
      if (content.length) owner = content.at(-1);
    } else if (m.role === "tool") {
      const result = blocks(m.content);
      content = [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id ?? "",
          ...(typeof m.content === "string"
            ? m.content
              ? { content: m.content }
              : {}
            : result.length
              ? { content: result }
              : {}),
        },
      ];
    } else if (m.role === "assistant") {
      const visible = [
        ...blocks(m.content, false),
        ...(m.tool_calls ?? []).map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: toolInput(call.function.arguments),
        })),
      ];
      // Only this route's own blocks, verbatim and in order; others belong to another account.
      const native = visible.length
        ? (m.reasoning_details ?? [])
            .filter(isAnthropicDirectReasoning)
            .map((e) => e.block as Block)
            .filter((b) => NATIVE.has(b.type))
            .map((b) => ({ ...b }))
        : [];
      content = [...native, ...visible];
    } else {
      const text = plain(m.content);
      content = text.trim() ? [{ type: "text", text }] : [];
      if (i === state) content.forEach((b) => volatile.add(b));
    }
    if (content.length)
      entries.push({ role: m.role === "tool" ? "user" : m.role, content });
  }
  // Mid-conversation system messages must follow a user turn and precede an assistant turn
  // or end the request; elsewhere they become a reminder in a user turn.
  entries.forEach((entry, i) => {
    if (entry.role !== "system") return;
    const prev = entries[i - 1];
    const next = entries[i + 1];
    if (prev?.role === "user" && (!next || next.role === "assistant")) return;
    entry.role = "user";
    entry.content = entry.content.map((b) => {
      const folded = reminder(b.text);
      if (volatile.has(b)) volatile.add(folded);
      return folded;
    });
  });
  const merged: Entry[] = [];
  for (const entry of entries) {
    const last = merged.at(-1);
    if (last && last.role === entry.role && entry.role !== "system")
      last.content.push(...entry.content);
    else merged.push({ ...entry, content: [...entry.content] });
  }
  for (const entry of merged)
    if (entry.role === "user")
      // All results of one assistant turn lead a single user message.
      entry.content.sort(
        (a, b) =>
          Number(b.type === "tool_result") - Number(a.type === "tool_result"),
      );
  if (merged[0]?.role !== "user")
    merged.unshift({
      role: "user",
      content: [{ type: "text", text: "(The conversation continues.)" }],
    });
  // Port of cacheHints (journal 100/104): automatic top-level caching plus the last block
  // before the state message, the owner's current message and the opening system prompt.
  const marks = new Set<Block>();
  const stable = merged
    .flatMap((e) => e.content)
    .findLast((b) => !volatile.has(b) && cacheable(b));
  if (stable) marks.add(stable);
  if (owner && !volatile.has(owner)) marks.add(owner);
  if (system.length) marks.add(system.at(-1)!);
  for (const block of marks) block.cache_control = { type: "ephemeral" };
  return {
    ...(system.length ? { system } : {}),
    messages: merged,
  };
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
};
type Fault =
  | "auth"
  | "permission"
  | "billing"
  | "rate_limit"
  | "unavailable"
  | "not_found";
/** On every failure, so model.failed lines and failed spans name this pathway. */
const ROUTE = { route: "anthropic-direct", provider: "Anthropic" } as const;

function retryAfter(headers: Headers | undefined) {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? Math.max(0, Math.ceil((at - Date.now()) / 1000))
    : undefined;
}

export class AnthropicDirect implements ModelAdapter {
  readonly model: string;
  private readonly nativeModel: string;
  private readonly prices: AnthropicPrices;
  private readonly transport: typeof fetch;
  constructor(
    private key: string,
    options: {
      model: string;
      nativeModel: string;
      prices: AnthropicPrices;
      transport?: typeof fetch;
    },
  ) {
    const { input, output, cacheRead, cacheWrite } = options.prices;
    if (
      ![input, output, cacheRead, cacheWrite].every(
        (n) => Number.isFinite(n) && n > 0,
      )
    )
      throw new Error("Anthropic prices must be positive");
    if (!PROFILES[options.nativeModel])
      throw new Error("Unsupported Anthropic model");
    this.model = options.model;
    this.nativeModel = options.nativeModel;
    this.prices = options.prices;
    this.transport = options.transport ?? fetch;
  }

  async generate(
    input: Parameters<ModelAdapter["generate"]>[0],
  ): Promise<Generation> {
    const maxOutputTokens = input.maxOutputTokens ?? 8000;
    if (
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > MAX_OUTPUT_TOKENS
    )
      throw new Error("Invalid model output allowance");
    const profile = PROFILES[this.nativeModel]!;
    const ledger = spending.getStore();
    const estimate =
      ((estimateInputBytes(input.messages) +
        Buffer.byteLength(JSON.stringify(input.tools)) +
        4096) *
        this.prices.input *
        1.25) /
        1e6 +
      (maxOutputTokens * this.prices.output) / 1e6;
    const charge = await ledger?.begin("anthropic-main", estimate);
    // cacheKey/sessionId have no native equivalent and are not sent.
    const body = {
      model: this.nativeModel,
      max_tokens: maxOutputTokens,
      ...translate(input.messages),
      ...(input.tools.length
        ? {
            // Eager input streaming stays off: the API then validates each parameter.
            tools: input.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      cache_control: { type: "ephemeral" },
      // Chief rebuilds history each call, so mismatched thinking is dropped, not a 400.
      thinking: {
        type: "adaptive",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
      output_config: { effort: input.reasoning },
      ...(profile.fallbacks ? { fallbacks: profile.fallbacks } : {}),
      betas: [BETAS.binding, ...(profile.fallbacks ? [BETAS.fallback] : [])],
    } as unknown as BetaMessageStreamParams;
    let bytes = 0;
    let emitted = false;
    let responseId: string | undefined;
    const transport = this.transport;
    const counting = (async (url: any, init?: RequestInit) => {
      const response = await transport(url, init);
      if (!response.body) return response;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      // The signal also ends a body whose transport ignores aborts.
      const body = response.body.pipeThrough(counter, {
        ...(init?.signal ? { signal: init.signal } : {}),
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }) as typeof fetch;
    const client = new Anthropic({
      apiKey: this.key,
      baseURL: "https://api.anthropic.com",
      fetch: counting,
      maxRetries: 0, // Callers own retries, as with OpenRouter.
      // Bounds the wait for response headers only; input.signal bounds the whole call.
      timeout: 10 * 60 * 1000,
      logLevel: "off", // The SDK can log raw stream chunks; never log content.
      openTelemetry: false, // Chief records its own model spans.
    });
    let message: BetaMessage;
    try {
      // Always streamed, so large output allowances never meet HTTP timeouts.
      const stream = client.beta.messages.stream(body, {
        signal: input.signal,
      });
      for await (const event of stream) {
        if (event.type === "message_start") responseId = event.message.id;
        else if (
          event.type === "content_block_start" ||
          event.type === "content_block_delta"
        ) {
          emitted = true;
          if (input.stream)
            await input.onProgress?.({
              responseId: responseId?.slice(0, 160),
              provider: "Anthropic",
              bytes,
            });
        }
      }
      message = await stream.finalMessage();
    } catch (error) {
      throw this.failure(error, input.signal, emitted);
    }
    const content = message.content as BetaContentBlock[];
    const boundary = content.findLastIndex((b) => b.type === "fallback");
    const fellBack =
      boundary >= 0 ||
      !!message.usage?.iterations?.some((i) => i.type === "fallback_message");
    const usage = this.usage(message, fellBack);
    if (charge) await ledger!.settle(charge, usage);
    const finishReason = message.stop_reason
      ? (FINISH[message.stop_reason] ?? String(message.stop_reason)).slice(
          0,
          60,
        )
      : null;
    // Structural diagnostics only; never response text or provider messages.
    const diagnostics = {
      ...ROUTE,
      responseId:
        typeof message.id === "string" ? message.id.slice(0, 160) : null,
      finishReason,
      errorCode: null,
      hasUsage: !!message.usage,
    };
    if (!finishReason)
      throw new ModelError("Model stream failed", true, {
        ...diagnostics,
        failureCode: "disconnected",
      });
    if (message.stop_reason === "refusal") {
      // The whole fallback chain declined; partial output is discarded, as the docs require.
      const category = message.stop_details?.category;
      throw new ModelError("The model declined this request.", false, {
        ...diagnostics,
        failureCode: "refusal",
        ...(typeof category === "string"
          ? { refusalCategory: category.slice(0, 60) }
          : {}),
      });
    }
    // After a fallback, thinking and tool_use before the final boundary are not part of the turn.
    const after = (index: number) => index > boundary;
    const text = content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
    const toolCalls: ToolCall[] = content.flatMap((b, i) =>
      b.type === "tool_use" && after(i)
        ? [
            {
              id: b.id,
              type: "function" as const,
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input ?? {}),
              },
            },
          ]
        : [],
    );
    const reasoning = content.flatMap((b, i) =>
      b.type === "fallback" ||
      ((b.type === "thinking" || b.type === "redacted_thinking") && after(i))
        ? [
            {
              type: TAG,
              format: FORMAT,
              block: JSON.parse(JSON.stringify(b)),
            } satisfies AnthropicDirectReasoning,
          ]
        : [],
    );
    if (input.requireComplete && !["stop", "tool_calls"].includes(finishReason))
      throw new ModelError(
        "The model response did not finish completely; no output was accepted.",
        false,
        { ...diagnostics, failureCode: "incomplete" },
      );
    if (!text.trim() && !toolCalls.length)
      throw new ModelError(
        "The model provider returned an empty response. Please try again shortly.",
        !["length", "content_filter"].includes(finishReason),
        { ...diagnostics, failureCode: "empty" },
      );
    if (
      !toolCalls.every(
        (t) =>
          typeof t.id === "string" &&
          t.id &&
          typeof t.function.name === "string" &&
          t.function.name,
      )
    )
      throw new ModelError("Invalid model tool calls", false, ROUTE);
    return {
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(reasoning.length ? { reasoning_details: reasoning } : {}),
      },
      provider: "Anthropic",
      model: this.model,
      usage,
      finishReason,
    };
  }

  /** OpenRouter-shaped usage, priced from the configured per-million rates. */
  private usage(message: BetaMessage, fellBack: boolean) {
    const u = message.usage;
    const uncached = u?.input_tokens ?? 0;
    const read = u?.cache_read_input_tokens ?? 0;
    const write = u?.cache_creation_input_tokens ?? 0;
    const output = u?.output_tokens ?? 0;
    const reasoning = u?.output_tokens_details?.thinking_tokens;
    const p = this.prices;
    return {
      prompt_tokens: uncached + read + write,
      completion_tokens: output,
      total_tokens: uncached + read + write + output,
      prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
      ...(Number.isFinite(reasoning)
        ? { completion_tokens_details: { reasoning_tokens: reasoning } }
        : {}),
      cost:
        (uncached * p.input +
          read * p.cacheRead +
          write * p.cacheWrite +
          output * p.output) /
        1e6,
      route: "anthropic-direct",
      thinking_dropped: (message.input_transformations ?? []).filter(
        (t) => t.type === "thinking_dropped",
      ).length,
      ...(fellBack && typeof message.model === "string"
        ? { served_model: message.model.slice(0, 100) }
        : {}),
    };
  }

  private failure(error: unknown, signal: AbortSignal, emitted: boolean) {
    if (signal.aborted) return signal.reason;
    if (error instanceof ModelError) return error;
    // A provider fault tells a router that falling back is safe: nothing was emitted yet.
    const fault = (value: Fault | undefined) =>
      value && !emitted ? { providerFault: value } : {};
    if (
      error instanceof Anthropic.APIError &&
      !(error instanceof Anthropic.APIConnectionError) &&
      !(error instanceof Anthropic.APIUserAbortError)
    ) {
      const status =
        typeof error.status === "number" ? error.status : undefined;
      const type = error.type;
      // A bad key fails every model; a permission refusal may be this model's alone.
      const value: Fault | undefined =
        status === 401 || type === "authentication_error"
          ? "auth"
          : status === 403 || type === "permission_error"
            ? "permission"
            : status === 402 ||
                type === "billing_error" ||
                error.errorCode === "enforced_spend_limit_reached"
              ? "billing"
              : status === 429 || type === "rate_limit_error"
                ? "rate_limit"
                : (status !== undefined && status >= 500) ||
                    ["api_error", "overloaded_error", "timeout_error"].includes(
                      String(type),
                    )
                  ? "unavailable"
                  : status === 404 || type === "not_found_error"
                    ? "not_found"
                    : undefined;
      const seconds = retryAfter(error.headers as Headers | undefined);
      return new ModelError(
        status
          ? `Model request failed (HTTP ${status}).`
          : "Model stream failed",
        value === "rate_limit" || value === "unavailable",
        {
          ...ROUTE,
          ...(status ? { httpStatus: status } : { failureCode: "provider" }),
          ...(typeof type === "string" ? { errorType: type.slice(0, 60) } : {}),
          ...fault(value),
          ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
        },
      );
    }
    return new ModelError("Model transport failed", true, {
      ...ROUTE,
      failureCode: "transport",
      ...fault("unavailable"),
    });
  }
}
