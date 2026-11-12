import { createHash } from "node:crypto";
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
 * Native models this adapter supports, kept in one place: Anthropic models differ in thinking,
 * effort, system-message and preserved-thinking support, so unlisted models are refused.
 * Opus 5.5, Sonnet 5.5 and Haiku 5.5 share what this adapter relies on: adaptive thinking
 * (a disabled setting or budget_tokens is a 400 on Opus and Sonnet), output_config.effort at
 * low to max, no prefill (the adapter never forces tool_choice), mid-conversation system messages, and
 * preserved thinking with the history check. Sonnet and Haiku were added on 11 November 2026
 * (journal 164) from Anthropic's model documentation; neither has been called live.
 */
const PROFILES = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);
// Server-side refusal fallbacks (`fallbacks`) are deliberately never sent: they can serve Opus 5
// or 4.8 at $5/$25, above the owner-approved $4/$20 ceilings, sticky and priced at the wrong rates.
const BETA = "thinking-binding-controls-2026-08-01";
/** The optional anthropic-workspace-id header value (an unscoped key needs one). */
export const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]+$/;
/** A 400 that fails every call until the account changes, not just this request. */
const NOT_ENROLLED = "organization_not_enrolled_in_beta";

const TAG = "anthropic.thinking";
const FORMAT = "anthropic-direct-v1";
/**
 * Native blocks a direct turn stores in reasoning_details and replays verbatim. Entries of any
 * other block type (such as `fallback` blocks from earlier test data) are never replayed.
 */
const NATIVE = new Set(["thinking", "redacted_thinking"]);
export type AnthropicDirectReasoning = {
  type: typeof TAG;
  format: typeof FORMAT;
  block: Record<string, unknown>;
  /**
   * Where the block stood among the turn's visible blocks as Chief stores them: the index, in
   * [text (when non-empty), tool_calls[0], tool_calls[1], ...], of the visible block it preceded
   * (the length of that list when it came last). Text counts as preceding the block when any
   * text block came before it in the response. Entries without it (stored before it existed)
   * replay before every visible block.
   */
  position?: number;
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
  // Nothing to strip: the same array and message objects, so the request is byte-identical.
  if (
    !messages.some((m) => m.reasoning_details?.some(isAnthropicDirectReasoning))
  )
    return messages;
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

/**
 * The trailing state message each thinking block was generated after, so a replay can rebuild
 * the block's prefix exactly. Chief rebuilds its per-call state message every call (src/context.ts),
 * so without it the API drops every replayed in-turn block (prefix_binding_mismatch). Keys are
 * hashes of the caller's scope (see callScope) and the block's signature or data, so a state
 * recorded in one owner's run is never inserted into another's request, even one that carries a
 * copied block; values are the exact state text, held only in this process (bounded by entries
 * and characters, least recently used first) and never logged. After a restart the map is empty
 * and replayed blocks are dropped, as before.
 */
export class ThinkingStates {
  private map = new Map<string, string[]>();
  private size = 0;
  constructor(
    private maxEntries = 2000,
    private maxChars = 8_000_000,
  ) {}
  /** A hash of the scope and the block's signature (or data); undefined without either. */
  static key(scope: string, block: Block) {
    const value =
      block.type === "thinking"
        ? block.signature
        : block.type === "redacted_thinking"
          ? block.data
          : undefined;
    return typeof value === "string" && value
      ? createHash("sha256")
          .update(JSON.stringify([scope, block.type, value]))
          .digest("hex")
      : undefined;
  }
  get(scope: string | undefined, block: Block) {
    const key = scope ? ThinkingStates.key(scope, block) : undefined;
    const value = key ? this.map.get(key) : undefined;
    if (key && value) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  /** Without a scope nothing is kept (see callScope). */
  remember(scope: string | undefined, block: Block, texts: string[]) {
    const key = scope ? ThinkingStates.key(scope, block) : undefined;
    const chars = texts.reduce((n, t) => n + t.length, 0);
    if (!key || !texts.length || chars > this.maxChars / 4) return;
    this.forget(key);
    this.map.set(key, [...texts]);
    this.size += chars;
    for (const [oldest] of this.map) {
      if (this.map.size <= this.maxEntries && this.size <= this.maxChars) break;
      this.forget(oldest);
    }
  }
  clear() {
    this.map.clear();
    this.size = 0;
  }
  get entries() {
    return this.map.size;
  }
  private forget(key: string) {
    const value = this.map.get(key);
    if (!value) return;
    this.map.delete(key);
    this.size -= value.reduce((n, t) => n + t.length, 0);
  }
}
/** Shared by every adapter in the process: the router builds a new adapter per agent run. */
export const thinkingStates = new ThinkingStates();

/**
 * Replayed blocks the API rejected: when a request that replayed thinking got a 400 and the same
 * request without thinking then succeeded, every block replayed in the rejected request is
 * remembered here (by scope and signature hash, bounded, least recently used first) and is not
 * replayed again, so a permanently rejected block costs one failed request, not one per call.
 * Calls without a scope share one unscoped namespace, apart from every scoped one.
 */
export class RejectedReplays {
  private keys = new Set<string>();
  constructor(private max = 1000) {}
  has(scope: string | undefined, block: Block) {
    const key = ThinkingStates.key(scope ?? "", block);
    if (!key || !this.keys.has(key)) return false;
    this.keys.delete(key);
    this.keys.add(key);
    return true;
  }
  add(scope: string | undefined, block: Block) {
    const key = ThinkingStates.key(scope ?? "", block);
    if (!key) return;
    this.keys.delete(key);
    this.keys.add(key);
    for (const oldest of this.keys) {
      if (this.keys.size <= this.max) break;
      this.keys.delete(oldest);
    }
  }
  clear() {
    this.keys.clear();
  }
  get entries() {
    return this.keys.size;
  }
}
export const rejectedReplays = new RejectedReplays();

/**
 * The owner and run a call belongs to: the host's spending scope (src/spending.ts), set for every
 * owner run, agent and research child run and learner run, and consecutive calls of one run share
 * it. Coding calls (whose messages come from a sandbox) and other calls without one get
 * undefined, so no thinking state is recorded for them or inserted into their requests.
 */
function callScope() {
  const store = spending.getStore();
  return typeof store?.user === "string" &&
    store.user &&
    typeof store.run === "string" &&
    store.run
    ? JSON.stringify(["run", store.user, store.run])
    : undefined;
}

/**
 * The API requires tool_use ids matching ^[a-zA-Z0-9_-]+$; other providers (through OpenRouter)
 * return ids such as `functions.memory_set:0` that stay in history. Those are mapped, the same way
 * for tool_use.id and tool_result.tool_use_id, to a sanitized prefix and a hash (at most 57
 * characters). Valid ids, including every id this API returns, are sent unchanged. An id that
 * recurs in later assistant turns (per-turn ids such as `functions.memory_set:0`) stays the same:
 * measured 11 November 2026, the API accepts the same tool_use id in different assistant turns,
 * mapped or native, and rejects it only twice within one turn, which a mapping cannot introduce.
 */
const TOOL_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function anthropicToolId(id: string) {
  if (TOOL_ID.test(id)) return id;
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `${id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40)}_${hash}`;
}

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
/** Truncated tool input that can never parse (see generate). */
function unparsable(raw: string) {
  try {
    JSON.parse(raw);
    return raw.trimEnd().slice(0, -1);
  } catch {
    return raw;
  }
}
const reminder = (text: string): Block => ({
  type: "text",
  text: `<system-reminder>\n${text}\n</system-reminder>`,
});

/**
 * Chief's OpenAI-style conversation as an Anthropic request (system, messages, cache marks).
 * With replay off, stored thinking is left out (text and tool_use stay), as are blocks the API
 * rejected before; `replayed` lists the native thinking blocks sent.
 */
function translate(
  messages: ModelMessage[],
  { replay = true, scope }: { replay?: boolean; scope?: string } = {},
) {
  const replayed: Block[] = [];
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
          tool_use_id: anthropicToolId(m.tool_call_id ?? ""),
          // Content is optional; an empty or whitespace-only result is sent without it.
          ...(typeof m.content === "string"
            ? m.content.trim()
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
          id: anthropicToolId(call.id),
          name: call.function.name,
          input: toolInput(call.function.arguments),
        })),
      ];
      // Only this route's own blocks, verbatim; others belong to another account.
      const stored =
        replay && visible.length
          ? (m.reasoning_details ?? [])
              .filter(isAnthropicDirectReasoning)
              .filter(
                (e) =>
                  NATIVE.has((e.block as Block).type) &&
                  !rejectedReplays.has(scope, e.block as Block),
              )
          : [];
      const native = stored.map((e) => ({ ...(e.block as Block) }));
      if (native.length) {
        replayed.push(...native);
        // Rebuild the block's prefix: the state message that ended the request it came from,
        // exactly as sent, unless that message is still in place.
        const before = native
          .map((b) => thinkingStates.get(scope, b))
          .find(Boolean);
        const previous = messages[i - 1];
        if (
          before &&
          !(
            previous?.role === "system" &&
            i - 1 >= start &&
            plain(previous.content) === before.join("\n")
          )
        )
          entries.push({
            role: "system",
            content: before.map((text) => ({ type: "text", text })),
          });
      }
      // Each block back where it stood (interleaved thinking before each tool call, say);
      // entries without a position lead, as before.
      const at = stored.map(({ position: p }) =>
        Number.isSafeInteger(p) && p! >= 0 ? Math.min(p!, visible.length) : 0,
      );
      content = [];
      for (let slot = 0; slot <= visible.length; slot++) {
        native.forEach((b, j) => at[j] === slot && content.push(b));
        if (slot < visible.length) content.push(visible[slot]!);
      }
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
  // Port of cacheHints (journal 100/104), three explicit marks: the last block before the
  // per-call state message (the last block when there is none), the owner's current message
  // and the opening system message. Chief opens with two system messages (stable instructions
  // and memories, then a per-turn summary); only the first is stable across turns, so it is the
  // one marked, as cacheHints marks messages[0]. No top-level automatic mark: it would land on
  // the trailing state message and pay a cache write on it every call.
  const marks = new Set<Block>();
  const stable = merged
    .flatMap((e) => e.content)
    .findLast((b) => !volatile.has(b) && cacheable(b));
  if (stable) marks.add(stable);
  if (owner && !volatile.has(owner)) marks.add(owner);
  if (system.length) marks.add(system[0]!);
  for (const block of marks) block.cache_control = { type: "ephemeral" };
  // The trailing state, when it went out as a mid-conversation system message: what any
  // thinking block in the response was generated after.
  const last = merged.at(-1);
  const trailing =
    last?.role === "system" && last.content.every((b) => volatile.has(b))
      ? last.content.map((b) => b.text as string)
      : undefined;
  return {
    request: { ...(system.length ? { system } : {}), messages: merged },
    replayed,
    trailing,
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
  | "not_found"
  | "rejected";
/** The API's error types (error.type), the only values logged from a provider error. */
const ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
]);
/** A stable error code (error.details.error_code) is a short snake_case identifier. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
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
  private readonly workspaceId: string;
  constructor(
    private key: string,
    options: {
      model: string;
      nativeModel: string;
      prices: AnthropicPrices;
      /** Sent as anthropic-workspace-id when set; a workspace-scoped key needs none. */
      workspaceId?: string;
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
    if (!PROFILES.has(options.nativeModel))
      throw new Error("Unsupported Anthropic model");
    const workspaceId = options.workspaceId ?? "";
    if (workspaceId && !WORKSPACE_ID.test(workspaceId))
      throw new Error("Invalid Anthropic workspace ID");
    this.workspaceId = workspaceId;
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
    const body = (request: ReturnType<typeof translate>["request"]) =>
      ({
        model: this.nativeModel,
        max_tokens: maxOutputTokens,
        ...request,
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
        // Chief rebuilds history each call, so mismatched thinking is dropped, not a 400.
        thinking: {
          type: "adaptive",
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        },
        output_config: { effort: input.reasoning },
        betas: [BETA],
      }) as unknown as BetaMessageStreamParams;
    const scope = callScope();
    const first = translate(input.messages, { scope });
    const { request, replayed } = first;
    let { trailing } = first;
    let message: BetaMessage;
    let rawInputs: Map<number, string>;
    let replayDropped = false;
    try {
      ({ message, rawInputs } = await this.attempt(
        body(request),
        input,
        maxOutputTokens,
      ));
    } catch (error) {
      // A rejected thinking replay (a corrupted block, or a key moved to an unlinked account)
      // would fail every later call with that turn in history, so retry once without it. The
      // decision is structural: a pre-output 400 on a request that replayed thinking.
      const d = error instanceof ModelError ? error.diagnostics : undefined;
      if (
        !replayed.length ||
        input.signal.aborted ||
        d?.providerFault !== "rejected" ||
        d.httpStatus !== 400 ||
        d.errorCode === NOT_ENROLLED
      )
        throw error;
      replayDropped = true;
      const retry = translate(input.messages, { replay: false, scope });
      try {
        ({ message, rawInputs } = await this.attempt(
          body(retry.request),
          input,
          maxOutputTokens,
        ));
      } catch (retryError) {
        if (retryError instanceof ModelError)
          retryError.diagnostics.replayDropped = true;
        throw retryError;
      }
      // The same request without thinking succeeded, so the replay was what failed: never
      // replay those blocks again. Later requests then skip exactly the blocks this retry left
      // out, so the blocks it returns share its prefix and their states can be kept.
      for (const b of replayed) rejectedReplays.add(scope, b);
      trailing = retry.trailing;
    }
    const content = message.content as BetaContentBlock[];
    const usage = {
      ...this.usage(message),
      ...(replayDropped ? { replay_dropped: true } : {}),
    };
    if (charge) await ledger!.settle(charge, usage);
    const finishReason = message.stop_reason
      ? (FINISH[message.stop_reason] ?? String(message.stop_reason)).slice(
          0,
          60,
        )
      : null;
    // Structural diagnostics only; never response text or provider messages. A complete
    // response was billed even when it is refused below, so its usage travels with the error.
    const diagnostics = {
      ...ROUTE,
      responseId:
        typeof message.id === "string" ? message.id.slice(0, 160) : null,
      finishReason,
      errorCode: null,
      hasUsage: !!message.usage,
      usage,
    };
    if (!finishReason)
      throw new ModelError("Model stream failed", true, {
        ...diagnostics,
        failureCode: "disconnected",
      });
    if (message.stop_reason === "refusal") {
      // Partial output is discarded, as the docs require. No refusal falls back anywhere.
      const category = message.stop_details?.category;
      throw new ModelError("The model declined this request.", false, {
        ...diagnostics,
        failureCode: "refusal",
        ...(typeof category === "string"
          ? { refusalCategory: category.slice(0, 60) }
          : {}),
      });
    }
    const text = content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
    // A response cut off at its output allowance can end inside a tool call. The SDK's tolerant
    // parse then yields valid-looking but truncated input (a dropped long value, say), so that
    // call carries the raw truncated text instead, as OpenRouter returns it: it fails JSON.parse
    // and is reported to the model, never run. Text that happens to parse loses its last
    // character so that the call can never run.
    const truncated =
      finishReason === "length" && content.at(-1)?.type === "tool_use"
        ? content.length - 1
        : -1;
    const toolCalls: ToolCall[] = content.flatMap((b, index) =>
      b.type === "tool_use"
        ? [
            {
              id: b.id,
              type: "function" as const,
              function: {
                name: b.name,
                arguments:
                  index === truncated
                    ? unparsable(rawInputs.get(index) ?? "")
                    : JSON.stringify(b.input ?? {}),
              },
            },
          ]
        : [],
    );
    // Each block's position among the visible blocks as stored (see AnthropicDirectReasoning).
    const textSlot = text.trim() ? 1 : 0;
    let textSeen = false;
    let toolsSeen = 0;
    const reasoning: AnthropicDirectReasoning[] = [];
    for (const b of content) {
      if (b.type === "text") textSeen = true;
      else if (b.type === "tool_use") toolsSeen++;
      else if (NATIVE.has(b.type))
        reasoning.push({
          type: TAG,
          format: FORMAT,
          block: JSON.parse(JSON.stringify(b)),
          position: (textSeen ? textSlot : 0) + toolsSeen,
        });
    }
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
      throw new ModelError("Invalid model tool calls", false, {
        ...ROUTE,
        usage,
      });
    // As the OpenRouter stream does: a response the Pi facade could not accept back as
    // history would fail every later request of the job (journal 170). Only Pi coding sets
    // the limit; Chief's own loop, agents and learners keep any number of calls.
    if (
      input.maxToolCalls !== undefined &&
      toolCalls.length > input.maxToolCalls
    )
      throw new ModelError(
        `The model requested more than ${input.maxToolCalls} tool calls in one response; no output was accepted.`,
        false,
        { ...diagnostics, failureCode: "malformed" },
      );
    // Remember the state each new thinking block followed (see ThinkingStates), for this
    // call's scope only.
    if (trailing && scope)
      for (const b of content)
        if (NATIVE.has(b.type))
          thinkingStates.remember(scope, b as unknown as Block, trailing);
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

  /** One streamed request; failures come back classified (see failure). */
  private async attempt(
    body: BetaMessageStreamParams,
    input: Parameters<ModelAdapter["generate"]>[0],
    maxOutputTokens: number,
  ): Promise<{ message: BetaMessage; rawInputs: Map<number, string> }> {
    let bytes = 0;
    // Each tool_use block's input exactly as streamed, by content index (see generate).
    const rawInputs = new Map<number, string>();
    // Complete-response (coding) calls bound the wire size as OpenRouter's stream reader does.
    const maxWireBytes = input.requireComplete
      ? Math.max(1600000, maxOutputTokens * 1024)
      : undefined;
    let oversized = false;
    // Model output only (content blocks), never pings: fallback safety depends on it.
    let emitted = false;
    let responseId: string | undefined;
    const progress = () =>
      input.onProgress?.({
        responseId: responseId?.slice(0, 160),
        provider: "Anthropic",
        bytes,
      });
    const transport = this.transport;
    const counting = (async (url: any, init?: RequestInit) => {
      const response = await transport(url, init);
      if (!response.body) return response;
      const live = response.ok && input.stream && !!input.onProgress;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (maxWireBytes !== undefined && bytes > maxWireBytes) {
            oversized = true;
            throw new Error("Model stream exceeded its wire allowance");
          }
          controller.enqueue(chunk);
          // Every received chunk is a sign of life: during omitted-display thinking the API
          // sends only pings, which the SDK drops, and a caller's idle timer must not fire.
          // A failing progress callback never fails the call from here.
          if (live)
            try {
              void Promise.resolve(progress()).catch(() => {});
            } catch {}
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
      ...(this.workspaceId
        ? { defaultHeaders: { "anthropic-workspace-id": this.workspaceId } }
        : {}),
      logLevel: "off", // The SDK can log raw stream chunks; never log content.
      openTelemetry: false, // Chief records its own model spans.
    });
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
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          )
            rawInputs.set(event.index, "");
          else if (
            event.type === "content_block_delta" &&
            event.delta.type === "input_json_delta"
          )
            rawInputs.set(
              event.index,
              (rawInputs.get(event.index) ?? "") + event.delta.partial_json,
            );
          if (input.stream) await progress();
        }
      }
      return { message: await stream.finalMessage(), rawInputs };
    } catch (error) {
      if (oversized && !input.signal.aborted)
        throw new ModelError("Model stream failed", false, {
          ...ROUTE,
          failureCode: "malformed",
        });
      throw this.failure(error, input.signal, emitted);
    }
  }

  /** OpenRouter-shaped usage, priced from the configured per-million rates. */
  private usage(message: BetaMessage) {
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
      const code = error.errorCode;
      // A bad key fails every model; a permission refusal may be this model's alone. A 400
      // (beta enrollment included) is "rejected"; a 413 stays unclassified, since OpenRouter
      // would meet the same size limits.
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
                    : status === 400 ||
                        type === "invalid_request_error" ||
                        code === NOT_ENROLLED
                      ? "rejected"
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
          // Enum values only, never provider message text.
          ...(typeof type === "string" && ERROR_TYPES.has(type)
            ? { errorType: type }
            : {}),
          ...(typeof code === "string" && ERROR_CODE.test(code)
            ? { errorCode: code }
            : {}),
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
