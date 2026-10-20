import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectCodingBackend } from "../src/coding/backend.js";
import { boxSettings, loadBoxesFile } from "../src/boxes/config.js";
import {
  BoxSandbox,
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
  const settings = selectCodingBackend(
    json("coding-backend.json"),
    json("coding.json"),
    json("coding-pi.json"),
  );
  const file = loadBoxesFile(new URL("../config/boxes.json", import.meta.url));
  const { config } = boxSettings(file, "123456789012");
  assert.deepEqual(file.ec2.coding?.taskCommand, CODING_TASK_COMMAND);
  const stranded = { query: async () => ({ rows: [] }) } as unknown as Database;
  const sandbox = await codingSandbox({
    db: stranded,
    settings,
    boxes: { config } as unknown as BoxController,
    taskCommand: file.ec2.coding?.taskCommand,
  });
  assert.ok(sandbox instanceof BoxSandbox);
});
