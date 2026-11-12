import Anthropic from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AnthropicPrices } from "../anthropic.js";
import type { CodingFailureCode } from "./model-failure.js";

/**
 * How a Pi coding job reaches Claude: the worker runs Pi's own Anthropic Messages client against
 * the host, and the host sends each request on with its key and relays Anthropic's stream
 * back unchanged (journal 190).
 */
export type CodingAnthropic = {
  /** The direct route for a job's model, or undefined when the model has none. */
  route(
    model: string,
  ): { nativeModel: string; prices: AnthropicPrices } | undefined;
  /** Sends the request with the beta features and API version Pi's client named. */
  send(
    body: Record<string, unknown>,
    wire: { betas: string[]; version?: string },
    signal: AbortSignal,
  ): Promise<Response>;
};

/** What the worker gets back: Anthropic's own stream, or an error in Anthropic's shape. */
export type MessagesReply = {
  status: number;
  headers: Record<string, string>;
  body: string | ReadableStream<Uint8Array>;
};

/**
 * An error in the shape Pi's Anthropic client reads. A host refusal (400) is final; a failed
 * connection to Anthropic (502) is left to Pi's own retry policy.
 */
export function refusal(message: string, status = 400): MessagesReply {
  return {
    status,
    headers: {
      "content-type": "application/json",
      ...(status === 400 ? { "x-should-retry": "false" } : {}),
    },
    body: JSON.stringify({
      type: "error",
      error: {
        type: status === 400 ? "invalid_request_error" : "api_error",
        message,
      },
    }),
  };
}

/** Anthropic's own error reply, with the headers Pi's retry policy reads. */
export function relayedError(error: InstanceType<typeof Anthropic.APIError>) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  for (const name of [
    "retry-after",
    "retry-after-ms",
    "x-should-retry",
    "request-id",
  ]) {
    const value = error.headers?.get(name);
    if (value) headers[name] = value;
  }
  return {
    status: error.status!,
    headers,
    body: JSON.stringify(
      error.error ?? {
        type: "error",
        error: { type: "api_error", message: "Model request failed" },
      },
    ),
  } satisfies MessagesReply;
}

/** A host refusal with a fixed reason code for the job record; the message may name a field. */
export class MessagesRefusal extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

/**
 * The top-level fields Pi's Anthropic client sends for Claude Opus 5.5 and Sonnet 5.5
 * (pi-ai 1.1.0, `dist/api/anthropic-messages.js`, `buildParams`): model, messages, max_tokens,
 * stream, system, tools, thinking, output_config, and metadata or tool_choice only when its
 * caller sets them. `betas` is not a body field there: the SDK sends it as the anthropic-beta
 * header. `temperature` and `fallbacks` are never sent for these models. The box is untrusted,
 * so anything else is refused: some fields (workspace_id, user_profile_id, betas) would be
 * lifted into headers by the SDK, and others turn on paid or server-side features.
 */
const BODY_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "stream",
  "system",
  "tools",
  "thinking",
  "output_config",
  "metadata",
  "tool_choice",
]);
/** Pi's output_config carries only the effort (top level and per-turn markers). */
const OUTPUT_CONFIG_FIELDS = new Set(["effort"]);
/**
 * The beta features Pi's client names for these models (`getBetaFeatures`): the mid-conversation
 * effort and thinking-binding pair for models with per-message effort, and inline tool changes
 * when tools change mid-conversation.
 */
export const PI_BETAS = new Set([
  "mid-conversation-output-config-2026-07-01",
  "thinking-binding-controls-2026-08-01",
  "inline-tools-2026-09-15",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A tool Pi defines and runs itself; server tools (web, code execution, MCP, computer) are refused. */
/**
 * The fields of a tool Pi defines (`convertTools`, and its deferred placeholder
 * `DEFERRED_TOOL_PLACEHOLDER`, which carries `defer_loading`). Pi sends no `type`, so a typed
 * tool is a server tool (web search or fetch, code execution, MCP, computer use) and is refused.
 */
const TOOL_FIELDS = new Set([
  "name",
  "description",
  "input_schema",
  "eager_input_streaming",
  "strict",
  "cache_control",
  "defer_loading",
]);
function assertClientTool(tool: unknown) {
  if (!isObject(tool) || tool.type !== undefined)
    throw new MessagesRefusal(
      `Messages request includes a server tool${isObject(tool) && typeof tool.type === "string" ? ` (${tool.type.slice(0, 60)})` : ""}; only Pi's own tools are allowed`,
      "server_tool_refused",
    );
  for (const key of Object.keys(tool))
    if (!TOOL_FIELDS.has(key))
      throw new MessagesRefusal(
        `Messages request tool field not allowed: ${key.slice(0, 60)}`,
        "tool_field_refused",
      );
}

/**
 * The content blocks Pi's client builds (`convertMessages` and `convertContentBlocks` in
 * pi-ai 1.1.0 `dist/api/anthropic-messages.js`): user turns hold text, base64 images and
 * tool results (whose content is a string or text and base64 image blocks); assistant turns
 * hold text, thinking, redacted thinking and tool calls; mid-conversation system messages hold
 * text and native tool changes. The box is untrusted, and a block with a URL or file source,
 * a server-tool block or a container upload would let it make Anthropic fetch or run something,
 * so any other block or source is refused.
 */
const BLOCKS: Record<string, Set<string>> = {
  user: new Set(["text", "image", "tool_result"]),
  assistant: new Set(["text", "thinking", "redacted_thinking", "tool_use"]),
  system: new Set(["text", "tool_addition", "tool_removal"]),
};
const MESSAGE_FIELDS: Record<string, Set<string>> = {
  user: new Set(["role", "content"]),
  assistant: new Set(["role", "content"]),
  // Pi's per-turn effort markers carry output_config.
  system: new Set(["role", "content", "output_config"]),
};

function refuseBlock(type: unknown, where: string): never {
  throw new MessagesRefusal(
    `Messages request content not allowed: ${typeof type === "string" ? type.slice(0, 60) : "unknown"} block in ${where}`,
    "content_block_refused",
  );
}

/** A Pi image: inline base64 only, never a URL or file the API would fetch. */
function assertImage(block: Record<string, unknown>, where: string) {
  if (!isObject(block.source) || block.source.type !== "base64")
    throw new MessagesRefusal(
      `Messages request content not allowed: image source ${isObject(block.source) && typeof block.source.type === "string" ? block.source.type.slice(0, 40) : "unknown"} in ${where}`,
      "content_source_refused",
    );
}

function assertBlock(block: unknown, role: string, where: string) {
  if (!isObject(block) || !BLOCKS[role]!.has(String(block.type)))
    refuseBlock(isObject(block) ? block.type : undefined, where);
  if (block.type === "image") assertImage(block, where);
  else if (block.type === "tool_result") {
    // Pi's tool results hold a string or text and base64 image blocks.
    if (Array.isArray(block.content))
      for (const inner of block.content) {
        if (
          !isObject(inner) ||
          (inner.type !== "text" && inner.type !== "image")
        )
          refuseBlock(
            isObject(inner) ? inner.type : undefined,
            `${where} tool_result`,
          );
        if (inner.type === "image") assertImage(inner, `${where} tool_result`);
      }
    else if (block.content !== undefined && typeof block.content !== "string")
      refuseBlock("tool_result content", where);
  } else if (block.type === "tool_addition") {
    if (!isObject(block.tool) || block.tool.type !== "tool_definition")
      refuseBlock("tool_addition", where);
    // Tools added mid-conversation are definitions too, so they get the same check.
    assertClientTool(block.tool.definition);
  } else if (block.type === "tool_removal") {
    if (!isObject(block.tool) || block.tool.type !== "tool_reference")
      refuseBlock("tool_removal", where);
  }
}

function assertOutputConfig(config: unknown, effort: string, where: string) {
  if (!isObject(config))
    throw new MessagesRefusal(
      "Invalid Messages request",
      "messages_request_invalid",
    );
  for (const key of Object.keys(config))
    if (!OUTPUT_CONFIG_FIELDS.has(key))
      throw new MessagesRefusal(
        `Messages request field not allowed: ${where}.${key.slice(0, 60)}`,
        "messages_field_refused",
      );
  if (where !== "output_config" && config.effort !== effort)
    throw new MessagesRefusal(
      "Model effort differs from the job's effort",
      "effort_not_pinned",
    );
}

/**
 * The only changes the host makes to a request: the job decides the effort and caps the output.
 * The box may send only the fields Pi sends, only Pi's own tools and only an automatic tool
 * choice. The content of messages, system prompt, tools and thinking goes to Anthropic as Pi
 * built it.
 */
export function messagesRequest(
  raw: unknown,
  pinned: { model: string; effort: string; maxTokens: number },
): Record<string, unknown> {
  if (!isObject(raw) || !Array.isArray(raw.messages))
    throw new MessagesRefusal(
      "Invalid Messages request",
      "messages_request_invalid",
    );
  const body = raw as Record<string, unknown> & { messages: unknown[] };
  for (const key of Object.keys(body))
    if (!BODY_FIELDS.has(key))
      throw new MessagesRefusal(
        `Messages request field not allowed: ${key.slice(0, 60)}`,
        "messages_field_refused",
      );
  if (body.model !== pinned.model)
    throw new MessagesRefusal(
      "Model is not the job's pinned role selection",
      "model_not_pinned",
    );
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools))
      throw new MessagesRefusal(
        "Invalid Messages request",
        "messages_request_invalid",
      );
    body.tools.forEach(assertClientTool);
  }
  if (
    body.tool_choice !== undefined &&
    !(
      isObject(body.tool_choice) &&
      body.tool_choice.type === "auto" &&
      Object.keys(body.tool_choice).length === 1
    )
  )
    throw new MessagesRefusal(
      "Messages request tool_choice must be automatic",
      "tool_choice_refused",
    );
  if (
    body.metadata !== undefined &&
    !(
      isObject(body.metadata) &&
      Object.keys(body.metadata).every((key) => key === "user_id")
    )
  )
    throw new MessagesRefusal(
      "Messages request field not allowed: metadata",
      "messages_field_refused",
    );
  if (body.output_config !== undefined)
    assertOutputConfig(body.output_config, pinned.effort, "output_config");
  if (body.system !== undefined && typeof body.system !== "string") {
    if (!Array.isArray(body.system))
      throw new MessagesRefusal(
        "Invalid Messages request",
        "messages_request_invalid",
      );
    for (const block of body.system)
      if (!isObject(block) || block.type !== "text")
        refuseBlock(isObject(block) ? block.type : undefined, "system");
  }
  for (const message of body.messages) {
    if (!isObject(message) || !MESSAGE_FIELDS[String(message.role)])
      throw new MessagesRefusal(
        "Invalid Messages request",
        "messages_request_invalid",
      );
    const role = String(message.role);
    for (const key of Object.keys(message))
      if (!MESSAGE_FIELDS[role]!.has(key))
        throw new MessagesRefusal(
          `Messages request field not allowed: messages[].${key.slice(0, 60)}`,
          "messages_field_refused",
        );
    // Pi's per-turn effort markers are system messages carrying output_config.
    if (message.output_config !== undefined)
      assertOutputConfig(
        message.output_config,
        pinned.effort,
        "messages[].output_config",
      );
    if (Array.isArray(message.content))
      for (const block of message.content)
        assertBlock(block, role, `${role} message`);
    else if (typeof message.content !== "string")
      throw new MessagesRefusal(
        "Invalid Messages request",
        "messages_request_invalid",
      );
  }
  const requested = body.max_tokens;
  if (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    requested < 1
  )
    throw new MessagesRefusal(
      "Invalid Messages request",
      "messages_request_invalid",
    );
  return {
    ...body,
    max_tokens: Math.min(requested, pinned.maxTokens),
    // Pi hard-codes "high" here; the per-turn markers carry its session effort. Setting the top
    // level makes a request without markers run at the job's effort too.
    output_config: { effort: pinned.effort },
  };
}

/** The beta features Pi's client named; any other value is refused (see PI_BETAS). */
export function piBetas(header: string | string[] | undefined) {
  const betas = betaList(header);
  for (const beta of betas)
    if (!PI_BETAS.has(beta))
      throw new MessagesRefusal(
        `Beta feature not allowed: ${beta.slice(0, 80)}`,
        "beta_refused",
      );
  return betas;
}

export function betaList(header: string | string[] | undefined) {
  return [
    ...new Set(
      (Array.isArray(header) ? header.join(",") : (header ?? ""))
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
    ),
  ];
}

/** The failure code a refused or failed upstream call records, as the earlier route did. */
export function upstreamFailureCode(
  status: number | undefined,
  type: string | null | undefined,
): CodingFailureCode {
  if (status === 429 || type === "rate_limit_error")
    return "model_rate_limited";
  if (
    (status !== undefined && status >= 500) ||
    type === "overloaded_error" ||
    type === "api_error"
  )
    return "model_transient_failure";
  return "model_provider_failed";
}

/**
 * Reads the host's copy of a relayed stream into the message Anthropic returned, using the SDK's
 * own accumulator. `complete` is false when the stream ended before message_stop.
 */
export async function assembleStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: BetaRawMessageStreamEvent) => void,
): Promise<{
  message?: BetaMessage;
  complete: boolean;
  error?: unknown;
}> {
  const sse = Stream.fromSSEResponse<BetaRawMessageStreamEvent>(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    new AbortController(),
  );
  const stream = BetaMessageStream.fromReadableStream(sse.toReadableStream());
  let stopped = false;
  stream.on("streamEvent", (event) => {
    if (event.type === "message_stop") stopped = true;
    onEvent(event as BetaRawMessageStreamEvent);
  });
  // The accumulator reports failures through finalMessage as well; never let them go unhandled.
  stream.on("error", () => {});
  try {
    const message = await stream.finalMessage();
    return { message, complete: stopped };
  } catch (error) {
    return { message: stream.currentMessage, complete: false, error };
  }
}
