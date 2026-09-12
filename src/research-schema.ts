import { z } from "zod";
export const researchAssignment = z
  .object({
    operation: z.literal("research_delegate"),
    objective: z.string().min(1).max(2000),
    context: z.string().max(3000),
    jobIds: z.array(z.string().uuid()).max(6),
    urls: z.array(z.string().url().max(2000)).max(6),
  })
  .strict();
export const researchReport = z
  .object({
    operation: z.literal("research_report"),
    targets: z
      .array(
        z
          .object({
            targetId: z.string().min(1).max(2000),
            status: z.enum(["complete", "partial", "blocked"]),
            summary: z.string().min(1).max(600),
            evidence: z
              .array(
                z
                  .object({
                    sourceId: z.string().uuid(),
                    quote: z.string().min(1).max(300),
                  })
                  .strict(),
              )
              .max(2),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export const researchReads = new Set(["web_search", "web_read", "source_read"]);
