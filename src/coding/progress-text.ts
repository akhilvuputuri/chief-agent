/**
 * Owner-facing wording for the Pi worker's progress lines. The worker reports internal
 * labels such as "Pi build: Running build" or "Pi check: lockstep run check: 0"; the host
 * stores and shows plain English instead. Deterministic, so a retried report matches.
 */
const phases: Record<string, string> = {
  plan: "Planning",
  build: "Implementation",
  review: "Review",
  learn: "Learning",
};

export function ownerProgress(summary: string): string {
  const check = /^Pi check: (.+): (-?\d+)$/s.exec(summary);
  if (check)
    return check[2] === "0"
      ? `Check passed: ${check[1]}`
      : `Check failed: ${check[1]} (exit ${check[2]})`;
  const command = /^Pi check: (.+)$/s.exec(summary);
  if (command) return `Check: ${command[1]}`;
  const state = /^Pi (plan|build|review|learn): (.+)$/s.exec(summary);
  if (!state) return summary;
  const [, intent, text] = state as unknown as [string, string, string];
  const phase = phases[intent]!;
  if (text === `Running ${intent}`) return `${phase} started`;
  if (text === "waiting_approval")
    return intent === "plan"
      ? "Plan ready for your approval"
      : `${phase} waiting for your approval`;
  if (text === "waiting_input") return `${phase} needs your answer`;
  if (text === "running") return `${phase} running`;
  if (text === "ready") return `${phase} ready`;
  if (["completed", "paused", "failed", "cancelled"].includes(text))
    return `${phase} ${text}`;
  return `${phase}: ${text}`;
}
