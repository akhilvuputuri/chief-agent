/**
 * Argument parsing for the operator probe (src/boxes/probe.ts), kept apart so it can be
 * tested without a database.
 */
const flags = {
  "--wait": "waitForMessage",
  "--hostile": "hostile",
  "--inspect": "inspect",
  "--probe": "probe",
} as const;

/**
 * `delegate <box-id> <request-key> [--wait] [--hostile] [--inspect] [--probe] <text…>`:
 * the `echo` task's payload. Flags come before the text; anything after the first
 * non-flag word is text.
 */
export function delegateArgs(args: string[]) {
  const [boxId, requestKey, ...rest] = args;
  if (!boxId || !requestKey)
    throw new Error("delegate <box-id> <request-key> [flags] <text>");
  const payload: Record<string, unknown> = {};
  let i = 0;
  for (; i < rest.length && rest[i]!.startsWith("--"); i++) {
    const flag = flags[rest[i] as keyof typeof flags];
    if (!flag) throw new Error(`Unknown flag ${rest[i]}`);
    payload[flag] = true;
  }
  const text = rest.slice(i).join(" ");
  if (text) payload.text = text;
  return { boxId, requestKey, payload };
}

/** `steer <box-id> <task-id> <request-key> <text…>`. */
export function steerArgs(args: string[]) {
  const [boxId, taskId, requestKey, ...rest] = args;
  const text = rest.join(" ");
  if (!boxId || !taskId || !requestKey || !text)
    throw new Error("steer <box-id> <task-id> <request-key> <text>");
  return { boxId, taskId, requestKey, text };
}
