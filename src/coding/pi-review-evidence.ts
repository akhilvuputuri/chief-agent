import {
  Workspace,
  type Executor,
  type ReferenceDocument,
} from "@chief-agent/pi-runtime";
import { artifactHash, validateFiles } from "./github.js";
import type { Checkpoint } from "./schema.js";

/** Trusted setup only: reviewers receive evidence, never this executor. */
export async function piReviewEvidence(
  workspace: Workspace,
  execute: Executor,
  checkpoint: Checkpoint,
  baseSha: string,
  signal: AbortSignal,
): Promise<ReferenceDocument[]> {
  validateFiles(checkpoint.files);
  const expected = artifactHash(checkpoint);
  const actual = await workspace.snapshot(execute, signal);
  if (
    actual.base !== baseSha ||
    artifactHash({
      ...checkpoint,
      patch: actual.patch,
      files: actual.files,
    }) !== expected
  )
    throw new Error(
      "Review tree does not match the checked candidate and base",
    );
  const inventory = await execute(
    "git -c core.hooksPath=/dev/null diff --cached --no-ext-diff --no-textconv --no-renames --name-status -z",
    signal,
    120000,
    1_000_000,
  );
  if (inventory.exitCode !== 0 || inventory.truncated)
    throw new Error("Complete review change inventory is unavailable");
  const fields = inventory.output.split("\0");
  if (fields.pop() !== "" || fields.length % 2)
    throw new Error("Invalid review change inventory");
  const statuses = {
    A: "added",
    M: "modified",
    D: "deleted",
    T: "type_changed",
  } as const;
  const changes: { path: string; status: string }[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = statuses[fields[i] as keyof typeof statuses];
    if (!status) throw new Error("Unsupported review change status");
    changes.push({ path: fields[i + 1]!, status });
  }
  if (
    JSON.stringify(changes.map((c) => c.path).sort()) !==
    JSON.stringify(checkpoint.files.map((f) => f.path).sort())
  )
    throw new Error("Review inventory does not cover the checked candidate");
  return [
    {
      id: "candidate_inventory",
      title: `Immutable change inventory for ${expected}`,
      text: JSON.stringify({
        version: 1,
        baseSha,
        candidateHash: expected,
        changes,
      }),
    },
    {
      id: "candidate_diff",
      title: `Complete diff from ${baseSha} for ${expected}`,
      text: actual.patch,
    },
  ];
}

const git = "git -c core.hooksPath=/dev/null";

/**
 * Writes an earlier reviewed candidate as a git tree in this checkout, then returns the
 * checkout to the base, so the next review can be given what changed since (journal 167).
 * Returns nothing when the tree cannot be built; the caller then reviews in full.
 */
export async function piReviewedTree(
  workspace: Workspace,
  execute: Executor,
  files: Checkpoint["files"],
  baseSha: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const run = async (command: string) => {
    const result = await execute(command, signal, 120000, 1_000_000);
    return result.exitCode === 0 && !result.truncated
      ? result.output
      : undefined;
  };
  let tree: string | undefined;
  try {
    validateFiles(files);
    await workspace.restore(files);
    if ((await run(`${git} add -A`)) !== undefined)
      tree = (await run(`${git} write-tree`))?.trim();
  } catch {
    tree = undefined;
  }
  // The candidate under review is restored next, and its tree is checked against its hash.
  if (
    (await run(`${git} reset -q --hard ${baseSha}`)) === undefined ||
    (await run(`${git} clean -fdq`)) === undefined ||
    (await run(`${git} status --porcelain 2>/dev/null`)) !== ""
  )
    throw new Error("Review checkout could not be returned to the base");
  return tree && /^[a-f0-9]{40,64}$/.test(tree) ? tree : undefined;
}

/** The diff between two trees: "" when they are identical, nothing when unavailable. */
async function treeDelta(
  execute: Executor,
  from: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const to = await execute(`${git} write-tree`, signal, 120000);
  if (to.exitCode !== 0 || to.truncated) return undefined;
  if (to.output.trim() === from) return "";
  const delta = await execute(
    `${git} diff --no-ext-diff --no-textconv --no-renames ${from} ${to.output.trim()}`,
    signal,
    120000,
    500_000,
  );
  return delta.exitCode === 0 && !delta.truncated ? delta.output : undefined;
}

/**
 * The complete diff from an earlier reviewed candidate's tree to the candidate now staged
 * in this checkout. Returns nothing when it is unavailable or too large to help.
 */
export async function piReviewDelta(
  execute: Executor,
  from: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const delta = await treeDelta(execute, from, signal);
  return delta?.trim() ? delta : undefined;
}

/**
 * For a change carried onto a new base (journal 174): the diff from the reviewed
 * candidate's files laid on the new base to the candidate staged now. "" means every file
 * the change touches is byte-identical to the reviewed candidate; nothing means unavailable.
 */
export function piCarriedDelta(
  execute: Executor,
  from: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  return treeDelta(execute, from, signal);
}

/** What main changed between two bases, as `git diff --stat`, or nothing when unavailable. */
export async function piMainChanges(
  execute: Executor,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!/^[a-f0-9]{40}$/.test(from) || !/^[a-f0-9]{40}$/.test(to))
    return undefined;
  const stat = await execute(
    `${git} diff --no-ext-diff --no-textconv --no-renames --stat=160 ${from} ${to}`,
    signal,
    120000,
    100_000,
  );
  return stat.exitCode === 0 && !stat.truncated
    ? stat.output.trimEnd() || "(no file changes)"
    : undefined;
}

/** A repair that rewrote much of the change gets a full review; a small one is read as a delta. */
export function deltaIsSmall(delta: string, complete: string) {
  return delta.length * 2 <= complete.length;
}
