/**
 * Owner-facing wording for the Pi worker's progress lines. The worker reports internal
 * labels such as "Pi coder: Running" or "Pi reviewer: completed"; the host stores and shows
 * plain English instead. Deterministic, so a retried report matches.
 */
const roles: Record<string, string> = {
  coder: "Coding",
  reviewer: "Review",
};

export function ownerProgress(summary: string): string {
  const state = /^Pi (coder|reviewer): (.+)$/s.exec(summary);
  if (!state) return summary;
  const [, role, text] = state as unknown as [string, string, string];
  const phase = roles[role]!;
  if (text === "Running") return `${phase} started`;
  if (text === "waiting_input") return `${phase} needs your answer`;
  if (["completed", "paused", "failed", "cancelled"].includes(text))
    return `${phase} ${text}`;
  return `${phase}: ${text}`;
}
