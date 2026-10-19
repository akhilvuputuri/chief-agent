import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codingBackend, selectCodingBackend } from "../src/coding/backend.js";
import { boxSettings, loadBoxesFile } from "../src/boxes/config.js";
import {
  CODING_TASK_COMMAND,
  codingSandbox,
} from "../src/coding/box-sandbox.js";
import type { BoxController } from "../src/boxes/controller.js";
import type { Database } from "../src/db.js";

const json = (path: string) =>
  JSON.parse(
    readFileSync(new URL(`../config/${path}`, import.meta.url), "utf8"),
  );

// The reviewed configuration must pass the gateway's own startup checks, so a mismatch
// fails here rather than stopping production at release.
test("the reviewed coding and box configuration passes the coding sandbox startup checks", async () => {
  const backend = json("coding-backend.json");
  const settings = selectCodingBackend(
    backend,
    json("coding.json"),
    json("coding-pi.json"),
  );
  const file = loadBoxesFile(new URL("../config/boxes.json", import.meta.url));
  const { config } = boxSettings(file, "123456789012");
  const coding = file.ec2.coding;
  if (config.profiles.coding)
    assert.deepEqual(coding?.taskCommand, CODING_TASK_COMMAND);
  const provider = await codingSandbox({
    db: {} as Database,
    codebuild: {
      create: async () => "build",
      find: async () => undefined,
      inspect: async () => "terminal",
      terminate: async () => {},
    },
    sandbox: codingBackend.parse(backend).sandbox,
    settings,
    boxes: config.profiles.coding
      ? ({ config } as unknown as BoxController)
      : undefined,
    taskCommand: coding?.taskCommand,
  }).catch((error) => {
    // Without a coding profile the check reads the database; that only matters live.
    if (config.profiles.coding) throw error;
    return undefined;
  });
  if (codingBackend.parse(backend).sandbox === "box") assert.ok(provider);
});
