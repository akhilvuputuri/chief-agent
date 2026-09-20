import { randomUUID } from "node:crypto";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "./db.js";
import { event } from "./db.js";
import { Bearer, LibraryClient, LibraryError } from "./library-client.js";
import { LibraryIdentity } from "./library-identity.js";
import {
  linkConfirming,
  linkDone,
  linkFailed,
  linkProgress,
} from "./library-cards.js";
export const linkLimits = {
  pollMs: 5000,
  deadlineMs: 5 * 60000,
  maxPolls: 60,
  maxEdits: 6,
  /** Libby syncs the card straight to the displaying identity; a sync check every N polls is the real completion signal. */
  syncEveryPolls: 4,
  attemptsPerDay: 2,
  fallbackWindowMs: 15 * 60000,
};
const codeResponse = z
  .object({
    result: z.string(),
    code: z.string().optional(),
    expiry: z.number().optional(),
    blessing: z.string().optional(),
  })
  .passthrough();
/** POST chip/clone may answer with a renewed identity; anything else is ignored. */
const cloneResponse = z
  .object({ identity: z.string().optional(), expiry: z.number().optional() })
  .passthrough();
export interface LinkApi {
  editMessageText(
    chat: string,
    messageId: number,
    text: string,
    extra?: {
      reply_markup?: {
        inline_keyboard: { text: string; callback_data: string }[][];
      };
    },
  ): Promise<unknown>;
}
export type LinkOutcome =
  | { status: "done"; loans: number; holds: number }
  | { status: "expired" | "aborted" | "failed" | "uncertain" };
/**
 * The phone-only linking ceremony. Runs detached from the Telegram callback so the owner's
 * control queue is never held; every poll result is journaled as an enum, never the code.
 */
export class LinkCeremony {
  constructor(
    private db: Database,
    private client: LibraryClient,
    private identity: LibraryIdentity,
    private api: LinkApi,
    private onFinished: (
      user: string,
      approvalId: string,
      outcome: LinkOutcome,
    ) => Promise<void>,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => delay(ms),
    private limits = linkLimits,
  ) {}
  async attemptsToday(user: string) {
    return Number(
      (
        await this.db.query(
          "SELECT count(*)::int AS n FROM library_link_attempts WHERE user_id=$1 AND started_at>now()-interval '1 day'",
          [user],
        )
      ).rows[0]?.n ?? 0,
    );
  }
  async liveAttempt(user: string) {
    return (
      await this.db.query(
        "SELECT id,approval_id,state,direction,deadline_at,telegram_message_id FROM library_link_attempts WHERE user_id=$1 AND state IN ('displaying','fulfilled','completing') ORDER BY started_at DESC LIMIT 1",
        [user],
      )
    ).rows[0];
  }
  /** Creates the attempt row and starts the detached loop; returns at once. */
  async start(
    user: string,
    approvalId: string,
    chat: string,
    messageId: number | null,
  ) {
    const id = randomUUID();
    const deadline = new Date(
      this.now() + this.limits.deadlineMs,
    ).toISOString();
    await this.db.query(
      "INSERT INTO library_link_attempts(id,user_id,approval_id,direction,state,deadline_at,telegram_message_id) VALUES($1,$2,$3,'display','displaying',$4,$5)",
      [id, user, approvalId, deadline, messageId],
    );
    void this.run(user, id, approvalId, chat, messageId, deadline).catch(
      async () => {
        await this.finish(user, id, approvalId, chat, messageId, {
          status: "failed",
        }).catch(() => {});
      },
    );
    return id;
  }
  private keyboard(attemptId: string) {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Stop linking", callback_data: `lib:abort:${attemptId}` }],
        ],
      },
    };
  }
  private async edit(
    chat: string,
    messageId: number | null,
    text: string,
    extra?: ReturnType<LinkCeremony["keyboard"]>,
  ) {
    if (messageId === null) return;
    await this.api
      .editMessageText(chat, messageId, text, extra)
      .catch(() => {});
  }
  private async progress(
    attemptId: string,
    fields: {
      polls?: number;
      rotations?: number;
      last_result?: string;
      state?: string;
    },
  ) {
    await this.db.query(
      "UPDATE library_link_attempts SET polls=COALESCE($2,polls),rotations=COALESCE($3,rotations),last_result=COALESCE($4,last_result),state=COALESCE($5,state) WHERE id=$1",
      [
        attemptId,
        fields.polls ?? null,
        fields.rotations ?? null,
        fields.last_result ?? null,
        fields.state ?? null,
      ],
    );
  }
  private async aborted(attemptId: string) {
    return !!(
      await this.db.query(
        "SELECT 1 FROM library_link_attempts WHERE id=$1 AND abort_requested",
        [attemptId],
      )
    ).rows.length;
  }
  private async run(
    user: string,
    attemptId: string,
    approvalId: string,
    chat: string,
    messageId: number | null,
    deadline: string,
  ) {
    const bearer = await this.identity.mint(user);
    let polls = 0;
    let rotations = 0;
    let edits = 0;
    let code: string | null = null;
    const deadlineAt = Date.parse(deadline);
    // Libby's own client polls with the code it is displaying; without it the server only
    // issues or retains codes and never reports fulfilment.
    const poll = () =>
      this.client.call("chipCloneCode", {
        query: { role: "pointer", ...(code ? { code } : {}) },
        bearer,
        schema: codeResponse,
        context: "background",
      });
    for (;;) {
      if (await this.aborted(attemptId))
        return this.finish(user, attemptId, approvalId, chat, messageId, {
          status: "aborted",
        });
      if (this.now() >= deadlineAt || polls >= this.limits.maxPolls)
        return this.finish(user, attemptId, approvalId, chat, messageId, {
          status: "expired",
        });
      let answer: z.infer<typeof codeResponse>;
      try {
        answer = await poll();
      } catch (error) {
        if (error instanceof LibraryError && error.kind === "transient") {
          await this.sleep(this.limits.pollMs);
          continue;
        }
        throw error;
      }
      polls++;
      const raw = answer.result.toLowerCase();
      const result = ["regenerated", "retained", "fulfilled"].includes(raw)
        ? raw
        : "other";
      await event(this.db, user, approvalId, "library.link_progress", {
        attemptId,
        result,
        polls,
        keys: Object.keys(answer)
          .filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k))
          .slice(0, 40),
      });
      // Observed on the first real link: the phone reported success while the code poll kept
      // answering "retained". The card arrives on the identity itself, so check the sync.
      if (result === "fulfilled" || polls % this.limits.syncEveryPolls === 0) {
        const arrived = await this.cardArrived(user, bearer);
        if (arrived || result === "fulfilled") {
          await this.progress(attemptId, {
            polls,
            rotations,
            last_result: result,
            state: "fulfilled",
          });
          await this.edit(chat, messageId, linkConfirming);
          return this.complete(
            user,
            attemptId,
            approvalId,
            chat,
            messageId,
            bearer,
            arrived,
            answer.blessing,
          );
        }
      }
      if (answer.code && answer.code !== code) {
        if (code !== null) rotations++;
        code = answer.code;
        if (edits < this.limits.maxEdits) {
          edits++;
          await this.edit(
            chat,
            messageId,
            linkProgress(code, deadline),
            this.keyboard(attemptId),
          );
        }
      }
      await this.progress(attemptId, { polls, rotations, last_result: result });
      await this.sleep(this.limits.pollMs);
    }
  }
  /** One paced sync with the attempt's bearer; the sync result when a card is already present. */
  private async cardArrived(user: string, bearer: Bearer) {
    try {
      const synced = await this.identity.syncRaw(user, bearer);
      return synced.card ? synced : null;
    } catch (error) {
      if (error instanceof LibraryError) return null;
      throw error;
    }
  }
  /** Settles a completing attempt from the Check shelf path: linked, or discarded so a fresh attempt is allowed. */
  async settle(user: string, approvalId: string, linked: boolean) {
    await this.db.query(
      "UPDATE library_link_attempts SET state=$3,finished_at=now() WHERE user_id=$1 AND approval_id=$2 AND state IN ('fulfilled','completing')",
      [user, approvalId, linked ? "done" : "failed"],
    );
    if (!linked) await this.identity.discard(user, true);
  }
  /** Fallback direction: the owner read a code in Libby and typed it here. */
  async enterCode(
    user: string,
    approvalId: string,
    chat: string,
    code: string,
  ) {
    const id = randomUUID();
    const deadline = new Date(
      this.now() + this.limits.deadlineMs,
    ).toISOString();
    await this.db.query(
      "INSERT INTO library_link_attempts(id,user_id,approval_id,direction,state,deadline_at) VALUES($1,$2,$3,'enter','fulfilled',$4)",
      [id, user, approvalId, deadline],
    );
    try {
      const existing = await this.identity.row(user);
      const bearer =
        existing && ["linking", "anonymous"].includes(existing.state)
          ? await this.identity.remint(user, "linking")
          : await this.identity.mint(user);
      const entered = await this.client.call("chipCloneEnter", {
        bearer,
        body: { code, role: "pointer" },
        schema: codeResponse.partial({ result: true }),
        context: "background",
      });
      // Libby's entering side treats an answer without a blessing as "transfer done".
      const already = entered.blessing
        ? null
        : await this.cardArrived(user, bearer);
      await event(this.db, user, approvalId, "library.link_progress", {
        attemptId: id,
        result: "entered",
        polls: 0,
      });
      return await this.complete(
        user,
        id,
        approvalId,
        chat,
        null,
        bearer,
        already,
        entered.blessing,
      );
    } catch (error) {
      await this.progress(id, {
        last_result:
          error instanceof LibraryError
            ? "error:" + error.kind
            : "error:" + String((error as Error)?.message ?? "").slice(0, 60),
      });
      const outcome: LinkOutcome = {
        status:
          error instanceof LibraryError && error.kind === "rejected"
            ? "failed"
            : "uncertain",
      };
      await this.finish(user, id, approvalId, chat, null, outcome);
      return outcome;
    }
  }
  private async complete(
    user: string,
    attemptId: string,
    approvalId: string,
    chat: string,
    messageId: number | null,
    bearer: Bearer,
    arrived: Awaited<ReturnType<LinkCeremony["cardArrived"]>> = null,
    blessing?: string,
  ): Promise<LinkOutcome> {
    await this.progress(attemptId, { state: "completing" });
    let cloned = !!arrived;
    try {
      // The card already arrived on this bearer: link it as is. Re-minting here is an
      // unexercised hypothesis that could discard the only token carrying the card; the
      // standing needsRemint path renews it later.
      let synced = arrived;
      if (!synced) {
        if (!blessing) throw new LibraryError("rejected", "no blessing", 0);
        // The documented completion: POST chip/clone {blessing}; the answer may carry a renewed identity.
        const answer = await this.client.call("chipClone", {
          bearer,
          body: { blessing },
          schema: cloneResponse,
          context: "background",
        });
        cloned = true;
        let current = bearer;
        // Hypothesis kept defensively: a clone answer carrying an identity is adopted. Not
        // observed in Libby's client, which instead re-mints with its existing bearer.
        if (answer.identity && answer.identity.length >= 20)
          current = await this.identity.adopt(
            user,
            answer.identity,
            answer.expiry,
          );
        synced = await this.identity.syncRaw(user, current);
        if (!synced.card) {
          // Libby's own client forgets its in-memory identity after the clone and re-mints
          // with the old bearer before syncing; do the same once.
          const renewed = await this.identity.remint(user, "linking");
          synced = await this.identity.syncRaw(user, renewed);
        }
      }
      const { shelf, card, cards } = synced;
      if (!card) {
        const outcome: LinkOutcome = { status: "failed" };
        await this.finish(
          user,
          attemptId,
          approvalId,
          chat,
          messageId,
          outcome,
        );
        return outcome;
      }
      await this.identity.markLinked(user, card.cardId, cards);
      await this.db.query(
        "INSERT INTO library_watch(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET status='scheduled',next_run=now()",
        [user],
      );
      const outcome: LinkOutcome = {
        status: "done",
        loans: shelf.loans.length,
        holds: shelf.holds.length,
      };
      await this.progress(attemptId, { state: "done" });
      await this.db.query(
        "UPDATE library_link_attempts SET finished_at=now() WHERE id=$1",
        [attemptId],
      );
      await this.edit(chat, messageId, linkDone(shelf));
      await this.onFinished(user, approvalId, outcome);
      return outcome;
    } catch (error) {
      await this.progress(attemptId, {
        last_result:
          error instanceof LibraryError
            ? "error:" + error.kind
            : "error:" + String((error as Error)?.message ?? "").slice(0, 60),
      });
      const outcome: LinkOutcome = {
        status:
          error instanceof LibraryError && error.kind === "rejected"
            ? "failed"
            : "uncertain",
      };
      await this.finish(
        user,
        attemptId,
        approvalId,
        chat,
        messageId,
        outcome,
        cloned,
      );
      return outcome;
    }
  }
  private async finish(
    user: string,
    attemptId: string,
    approvalId: string,
    chat: string,
    messageId: number | null,
    outcome: LinkOutcome,
    cloned = false,
  ) {
    const rotations = Number(
      (
        await this.db.query(
          "UPDATE library_link_attempts SET state=$2,finished_at=now() WHERE id=$1 RETURNING rotations",
          [
            attemptId,
            outcome.status === "done"
              ? "done"
              : outcome.status === "uncertain"
                ? "completing"
                : outcome.status,
          ],
        )
      ).rows[0]?.rotations ?? 0,
    );
    // A token discarded after a successful clone may carry the card: revoke it upstream, best effort.
    if (outcome.status !== "uncertain" && outcome.status !== "done")
      await this.identity.discard(user, cloned);
    if (outcome.status !== "done")
      await this.edit(
        chat,
        messageId,
        outcome.status === "uncertain"
          ? "Libby accepted the code but I could not confirm the card yet. Send /library to check; nothing will be retried on its own."
          : linkFailed(outcome.status, rotations),
      );
    await this.onFinished(user, approvalId, outcome);
  }
}
