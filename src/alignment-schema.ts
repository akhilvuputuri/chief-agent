import { z } from "zod";
const short = z.string().min(1).max(1200);
export const alignmentStart = z
  .object({
    operation: z.literal("job_alignment_start"),
    objective: z.string().min(1).max(3000),
    allSaved: z.boolean(),
    jobIds: z.array(z.string().uuid()),
    memoryKeys: z.array(z.string().min(1).max(200)).max(30),
  })
  .strict();
export const alignmentResume = z
  .object({
    operation: z.literal("job_alignment_resume"),
    scopeId: z.string().uuid(),
  })
  .strict();
export const alignmentRead = z
  .object({
    operation: z.literal("job_alignment_read"),
    scopeId: z.string().uuid(),
    jobId: z.string().uuid().nullable(),
    offset: z.number().int().min(0),
  })
  .strict();
export const alignmentInput = z
  .object({
    operation: z.literal("job_alignment_input"),
    kind: z.enum(["job", "memory"]),
    id: z.string(),
    offset: z.number().int().min(0),
  })
  .strict();
export const citation = z
  .object({
    kind: z.enum(["web", "job_snapshot"]),
    refId: z.string().uuid(),
    quote: z.string().min(1).max(500),
  })
  .strict();
const citations = z.array(citation).max(4);
const memoryEvidence = z
  .array(
    z.object({ key: z.string(), quote: z.string().min(1).max(500) }).strict(),
  )
  .max(3);
export const alignmentTarget = z
  .object({
    targetId: z.string().uuid(),
    status: z.enum(["complete", "partial", "blocked"]),
    summary: short,
    identity: z
      .object({
        match: z.enum(["matched", "saved_only", "unverified", "mismatch"]),
        location: z.string().max(300),
        level: z.string().max(300),
        note: short,
        evidence: citations,
      })
      .strict(),
    requirements: z
      .array(
        z
          .object({
            id: z.string().min(1).max(60),
            requirement: short,
            kind: z.enum(["essential", "preferred", "inferred"]),
            evidence: citations,
            fit: z
              .object({
                status: z.enum([
                  "demonstrated",
                  "transferable",
                  "confirmed_gap",
                  "unknown",
                ]),
                explanation: short,
                memoryEvidence,
              })
              .strict(),
          })
          .strict(),
      )
      .max(16),
    interviews: z
      .object({
        status: z.enum(["supported", "uncertain", "not_found"]),
        searchSummary: short,
        findings: z
          .array(
            z
              .object({
                id: z.string().min(1).max(60),
                claim: short,
                scope: z.enum([
                  "exact_role",
                  "employer_general",
                  "other_role_or_location",
                  "unknown",
                ]),
                roleMatch: z.enum(["matched", "mismatch", "unknown"]),
                locationMatch: z.enum(["matched", "mismatch", "unknown"]),
                levelMatch: z.enum(["matched", "mismatch", "unknown"]),
                sourceType: z.enum(["official", "candidate_report", "other"]),
                date: z.string().max(100).nullable(),
                confidence: z.enum(["high", "medium", "low"]),
                caveat: short,
                evidence: citations,
              })
              .strict(),
          )
          .max(8),
      })
      .strict(),
    preparation: z
      .array(
        z
          .object({
            id: z.string().min(1).max(60),
            requirementIds: z.array(z.string()).max(16),
            interviewIds: z.array(z.string()).max(8),
            priority: z.enum(["minimum", "optional"]),
            action: short,
            why: short,
            doneWhen: short,
            effortEstimate: z.string().max(200).nullable(),
          })
          .strict(),
      )
      .max(8),
    unknowns: z.array(short).max(12),
  })
  .strict();
export const alignmentReport = z
  .object({
    operation: z.literal("job_alignment_report"),
    targets: z.array(alignmentTarget).min(1).max(2),
  })
  .strict();
export type AlignmentTarget = z.infer<typeof alignmentTarget>;
