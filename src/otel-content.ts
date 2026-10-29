// Message content for trace export (issue #323), off unless the owner opts in with
// OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true. When on, model spans carry their
// input and output messages, tool spans their arguments and results, and each turn's root
// span the owner's message and the final model output, in the GenAI conventions' message
// format. Credentials are scrubbed with the event journal's rules, images are replaced by a
// placeholder, and every value is capped so a span stays small enough to send.

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
export type ChatMessage = { role: string; parts: Part[] };

/** Whether the standard variable asks for message content. */
export function captureRequested(env: NodeJS.ProcessEnv = process.env) {
  return /^(true|1)$/i.test(
    env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?.trim() ?? "",
  );
}

/** Scrubbed and capped text; cut before scrubbing, so a huge value costs no more than a cap. */
export function contentText(value: unknown, max = MAX_PART_CHARS) {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  if (text.length <= max) return scrubTrace(text) as string;
  // A credential straddling the cut loses its tail, which the pattern may then miss; keep a
  // margin and scrub before the final cut.
  const scrubbed = scrubTrace(text.slice(0, max + 256)) as string;
  return `${scrubbed.slice(0, max)}… [${text.length - max} characters cut]`;
}

function parsed(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** One provider message in the conventions' shape: a role and typed parts. */
export function chatMessage(message: ModelMessage): ChatMessage {
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
  return { role: message.role, parts };
}

/**
 * A message list as one JSON attribute value, newest messages kept when it is too long.
 * Returns the text and whether older messages were dropped.
 */
export function messagesJson(messages: ChatMessage[]) {
  const kept: string[] = [];
  let size = 2;
  for (let i = messages.length - 1; i >= 0; i--) {
    const one = JSON.stringify(messages[i]);
    if (kept.length && size + one.length + 1 > MAX_MESSAGES_CHARS) break;
    kept.unshift(one);
    size += one.length + 1;
  }
  return {
    json: `[${kept.join(",")}]`,
    truncated: kept.length < messages.length,
  };
}

/** The owner's message as an input message list. */
export function userMessageJson(text: string) {
  return messagesJson([
    { role: "user", parts: [{ type: "text", content: contentText(text) }] },
  ]).json;
}
