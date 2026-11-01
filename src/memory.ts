// Revisioned owner memory (issue #326 phase 1, design in docs/learning.md).
//
// Every change is a new immutable revision with its provenance; a head points at the
// current one. Retiring and rolling back append revisions too, so no earlier value is ever
// lost. The legacy `memories` table remains the projection of the owner's active explicit
// facts for job analysis, job alignment and older images.
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { transaction } from "./db-transaction.js";
import { ToolValidationError } from "./tool-errors.js";

export type MemoryKind = "fact" | "lesson";
export type MemoryOrigin = "owner" | "learned" | "legacy" | "rollback";
export type MemoryTrust = "owner" | "untrusted" | "unknown";

export interface MemoryWrite {
  key: string;
  value: string;
  kind: MemoryKind;
  origin: "owner" | "learned";
  reason: string;
  /** Run, input, task, step, invocation and message IDs the item came from. */
  source: Record<string, unknown>;
  learnerRun?: string;
  /** Kinds of untrusted content the learning run read (email, web, document, agent_report). */
  untrustedSources?: string[];
  /** Host flags to add to the threat scan's, such as a fact reworded beyond its quote. */
  flags?: string[];
  outcome?: "success" | "pitfall";
  domain?: string;
}

export interface MemoryRevision {
  id: string;
  key: string;
  revision: number;
  kind: MemoryKind;
  status: "active" | "retired";
  value: string | null;
  outcome: "success" | "pitfall" | null;
  domain: string | null;
  origin: MemoryOrigin;
  reason: string;
  source: Record<string, unknown>;
  learner_run: string | null;
  trust: MemoryTrust;
  untrusted_sources: string[];
  flags: string[];
  created_at: string;
  pinned?: boolean;
}

export interface LearnedItem {
  key: string;
  kind: MemoryKind;
  value: string;
  outcome?: "success" | "pitfall";
  domain?: string;
}

export interface MemorySelection {
  /** Facts the owner asked to keep, plus imported ones; all are always included, as before. */
  explicit: { key: string; value: string }[];
  /** Learned facts and lessons within the budget, sorted by key so the prefix stays stable. */
  learned: LearnedItem[];
  selected: string[];
  omitted: string[];
  flagged: number;
  chars: number;
}

export interface RollbackFilter {
  learnerRun?: string;
  since?: Date;
  until?: Date;
  untrustedSource?: string;
  kind?: MemoryKind;
}

/** What a run that receives no memories had in context. */
export const emptySelection: MemorySelection = {
  explicit: [],
  learned: [],
  selected: [],
  omitted: [],
  flagged: 0,
  chars: 0,
};

/** Characters of learned facts and lessons offered to one run. Owner facts are not capped. */
export const LEARNED_BUDGET_CHARS = 12000;

// Flag, never block: a flagged item is applied and listed first in the digest.
const THREATS: Array<[string, RegExp]> = [
  [
    "injection",
    /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|any|your)\b.{0,30}\b(instructions?|rules?|prompts?|guidelines?)\b/i,
  ],
  [
    "injection",
    /\b(system prompt|developer message|you are now|new instructions?|act as (an?|the) )\b/i,
  ],
  [
    "exfiltration",
    /\b(send|forward|post|upload|email|share)\b.{0,60}\b(passwords?|tokens?|api[ _-]?keys?|secrets?|credentials?|otp|pin)\b/i,
  ],
  ["exfiltration", /https?:\/\/\S*[?&][^=\s&]+=\S/i],
  ["invisible_text", /[​-‏‪-‮⁠-⁤﻿]/],
  [
    "secret",
    /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,})\b/,
  ],
];

export function scanThreats(text: string): string[] {
  return [
    ...new Set(THREATS.filter(([, re]) => re.test(text)).map(([f]) => f)),
  ];
}

const COLUMNS = `r.id,r.key,r.revision,r.kind,r.status,r.value,r.outcome,r.domain,r.origin,r.reason,
  r.source,r.learner_run,r.trust,r.untrusted_sources,r.flags,r.created_at::text AS created_at`;

// A restored copy names the original revision it restored (never another copy), so its
// origin is one level deep.
export const isLearned = (r: Pick<MemoryRevision, "origin" | "source">) =>
  r.origin === "learned" ||
  (r.origin === "rollback" && r.source.restoredOrigin === "learned");

const trustOf = (origin: "owner" | "learned", untrusted: string[]) =>
  origin === "learned" && untrusted.length ? "untrusted" : "owner";

const time = (r: Pick<MemoryRevision, "created_at">) =>
  Date.parse(r.created_at);

export class MemoryStore {
  constructor(private db: Database) {}

  /** Record a fact or lesson as the key's next revision. */
  async write(user: string, w: MemoryWrite) {
    // Refused before any mutation, so a refusal is never an uncertain write.
    if (w.kind === "fact" && (w.outcome || w.domain))
      throw new ToolValidationError("Facts carry no outcome or domain");
    if ((w.kind === "lesson") !== w.key.startsWith("lesson:"))
      throw new ToolValidationError(
        "Lesson keys, and only lesson keys, start with lesson:",
      );
    return transaction(this.db, async (client) => {
      const head = await this.lockHead(client, user, w.key);
      if (head && head.kind !== w.kind)
        throw new ToolValidationError(
          `Memory ${w.key} is a ${head.kind}, not a ${w.kind}`,
        );
      const flags = [...scanThreats(w.value), ...(w.flags ?? [])];
      // Newer evidence wins as a new revision; a learned change to an owner's fact is
      // flagged for the digest.
      if (
        w.origin === "learned" &&
        head?.status === "active" &&
        !isLearned(head)
      )
        flags.push("conflict");
      const untrusted = [...new Set(w.untrustedSources ?? [])].sort();
      return this.append(client, user, {
        key: w.key,
        revision: (head?.revision ?? 0) + 1,
        kind: w.kind,
        status: "active",
        value: w.value,
        outcome: w.outcome ?? null,
        domain: w.domain ?? null,
        origin: w.origin,
        reason: w.reason,
        source: w.source,
        learnerRun: w.learnerRun ?? null,
        trust: trustOf(w.origin, untrusted),
        untrusted,
        flags,
      });
    });
  }

  /**
   * Retire a key as a new revision. Returns null when it holds nothing active. The
   * retirement carries its own trust: a learner retiring an item after reading email is
   * tagged with email, so a rollback by source undoes the retirement too.
   */
  async retire(
    user: string,
    key: string,
    by: {
      origin: "owner" | "learned";
      reason: string;
      learnerRun?: string;
      untrustedSources?: string[];
    },
    source: Record<string, unknown> = {},
  ) {
    const untrusted = [...new Set(by.untrustedSources ?? [])].sort();
    return transaction(this.db, async (client) => {
      const head = await this.lockHead(client, user, key);
      if (!head || head.status !== "active") return null;
      return this.append(client, user, {
        ...this.carry(head),
        revision: head.revision + 1,
        status: "retired",
        value: null,
        origin: by.origin,
        reason: by.reason,
        source,
        learnerRun: by.learnerRun ?? null,
        trust: trustOf(by.origin, untrusted),
        untrusted,
        flags: [],
      });
    });
  }

  /**
   * Undo the learner revisions that match the filter. Each one is recorded in
   * `memory_undone` and never restored again. A key whose current value came from an undone
   * revision returns to the latest revision that is neither undone nor a restored copy, or
   * is retired when that is none or a retirement. A key whose current value came from
   * anything else, such as a later owner revision, is left alone. The undo is itself a
   * revision, and repeating a rollback changes nothing.
   */
  async rollback(user: string, filter: RollbackFilter, reason: string) {
    if (
      !filter.learnerRun &&
      !filter.since &&
      !filter.until &&
      !filter.untrustedSource &&
      !filter.kind
    )
      throw new ToolValidationError("A rollback needs at least one filter");
    // Only the learner's own revisions match. Restored copies resolve to their original.
    const matches = (r: MemoryRevision) =>
      r.origin === "learned" &&
      (!filter.learnerRun || r.learner_run === filter.learnerRun) &&
      (!filter.since || time(r) >= filter.since.getTime()) &&
      (!filter.until || time(r) < filter.until.getTime()) &&
      (!filter.untrustedSource ||
        r.untrusted_sources.includes(filter.untrustedSource)) &&
      (!filter.kind || r.kind === filter.kind);
    return transaction(this.db, async (client) => {
      await this.lockOwner(client, user);
      const revisions = (
        await client.query(
          `SELECT ${COLUMNS} FROM memory_revisions r WHERE r.user_id=$1
           ORDER BY r.key,r.revision`,
          [user],
        )
      ).rows as MemoryRevision[];
      const undone = new Set<string>(
        (
          await client.query(
            "SELECT revision_id FROM memory_undone WHERE user_id=$1",
            [user],
          )
        ).rows.map((r) => r.revision_id),
      );
      const byKey = new Map<string, MemoryRevision[]>();
      for (const r of revisions)
        byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
      let restored = 0;
      let retired = 0;
      let matched = 0;
      for (const [key, history] of byKey) {
        const fresh = history.filter((r) => !undone.has(r.id) && matches(r));
        for (const r of fresh) {
          await client.query(
            "INSERT INTO memory_undone(user_id,revision_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [user, r.id, reason],
          );
          undone.add(r.id);
        }
        matched += fresh.length;
        if (!fresh.length) continue;
        const byId = new Map(history.map((r) => [r.id, r]));
        const original = (r: MemoryRevision) =>
          r.origin === "rollback" && typeof r.source.restoredFrom === "string"
            ? (byId.get(r.source.restoredFrom) ?? r)
            : r;
        const head = history.at(-1)!;
        if (!undone.has(original(head).id)) continue;
        const keep = history
          .slice(0, -1)
          .reverse()
          .find((r) => r.origin !== "rollback" && !undone.has(r.id));
        const source = {
          rollback: { of: head.id, ...this.describe(filter) },
          ...(keep
            ? { restoredFrom: keep.id, restoredOrigin: keep.origin }
            : {}),
        };
        if (keep?.status === "active") {
          await this.append(client, user, {
            ...this.carry(keep),
            key,
            revision: head.revision + 1,
            status: "active",
            value: keep.value,
            origin: "rollback",
            reason,
            source,
            learnerRun: null,
            flags: keep.flags,
          });
          restored++;
        } else if (head.status === "active") {
          await this.append(client, user, {
            ...this.carry(head),
            revision: head.revision + 1,
            status: "retired",
            value: null,
            origin: "rollback",
            reason,
            source,
            learnerRun: null,
            flags: [],
          });
          retired++;
        }
      }
      return { undone: matched, restored, retired };
    });
  }

  /** Active items, owner facts first. */
  async active(user: string): Promise<MemoryRevision[]> {
    return (
      await this.db.query(
        `SELECT ${COLUMNS},h.pinned FROM memory_heads h JOIN memory_revisions r
         ON r.user_id=h.user_id AND r.id=h.revision_id
         WHERE h.user_id=$1 AND r.status='active' ORDER BY r.key`,
        [user],
      )
    ).rows;
  }

  async history(user: string, key: string): Promise<MemoryRevision[]> {
    return (
      await this.db.query(
        `SELECT ${COLUMNS} FROM memory_revisions r WHERE r.user_id=$1 AND r.key=$2
         ORDER BY r.revision`,
        [user, key],
      )
    ).rows;
  }

  /**
   * What one run gets in context. Owner and imported facts are always included, as before
   * this store existed. Learned items are added pinned first, then newest first, until the
   * budget is spent; the result is sorted by key so an unchanged set keeps the cached prefix.
   */
  async select(
    user: string,
    budget = LEARNED_BUDGET_CHARS,
  ): Promise<MemorySelection> {
    const items = await this.active(user);
    const explicit: MemorySelection["explicit"] = [];
    const candidates: MemoryRevision[] = [];
    for (const r of items) {
      if (isLearned(r)) candidates.push(r);
      else if (r.kind === "fact")
        explicit.push({ key: r.key, value: r.value! });
    }
    candidates.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        time(b) - time(a) ||
        a.key.localeCompare(b.key),
    );
    const learned: Array<LearnedItem & { id: string }> = [];
    const omitted: string[] = [];
    let chars = 0;
    for (const r of candidates) {
      const item: LearnedItem = {
        key: r.key,
        kind: r.kind,
        value: r.value!,
        ...(r.outcome ? { outcome: r.outcome } : {}),
        ...(r.domain ? { domain: r.domain } : {}),
      };
      const size = JSON.stringify(item).length + 1;
      if (chars + size > budget) omitted.push(r.id);
      else {
        learned.push({ ...item, id: r.id });
        chars += size;
      }
    }
    learned.sort((a, b) => a.key.localeCompare(b.key));
    const selected = new Set([
      ...items
        .filter((r) => !isLearned(r) && r.kind === "fact")
        .map((r) => r.id),
      ...learned.map((l) => l.id),
    ]);
    return {
      explicit,
      learned: learned.map(({ id: _id, ...item }) => item),
      selected: [...selected],
      omitted,
      // Learned items only, rescanned on load so a pattern added later also flags older
      // ones. The owner's own facts are theirs to word as they like. A reworded fact is
      // normal under "save, prune later": findable by its flag, but not a warning.
      flagged: candidates.filter(
        (r) =>
          selected.has(r.id) &&
          (r.flags.some((f) => f !== "paraphrased") ||
            scanThreats(r.value!).length > 0),
      ).length,
      chars: JSON.stringify(explicit).length + chars,
    };
  }

  /** Record what a run had in context; the first record for a run wins. */
  async recordContext(user: string, run: string, s: MemorySelection) {
    await this.db.query(
      `INSERT INTO memory_context(run_id,user_id,selected,omitted,chars)
       VALUES($1,$2,$3::uuid[],$4::uuid[],$5) ON CONFLICT(run_id) DO NOTHING`,
      [run, user, s.selected, s.omitted, s.chars],
    );
  }

  /**
   * Import `memories` rows that the revisions do not hold: every row on first start, and
   * any row an older image wrote after a rollback. The original source is unknown, so it
   * is recorded as unknown rather than guessed. Also restores a missing projection row.
   */
  async importLegacy(): Promise<{ imported: number; projected: number }> {
    let imported = 0;
    let projected = 0;
    const rows = (
      await this.db.query(
        `SELECT m.user_id,m.key,m.value,m.updated_at::text AS updated_at FROM memories m
         LEFT JOIN memory_heads h ON h.user_id=m.user_id AND h.key=m.key
         LEFT JOIN memory_revisions r ON r.user_id=h.user_id AND r.id=h.revision_id
         WHERE r.id IS NULL OR r.status<>'active' OR r.kind<>'fact' OR r.value<>m.value
         OR (r.origin='learned' OR (r.origin='rollback' AND r.source->>'restoredOrigin'='learned'))`,
      )
    ).rows as Array<{
      user_id: string;
      key: string;
      value: string;
      updated_at: string;
    }>;
    for (const row of rows)
      await transaction(this.db, async (client) => {
        const head = await this.lockHead(client, row.user_id, row.key);
        const current = (
          await client.query(
            "SELECT value FROM memories WHERE user_id=$1 AND key=$2",
            [row.user_id, row.key],
          )
        ).rows[0]?.value as string | undefined;
        if (current === undefined) return;
        if (
          head?.status === "active" &&
          head.kind === "fact" &&
          !isLearned(head) &&
          head.value === current
        )
          return;
        if (head && head.kind !== "fact") return; // a lesson key is never projected
        await this.append(client, row.user_id, {
          key: row.key,
          revision: (head?.revision ?? 0) + 1,
          kind: "fact",
          status: "active",
          value: current,
          outcome: null,
          domain: null,
          origin: "legacy",
          reason: "Imported from the memories table; original source unknown",
          source: { importedFrom: "memories", updatedAt: row.updated_at },
          learnerRun: null,
          trust: "unknown",
          untrusted: [],
          flags: scanThreats(current),
        });
        imported++;
      });
    const missing = await this.db.query(
      `INSERT INTO memories(user_id,key,value)
       SELECT r.user_id,r.key,r.value FROM memory_heads h JOIN memory_revisions r
       ON r.user_id=h.user_id AND r.id=h.revision_id
       WHERE r.status='active' AND r.kind='fact' AND NOT (r.origin='learned' OR (r.origin='rollback' AND r.source->>'restoredOrigin'='learned'))
       AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.user_id=r.user_id AND m.key=r.key)
       ON CONFLICT DO NOTHING RETURNING key`,
    );
    projected = missing.rows.length;
    return { imported, projected };
  }

  private describe(f: RollbackFilter) {
    return {
      ...(f.learnerRun ? { learnerRun: f.learnerRun } : {}),
      ...(f.since ? { since: f.since.toISOString() } : {}),
      ...(f.until ? { until: f.until.toISOString() } : {}),
      ...(f.untrustedSource ? { untrustedSource: f.untrustedSource } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
    };
  }

  private carry(r: MemoryRevision) {
    return {
      key: r.key,
      kind: r.kind,
      outcome: r.outcome,
      domain: r.domain,
      trust: r.trust,
      untrusted: r.untrusted_sources,
    };
  }

  // One owner's memory writes are serialized, so revision numbers never race.
  private async lockOwner(client: Database, user: string) {
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user]);
  }

  private async lockHead(client: Database, user: string, key: string) {
    await this.lockOwner(client, user);
    return (
      await client.query(
        `SELECT ${COLUMNS} FROM memory_heads h JOIN memory_revisions r
         ON r.user_id=h.user_id AND r.id=h.revision_id WHERE h.user_id=$1 AND h.key=$2`,
        [user, key],
      )
    ).rows[0] as MemoryRevision | undefined;
  }

  private async append(
    client: Database,
    user: string,
    r: {
      key: string;
      revision: number;
      kind: MemoryKind;
      status: "active" | "retired";
      value: string | null;
      outcome: "success" | "pitfall" | null;
      domain: string | null;
      origin: MemoryOrigin;
      reason: string;
      source: Record<string, unknown>;
      learnerRun: string | null;
      trust: MemoryTrust;
      untrusted: string[];
      flags: string[];
    },
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO memory_revisions(id,user_id,key,revision,kind,status,value,outcome,domain,
       origin,reason,source,learner_run,trust,untrusted_sources,flags)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::text[],$16::text[])`,
      [
        id,
        user,
        r.key,
        r.revision,
        r.kind,
        r.status,
        r.value,
        r.outcome,
        r.domain,
        r.origin,
        r.reason,
        JSON.stringify(r.source),
        r.learnerRun,
        r.trust,
        r.untrusted,
        [...new Set(r.flags)].sort(),
      ],
    );
    await client.query(
      `INSERT INTO memory_heads(user_id,key,revision_id) VALUES($1,$2,$3)
       ON CONFLICT(user_id,key) DO UPDATE SET revision_id=EXCLUDED.revision_id`,
      [user, r.key, id],
    );
    // The projection holds the owner's explicit facts only, so older readers (job analysis,
    // job alignment, an older image) never see a learned fact unlabelled.
    if (r.kind === "fact") {
      if (r.status === "active" && !isLearned(r))
        await client.query(
          `INSERT INTO memories(user_id,key,value) VALUES($1,$2,$3)
           ON CONFLICT(user_id,key) DO UPDATE SET value=$3,updated_at=now()`,
          [user, r.key, r.value],
        );
      else
        await client.query("DELETE FROM memories WHERE user_id=$1 AND key=$2", [
          user,
          r.key,
        ]);
    }
    return {
      id,
      key: r.key,
      revision: r.revision,
      status: r.status,
      flags: [...new Set(r.flags)].sort(),
    };
  }
}
