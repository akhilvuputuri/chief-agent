import { z } from "zod";

// owner/name, as GitHub spells them; the allowlist decides which are usable.
const repo = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    "Use the repository as owner/name",
  );

export const githubIssueDraft = z
  .object({
    operation: z.literal("github_issue_draft"),
    repo,
    title: z.string().trim().min(1).max(256),
    body: z.string().trim().min(1).max(3000),
    labels: z.array(z.string().trim().min(1).max(50)).max(5).optional(),
  })
  .strict();
export const githubIssueSearch = z
  .object({
    operation: z.literal("github_issue_search"),
    repo,
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export const githubSchemas = [githubIssueDraft, githubIssueSearch] as const;
export type GithubIssueDraft = Omit<
  z.infer<typeof githubIssueDraft>,
  "operation"
>;
