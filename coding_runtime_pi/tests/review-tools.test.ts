import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools } from "../src/tools.js";
import { resources } from "../src/resources.js";
import { Workspace, localExecutor } from "../src/workspace.js";

test("the reviewer has a shell in its copy but no edit or write; the coder has both", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-tools-"));
  const workspace = await new Workspace(root).initialize();
  const execute = localExecutor(root, join(root, "home"), () => {});
  const names = (role: "coder" | "reviewer") =>
    tools(workspace, role, execute, () => {}).map((t) => t.name);
  assert.deepEqual(names("reviewer").sort(), [
    "bash",
    "find",
    "grep",
    "ls",
    "read",
    "report",
  ]);
  assert.deepEqual(names("coder").sort(), [
    "bash",
    "edit",
    "find",
    "grep",
    "ls",
    "read",
    "report",
    "write",
  ]);
  assert.throws(() => tools(workspace, "reviewer", undefined, () => {}));
});

test("the only extension handler saves at turn ends, so compaction and prompts run as Pi ships", () => {
  assert.deepEqual(resources("Role text").getExtensions().extensions, []);
  const loader = resources("Role text", [], async () => {});
  const [extension, ...others] = loader.getExtensions().extensions;
  assert.deepEqual(others, []);
  assert.deepEqual([...extension!.handlers.keys()], ["turn_end"]);
  assert.deepEqual(loader.getAppendSystemPrompt(), ["Role text"]);
  assert.equal(loader.getSystemPrompt(), undefined);
});
