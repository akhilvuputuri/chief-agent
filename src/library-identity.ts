import { z } from "zod";
import { type Database, event } from "./db.js";
import { randomUUID } from "node:crypto";
import { Bearer, LibraryClient, LibraryError } from "./library-client.js";
import { libraryKey, websiteId } from "./library-routes.js";
import { open, seal } from "./secret-box.js";
export const identityLimits = {
  tokenLifetimeMs: 7 * 86400000,
  remintBeforeMs: 72 * 3600000,
  syncCacheMs: 15 * 60000,
};
const mintResponse = z.object({
  identity: z.string().min(20),
  expiry: z.number().optional(),
  chip: z.string().optional(),
});
const idText = z.union([z.string(), z.number()]).transform((v) => String(v));
const loan = z.object({
  id: idText,
  title: z.string().default("Untitled"),
  firstCreatorName: z.string().nullable().optional(),
  type: z.object({ id: z.string() }).optional(),
  checkoutDate: z.string().nullable().optional(),
  expireDate: z.string().nullable().optional(),
  isLuckyDayCheckout: z.boolean().optional(),
  cardId: idText.optional(),
});
const hold = z.object({
  id: idText,
  title: z.string().default("Untitled"),
  firstCreatorName: z.string().nullable().optional(),
  isAvailable: z.boolean().optional(),
  estimatedWaitDays: z.number().nullable().optional(),
  placedDate: z.string().nullable().optional(),
  suspensionFlag: z.union([z.boolean(), z.number()]).optional(),
  cardId: idText.optional(),
});
const card = z.object({
  cardId: idText,
  advantageKey: z.string().nullable().optional(),
  library: z
    .object({
      websiteId: z.union([z.number(), z.string()]).optional(),
      name: z.string().optional(),
    })
    .optional(),
  limits: z
    .object({ loan: z.number().optional(), hold: z.number().optional() })
    .optional(),
  counts: z
    .object({ loan: z.number().optional(), hold: z.number().optional() })
    .optional(),
});
const syncResponse = z
  .object({
    cards: z.array(card).default([]),
    loans: z.array(loan).default([]),
    holds: z.array(hold).default([]),
  })
  .passthrough();
/** Structural fingerprint of an upstream body: key names and sizes only, never values. */
export function shapeOf(value: unknown, depth = 0): unknown {
  // Leading letter required: numeric keys could be ids; anything else is masked.
  const name = (k: string) =>
    /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k) ? k : "?";
  if (Array.isArray(value))
    return {
      length: value.length,
      item:
        value.length && depth < 2 ? shapeOf(value[0], depth + 1) : undefined,
    };
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      40,
    );
    return Object.fromEntries(
      entries.map(([k, v]) => [
        name(k),
        depth < 2 && v && typeof v === "object"
          ? shapeOf(v, depth + 1)
          : typeof v,
      ]),
    );
  }
  return value === null ? "null" : typeof value;
}
export type SyncResponse = z.infer<typeof syncResponse>;
export interface ShelfLoan {
  titleId: string;
  title: string;
  creator: string;
  format?: string;
  checkedOutAt?: string;
  expiresAt?: string;
  daysLeft: number | null;
  luckyDay: boolean;
}
export interface ShelfHold {
  titleId: string;
  title: string;
  creator: string;
  ready: boolean;
  estimatedWaitDays: number | null;
  placedAt?: string;
  suspended: boolean;
}
export interface Shelf {
  linked: true;
  syncedAt: string;
  loans: ShelfLoan[];
  holds: ShelfHold[];
  capacity: {
    loans: { used: number; limit?: number };
    holds: { used: number; limit?: number };
  };
}
export type IdentityState =
  "anonymous" | "linking" | "linked" | "expired" | "revoked";
interface Sealed {
  bearer: string;
  cardId: string | null;
  expiresAt: string;
  /** Libby's chip id; its prefix is sent as `v` on renewals, as the official client does. */
  chip?: string;
}
/** Libby's own chip request parameters (client version and shell), not the third-party `client=dewey`. */
export const chipQuery = (chip?: string) => ({
  c: "d:22.1.1",
  s: "0",
  ...(chip ? { v: chip.split("-")[0]! } : {}),
});
export function daysLeft(expiresAt: string | null | undefined, now: number) {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 86400000));
}
export function pickCard(cards: SyncResponse["cards"]) {
  return (
    cards.find(
      (c) =>
        String(c.library?.websiteId ?? "") === String(websiteId) ||
        c.advantageKey === libraryKey,
    ) ?? null
  );
}
/** Owns the encrypted Libby identity. The bearer is decrypted only inside withBearer and never returned. */
export class LibraryIdentity {
  private shelfCache = new Map<string, { at: number; shelf: Shelf }>();
  constructor(
    private db: Database,
    private client: LibraryClient,
    private key: Buffer,
    private now: () => number = Date.now,
  ) {}
  private aad(user: string) {
    return "library-identity-v1:" + user;
  }
  async row(user: string) {
    return (
      await this.db.query(
        "SELECT state,token_expires_at,minted_at,card_id,card_count,linked_at,revoked_at,remote_revoked FROM library_identities WHERE user_id=$1",
        [user],
      )
    ).rows[0] as
      | {
          state: IdentityState;
          token_expires_at: string | null;
          minted_at: string | null;
          card_id: string | null;
          card_count: number;
          linked_at: string | null;
          revoked_at: string | null;
          remote_revoked: boolean;
        }
      | undefined;
  }
  /** Linked state and freshness for the per-turn context; no secrets, no network. */
  async status(user: string) {
    const row = await this.row(user);
    const shelf = (
      await this.db.query(
        "SELECT synced_at FROM library_shelf WHERE user_id=$1",
        [user],
      )
    ).rows[0];
    return {
      state: row?.state ?? ("none" as const),
      linked: row?.state === "linked",
      tokenRenewsBy: row?.token_expires_at
        ? new Date(row.token_expires_at).toISOString()
        : null,
      lastSyncAt: shelf ? new Date(shelf.synced_at).toISOString() : null,
    };
  }
  private async store(
    user: string,
    sealed: Sealed,
    state: IdentityState,
    extra: { cardCount?: number } = {},
  ) {
    const box = seal(this.key, JSON.stringify(sealed), this.aad(user));
    await this.db.query(
      `INSERT INTO library_identities(user_id,state,token_box,token_expires_at,minted_at,card_id,card_count,linked_at)
       VALUES($1,$2,$3,$4,now(),$5,$6,CASE WHEN $2='linked' THEN now() END)
       ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,token_box=EXCLUDED.token_box,token_expires_at=EXCLUDED.token_expires_at,minted_at=now(),card_id=EXCLUDED.card_id,card_count=EXCLUDED.card_count,linked_at=CASE WHEN EXCLUDED.state='linked' THEN COALESCE(library_identities.linked_at,now()) ELSE library_identities.linked_at END,revoked_at=NULL,remote_revoked=false,updated_at=now()`,
      [
        user,
        state,
        box,
        sealed.expiresAt,
        sealed.cardId,
        extra.cardCount ?? (sealed.cardId ? 1 : 0),
      ],
    );
  }
  private async load(user: string): Promise<Sealed | null> {
    const row = (
      await this.db.query(
        "SELECT token_box,state FROM library_identities WHERE user_id=$1",
        [user],
      )
    ).rows[0];
    if (!row?.token_box) return null;
    return JSON.parse(open(this.key, row.token_box, this.aad(user))) as Sealed;
  }
  /** The only decrypt path. fn receives an opaque Bearer and the card id; neither is returned. */
  async withBearer<T>(
    user: string,
    fn: (bearer: Bearer, cardId: string | null) => Promise<T>,
  ): Promise<T> {
    const sealed = await this.load(user);
    if (!sealed)
      throw new LibraryError("unauthenticated", "the Libby card is not linked");
    try {
      return await fn(new Bearer(sealed.bearer), sealed.cardId);
    } catch (error) {
      if (error instanceof LibraryError && error.kind === "unauthenticated")
        await this.db.query(
          "UPDATE library_identities SET state='expired',updated_at=now() WHERE user_id=$1 AND state IN ('linked','anonymous','linking')",
          [user],
        );
      throw error;
    }
  }
  private expiry(response: z.infer<typeof mintResponse>) {
    const seconds = response.expiry;
    const at =
      typeof seconds === "number" && seconds > 1e9
        ? seconds * (seconds > 1e12 ? 1 : 1000)
        : this.now() + identityLimits.tokenLifetimeMs;
    return new Date(at).toISOString();
  }
  /** Mints an anonymous chip for a linking attempt; it holds no card until the clone completes. */
  async mint(user: string) {
    const response = await this.client.call("chipMint", {
      query: chipQuery(),
      schema: mintResponse,
      context: "background",
    });
    await this.store(
      user,
      {
        bearer: response.identity,
        cardId: null,
        expiresAt: this.expiry(response),
        ...(response.chip ? { chip: response.chip } : {}),
      },
      "linking",
    );
    return new Bearer(response.identity);
  }
  /** Re-mints with the current bearer so the token (and any baked-in card) is renewed. */
  async remint(user: string, state: IdentityState = "linked") {
    const previous = await this.load(user);
    return this.withBearer(user, async (bearer, cardId) => {
      const response = await this.client.call("chipMint", {
        query: chipQuery(previous?.chip),
        bearer,
        schema: mintResponse,
        context: "background",
      });
      const chip = response.chip ?? previous?.chip;
      await this.store(
        user,
        {
          bearer: response.identity,
          cardId,
          expiresAt: this.expiry(response),
          ...(chip ? { chip } : {}),
        },
        state,
      );
      return new Bearer(response.identity);
    });
  }
  /** Stores an identity handed back by the clone completion; keeps the card id until sync confirms it. */
  async adopt(user: string, identity: string, expiry?: number) {
    const existing = await this.load(user);
    await this.store(
      user,
      {
        bearer: identity,
        cardId: existing?.cardId ?? null,
        expiresAt: this.expiry({ identity, expiry }),
        ...(existing?.chip ? { chip: existing.chip } : {}),
      },
      "linking",
    );
    return new Bearer(identity);
  }
  async needsRemint(user: string) {
    const row = await this.row(user);
    if (!row || row.state !== "linked" || !row.token_expires_at) return false;
    return (
      new Date(row.token_expires_at).getTime() - this.now() <
      identityLimits.remintBeforeMs
    );
  }
  private project(response: SyncResponse): Shelf {
    const now = this.now();
    const chosen = pickCard(response.cards);
    const mine = <T extends { cardId?: string }>(items: T[]) =>
      chosen && items.some((i) => i.cardId)
        ? items.filter((i) => !i.cardId || i.cardId === chosen.cardId)
        : items;
    const loans = mine(response.loans).map((l) => ({
      titleId: l.id,
      title: l.title,
      creator: l.firstCreatorName ?? "Unknown author",
      ...(l.type?.id ? { format: l.type.id } : {}),
      ...(l.checkoutDate ? { checkedOutAt: l.checkoutDate } : {}),
      ...(l.expireDate ? { expiresAt: l.expireDate } : {}),
      daysLeft: daysLeft(l.expireDate, now),
      luckyDay: !!l.isLuckyDayCheckout,
    }));
    const holds = mine(response.holds).map((h) => ({
      titleId: h.id,
      title: h.title,
      creator: h.firstCreatorName ?? "Unknown author",
      ready: !!h.isAvailable,
      estimatedWaitDays: h.estimatedWaitDays ?? null,
      ...(h.placedDate ? { placedAt: h.placedDate } : {}),
      suspended: !!h.suspensionFlag,
    }));
    return {
      linked: true,
      syncedAt: new Date(now).toISOString(),
      loans,
      holds,
      capacity: {
        loans: {
          used: chosen?.counts?.loan ?? loans.length,
          ...(chosen?.limits?.loan ? { limit: chosen.limits.loan } : {}),
        },
        holds: {
          used: chosen?.counts?.hold ?? holds.length,
          ...(chosen?.limits?.hold ? { limit: chosen.limits.hold } : {}),
        },
      },
    };
  }
  /** Raw sync for the link ceremony and write reconciliation: returns the projection plus the chosen card. */
  async syncRaw(user: string, bearer?: Bearer) {
    const call = (b: Bearer) =>
      this.client.call("chipSync", {
        bearer: b,
        schema: syncResponse,
        context: "background",
      });
    const response = bearer
      ? await call(bearer)
      : await this.withBearer(user, (b) => call(b));
    // Ceremony syncs record the body's shape so an unexpected layout is diagnosable without values.
    if (bearer)
      await event(this.db, user, randomUUID(), "library.sync_shape", {
        shape: shapeOf(response),
      });
    const shelf = this.project(response);
    await this.persist(user, shelf);
    return {
      shelf,
      card: pickCard(response.cards),
      cards: response.cards.length,
    };
  }
  private async persist(user: string, shelf: Shelf) {
    this.shelfCache.set(user, { at: this.now(), shelf });
    await this.db.query(
      "INSERT INTO library_shelf(user_id,synced_at,loans,holds,capacity) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) ON CONFLICT(user_id) DO UPDATE SET synced_at=EXCLUDED.synced_at,loans=EXCLUDED.loans,holds=EXCLUDED.holds,capacity=EXCLUDED.capacity",
      [
        user,
        shelf.syncedAt,
        JSON.stringify(shelf.loans),
        JSON.stringify(shelf.holds),
        JSON.stringify(shelf.capacity),
      ],
    );
  }
  /** Shelf for reads: cached fifteen minutes, one paced sync otherwise. */
  async shelf(user: string, fresh = false): Promise<Shelf> {
    const cached = this.shelfCache.get(user);
    if (!fresh && cached && this.now() - cached.at < identityLimits.syncCacheMs)
      return cached.shelf;
    return (await this.syncRaw(user)).shelf;
  }
  /** Last persisted snapshot with days recomputed; never calls the library. */
  async snapshot(user: string): Promise<Shelf | null> {
    const row = (
      await this.db.query(
        "SELECT synced_at,loans,holds,capacity FROM library_shelf WHERE user_id=$1",
        [user],
      )
    ).rows[0];
    if (!row) return null;
    const now = this.now();
    return {
      linked: true,
      syncedAt: new Date(row.synced_at).toISOString(),
      loans: (row.loans as ShelfLoan[]).map((l) => ({
        ...l,
        daysLeft: daysLeft(l.expiresAt, now),
      })),
      holds: row.holds,
      capacity: row.capacity,
    };
  }
  /** Marks the identity linked once a card is confirmed by sync. */
  async markLinked(user: string, cardId: string, cardCount: number) {
    const sealed = await this.load(user);
    if (!sealed) throw new Error("Library identity missing");
    await this.store(user, { ...sealed, cardId }, "linked", { cardCount });
  }
  /** Forgets an unlinked identity (anonymous chips hold nothing and expire by themselves). */
  async discard(user: string, revokeRemote = false) {
    if (revokeRemote)
      await this.withBearer(user, (bearer) =>
        this.client.call("chipRevoke", {
          bearer,
          schema: z.unknown(),
          context: "background",
        }),
      ).catch(() => {});
    await this.db.query(
      "DELETE FROM library_identities WHERE user_id=$1 AND state IN ('anonymous','linking')",
      [user],
    );
  }
  /**
   * Owner kill switch. Decrypts the bearer first, forgets it locally in one transaction, then
   * makes one remote revoke attempt. Never retried: once token_box is null nothing can retry.
   */
  async revoke(user: string) {
    let sealed: Sealed | null = null;
    try {
      sealed = await this.load(user);
    } catch {
      sealed = null; // unreadable box: wipe locally anyway; the remote token lapses by itself
    }
    // One statement: the pool does not pin a connection across BEGIN/COMMIT.
    await this.db.query(
      `WITH identity AS (
        UPDATE library_identities SET state='revoked',token_box=NULL,card_id=NULL,revoked_at=now(),updated_at=now() WHERE user_id=$1 RETURNING user_id
      ), denied AS (
        UPDATE approvals SET status='denied' WHERE user_id=$1 AND operation LIKE 'library\\_%' AND operation<>'library_revoke' AND status='pending' RETURNING id
      ), paused AS (
        UPDATE library_watch SET status='paused' WHERE user_id=$1 RETURNING user_id
      ) DELETE FROM library_shelf WHERE user_id=$1`,
      [user],
    );
    this.shelfCache.delete(user);
    if (!sealed) return { remote: false as const, expiresAt: null };
    try {
      await this.client.call("chipRevoke", {
        bearer: new Bearer(sealed.bearer),
        schema: z.unknown(),
        context: "background",
      });
      await this.db.query(
        "UPDATE library_identities SET remote_revoked=true,updated_at=now() WHERE user_id=$1",
        [user],
      );
      return { remote: true as const, expiresAt: sealed.expiresAt };
    } catch {
      return { remote: false as const, expiresAt: sealed.expiresAt };
    }
  }
}
