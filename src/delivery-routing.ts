import type { Database } from "./db.js";
import type { Delivery } from "./answer.js";

export type Destination =
  | { kind: "general" }
  | { kind: "thread"; threadId: number }
  | { kind: "topic"; topic: "news" | "markets" | "coding" | "updates" };

export const threadId = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 1
    ? value
    : undefined;
export const sameThread = (a: unknown, b: unknown) =>
  threadId(a) === threadId(b);

/** Routing authority is host metadata, never fields supplied in a model answer. */
export function destination(input: {
  kind:
    "foreground" | "owner_work" | "unprompted" | "news" | "markets" | "notice";
  threadId?: number;
  reason?: string;
}): Destination {
  if (input.kind === "foreground" || input.kind === "owner_work")
    return threadId(input.threadId)
      ? { kind: "thread", threadId: threadId(input.threadId)! }
      : { kind: "general" };
  if (input.kind === "news" || input.kind === "markets")
    return { kind: "topic", topic: input.kind };
  return { kind: "general" };
}

/** Redirect already queued background posts away from the retired Updates feed. */
export function workDestination(payload: Delivery): Destination {
  if (
    payload.sourceLabel ||
    (payload.destination?.kind === "topic" &&
      payload.destination.topic === "updates")
  )
    return { kind: "general" };
  return payload.destination ?? { kind: "general" };
}

export async function taskDelivery(
  db: Database,
  user: string,
  task: string,
  payload: Delivery,
) {
  const saved = (
    await db.query(
      `SELECT t.delivery_context,r.name FROM work_tasks t
     LEFT JOIN routine_occurrences o ON o.task_id=t.id AND o.user_id=t.user_id
     LEFT JOIN agent_routines r ON r.id=o.routine_id AND r.user_id=t.user_id
     WHERE t.id=$1 AND t.user_id=$2`,
      [task, user],
    )
  ).rows[0];
  if (!saved) throw new Error("Unknown delivery task");
  const context = saved.delivery_context ?? {};
  const owner = context.source === "owner" || (!context.source && !saved.name);
  const target = destination({
    kind: owner ? "owner_work" : "unprompted",
    threadId: context.threadId,
    reason: payload.reason,
  });
  return {
    ...payload,
    destination: target,
    ...(owner
      ? {}
      : {
          sourceLabel: saved.name
            ? `From routine '${String(saved.name).slice(0, 120)}':`
            : "From background work:",
        }),
  } satisfies Delivery;
}

export const slowReply = (
  input: { threadId?: number; receivedAt?: string; pointerSent?: boolean },
  now = Date.now(),
) =>
  !!threadId(input.threadId) &&
  !input.pointerSent &&
  !!input.receivedAt &&
  Number.isFinite(Date.parse(input.receivedAt)) &&
  now - Date.parse(input.receivedAt) > 60_000;
