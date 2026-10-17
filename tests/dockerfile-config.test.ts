import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

// The production image copies config files one by one. A config file that src reads but
// the image lacks stops the gateway at startup, which local tests and CI cannot see.
test("every config file the gateway reads is copied into the image", async () => {
  const dockerfile = await readFile(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  const copied = new Set(
    dockerfile
      .split("\n")
      .filter((l) => /^COPY\b/.test(l))
      .flatMap((l) => [...l.matchAll(/config\/([a-z0-9-]+\.json)/g)])
      .map((m) => m[1]!),
  );
  const src = new URL("../src/", import.meta.url);
  const read = new Set<string>();
  for (const entry of await readdir(src, { recursive: true }))
    if (String(entry).endsWith(".ts"))
      for (const m of (
        await readFile(new URL(String(entry), src), "utf8")
      ).matchAll(/new URL\(\s*"\.\.\/(?:\.\.\/)?config\/([a-z0-9-]+\.json)"/g))
        read.add(m[1]!);
  assert(read.size >= 5, `found ${[...read]}`);
  assert.deepEqual(
    [...read].filter((f) => !copied.has(f)).sort(),
    [],
    "missing from the Dockerfile COPY lines",
  );
});
