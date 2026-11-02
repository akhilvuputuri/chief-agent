#!/usr/bin/env node
// Installs the agent-browser release pinned in tools/agent-browser.json after checking its
// SHA-256. Used only by the public-browser Docker build.
//
//   node install-agent-browser.mjs PIN_FILE DESTINATION
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const [pinFile, destination] = process.argv.slice(2);
if (!pinFile || !destination) {
  console.error("Usage: install-agent-browser.mjs PIN_FILE DESTINATION");
  process.exit(2);
}
const pin = JSON.parse(readFileSync(pinFile, "utf8"));
const asset = pin.assets[`${process.platform}-${process.arch}`];
if (!asset) {
  console.error(
    `agent-browser: no pin for ${process.platform}-${process.arch}`,
  );
  process.exit(1);
}
const response = await fetch(asset.url);
if (!response.ok) {
  console.error(`agent-browser: download failed with ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
const actual = createHash("sha256").update(bytes).digest("hex");
if (actual !== asset.sha256) {
  console.error(`agent-browser: checksum mismatch, got ${actual}`);
  process.exit(1);
}
writeFileSync(destination, bytes);
chmodSync(destination, 0o755);
