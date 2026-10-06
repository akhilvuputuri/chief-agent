import type { Outcome } from "./schema.js";
import { artifactHash } from "./github.js";

/** Operator-reviewed boundary. A model cannot widen it through task instructions. */
export function protectedMergePath(path: string) {
  return (
    /^(?:\.github|db|deploy|scripts|config|evals|coding_runtime|plugins)(?:\/|$)/.test(
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
        (c) => c.command === `npm run ${script}` && c.exitCode === 0,
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
export interface PrAutomationRepository {
  inspect(target: MergeTarget): Promise<PrInspection>;
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
