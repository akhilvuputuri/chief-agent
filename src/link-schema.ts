import { z } from "zod";
export const linkResolve = z
  .object({
    operation: z.literal("link_resolve"),
    url: z.string().url().max(2048),
    target: z.enum(["article", "discussion"]).default("article"),
  })
  .strict();
export const linkResult = z
  .object({
    originalUrl: z.string().url(),
    pageUrl: z.string().url().nullable(),
    articleUrl: z.string().url().nullable(),
    status: z.enum(["resolved", "discussion", "ambiguous", "blocked"]),
    method: z.enum(["http", "browser", "owner_verified", "owner_provided"]),
    reason: z.string().max(300),
    candidates: z.array(z.string().url()).max(6),
    observedAt: z.string().datetime(),
  })
  .strict();
export type LinkResult = z.infer<typeof linkResult>;
