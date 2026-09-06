import test from "node:test";
import assert from "node:assert/strict";
import { formatTelegram } from "../src/telegram-format.js";
test("renders screenshot-style headings and emphasis without raw Markdown", () => {
  const [m] = formatTelegram(
    "### Summary\n\n- **Current Role:** TikTok\n- *In Progress:* PMO\n\n---\nNext question?",
  );
  assert.match(m!.text, /Summary\n\n• Current Role: TikTok/);
  assert.doesNotMatch(m!.text, /[#*]|---/);
  assert.equal(m!.entities.filter((e) => e.type === "bold").length, 2);
});
test("preserves code and literal HTML while rendering links", () => {
  const [m] = formatTelegram(
    '<script>x</script> & [Source](https://example.com)\n```ts\nconst x = "**literal**";\n```',
  );
  assert.match(m!.text, /<script>x<\/script>/);
  assert.match(m!.text, /\*\*literal\*\*/);
  assert.ok(m!.entities.some((e) => e.type === "pre"));
  assert.ok(m!.entities.some((e) => e.type === "text_link"));
});
test("chunks long formatted replies without losing text, splitting emoji or invalidating entities", () => {
  const input = "**" + "🙂 important ".repeat(1000) + "**";
  const chunks = formatTelegram(input, 128);
  assert.equal(
    chunks.map((c) => c.text).join(""),
    input.slice(2, -2).trimEnd(),
  );
  for (const c of chunks) {
    assert.ok(c.text.length <= 128);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(c.text));
    for (const e of c.entities) {
      assert.ok(
        e.offset >= 0 && e.length > 0 && e.offset + e.length <= c.text.length,
      );
    }
  }
});
test("preserves approval commands exactly", () => {
  const cmd = "/approve 12345678-1234-1234-1234-123456789abc";
  assert.equal(formatTelegram(cmd)[0]!.text, cmd);
});
