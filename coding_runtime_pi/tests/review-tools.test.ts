import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools } from "../src/tools.js";
import { Workspace, localExecutor } from "../src/workspace.js";

test("only build and a candidate review with an executor get a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-tools-"));
  const workspace = await new Workspace(root).initialize();
  const execute = localExecutor(root, join(root, "home"), () => {});
  const names = (intent: any, withShell: boolean) =>
    tools(
      workspace,
      intent,
      withShell ? execute : undefined,
      () => {},
      async () => {},
    ).map((t) => t.name);
  assert(names("review", true).includes("bash"));
  assert(!names("review", false).includes("bash"));
  assert(!names("review", true).includes("edit"));
  assert(!names("review", true).includes("write"));
  assert(!names("plan", true).includes("bash"));
  assert(!names("learn", true).includes("bash"));
  assert(names("build", true).includes("bash"));
});
