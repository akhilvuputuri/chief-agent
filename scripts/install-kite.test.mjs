import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const installer = new URL("../tools/install-kite.mjs", import.meta.url)
  .pathname;
const binary = Buffer.from("#!/bin/sh\necho synthetic-kite\n");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function serve(t) {
  const server = createServer((_, res) => res.end(binary));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/kite`;
}

function pin(dir, url, hash) {
  const path = join(dir, "pin.json");
  const assets = {
    [`${process.platform}-${process.arch}`]: { url, sha256: hash },
  };
  writeFileSync(path, JSON.stringify({ version: "0.0.0-test", assets }));
  return path;
}

test("the installer installs a binary whose checksum matches the pin", async (t) => {
  const url = await serve(t);
  const dir = mkdtempSync(join(tmpdir(), "kite-install-"));
  const out = await run(process.execPath, [
    installer,
    "--pin",
    pin(dir, url, sha256(binary)),
    "--dir",
    join(dir, "bin"),
  ]);
  assert.equal(out.stdout.trim(), join(dir, "bin", "kite"));
  assert.deepEqual(readFileSync(join(dir, "bin", "kite")), binary);
});

test("the installer refuses a checksum mismatch and installs nothing", async (t) => {
  const url = await serve(t);
  const dir = mkdtempSync(join(tmpdir(), "kite-install-"));
  await assert.rejects(
    run(process.execPath, [
      installer,
      "--pin",
      pin(dir, url, "0".repeat(64)),
      "--dir",
      join(dir, "bin"),
    ]),
    /checksum mismatch/,
  );
  assert.equal(existsSync(join(dir, "bin", "kite")), false);
});

test("the installer requires a value for --dir", async () => {
  await assert.rejects(
    run(process.execPath, [installer, "--dir"]),
    /--dir needs a value/,
  );
});
