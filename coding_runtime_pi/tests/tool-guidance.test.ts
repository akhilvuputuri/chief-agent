import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools, toolGuidance } from "../src/tools.js";
import { Workspace, localExecutor } from "../src/workspace.js";

const word = (name: string) => new RegExp(`\\b${name}\\b`);

test("tool guidance names only the tools each intent is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-guidance-"));
  const workspace = await new Workspace(root).initialize();
  const execute = localExecutor(root, join(root, "home"), () => {});
  const guidance = (intent: any, withShell: boolean) =>
    toolGuidance(
      tools(
        workspace,
        intent,
        withShell ? execute : undefined,
        () => {},
        async () => {},
      ).map((t) => t.name),
    );

  const build = guidance("build", true);
  assert.match(build, /^Tool use: /);
  assert.match(build, /View files with read \(offset and limit/);
  assert.match(build, /change them with edit and create new files with write/);
  assert.match(
    build,
    /rather than cat, sed -n, head or python3 and heredoc scripts through bash/,
  );
  assert.match(build, /Search with grep, find and ls\./);
  assert.match(build, /Keep bash for running commands, tests and git/);
  assert.match(build, /same turn as parallel tool calls \(up to eight\)/);
  assert.match(build, /call report on its own/);

  const review = guidance("review", true);
  assert.match(review, /View files with read/);
  assert.match(review, /rather than cat, sed -n or head through bash/);
  assert.match(review, /Keep bash for running commands/);
  assert.match(review, /parallel tool calls/);
  for (const absent of ["edit", "write", "python3"])
    assert.doesNotMatch(review, word(absent), `review names ${absent}`);

  for (const [intent, withShell] of [
    ["plan", true],
    ["learn", true],
    ["review", false],
  ] as const) {
    const text = guidance(intent, withShell);
    assert.match(text, /View files with read/, intent);
    assert.match(text, /Search with grep, find and ls\./, intent);
    assert.match(text, /parallel tool calls/, intent);
    for (const absent of ["edit", "write", "bash", "cat", "python3"])
      assert.doesNotMatch(text, word(absent), `${intent} names ${absent}`);
  }
});

test("tool guidance degrades to the tools present", () => {
  assert.equal(toolGuidance([]), "");
  assert.equal(toolGuidance(["report"]), "");
  const searchOnly = toolGuidance(["grep", "report"]);
  assert.equal(
    searchOnly,
    "Tool use: Search with grep. When several reads or searches are independent, request them in the same turn as parallel tool calls (up to eight) instead of one per turn; call report on its own, after the other results are back.",
  );
  assert.doesNotMatch(toolGuidance(["read"]), /report/);
});
