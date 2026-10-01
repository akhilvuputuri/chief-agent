import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RUNTIME_SETTINGS,
  readConfig,
  readRuntimeSettings,
} from "../src/config.js";
import { sanitize } from "../src/ops-log.js";

const required = {
  DATABASE_URL: "postgres://x:x@localhost/x",
  TELEGRAM_BOT_TOKEN: "123:long-test-token",
  TELEGRAM_ALLOWED_USER_IDS: "123",
};

function file(content: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-config-"));
  const path = join(dir, "runtime.json");
  writeFileSync(path, JSON.stringify(content));
  return {
    url: pathToFileURL(path),
    done: () => rmSync(dir, { recursive: true }),
  };
}

test("the committed runtime config is valid and matches the code defaults", () => {
  const settings = readRuntimeSettings();
  // Every behaviour setting is listed, so the file is the full record.
  assert.deepEqual(Object.keys(settings).sort(), [...RUNTIME_SETTINGS].sort());
  const withFile = readConfig(required);
  const codeDefaults = readConfig(required, {});
  for (const key of RUNTIME_SETTINGS)
    assert.equal(withFile[key], codeDefaults[key], key);
  assert.deepEqual(withFile.overridden, []);
});

test("file values apply, the environment still wins, and overrides are listed by name", () => {
  const runtime = {
    MEDIA_MODEL: "google/gemini-3.8-flash",
    VOICE_REPLIES: "true",
    AGENT_BUDGET_MS: "600000",
    TOOL_PICKER: "jev",
  };
  const c = readConfig(
    { ...required, VOICE_REPLIES: "false", TOOL_PICKER: "jev" },
    runtime,
  );
  assert.equal(c.MEDIA_MODEL, "google/gemini-3.8-flash");
  assert.equal(c.AGENT_BUDGET_MS, 600000);
  assert.equal(c.VOICE_REPLIES, "false");
  // An environment value equal to the file is not an override.
  assert.deepEqual(c.overridden, ["VOICE_REPLIES"]);
  // Numbers compare after parsing: "600000" and 600000 are the same setting.
  assert.deepEqual(
    readConfig({ ...required, AGENT_BUDGET_MS: "600000" }, runtime).overridden,
    [],
  );
});

test("the runtime file refuses secrets, identifiers, unknown names and bad values", () => {
  for (const settings of [
    { TELEGRAM_BOT_TOKEN: "123:secret" },
    { OPENROUTER_API_KEY: "sk-or-x" },
    { TELEGRAM_ALLOWED_USER_IDS: "123" },
    { GMAIL_EMAIL: "someone@example.com" },
    { MADE_UP: "x" },
    { MEDIA_MODEL: true },
  ]) {
    const f = file({ schemaVersion: 1, settings });
    try {
      assert.throws(() => readRuntimeSettings(f.url), JSON.stringify(settings));
    } finally {
      f.done();
    }
  }
  const wrongVersion = file({ schemaVersion: 2, settings: {} });
  try {
    assert.throws(() => readRuntimeSettings(wrongVersion.url));
  } finally {
    wrongVersion.done();
  }
  // A well-formed file with an invalid value fails when the config is read.
  assert.throws(() => readConfig(required, { TOOL_PICKER: "maybe" }));
});

test("the startup log carries setting names only", () => {
  const entry = sanitize("config.loaded", "info", {
    envSettings: ["VOICE_REPLIES", "sk-or-secret value", "MEDIA_MODEL"],
  })!;
  assert.deepEqual(entry.envSettings, ["VOICE_REPLIES", "MEDIA_MODEL"]);
  assert.equal(entry.dropped, 1);
});
