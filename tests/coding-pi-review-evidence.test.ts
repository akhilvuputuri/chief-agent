import { test } from "node:test";
import assert from "node:assert/strict";
import { piReviewInstructions } from "../src/coding/pi-worker.js";

import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  Workspace,
  localExecutor,
  documentHash,
} from "@chief-agent/pi-runtime";
import { piReviewEvidence } from "../src/coding/pi-review-evidence.js";
import { artifactHash } from "../src/coding/github.js";
import { checkpoint } from "../src/coding/schema.js";
import { documents } from "../coding_runtime_pi/src/documents.js";
import { tools } from "../coding_runtime_pi/src/tools.js";

test("Pi reviewer is directed to the exact changed-path inventory and complete diff", () => {
  const prompt = piReviewInstructions({
    candidateHash: "a".repeat(64),
    baseSha: "b".repeat(40),
    fileCount: 3,
    plan: "Fix addition only",
    context: "Preserve all unrelated behavior",
    checks: [{ command: "kite run check", exitCode: 0, output: "passed" }],
  });
  assert.match(prompt, /candidate_inventory/);
  assert.match(prompt, /candidate_diff/);
});

test("review evidence exposes complete unexpected changes and rejects stale identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  await writeFile(join(root, "requested.js"), "export const value = 1;\n");
  await writeFile(join(root, "unrelated.txt"), "Unrelated behavior before\n");
  await writeFile(join(root, "deleted.txt"), "Unexpected deletion evidence\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-qm",
    "Fixture",
  );
  const base = git("rev-parse", "HEAD").toString().trim();
  await writeFile(join(root, "requested.js"), "export const value = 2;\n");
  await writeFile(join(root, "unrelated.txt"), "Unrelated behavior changed\n");
  await unlink(join(root, "deleted.txt"));
  await writeFile(
    join(root, "added.txt"),
    Array.from({ length: 4000 }, (_, i) => `Evidence line ${i}\n`).join(""),
  );
  const tree = await new Workspace(root).initialize();
  const execute = localExecutor(root, join(root, ".ignored-home"));
  // The executor home must not become part of the candidate.
  await writeFile(join(root, ".git", "info", "exclude"), ".ignored-home/\n");
  const signal = new AbortController().signal;
  const actual = await tree.snapshot(execute, signal);
  const saved = checkpoint.parse({
    plan: "Change requested.js only",
    patch: actual.patch,
    files: actual.files,
  });
  const evidence = await piReviewEvidence(tree, execute, saved, base, signal);
  const inventory = JSON.parse(evidence[0]!.text);
  assert.equal(inventory.baseSha, base);
  assert.equal(inventory.candidateHash, artifactHash(saved));
  assert.deepEqual(inventory.changes, [
    { path: "added.txt", status: "added" },
    { path: "deleted.txt", status: "deleted" },
    { path: "requested.js", status: "modified" },
    { path: "unrelated.txt", status: "modified" },
  ]);
  assert.equal(evidence[1]!.text, actual.patch);
  assert(evidence[1]!.text.length > 32000);
  assert.match(evidence[1]!.text, /-Unexpected deletion evidence/);
  assert.match(evidence[1]!.text, /\+Unrelated behavior changed/);
  const paged = documents(evidence);
  const collected: string[] = [];
  for (let page = 0; page < Math.ceil(actual.patch.length / 4000); page++) {
    const result = await paged.tool.execute(
      "read",
      { id: "candidate_diff", page },
      signal,
      undefined,
      {} as any,
    );
    const body = JSON.parse((result.content[0] as any).text);
    assert.equal(body.hash, documentHash(actual.patch));
    for (let i = body.from; i < body.to; i++)
      collected[i] = body.text[i - body.from];
  }
  assert.equal(collected.join(""), actual.patch);
  assert.deepEqual(paged.unread(), ["candidate_inventory"]);
  assert(
    !tools(
      tree,
      "review",
      execute,
      () => {},
      async () => {},
    ).some((t) => ["bash", "edit", "write"].includes(t.name)),
  );
  await assert.rejects(
    piReviewEvidence(tree, execute, saved, "0".repeat(40), signal),
    /checked candidate and base/,
  );
  await assert.rejects(
    piReviewEvidence(
      tree,
      execute,
      { ...saved, patch: saved.patch + "tampered" },
      base,
      signal,
    ),
    /checked candidate and base/,
  );
  await writeFile(join(root, "unrelated.txt"), "Unrelated behavior before\n");
  await assert.rejects(
    piReviewEvidence(tree, execute, saved, base, signal),
    /checked candidate and base/,
  );
  const repaired = await tree.snapshot(execute, signal);
  const replacement = checkpoint.parse({
    ...saved,
    patch: repaired.patch,
    files: repaired.files,
  });
  const next = await piReviewEvidence(tree, execute, replacement, base, signal);
  assert.notEqual(
    JSON.parse(next[0]!.text).candidateHash,
    inventory.candidateHash,
  );
  assert(
    !JSON.parse(next[0]!.text).changes.some(
      (c: any) => c.path === "unrelated.txt",
    ),
  );
  assert.equal(next[1]!.text, repaired.patch);
  assert.notEqual(documentHash(next[1]!.text), documentHash(evidence[1]!.text));
});
