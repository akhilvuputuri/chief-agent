import { randomUUID } from "node:crypto";
import { type Database, event } from "./db.js";
import { ToolValidationError } from "./tool-errors.js";
import { LibraryClient, LibraryError } from "./library-client.js";
import { LibraryIdentity } from "./library-identity.js";
import { LinkCeremony, linkLimits, type LinkOutcome } from "./library-link.js";
import {
  linkCard,
  revokeCard,
  revokeDone,
  shelfText,
} from "./library-cards.js";
export type LibraryOperation =
  | "library_borrow"
  | "library_hold"
  | "library_hold_cancel"
  | "library_link"
  | "library_revoke";
export const libraryOperations: LibraryOperation[] = [
  "library_borrow",
  "library_hold",
  "library_hold_cancel",
  "library_link",
  "library_revoke",
];
export const approvalLimits = { pendingPerOwner: 5 };
/** Render the authoritative card for a pending row; deadlines from the row itself. */
export function libraryPreview(
  operation: string,
  payload: Record<string, any>,
  expiresAt: string,
) {
  if (operation === "library_link") return linkCard(expiresAt);
  if (operation === "library_revoke") return revokeCard(expiresAt);
  return `Library action ${operation} awaiting approval (details arrive in a later release). Approve by ${new Date(expiresAt).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit" })} SGT.`;
}
export function libraryButtons(operation: string, id: string) {
  const labels: Record<string, [string, string]> = {
    library_link: ["Start linking", "Not now"],
    library_revoke: ["Disconnect", "Keep linked"],
    library_borrow: ["Borrow", "Not now"],
    library_hold: ["Place hold", "Not now"],
    library_hold_cancel: ["Cancel hold", "Keep hold"],
  };
  const [yes, no] = labels[operation] ?? ["Approve", "Decline"];
  return [
    [
      { text: yes, callback_data: `lib:yes:${id}` },
      { text: no, callback_data: `lib:no:${id}` },
    ],
  ];
}
export type DecideResult =
  | { status: "denied"; operation: string }
  | { status: "linking"; operation: "library_link" }
  | {
      status: "created";
      operation: string;
      remote?: boolean;
      expiresAt?: string | null;
      loans?: number;
      holds?: number;
    }
  | { status: "failed"; operation: string; reason: string }
  | { status: "uncertain"; operation: string }
  | { status: "busy" };
/**
 * Approval-gated library actions in the Calendar shape: a draft is a pending row, only the
 * authenticated Telegram tap executes, once, and outcomes are recorded on the row.
 */
export class LibraryActions {
  constructor(
    private db: Database,
    private deps: {
      identity: LibraryIdentity;
      link: LinkCeremony;
      client: LibraryClient;
    },
    private owner: string,
  ) {}
  private assertOwner(user: string) {
    if (!this.owner || user !== this.owner)
      throw new Error("Library account is not connected for this user");
  }
  private async retireExpired(user: string) {
    await this.db.query(
      "UPDATE approvals SET status='denied' WHERE user_id=$1 AND operation LIKE 'library\\_%' AND status='pending' AND expires_at<=now()",
      [user],
    );
  }
  async draft(
    user: string,
    run: string,
    operation: LibraryOperation,
    draft: Record<string, unknown>,
    options: { source?: "chat" | "command" | "watcher"; expires?: string } = {},
  ) {
    this.assertOwner(user);
    await this.retireExpired(user);
    const blocking = (
      await this.db.query(
        "SELECT operation FROM approvals WHERE user_id=$1 AND operation LIKE 'library\\_%' AND operation<>'library_revoke' AND status='approved' AND payload->>'execution' IN ('executing','uncertain') LIMIT 1",
        [user],
      )
    ).rows[0];
    if (blocking && operation !== "library_revoke")
      throw new ToolValidationError(
        "Library validation: an earlier library action is still executing or uncertain; use its Check shelf button first",
      );
    const pending = Number(
      (
        await this.db.query(
          "SELECT count(*)::int AS n FROM approvals WHERE user_id=$1 AND operation LIKE 'library\\_%' AND status='pending'",
          [user],
        )
      ).rows[0]?.n ?? 0,
    );
    if (pending >= approvalLimits.pendingPerOwner)
      throw new ToolValidationError(
        "Library validation: five cards are already waiting in Telegram",
      );
    const id = randomUUID();
    let row;
    try {
      row = (
        await this.db.query(
          "INSERT INTO approvals(id,user_id,run_id,operation,payload,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,now()+$6::interval) RETURNING id,expires_at",
          [
            id,
            user,
            run,
            operation,
            JSON.stringify({
              draft,
              source: options.source ?? "chat",
              execution: "not_started",
            }),
            options.expires ?? "15 minutes",
          ],
        )
      ).rows[0];
    } catch (error: any) {
      if (error?.code === "23505") {
        const existing = (
          await this.db.query(
            "SELECT id FROM approvals WHERE user_id=$1 AND status='pending' AND operation LIKE 'library\\_%' AND payload->'draft'->>'titleId'=$2 LIMIT 1",
            [user, String((draft as any).titleId ?? "")],
          )
        ).rows[0];
        return {
          approvalId: existing?.id ?? null,
          status: "awaiting_approval" as const,
          preview: "",
          note: "A card for this title is already waiting in Telegram; the user should tap it.",
        };
      }
      throw error;
    }
    const expiresAt = new Date(row.expires_at).toISOString();
    return {
      approvalId: id,
      status: "awaiting_approval" as const,
      preview: libraryPreview(operation, { draft }, expiresAt),
      note: "Only saved a proposal. The user must tap the Telegram card. Nothing has happened at the library.",
    };
  }
  async pending(user: string) {
    await this.retireExpired(user);
    return (
      await this.db.query(
        "SELECT id,operation,payload,expires_at FROM approvals WHERE user_id=$1 AND operation LIKE 'library\\_%' AND status='pending' AND expires_at>now() ORDER BY created_at",
        [user],
      )
    ).rows as {
      id: string;
      operation: string;
      payload: any;
      expires_at: string;
    }[];
  }
  /** Host commands: no model, an approval row where a write is involved. */
  async command(
    user: string,
    kind: "shelf" | "link" | "revoke" | "pending" | "code",
    arg: string | undefined,
    chat: string,
  ): Promise<{ text: string; cards?: boolean }> {
    this.assertOwner(user);
    const identity = this.deps.identity;
    if (kind === "shelf") {
      const status = await identity.status(user);
      const usage = await this.deps.client.usage();
      const interrupted = (
        await this.db.query(
          "DELETE FROM library_notices WHERE user_id=$1 AND kind='link_interrupted' RETURNING kind",
          [user],
        )
      ).rows.length;
      return {
        text:
          (interrupted
            ? "A linking attempt was interrupted by a restart; nothing was linked. Send /library link to try again.\n\n"
            : "") +
          shelfText(
            status.linked ? await identity.snapshot(user) : null,
            status.linked,
            usage,
          ),
      };
    }
    if (kind === "pending") {
      const rows = await this.pending(user);
      if (!rows.length) return { text: "No library cards are waiting." };
      await this.db.query(
        "UPDATE approvals SET payload=payload - 'telegramMessageId' WHERE user_id=$1 AND operation LIKE 'library\\_%' AND status='pending'",
        [user],
      );
      return { text: "Re-sending your pending library cards.", cards: true };
    }
    if (kind === "link") {
      const row = await identity.row(user);
      if (row?.state === "linked")
        return {
          text: "Already linked. Send /library revoke first if you want to link a different card.",
        };
      const live = await this.deps.link.liveAttempt(user);
      if (live && live.state !== "completing")
        return {
          text: "A linking attempt is already in progress. Tap Stop linking on that message to abandon it.",
        };
      if (live) {
        // An attempt stuck after the clone: settle it read-only (linked, or discarded) before starting anew.
        const settledResult = await this.decide(user, live.approval_id, true, {
          chat,
        });
        if (settledResult.status === "created")
          return { text: LibraryActions.replyFor(settledResult) };
        if (settledResult.status !== "failed")
          return {
            text: "The last attempt could not be confirmed yet; try /library link again in a minute.",
          };
      }
      if (
        (await this.pending(user)).some((p) => p.operation === "library_link")
      )
        return {
          text: "A link card is already waiting above; tap Start linking on it, or send /library pending to get it again.",
        };
      if (
        (await this.deps.link.attemptsToday(user)) >= linkLimits.attemptsPerDay
      )
        return {
          text: "Four linking attempts were already made today. Try again tomorrow so the library is not called too often.",
        };
      // A previous attempt's identity may already hold the card (Libby syncs to the displaying
      // identity without reporting it on the code poll). One sync settles it without a new code.
      if (row && row.state !== "revoked") {
        try {
          const { shelf, card, cards } = await identity.syncRaw(user);
          if (card) {
            await identity.markLinked(user, card.cardId, cards);
            await this.db.query(
              "INSERT INTO library_watch(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET status='scheduled',next_run=now()",
              [user],
            );
            await event(this.db, user, randomUUID(), "library.link_progress", {
              result: "reused",
              polls: 0,
            });
            return {
              text: `Linked to NLB using the earlier setup: ${shelf.loans.length} loans, ${shelf.holds.length} holds on your shelf. Send /library any time.`,
            };
          }
        } catch (error) {
          if (!(error instanceof LibraryError)) throw error;
        }
      }
      const usage = await this.deps.client.usage();
      if (usage.breakerOpenUntil)
        return {
          text: "Library calls are paused after a throttle signal; try linking later.",
        };
      if (usage.dailyCeiling - usage.callsToday < 80)
        return {
          text: "Not enough library call allowance left today to link safely; try tomorrow.",
        };
      try {
        await this.draft(
          user,
          randomUUID(),
          "library_link",
          {},
          { source: "command" },
        );
      } catch (error) {
        if (error instanceof ToolValidationError)
          return { text: error.message.replace(/^Library validation: /, "") };
        throw error;
      }
      return { text: "Sent you a card to start linking.", cards: true };
    }
    if (kind === "revoke") {
      const row = await identity.row(user);
      if (
        !row ||
        !["linked", "linking", "anonymous", "expired"].includes(row.state)
      )
        return { text: "No Libby link to disconnect." };
      if (
        (await this.pending(user)).some((p) => p.operation === "library_revoke")
      )
        return {
          text: "A disconnect card is already waiting above; tap it, or send /library pending to get it again.",
        };
      await this.draft(
        user,
        randomUUID(),
        "library_revoke",
        {},
        { source: "command" },
      );
      return { text: "Sent you a card to confirm disconnecting.", cards: true };
    }
    // code: the fallback direction within a short window after an approved attempt that never fulfilled.
    if (!arg || !/^\d{8}$/.test(arg))
      return { text: "Send the 8-digit code as /library code 12345678." };
    const row = await identity.row(user);
    if (row?.state === "linked") return { text: "Already linked." };
    const approved = (
      await this.db.query(
        "SELECT id FROM approvals WHERE user_id=$1 AND operation='library_link' AND status='approved' AND (payload->>'startedAt')::timestamptz>now()-($2::int * interval '1 millisecond') AND payload->>'execution'<>'created' ORDER BY created_at DESC LIMIT 1",
        [user, linkLimits.fallbackWindowMs],
      )
    ).rows[0];
    if (!approved)
      return {
        text: "Start with /library link and approve the card first; the code route only works within 15 minutes of that approval.",
      };
    if (await this.deps.link.liveAttempt(user))
      return {
        text: "A linking attempt is still running; tap Stop linking first.",
      };
    const outcome = await this.deps.link.enterCode(
      user,
      approved.id,
      chat,
      arg,
    );
    return {
      text:
        outcome.status === "done"
          ? `Linked to NLB. Shelf now: ${outcome.loans} loans, ${outcome.holds} holds. Send /library any time.`
          : outcome.status === "uncertain"
            ? "Libby accepted the code but I could not confirm the card yet. Send /library to check later."
            : "Libby did not accept that code. Nothing was changed.",
    };
  }
  /** Called by the ceremony when an attempt ends; records the outcome on the approval. */
  async linkFinished(user: string, approvalId: string, outcome: LinkOutcome) {
    const execution =
      outcome.status === "done"
        ? "created"
        : outcome.status === "uncertain"
          ? "uncertain"
          : "failed";
    await this.db.query(
      "UPDATE approvals SET payload=payload || $3::jsonb WHERE id=$1 AND user_id=$2 AND payload->>'execution'<>'created'",
      [
        approvalId,
        user,
        JSON.stringify({
          execution,
          ...(outcome.status === "done"
            ? { result: { loans: outcome.loans, holds: outcome.holds } }
            : { failure: { code: outcome.status } }),
        }),
      ],
    );
    await event(this.db, user, approvalId, "library.link_finished", {
      status: outcome.status,
    });
  }
  async decide(
    user: string,
    id: string,
    approve: boolean,
    context: { chat: string } = { chat: user },
  ): Promise<DecideResult> {
    this.assertOwner(user);
    let claimed;
    try {
      claimed = (
        await this.db.query(
          "UPDATE approvals SET status=$3,payload=payload || $4::jsonb WHERE id=$1 AND user_id=$2 AND operation LIKE 'library\\_%' AND status='pending' AND expires_at>now() RETURNING *",
          [
            id,
            user,
            approve ? "approved" : "denied",
            JSON.stringify(
              approve
                ? {
                    execution: "executing",
                    startedAt: new Date().toISOString(),
                  }
                : { execution: "not_started" },
            ),
          ],
        )
      ).rows[0];
    } catch (error: any) {
      if (error?.code === "23505") return { status: "busy" };
      throw error;
    }
    if (!claimed) return this.reconcile(user, id, approve, context);
    await event(this.db, user, claimed.run_id, "library.approval_decided", {
      id,
      operation: claimed.operation,
      approved: approve,
    });
    if (!approve) return { status: "denied", operation: claimed.operation };
    if (claimed.operation === "library_link") {
      await this.deps.link.start(
        user,
        id,
        context.chat,
        typeof claimed.payload.telegramMessageId === "number"
          ? claimed.payload.telegramMessageId
          : null,
      );
      return { status: "linking", operation: "library_link" };
    }
    if (claimed.operation === "library_revoke") {
      const result = await this.deps.identity.revoke(user);
      await this.record(claimed, {
        remote: result.remote,
        expiresAt: result.expiresAt,
      });
      return {
        status: "created",
        operation: "library_revoke",
        remote: result.remote,
        expiresAt: result.expiresAt,
      };
    }
    await this.db.query(
      'UPDATE approvals SET payload=payload || \'{"execution":"failed","failure":{"code":"not_available_yet"}}\'::jsonb WHERE id=$1 AND user_id=$2',
      [id, user],
    );
    return {
      status: "failed",
      operation: claimed.operation,
      reason: "borrowing arrives in the next release",
    };
  }
  private async reconcile(
    user: string,
    id: string,
    approve: boolean,
    _context: { chat: string },
  ): Promise<DecideResult> {
    const previous = (
      await this.db.query(
        "SELECT * FROM approvals WHERE id=$1 AND user_id=$2 AND operation LIKE 'library\\_%'",
        [id, user],
      )
    ).rows[0];
    if (!previous || previous.status !== "approved" || !approve)
      throw new Error("Approval unavailable, expired, or already used");
    const execution = previous.payload.execution;
    if (execution === "created")
      return {
        status: "created",
        operation: previous.operation,
        ...previous.payload.result,
      };
    if (execution === "failed")
      return {
        status: "failed",
        operation: previous.operation,
        reason: previous.payload.failure?.code ?? "failed",
      };
    if (previous.operation === "library_link") {
      const live = await this.deps.link.liveAttempt(user);
      if (live && live.state !== "completing")
        return { status: "linking", operation: "library_link" };
      // Read-only check: a card present under the stored token means the clone completed.
      let outcome: "linked" | "absent" | "unknown" = "unknown";
      let counts = { loans: 0, holds: 0 };
      try {
        const { shelf, card, cards } = await this.deps.identity.syncRaw(user);
        if (card) {
          await this.deps.identity.markLinked(user, card.cardId, cards);
          counts = { loans: shelf.loans.length, holds: shelf.holds.length };
          outcome = "linked";
        } else outcome = "absent";
      } catch (error) {
        if (!(error instanceof LibraryError)) throw error;
        if (error.kind === "unauthenticated") outcome = "absent";
      }
      if (outcome === "unknown")
        return { status: "uncertain", operation: previous.operation };
      await this.deps.link.settle(user, id, outcome === "linked");
      if (outcome === "linked") {
        await this.linkFinished(user, id, { status: "done", ...counts });
        return { status: "created", operation: "library_link", ...counts };
      }
      await this.linkFinished(user, id, { status: "failed" });
      return {
        status: "failed",
        operation: "library_link",
        reason: "no card was linked; send /library link to try again",
      };
    }
    return { status: "uncertain", operation: previous.operation };
  }
  private async record(approval: any, result: Record<string, unknown>) {
    await this.db.query(
      `WITH saved AS (
        UPDATE approvals SET payload=payload || $4::jsonb WHERE id=$1 AND user_id=$2 AND payload->>'execution'<>'created' RETURNING id
      ), receipt AS (
        INSERT INTO tool_receipts(id,user_id,run_id,task_id,operation,status,details)
        SELECT $1,$2,$3,(SELECT task_id FROM work_turns WHERE run_id=$3),$5,'success',$6::jsonb FROM saved
        ON CONFLICT(id) DO NOTHING
      ) INSERT INTO events(user_id,run_id,type,data) SELECT $2,$3,$7,$6::jsonb FROM saved`,
      [
        approval.id,
        approval.user_id,
        approval.run_id,
        JSON.stringify({ execution: "created", result }),
        approval.operation,
        JSON.stringify({ approvalId: approval.id, ...result }),
        `library.${approval.operation.replace(/^library_/, "")}_done`,
      ],
    );
  }
  static replyFor(result: DecideResult): string {
    switch (result.status) {
      case "busy":
        return "Another library action is still in progress. Finish it or tap its Check shelf first; nothing was sent.";
      case "denied":
        return result.operation === "library_link"
          ? "Not linked. Nothing changed."
          : result.operation === "library_revoke"
            ? "Still linked."
            : "Nothing changed.";
      case "linking":
        return "Getting a setup code from Libby. This message updates in a moment.";
      case "created":
        if (result.operation === "library_revoke")
          return revokeDone(!!result.remote, result.expiresAt ?? null);
        if (result.operation === "library_link")
          return `Linked to NLB. Shelf now: ${result.loans ?? 0} loans, ${result.holds ?? 0} holds. Send /library any time.`;
        return "Done.";
      case "failed":
        return `The library refused this: ${result.reason.replace(/_/g, " ")}. Nothing was changed.`;
      default:
        return "I could not confirm the outcome. I will not try again on my own. Tap Check shelf and I will look at your shelf.";
    }
  }
}
