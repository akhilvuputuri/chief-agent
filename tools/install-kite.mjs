#!/usr/bin/env node
// Installs the kite release pinned in tools/kite.json after checking
// its SHA-256. Needs only Node, so it works on a fresh machine, in CI and in
// Docker builds.
//
//   node tools/install-kite.mjs [--dir DIR] [--pin FILE]
//
// DIR defaults to ~/.local/bin. Prints the installed path.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) {
    console.error(`kite: ${name} needs a value`);
    process.exit(2);
  }
  return args[i + 1];
};
const MAX_BYTES = 64 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));
const pinPath = resolve(option("--pin", join(here, "kite.json")));
const dir = resolve(option("--dir", join(homedir(), ".local", "bin")));

const pin = JSON.parse(readFileSync(pinPath, "utf8"));
const platform = `${process.platform}-${process.arch}`;
const asset = pin.assets[platform];
if (!asset) {
  console.error(
    `kite ${pin.version} has no build for ${platform}; available: ${Object.keys(pin.assets).join(", ")}`,
  );
  process.exit(1);
}

const target = join(dir, "kite");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
if (existsSync(target) && sha256(readFileSync(target)) === asset.sha256) {
  console.log(target);
  process.exit(0);
}

let body;
for (let attempt = 1; ; attempt++) {
  try {
    const response = await fetch(asset.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") || 0) > MAX_BYTES)
      throw new Error("download is too large");
    body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error("download is too large");
    break;
  } catch (error) {
    if (attempt === 3) {
      console.error(`kite: downloading ${asset.url} failed: ${error.message}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}
const actual = sha256(body);
if (actual !== asset.sha256) {
  console.error(
    `kite: checksum mismatch for ${asset.url}\n  expected ${asset.sha256}\n  got      ${actual}`,
  );
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const tmp = `${target}.download-${process.pid}`;
writeFileSync(tmp, body);
chmodSync(tmp, 0o755);
renameSync(tmp, target);
console.log(target);
