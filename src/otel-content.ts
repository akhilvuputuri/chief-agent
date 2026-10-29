// Message content for trace export (issue #323), off unless the owner opts in with
// OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true. When on, model spans carry their
// input and output messages, tool spans their arguments and results, and each turn's root
// span the owner's message and the final model output, in the GenAI conventions' message
// format. Credentials are scrubbed (the event journal's rules plus more token shapes and
// credential-named keys at any depth, also inside JSON text), images and long base64 data
// are replaced by placeholders, and every value is capped so a span stays small enough to
// send. Scrubbing is best effort: content such as a one-time code in an email is exported.

import type { ModelMessage } from "./model.js";
import { scrubTrace } from "./trace-scrub.js";

/** Largest serialized message list on one span; older messages are dropped first. */
export const MAX_MESSAGES_CHARS = 128_000;
/** Largest single text part, tool argument or tool result. */
export const MAX_PART_CHARS = 32_000;

type Part =
  | { type: "text"; content: string }
  | { type: "image"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_call_response"; id: string; response: string };
export type ChatMessage = {
  role: string;
  parts: Part[];
  finish_reason?: string;
};

/** Whether the standard variable asks for message content. */
export function captureRequested(env: NodeJS.ProcessEnv = process.env) {
  return /^(true|1)$/i.test(
    env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?.trim() ?? "",
  );
}

// Token shapes the journal's rules do not cover: Google OAuth access tokens and API keys,
// AWS access key IDs, Slack tokens.
const MORE_TOKENS =
  /\b(?:ya29\.[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,})\b/g;
// Inline files and other long base64 runs: never useful in a trace, and often an image.
const DATA_URL = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const BASE64_RUN = /[A-Za-z0-9+/]{2000,}={0,2}/g;
const CREDENTIAL_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|passcode|passwd|secret|client_secret|api[-_]?key|x-api-key|(access|refresh|id|session|auth|bearer)[-_]?token|token)$/i;

function scrubText(text: string) {
  return (scrubTrace(text) as string)
    .replace(MORE_TOKENS, "[REDACTED_CREDENTIAL]")
    .replace(DATA_URL, "[data omitted]")
    .replace(BASE64_RUN, "[base64 omitted]");
}

/** Credentials and inline data removed at any depth, including credential-named keys. */
export function scrubContent(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubContent);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        CREDENTIAL_KEY.test(key) ? "[REDACTED_CREDENTIAL]" : scrubContent(v),
      ]),
    );
  return value;
}

/** JSON text parsed, so its keys are scrubbed too; any other text as it is. */
export function parsed(text: string): unknown {
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[") return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Scrubbed and capped text. Objects, and JSON text, are scrubbed by key and value before
 * they are serialized; the result is cut to `max` characters, counting what was cut.
 */
export function contentText(value: unknown, max = MAX_PART_CHARS) {
  const source = typeof value === "string" ? parsed(value) : value;
  const scrubbed = scrubContent(source);
  const text =
    typeof scrubbed === "string" ? scrubbed : (JSON.stringify(scrubbed) ?? "");
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [${text.length - max} characters cut]`;
}

/** Tool-call arguments as the model sent them: the object, when it sent JSON text. */
export function toolArguments(args: unknown) {
  const raw =
    args && typeof args === "object" && "raw" in args
      ? (args as { raw: unknown }).raw
      : args;
  return contentText(raw);
}

/** One provider message in the conventions' shape: a role and typed parts. */
export function chatMessage(
  message: ModelMessage,
  finishReason?: string,
): ChatMessage {
  const parts: Part[] = [];
  if (message.role === "tool")
    return {
      role: "tool",
      parts: [
        {
          type: "tool_call_response",
          id: message.tool_call_id ?? "",
          response: contentText(message.content ?? ""),
        },
      ],
    };
  if (typeof message.content === "string" && message.content)
    parts.push({ type: "text", content: contentText(message.content) });
  else if (Array.isArray(message.content))
    for (const part of message.content)
      parts.push(
        part.type === "text"
          ? { type: "text", content: contentText(part.text) }
          : { type: "image", content: "[image omitted]" },
      );
  for (const call of message.tool_calls ?? [])
    parts.push({
      type: "tool_call",
      id: call.id,
      name: call.function.name,
      arguments: parsed(contentText(call.function.arguments)),
    });
  return {
    role: message.role,
    parts,
    ...(finishReason ? { finish_reason: finishReason } : {}),
  };
}

/** A message whose parts share about `budget` characters between them. */
function shrink(message: ChatMessage, budget: number): ChatMessage {
  const each = Math.max(
    200,
    Math.floor(budget / 2 / Math.max(1, message.parts.length)),
  );
  const cut = (text: string) =>
    text.length > each
      ? `${text.slice(0, each)}… [${text.length - each} characters cut]`
      : text;
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === "text" || part.type === "image"
        ? { ...part, content: cut(part.content) }
        : part.type === "tool_call_response"
          ? { ...part, response: cut(part.response) }
          : { ...part, arguments: cut(JSON.stringify(part.arguments) ?? "") },
    ),
  };
}

/**
 * A message list as one JSON attribute value, newest messages kept when it is too long; the
 * newest is always kept, cut to fit on its own. Returns the text and whether anything was cut.
 */
export function messagesJson(messages: ChatMessage[]) {
  const kept: string[] = [];
  let size = 2;
  let cut = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    let one = JSON.stringify(messages[i]);
    if (kept.length && size + one.length + 1 > MAX_MESSAGES_CHARS) break;
    if (!kept.length && one.length > MAX_MESSAGES_CHARS) {
      one = JSON.stringify(shrink(messages[i]!, MAX_MESSAGES_CHARS));
      cut = true;
    }
    kept.unshift(one);
    size += one.length + 1;
  }
  return {
    json: `[${kept.join(",")}]`,
    truncated: cut || kept.length < messages.length,
  };
}

/** The owner's message as an input message list. */
export function userMessageJson(text: string) {
  return messagesJson([
    { role: "user", parts: [{ type: "text", content: contentText(text) }] },
  ]).json;
}
