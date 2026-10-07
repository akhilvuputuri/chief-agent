import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { formatTelegram } = await import(pathToFileURL(process.argv[2]));
const [id, group] = process.argv.slice(3);
if (group === "regression") {
  assert.deepEqual(formatTelegram("**Hello** world")[0], {
    text: "Hello world",
    entities: [{ type: "bold", offset: 0, length: 5 }],
  });
  assert.equal(formatTelegram("<b>literal</b>")[0].text, "<b>literal</b>");
  assert.throws(() => formatTelegram("x", 31));
  const link = formatTelegram("[docs](https://example.com)")[0];
  assert.equal(link.entities[0].url, "https://example.com");
  assert.equal(formatTelegram("a\r\nb")[0].text, "a\nb");
} else if (id === "chief-format-surrogate") {
  for (const prefix of [31, 63, 95]) {
    const text = "a".repeat(prefix) + "😀" + "z".repeat(67);
    const chunks = formatTelegram(text, 32);
    assert.equal(chunks.map((x) => x.text).join(""), text);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 32);
      assert.ok(chunk.text.isWellFormed());
    }
  }
} else {
  for (const input of [
    "**" + "x".repeat(100) + "**",
    "abc **" + "y".repeat(99) + "**",
  ]) {
    const chunks = formatTelegram(input, 32);
    assert.equal(
      chunks.map((x) => x.text).join(""),
      input.replaceAll("**", ""),
    );
    assert.equal(
      chunks.reduce(
        (n, c) => n + c.entities.reduce((s, e) => s + e.length, 0),
        0,
      ),
      input.startsWith("abc") ? 99 : 100,
    );
    for (const c of chunks)
      for (const e of c.entities) {
        assert.ok(
          e.offset >= 0 && e.length > 0 && e.offset + e.length <= c.text.length,
        );
      }
  }
}

// Reaching every assertion is required; candidate exit(0) is not success.
process.exitCode = 42;
