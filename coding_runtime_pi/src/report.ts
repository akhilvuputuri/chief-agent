import { createHash } from "node:crypto";
import type { Report } from "./types.js";

/**
 * One transport and storage contract: the host stores reports in fixed-size fields. An ask is
 * one short message to the owner with at most three buttons (the coding-loop specification).
 */
export const reportLimits = Object.freeze({
  document: 32000,
  summary: 4000,
  ask: 300,
  options: 3,
  /**
   * One button label. Telegram's Bot API names no maximum for a button's text, but clients cut
   * a label that does not fit its button; 40 characters on one line fit a full-width button
   * on a phone, so the owner taps what they read (journal 192).
   */
  option: 40,
});
export type ReportDocument = Omit<Report, "detail"> & {
  detail: string;
  version: 1;
  hash: string;
};
/** Validates a report; each refusal names the field and its bound so the model can fix it. */
export function reportDocument(report: Report): ReportDocument {
  if (
    !["done", "review", "ask"].includes(report.kind) ||
    typeof report.summary !== "string" ||
    (report.detail !== undefined && typeof report.detail !== "string") ||
    (report.kind === "review" &&
      !["APPROVE", "REQUEST_CHANGES"].includes(report.verdict ?? "")) ||
    (report.kind !== "review" && report.verdict !== undefined)
  )
    throw new Error(
      "Use kind done (coder) or review with verdict APPROVE or REQUEST_CHANGES (reviewer), or kind ask to ask the owner",
    );
  const detail = report.detail ?? "";
  const texts = [
    report.summary,
    detail,
    report.ask ?? "",
    ...(report.options ?? []),
  ];
  // The host stores reports in Postgres, which refuses NUL and lone surrogates (journal 155).
  if (
    texts.some((t) => Buffer.from(t).toString() !== t || t.includes("\u0000"))
  )
    throw new Error(
      "Report text must contain well-formed Unicode and no NUL characters; write \\u0000 as text, not as the character",
    );
  if (!report.summary.trim()) throw new Error("summary must not be empty");
  if (report.summary.length > reportLimits.summary)
    throw new Error(
      `summary has ${report.summary.length} characters; shorten it to at most ${reportLimits.summary} and put the rest in detail`,
    );
  if (detail.length > reportLimits.document)
    throw new Error(
      `detail has ${detail.length} characters; shorten it to at most ${reportLimits.document}`,
    );
  if (report.kind === "ask") {
    if (typeof report.ask !== "string" || !report.ask.trim())
      throw new Error("An ask needs the question in ask");
    if (report.ask.length > reportLimits.ask)
      throw new Error(
        `ask has ${report.ask.length} characters; shorten it to at most ${reportLimits.ask} and keep the detail in detail`,
      );
    if (
      report.options !== undefined &&
      (!Array.isArray(report.options) ||
        report.options.length > reportLimits.options ||
        report.options.some((o) => typeof o !== "string" || !o.trim()))
    )
      throw new Error(
        `options must be at most ${reportLimits.options} non-empty answers the owner can tap`,
      );
    for (const [index, option] of (report.options ?? []).entries())
      if (option.length > reportLimits.option || /\n/.test(option))
        throw new Error(
          `option ${index + 1} has ${option.length} characters; each option is one line of at most ${reportLimits.option} characters, as a button shows it in full; put the detail in ask or detail`,
        );
  } else {
    if (report.ask !== undefined || report.options !== undefined)
      throw new Error("ask and options belong to kind ask");
    if (!detail.trim()) throw new Error("detail must not be empty");
  }
  const body = {
    kind: report.kind,
    summary: report.summary,
    detail,
    ...(report.verdict ? { verdict: report.verdict } : {}),
    ...(report.kind === "ask" ? { ask: report.ask } : {}),
    ...(report.options?.length ? { options: report.options } : {}),
  };
  return {
    ...body,
    version: 1,
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}
