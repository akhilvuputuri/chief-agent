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
