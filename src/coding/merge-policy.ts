import type { Outcome } from "./schema.js";
import { artifactHash } from "./github.js";

/**
 * Never merged through Chief, even with the owner's Merge card: database migrations and
 * Compose need a reviewed operator rollout (the release guard refuses them otherwise),
 * environment files hold secrets, and the GitHub App cannot merge workflow changes.
 */
export function hardStopMergePath(path: string) {
  return (
    /^(?:\.github|db)(?:\/|$)/.test(path) ||
    /^compose(?:\..+)?\.ya?ml$/.test(path) ||
    path.split("/").some((p) => p.startsWith(".env") && p !== ".env.example")
  );
}
/**
 * Operator-reviewed boundary. A model cannot widen it through task instructions. Without
 * the owner's Merge card these paths are never merged automatically; with it, the card
 * names them so the owner approves them knowingly (owner decision, 21 October 2026).
 */
export function protectedMergePath(path: string) {
  return (
    /^(?:\.github|db|deploy|scripts|config|evals|coding_runtime|coding_runtime_pi|plugins|tools)(?:\/|$)/.test(
      path,
    ) ||
    /^(?:AGENTS\.md|REVIEW\.md|compose(?:\..+)?\.ya?ml|Dockerfile(?:\..+)?|package(?:-lock)?\.json)$/.test(
      path,
    ) ||
    path.split("/").some((p) => p.startsWith(".env") && p !== ".env.example") ||
    /^src\/(?:coding\/|browser\/|main\.ts$|config\.ts$|model\.ts$|server\.ts$|process-guard\.ts$|ops-log\.ts$|trace-scrub\.ts$|tools\.ts$|protocol\.ts$|execution\.ts$|runtime\.ts$|model-policy\.ts$|security\.ts$|plugin-execution\.ts$|plugin-registry\.ts$|agent\.ts$|custom-agent\.ts$|telegram\.ts$|history\.ts$|db\.ts$|plugins\.ts$|miniapp\.ts$|gathering\/(?:api|vault|sessions)\.ts$|ibkr\/)/.test(
      path,
    ) ||
    /(?:^|\/)[^/]*(?:auth|secret|credential|permission|approval|actions)[^/]*\.[cm]?[jt]s$/.test(
      path,
    )
  );
}
export function approvedArtifact(result: Outcome, reviewerModel: string) {
  const hash = artifactHash(result.checkpoint);
  return (
    result.kind === "candidate" &&
    result.review?.verdict === "APPROVE" &&
    result.review.model === reviewerModel &&
    result.review.patchHash === hash &&
    ["check", "build", "format:check"].every((script) =>
      result.checks.some(
        (c) => c.command === `kite run ${script}` && c.exitCode === 0,
      ),
    )
  );
}
export type PrInspection = {
  head: string;
  tree: string;
  base: string;
  main: string;
  merged: boolean;
  mergeSha?: string;
  closed: boolean;
  draft: boolean;
  mergeable: boolean | null;
  checks: "pending" | "passed" | "failed";
  feedback: { id: string; text: string }[];
  unresolvedThreads?: number;
};
export type MergeTarget = {
  id: string;
  revision: number;
  baseSha: string;
  head: string;
  url: string;
  tree: string;
};
export type PrOutcome = {
  merged: boolean;
  closed: boolean;
  mergeSha?: string | null;
};
export interface PrAutomationRepository {
  inspect(target: MergeTarget): Promise<PrInspection>;
  /** Whether a job's own PR was merged or closed, with no merge target recorded for it. */
  outcome(job: { id: string; url: string }): Promise<PrOutcome>;
  ready(target: MergeTarget): Promise<void>;
  attest(
    target: MergeTarget,
    model: string,
    artifact: string,
    handledFeedback?: string[],
  ): Promise<void>;
  merge(target: MergeTarget): Promise<{ sha: string }>;
  release(sha: string): Promise<"pending" | "success" | "failure">;
}

/** A definite GitHub refusal is distinct from an unknown merge outcome. */
export class MergeRefused extends Error {}

/**
 * What a person still has to do after review, named from the changed paths, so a stop says
 * exactly what is left instead of "explicit review is needed".
 */
export function operatorSteps(paths: string[]) {
  const steps: string[] = [];
  const db = paths.filter((p) => /^db(?:\/|$)/.test(p));
  if (db.length)
    steps.push(
      `merge it on GitHub and right away run the database rollout for ${db.map((p) => p.replace(/^db\//, "")).join(", ")} (its scripts/deploy-*.py)`,
    );
  if (paths.some((p) => /^compose(?:\..+)?\.ya?ml$/.test(p)))
    steps.push(
      "merge it on GitHub and apply the Compose change through its rollout script",
    );
  if (paths.some((p) => /^\.github(?:\/|$)/.test(p)))
    steps.push(
      "merge on GitHub yourself, because Chief's app cannot merge workflow changes",
    );
  if (
    paths.some((p) =>
      p
        .split("/")
        .some((part) => part.startsWith(".env") && part !== ".env.example"),
    )
  )
    steps.push(
      "merge it on GitHub and update the production environment file on the host",
    );
  if (paths.includes("config/tool-picker.json"))
    steps.push("run kite run eval:picker and record its result before merging");
  return steps;
}
