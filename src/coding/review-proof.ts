import { scrubTrace } from "../trace-scrub.js";
import { artifactHash } from "./github.js";
import type { CodingJob } from "./controller.js";
/** A delivered page is present in a model REQUEST, never just its current tool output. */
export function reviewMetadata(input: any, job: CodingJob) {
  if (
    input?.requestedModel !== job.settings.reviewerModel ||
    !Array.isArray(input.tools) ||
    input.tools.some(
      (t: any) =>
        ![
          "file_read",
          "plan_read",
          "command",
          "report",
          "logs_read",
          "glob",
          "grep",
          "notes_read",
          "notes_update",
        ].includes(t.name),
    )
  )
    return null;
  try {
    const m = input.messages.find((m: any) => m.role === "user");
    const brief = JSON.parse(m.content);
    if (
      typeof brief.handoff?.id !== "string" ||
      !brief.handoff.id ||
      brief.handoff.recipient !== "reviewer" ||
      brief.handoff.candidateHash !== artifactHash(job.result.checkpoint) ||
      brief.baseSha !== job.base_sha ||
      brief.objective !== scrubTrace(job.objective) ||
      brief.context !== scrubTrace(job.context)
    )
      return null;
    return brief.handoff.id as string;
  } catch {
    return null;
  }
}
export function completePlanDelivered(inputs: any[], plan: string) {
  const points = [...plan];
  const pages: { start: number; end: number }[] = [];
  for (const input of inputs) {
    const calls = new Map<string, number>();
    for (const m of input.messages ?? []) {
      if (m.role === "assistant")
        for (const c of m.tool_calls ?? []) {
          if (c.function?.name !== "plan_read") continue;
          try {
            const a = JSON.parse(c.function.arguments);
            const offset = a.offset ?? 0;
            if (
              (a.section ?? "plan") === "plan" &&
              Number.isSafeInteger(offset) &&
              offset >= 0
            )
              calls.set(c.id, offset);
          } catch {
            /* Invalid observations are not authority. */
          }
        }
      if (m.role !== "tool" || !calls.has(m.tool_call_id)) continue;
      try {
        const result = JSON.parse(m.content);
        const start = calls.get(m.tool_call_id)!;
        const end =
          result.nextOffset === null ? points.length : result.nextOffset;
        if (
          !Number.isSafeInteger(end) ||
          end <= start ||
          end > points.length ||
          result.text !== scrubTrace(points.slice(start, end).join(""))
        )
          continue;
        pages.push({ start, end });
      } catch {
        /* Keep incomplete coverage visibly incomplete. */
      }
    }
  }
  let covered = 0;
  for (const page of pages.sort((a, b) => a.start - b.start)) {
    if (page.start > covered) return false;
    covered = Math.max(covered, page.end);
  }
  return points.length > 0 && covered >= points.length;
}
