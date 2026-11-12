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
  documentPageChars,
} from "@chief-agent/pi-runtime";
import {
  deltaIsSmall,
  piReviewDelta,
  piReviewEvidence,
  piReviewedTree,
} from "../src/coding/pi-review-evidence.js";
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
  for (
    let page = 0;
    page < Math.ceil(actual.patch.length / documentPageChars);
    page++
  ) {
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
  assert(
    !tools(
      tree,
      "review",
      execute,
      () => {},
      async () => {},
    ).some((t) => ["edit", "write"].includes(t.name)),
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

test("a later review round is told what changed since the reviewed candidate, within the instruction bound", () => {
  const input = {
    candidateHash: "a".repeat(64),
    baseSha: "b".repeat(40),
    fileCount: 100,
    context: "c".repeat(16000),
    checks: [
      "kite ci",
      "kite run check",
      "kite run build",
      "kite run lint",
    ].map((command) => ({ command, exitCode: 0, output: "r".repeat(32000) })),
  };
  const first = piReviewInstructions(input);
  assert.match(
    first,
    /Read every page of candidate_inventory and candidate_diff/,
  );
  assert.doesNotMatch(first, /review_delta|previous_findings/);
  const later = piReviewInstructions({
    ...input,
    reReview: { previousHash: "d".repeat(64), round: 3 },
  });
  assert(later.length <= 32000, `Re-review instructions: ${later.length}`);
  assert.match(later, /first judge it yourself/);
  assert.doesNotMatch(later, /in full/);
  // Escaped output (newlines, colour codes) grows in JSON; the receipts shrink, the brief does not.
  for (const output of [
    "line\n".repeat(8000),
    "\u001b[32mok\u001b[0m".repeat(4000),
  ])
    for (const reReview of [
      undefined,
      { previousHash: "d".repeat(64), round: 2 },
    ]) {
      const escaped = piReviewInstructions({
        ...input,
        checks: input.checks.map((c) => ({ ...c, output })),
        ...(reReview ? { reReview } : {}),
      });
      assert(escaped.length <= 32000, `Escaped receipts: ${escaped.length}`);
      assert(escaped.includes(input.context));
      assert.equal((escaped.match(/"exitCode":0/g) ?? []).length, 4);
    }
  assert.match(later, /review round 3/);
  assert(later.includes("d".repeat(64)));
  assert.match(
    later,
    /Read every page of candidate_inventory, previous_findings and review_delta/,
  );
  assert.match(
    later,
    /candidate_diff, the complete change set against the base, is optional/,
  );
  assert.match(later, /verdict covers the whole candidate/);
  // The standing review duties stay in both.
  for (const prompt of [first, later]) {
    assert.match(prompt, /requirement by requirement/);
    assert.match(prompt, /construct at least one concrete failure case/);
    assert(prompt.includes(input.context));
  }
});

test("the delta holds exactly what changed since the reviewed candidate, and leaves the checkout exact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-delta-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  git("init", "-q");
  const write = (path: string, text: string) =>
    writeFile(join(root, path), text);
  await write("a.js", "export const a = 'one';\n");
  await write("b.js", "export const b = 1;\n");
  await write("gone.txt", "Deleted by the first candidate\n");
  await write("kept.txt", "Never touched\n");
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
  const base = git("rev-parse", "HEAD");
  await writeFile(join(root, ".git", "info", "exclude"), ".ignored-home/\n");
  const tree = await new Workspace(root).initialize();
  const execute = localExecutor(root, join(root, ".ignored-home"));
  const signal = new AbortController().signal;
  const toBase = () => {
    git("reset", "-q", "--hard", base);
    git("clean", "-fdq");
  };
  // The reviewed candidate.
  await write("a.js", "export const a = 'two';\n");
  await write("b.js", "export const b = 2;\n");
  await write("added.js", "export const added = true;\n");
  await unlink(join(root, "gone.txt"));
  const reviewed = await tree.snapshot(execute, signal);
  toBase();
  // The repaired candidate: a.js changed again, b.js kept, the addition and deletion undone.
  await write("a.js", "export const a = 'three';\n");
  await write("b.js", "export const b = 2;\n");
  await write("fresh.js", "export const fresh = 1;\n");
  const repaired = await tree.snapshot(execute, signal);
  const saved = checkpoint.parse({
    plan: "Change a.js",
    patch: repaired.patch,
    files: repaired.files,
  });
  toBase();

  const from = await piReviewedTree(
    tree,
    execute,
    reviewed.files,
    base,
    signal,
  );
  assert.match(from ?? "", /^[a-f0-9]{40}$/);
  // The checkout is the base again: nothing of the earlier candidate reaches this review.
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("rev-parse", "HEAD"), base);
  await tree.restore(saved.files);
  const evidence = await piReviewEvidence(tree, execute, saved, base, signal);
  assert.equal(evidence[1]!.text, repaired.patch);
  const delta = await piReviewDelta(execute, from!, signal);
  assert(delta);
  assert.match(delta, /-export const a = 'two';\n\+export const a = 'three';/);
  assert.match(delta, /-export const added = true;/);
  assert.match(delta, /\+Deleted by the first candidate/);
  assert.match(delta, /\+export const fresh = 1;/);
  // Unchanged since the review, so not in the delta, though it differs from the base.
  assert.doesNotMatch(delta, /b\.js/);
  assert.doesNotMatch(delta, /kept\.txt/);
  assert.match(repaired.patch, /b\.js/);
  assert(delta.length < repaired.patch.length + reviewed.patch.length);

  // A repair of up to half the complete change is read as a delta; a larger one in full.
  assert.equal(deltaIsSmall("d".repeat(50), "c".repeat(100)), true);
  assert.equal(deltaIsSmall("d".repeat(51), "c".repeat(100)), false);
  assert.equal(deltaIsSmall(delta, repaired.patch), false);

  // No delta, never a wrong one: an unknown tree, or an identical candidate.
  assert.equal(await piReviewDelta(execute, "0".repeat(40), signal), undefined);
  const same = git("write-tree");
  assert.equal(await piReviewDelta(execute, same, signal), undefined);
  // Files that cannot be restored give no tree, and the checkout still returns to the base.
  toBase();
  assert.equal(
    await piReviewedTree(
      tree,
      execute,
      [{ path: "../escape.js", content: "x", mode: "100644" }],
      base,
      signal,
    ),
    undefined,
  );
  assert.equal(git("status", "--porcelain"), "");
  // A checkout that cannot be returned to the base ends the review; it never continues dirty.
  await assert.rejects(
    piReviewedTree(
      tree,
      async (command, ...rest) =>
        command.includes("reset")
          ? { exitCode: 1, output: "", truncated: false }
          : execute(command, ...rest),
      reviewed.files,
      base,
      signal,
    ),
    /returned to the base/,
  );
});
