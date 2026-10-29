import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MESSAGES_CHARS,
  MAX_PART_CHARS,
  captureRequested,
  chatMessage,
  contentText,
  messagesJson,
  toolArguments,
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
  const long = contentText("word ".repeat(MAX_PART_CHARS / 5 + 100));
  assert.ok(long.endsWith("[500 characters cut]"));
  // Scrubbed before the cut, so a credential at the cut is still scrubbed.
  const straddling = contentText(
    "word ".repeat((MAX_PART_CHARS - 10) / 5) +
      " sk-abcdefghijklmnopqrstuvwxyz",
  );
  assert.ok(!straddling.includes("sk-abc"));
  const big = Array.from({ length: 20 }, (_, i) => ({
    role: "user",
    parts: [{ type: "text" as const, content: `${i}:` + "zz ".repeat(7_000) }],
  }));
  const kept = messagesJson(big);
  assert.equal(kept.truncated, true);
  assert.ok(kept.json.length <= MAX_MESSAGES_CHARS);
  const parsed = JSON.parse(kept.json) as { parts: { content: string }[] }[];
  assert.ok(parsed.at(-1)!.parts[0]!.content.startsWith("19:"));
  assert.equal(messagesJson(big.slice(0, 2)).truncated, false);
});

test("credentials under credential-named keys and in more token shapes are scrubbed", () => {
  const out = contentText({
    access_token: "ya29.a0AfH6SMBexampleexampleexample",
    nested: { password: "hunter2hunter2", note: "key AKIAABCDEFGHIJKLMNOP" },
    list: [{ refresh_token: "abcdefghijklmnop" }],
  });
  for (const secret of ["ya29.", "hunter2", "AKIAABCD", "abcdefghijklmnop"])
    assert.ok(!out.includes(secret), secret);
  // JSON text is parsed so its keys are scrubbed too.
  assert.ok(
    !contentText('{"api_key":"plain-value-123"}').includes("plain-value"),
  );
  assert.equal(contentText("AIza" + "A".repeat(35)), "[REDACTED_CREDENTIAL]");
});

test("inline files and long base64 never leave", () => {
  const image = "data:image/png;base64," + "iVBORw0KGgo".repeat(50);
  assert.equal(contentText(`see ${image} here`), "see [data omitted] here");
  assert.equal(
    contentText({ data: "QUJD".repeat(1_000) }),
    '{"data":"[base64 omitted]"}',
  );
});

test("tool arguments are the object the model sent, and one huge message is cut to fit", () => {
  assert.equal(
    toolArguments({ raw: '{"query":"hi \\"x\\""}' }),
    '{"query":"hi \\"x\\""}',
  );
  const huge = {
    role: "assistant",
    parts: Array.from({ length: 40 }, (_, i) => ({
      type: "tool_call_response" as const,
      id: String(i),
      response: "r ".repeat(16_000),
    })),
  };
  const kept = messagesJson([huge]);
  assert.ok(kept.json.length <= MAX_MESSAGES_CHARS);
  assert.equal(kept.truncated, true);
});
