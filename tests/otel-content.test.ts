import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MESSAGES_CHARS,
  MAX_PART_CHARS,
  captureRequested,
  chatMessage,
  contentText,
  messagesJson,
} from "../src/otel-content.js";

test("content capture needs the standard variable set to true", () => {
  assert.equal(captureRequested({}), false);
  assert.equal(
    captureRequested({
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
    }),
    true,
  );
  assert.equal(
    captureRequested({
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "1",
    }),
    true,
  );
  assert.equal(
    captureRequested({
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "yes",
    }),
    false,
  );
});

test("provider messages become the conventions' parts, without images or credentials", () => {
  assert.deepEqual(
    chatMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: "what is in this photo? key sk-abcdefghijklmnop1234",
        },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,AAAA" },
        },
      ],
    }),
    {
      role: "user",
      parts: [
        {
          type: "text",
          content: "what is in this photo? key [REDACTED_CREDENTIAL]",
        },
        { type: "image", content: "[image omitted]" },
      ],
    },
  );
  assert.deepEqual(
    chatMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "web_search", arguments: '{"query":"rain"}' },
        },
      ],
    }),
    {
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          id: "c1",
          name: "web_search",
          arguments: { query: "rain" },
        },
      ],
    },
  );
  assert.deepEqual(
    chatMessage({ role: "tool", content: '{"ok":true}', tool_call_id: "c1" }),
    {
      role: "tool",
      parts: [
        { type: "tool_call_response", id: "c1", response: '{"ok":true}' },
      ],
    },
  );
});

test("long values are cut, and long histories keep their newest messages", () => {
  const long = contentText("x".repeat(MAX_PART_CHARS + 500));
  assert.ok(long.endsWith("[500 characters cut]"));
  // A credential at the cut is still scrubbed.
  const straddling = contentText(
    "y".repeat(MAX_PART_CHARS - 10) + " sk-abcdefghijklmnopqrstuvwxyz",
  );
  assert.ok(!straddling.includes("sk-abc"));
  const big = Array.from({ length: 20 }, (_, i) => ({
    role: "user",
    parts: [{ type: "text" as const, content: `${i}:` + "z".repeat(20_000) }],
  }));
  const kept = messagesJson(big);
  assert.equal(kept.truncated, true);
  assert.ok(kept.json.length <= MAX_MESSAGES_CHARS);
  const parsed = JSON.parse(kept.json) as { parts: { content: string }[] }[];
  assert.ok(parsed.at(-1)!.parts[0]!.content.startsWith("19:"));
  assert.equal(messagesJson(big.slice(0, 2)).truncated, false);
});
