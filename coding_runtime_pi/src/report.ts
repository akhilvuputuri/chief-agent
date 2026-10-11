import { createHash } from "node:crypto";
import type { Report } from "./types.js";

/** One transport/storage contract, independent of UI presentation limits. */
export const reportLimits = Object.freeze({
  document: 32000,
  summary: 4000,
  question: 2000,
});
export type ReportDocument = Report & { version: 1; hash: string };
export function reportDocument(report: Report): ReportDocument {
  if (
    !["learned", "plan", "question", "done", "review"].includes(report.kind) ||
    typeof report.detail !== "string" ||
    typeof report.summary !== "string" ||
    (report.kind === "review" &&
      !["APPROVE", "REQUEST_CHANGES"].includes(report.verdict ?? ""))
  )
    throw new Error("Invalid report kind, text or review verdict");
  if (!report.detail.trim() || report.detail.length > reportLimits.document)
    throw new Error(
      `Report document must contain 1–${reportLimits.document} characters; preserve the complete scope.`,
    );
  if (!report.summary.trim() || report.summary.length > reportLimits.summary)
    throw new Error(
      `Report status must contain 1–${reportLimits.summary} characters; full content belongs in detail.`,
    );
  if (
    report.kind === "question" &&
    report.detail.length > reportLimits.question
  )
    throw new Error(`Question must fit ${reportLimits.question} characters.`);
  const body = {
    kind: report.kind,
    summary: report.summary,
    detail: report.detail,
    ...(report.verdict ? { verdict: report.verdict } : {}),
  };
  return {
    ...body,
    version: 1,
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}
export type ReferenceDocument = { id: string; title: string; text: string };
export function documentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
