import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { ParcelTools, decides, refKey } from "../src/parcels.js";
import { action } from "../src/protocol.js";
import { runtimeContext } from "../src/runtime.js";
async function fixture() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => /^\d.*sql$/.test(f))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  let now = Date.UTC(2026, 8, 21, 2, 0, 0);
  return {
    pg,
    db,
    tools: new ParcelTools(db, () => now),
    at: (v: number) => (now = v),
  };
}
const email = (messageId: string, observedAt: string, extra: object = {}) => ({
  sourceKind: "email" as const,
  messageId,
  observedAt,
  ...extra,
});
const user = (observedAt?: string) => ({
  sourceKind: "user" as const,
  ...(observedAt ? { observedAt } : {}),
});
const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}T02:00:00Z`;

test("a requested email search can create a parcel a later email updates", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Headphones",
      merchant: "Acme Audio",
      orderRef: "ORD-1234",
      status: "ordered",
      ...email("aa01", day(14), { subject: "Your order" }),
    });
    assert.equal(saved.status, "ordered");
    assert.equal(saved.statusSource, "email");
    assert.equal(saved.created, true);
    assert.match(saved.notice, /never|Nothing here is checked/i);
    const shipped: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "shipped",
      carrier: "SingPost",
      trackingRef: "sp 123-456",
      eta: "2026-09-20",
      ...email("aa02", day(16)),
    });
    assert.equal(shipped.applied, true);
    assert.equal(shipped.status, "shipped");
    assert.equal(shipped.carrier, "SingPost");
    assert.equal(shipped.eta, "2026-09-20");
    // State survives a restart because it is read back from Postgres, not memory.
    const fresh: any = await new ParcelTools(f.db).call("a", {
      operation: "parcel_list",
      id: saved.id,
    });
    assert.equal(fresh.status, "shipped");
    assert.equal(fresh.totalUpdates, 2);
    assert.equal(fresh.history[0].source.messageId, "aa02");
    assert.equal(fresh.history[0].applied, true);
  } finally {
    await f.pg.close();
  }
});

test("an older email does not overwrite newer user input but is still recorded", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Headphones",
      status: "shipped",
      ...email("bb01", day(15)),
    });
    // The owner says it arrived on the 17th.
    const arrived: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "delivered",
      ...user(day(17)),
    });
    assert.equal(arrived.applied, true);
    assert.equal(arrived.status, "delivered");
    // A carrier email describing the 16th arrives late. It must not undo that.
    const stale: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "out_for_delivery",
      ...email("bb02", day(16)),
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.status, "delivered");
    assert.match(stale.ignoredReason, /more recent/);
    // It is still in the history, visibly not applied.
    const read: any = await f.tools.call("a", {
      operation: "parcel_list",
      id: saved.id,
    });
    assert.equal(read.totalUpdates, 3);
    const ignored = read.history.find(
      (h: any) => h.source.messageId === "bb02",
    );
    assert.equal(ignored.applied, false);
    assert.match(ignored.ignoredReason, /more recent/);
  } finally {
    await f.pg.close();
  }
});

test("a newer email still updates a parcel the owner last mentioned long ago", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Kettle",
      status: "ordered",
      ...user(day(1)),
    });
    const later: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "out_for_delivery",
      ...email("cc01", day(20)),
    });
    assert.equal(later.applied, true);
    assert.equal(later.status, "out_for_delivery");
  } finally {
    await f.pg.close();
  }
});

test("an explicit correction wins over a fresher email", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Monitor",
      status: "out_for_delivery",
      ...email("dd01", day(20)),
    });
    // Same observed moment, but the owner is correcting it.
    const corrected: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "delayed",
      note: "driver left a card, nothing arrived",
      ...user(day(20)),
    });
    assert.equal(corrected.applied, true);
    assert.equal(corrected.status, "delayed");
    assert.equal(corrected.statusSource, "user");
  } finally {
    await f.pg.close();
  }
});

test("the same email applied twice changes nothing the second time", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Books",
      status: "ordered",
      ...user(day(10)),
    });
    const first: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "shipped",
      ...email("ee01", day(12)),
    });
    assert.equal(first.applied, true);
    const repeat: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "delivered",
      ...email("ee01", day(13)),
    });
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.applied, false);
    assert.equal(repeat.status, "shipped");
    const read: any = await f.tools.call("a", {
      operation: "parcel_list",
      id: saved.id,
    });
    assert.equal(read.totalUpdates, 2);
  } finally {
    await f.pg.close();
  }
});

test("two parcels under one order stay ambiguous until a tracking reference separates them", async () => {
  const f = await fixture();
  try {
    for (const label of ["Desk lamp", "Desk mat"])
      await f.tools.call("a", {
        operation: "parcel_record",
        label,
        merchant: "Acme Home",
        orderRef: "ORD-77",
        status: "ordered",
        ...user(day(10)),
      });
    const byOrder: any = await f.tools.call("a", {
      operation: "parcel_match",
      orderRef: "ord 77",
      merchant: "Acme Home",
    });
    assert.equal(byOrder.candidates.length, 2);
    assert.equal(byOrder.ambiguous, true);
    assert.equal(byOrder.resolvedId, null);
    assert.match(byOrder.hint, /Ask which one/);
    // Give one of them a tracking reference; now that reference is decisive.
    const lamp = byOrder.candidates.find((c: any) => c.label === "Desk lamp");
    await f.tools.call("a", {
      operation: "parcel_record",
      id: lamp.id,
      trackingRef: "SP-999",
      status: "shipped",
      ...email("ff01", day(11)),
    });
    const byTracking: any = await f.tools.call("a", {
      operation: "parcel_match",
      trackingRef: "sp999",
    });
    assert.equal(byTracking.ambiguous, false);
    assert.equal(byTracking.resolvedId, lamp.id);
    assert.equal(byTracking.candidates[0].matchedOn, "tracking reference");
    // A merchant alone is never decisive.
    const byMerchant: any = await f.tools.call("a", {
      operation: "parcel_match",
      merchant: "Acme Home",
    });
    assert.equal(byMerchant.ambiguous, true);
    assert.ok(byMerchant.candidates.every((c: any) => !c.decisive));
  } finally {
    await f.pg.close();
  }
});

test("parcels are owner scoped for every operation", async () => {
  const f = await fixture();
  try {
    const mine: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Private parcel",
      trackingRef: "SP-1",
      ...user(day(10)),
    });
    await assert.rejects(
      f.tools.call("b", { operation: "parcel_read", id: mine.id }),
      /not found/,
    );
    await assert.rejects(
      f.tools.call("b", {
        operation: "parcel_record",
        id: mine.id,
        status: "delivered",
        ...user(day(11)),
      }),
      /not found/,
    );
    assert.deepEqual(
      (await f.tools.call("b", { operation: "parcel_list" })) as any,
      { parcels: [], notice: (mine as any).notice },
    );
    const other: any = await f.tools.call("b", {
      operation: "parcel_match",
      trackingRef: "SP-1",
    });
    assert.equal(other.candidates.length, 0);
    assert.equal(other.resolvedId, null);
  } finally {
    await f.pg.close();
  }
});

test("archiving is the owner's alone and hides a parcel from the active list", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Old parcel",
      status: "delivered",
      ...user(day(10)),
    });
    await assert.rejects(
      f.tools.call("a", {
        operation: "parcel_record",
        id: saved.id,
        archive: true,
        ...email("gg01", day(11)),
      }),
      /only you can archive/,
    );
    await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      archive: true,
      ...user(day(11)),
    });
    const active: any = await f.tools.call("a", { operation: "parcel_list" });
    assert.equal(active.parcels.length, 0);
    const all: any = await f.tools.call("a", {
      operation: "parcel_list",
      includeArchived: true,
    });
    assert.equal(all.parcels.length, 1);
    assert.equal(all.parcels[0].archived, true);
  } finally {
    await f.pg.close();
  }
});

test("a note-only observation never moves the status", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Chair",
      status: "shipped",
      ...email("hh01", day(12)),
    });
    const noted: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      note: "leave it with the neighbour",
      ...user(day(13)),
    });
    assert.equal(noted.status, "shipped");
    assert.equal(noted.applied, false);
    assert.equal(noted.note, "leave it with the neighbour");
  } finally {
    await f.pg.close();
  }
});

test("unmappable carrier wording stays verbatim and never becomes a status", async () => {
  const id = "8f2a1c4e-0000-4000-8000-000000000000";
  // A carrier phrase is not a status; it must be carried in rawStatus instead.
  assert.equal(
    action.safeParse({
      operation: "parcel_record",
      id,
      status: "held at customs",
      sourceKind: "user",
    }).success,
    false,
  );
  assert.equal(
    action.safeParse({
      operation: "parcel_record",
      id,
      status: "unknown",
      rawStatus: "held at customs",
      sourceKind: "user",
    }).success,
    true,
  );
  // A path-like message id never reaches the schema, let alone a request.
  assert.equal(
    action.safeParse({
      operation: "parcel_record",
      label: "x",
      sourceKind: "email",
      messageId: "../profile",
      observedAt: day(10),
    }).success,
    false,
  );
  // An email without the moment it describes is refused by the host.
  const f = await fixture();
  try {
    await assert.rejects(
      f.tools.call("a", {
        operation: "parcel_record",
        label: "x",
        sourceKind: "email",
        messageId: "ab01",
      } as never),
      /needs messageId and the message's own Date/,
    );
    await assert.rejects(
      f.tools.call("a", {
        operation: "parcel_record",
        label: "x",
        sourceKind: "email",
        observedAt: day(10),
      } as never),
      /needs messageId/,
    );
  } finally {
    await f.pg.close();
  }
});

test("parcel tools appear only where the capability is enabled", () => {
  const off = runtimeContext({}, null).tools.map((t) => t.name);
  assert.ok(!off.some((n) => n.startsWith("parcel_")));
  const on = runtimeContext({ parcels: true }, null).tools.map((t) => t.name);
  assert.deepEqual(on.filter((n) => n.startsWith("parcel_")).sort(), [
    "parcel_list",
    "parcel_match",
    "parcel_record",
  ]);
});

test("the precedence rule and reference normalisation are exactly as documented", () => {
  const t = (d: number) => Date.UTC(2026, 8, d);
  // Newer observation wins outright, whoever it came from.
  assert.equal(
    decides(
      { authority: 1, observedAt: t(20) },
      { authority: 2, observedAt: t(10) },
    ),
    true,
  );
  // Older observation loses unless it carries higher authority.
  assert.equal(
    decides(
      { authority: 1, observedAt: t(10) },
      { authority: 2, observedAt: t(20) },
    ),
    false,
  );
  assert.equal(
    decides(
      { authority: 2, observedAt: t(10) },
      { authority: 1, observedAt: t(20) },
    ),
    true,
  );
  // Equal moment and equal authority does not displace what is already recorded.
  assert.equal(
    decides(
      { authority: 1, observedAt: t(10) },
      { authority: 1, observedAt: t(10) },
    ),
    false,
  );
  assert.equal(decides({ authority: 1, observedAt: t(1) }, null), true);
  assert.equal(refKey("sp 123-456"), "SP123456");
  assert.equal(refKey("SP123456"), refKey("sp-123.456"));
  assert.equal(refKey(undefined), "");
});
