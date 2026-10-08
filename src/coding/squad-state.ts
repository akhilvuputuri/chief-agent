import { createHash } from "node:crypto";
import type { CodingJob } from "./controller.js";
import type { Checkpoint } from "./schema.js";
import { artifactHash, canonicalJson } from "./github.js";

export function squadScope(job: CodingJob, plan: string) {
  return createHash("sha256")
    .update(
      canonicalJson({
        id: job.id,
        objective: job.objective,
        context: job.context,
        baseSha: job.base_sha,
        plan: job.mode === "implement" ? plan : "",
      }),
    )
    .digest("hex");
}
const transitions: Record<string, string[]> = {
  planning: ["planning", "planned", "awaiting_input"],
  planned: ["planned"],
  idle: ["coding", "awaiting_input", "idle"],
  coding: ["coding", "verifying", "awaiting_input"],
  verifying: ["verifying", "coding", "reviewing", "rework", "awaiting_input"],
  reviewing: ["reviewing", "approved", "rework", "awaiting_input"],
  rework: ["rework", "coding", "awaiting_input"],
  approved: ["approved", "coding", "awaiting_input"],
  awaiting_input: ["awaiting_input"],
};
export function assertSquadCheckpoint(job: CodingJob, c: Checkpoint) {
  if (
    c.runtimeMemory &&
    (job.settings.harnessVersion !== 2 ||
      c.runtimeMemory.scopeHash !== squadScope(job, c.plan))
  )
    throw new Error("Working notebook is outside the reviewed harness scope");
  const s = c.squadState;
  if (!job.settings.squad) {
    if (s) throw new Error("Legacy jobs cannot introduce squad state");
    return;
  }
  if (
    !s ||
    s.revision !== job.revision ||
    s.attemptId !== job.attempt_id ||
    s.scopeHash !== squadScope(job, c.plan) ||
    s.toolsUsed > job.settings.limits.tools
  )
    throw new Error("Squad checkpoint is outside the fenced scope/allocation");
  const prior = job.checkpoint.squadState;
  const active =
    prior?.attemptId === job.attempt_id && prior.revision === job.revision;
  if (
    active &&
    s.sequence === prior.sequence &&
    canonicalJson(c) === canonicalJson(job.checkpoint)
  )
    return;
  if (s.sequence !== (active ? prior.sequence + 1 : 1))
    throw new Error("Squad sequence conflict");
  if (
    active &&
    (!transitions[prior.phase]?.includes(s.phase) ||
      s.toolsUsed < prior.toolsUsed ||
      s.candidateVersion !==
        prior.candidateVersion +
          (s.phase === "coding" && prior.phase !== "coding" ? 1 : 0))
  )
    throw new Error("Illegal squad transition");
  if (!active && s.phase !== (job.mode === "plan" ? "planning" : "idle"))
    throw new Error("A new attempt must start at its leader");
  if (
    job.mode === "plan" &&
    !["planning", "planned", "awaiting_input"].includes(s.phase)
  )
    throw new Error("Planning cannot dispatch implementation/review");
  if (
    ["verifying", "reviewing", "rework", "approved"].includes(s.phase) &&
    s.candidateHash !== artifactHash(c)
  )
    throw new Error("Squad candidate hash is stale");
  const checked = [
    "npm run check",
    "npm run build",
    "npm run format:check",
  ].every((command) =>
    s.checks.some((check) => check.command === command && check.exitCode === 0),
  );
  if (["reviewing", "approved"].includes(s.phase) && !checked)
    throw new Error("Review requires passing checks");
  if (
    s.phase === "reviewing" &&
    (s.handoff?.recipient !== "reviewer" ||
      s.handoff.candidateHash !== s.candidateHash)
  )
    throw new Error("Review handoff is not bound to the candidate");
  if (
    s.phase === "approved" &&
    (s.review?.verdict !== "APPROVE" ||
      s.review.model !== job.settings.reviewerModel ||
      s.review.patchHash !== s.candidateHash)
  )
    throw new Error("Leader cannot bypass exact reviewer approval");
  if (
    s.phase === "coding" &&
    (s.handoff?.recipient !== "coder" ||
      s.review ||
      s.checks.length ||
      s.candidateHash)
  )
    throw new Error("Coding must invalidate previous checks/review");
}
