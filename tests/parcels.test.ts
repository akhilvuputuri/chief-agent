import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { ParcelTools, decides, refKey, parcelLimits } from "../src/parcels.js";
import { action } from "../src/protocol.js";
import { runtimeContext } from "../src/runtime.js";
import { projectObservation } from "../src/observations.js";
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
    assert.match(saved.notice, /Nothing here is checked with the carrier/);
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
    assert.match(stale.ignoredReason, /confirmed this parcel was delivered/);
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
    assert.equal(ignored.statusApplied, false);
    assert.match(ignored.ignoredReason, /confirmed this parcel was delivered/);
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
    // The read path is parcel_list with an id, not a separate operation.
    await assert.rejects(
      f.tools.call("b", { operation: "parcel_list", id: mine.id }),
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
    const theirs: any = await f.tools.call("b", { operation: "parcel_list" });
    assert.deepEqual(theirs.parcels, []);
    assert.equal(theirs.total, 0);
    const other: any = await f.tools.call("b", {
      operation: "parcel_match",
      trackingRef: "SP-1",
    });
    assert.equal(other.candidates.length, 0);
    assert.equal(other.resolvedId, null);
    // The owner's own read still works and is the same parcel.
    const own: any = await f.tools.call("a", {
      operation: "parcel_list",
      id: mine.id,
    });
    assert.equal(own.id, mine.id);
    assert.equal(own.totalUpdates, 1);
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
    // The owner's note applies as a detail; it does not touch the status or its clock.
    assert.equal(noted.status, "shipped");
    assert.equal(noted.applied, true);
    assert.equal(noted.statusApplied, undefined);
    assert.equal(
      new Date(noted.asOf).getTime(),
      new Date(saved.asOf).getTime(),
    );
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

test("an observation with nothing to say is a safe no-op, not broken SQL", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Empty",
      status: "shipped",
      ...user(day(10)),
    });
    const bare: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      ...user(day(11)),
    });
    assert.equal(bare.status, "shipped");
    assert.equal(bare.applied, false);
    const read: any = await f.tools.call("a", {
      operation: "parcel_list",
      id: saved.id,
    });
    assert.equal(read.totalUpdates, 2);
  } finally {
    await f.pg.close();
  }
});

test("the same email against the same parcel is a no-op that changes nothing", async () => {
  const f = await fixture();
  try {
    const first: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "First",
      status: "shipped",
      ...email("aa01", day(10)),
    });
    const repeat: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: first.id,
      status: "delivered",
      ...email("aa01", day(11)),
    });
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.applied, false);
    assert.equal(repeat.status, "shipped");
    const read: any = await f.tools.call("a", {
      operation: "parcel_list",
      id: first.id,
    });
    assert.equal(read.totalUpdates, 1);
    assert.equal(read.status, "shipped");
  } finally {
    await f.pg.close();
  }
});

test("one email can describe two parcels of the same order", async () => {
  const f = await fixture();
  try {
    const a1: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Lamp",
      orderRef: "ORD-5",
      ...user(day(10)),
    });
    const a2: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Mat",
      orderRef: "ORD-5",
      ...user(day(10)),
    });
    const one: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: a1.id,
      status: "shipped",
      ...email("bb01", day(12)),
    });
    const two: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: a2.id,
      status: "shipped",
      ...email("bb01", day(12)),
    });
    assert.equal(one.applied, true);
    assert.equal(two.applied, true, "same message, different parcel");
    assert.equal(two.duplicate, undefined);
  } finally {
    await f.pg.close();
  }
});

test("a delivery date does not advance the moment the status describes", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Desk",
      status: "shipped",
      ...email("cc01", day(10)),
    });
    // The owner supplies only a date on the 15th.
    const dated: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      eta: "2026-09-18",
      ...user(day(15)),
    });
    assert.equal(dated.applied, true);
    assert.equal(dated.eta, "2026-09-18");
    assert.equal(dated.status, "shipped");
    // A carrier email from the 12th still beats a status observed on the 10th.
    const later: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "delivered",
      ...email("cc02", day(12)),
    });
    assert.equal(later.applied, true);
    assert.equal(later.status, "delivered");
  } finally {
    await f.pg.close();
  }
});

test("a decisive reference finds a parcel outside the recent window", async () => {
  const f = await fixture();
  try {
    const target: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Old parcel",
      trackingRef: "SP-OLD-1",
      ...user(day(1)),
    });
    for (let i = 0; i < 120; i++)
      await f.tools.call("a", {
        operation: "parcel_record",
        label: `Filler ${i}`,
        ...user(day(20)),
      });
    const found: any = await f.tools.call("a", {
      operation: "parcel_match",
      trackingRef: "sp old 1",
    });
    assert.equal(
      found.ambiguous,
      false,
      "must not tell the model to duplicate",
    );
    assert.equal(found.resolvedId, target.id);
  } finally {
    await f.pg.close();
  }
});

test("a stale email cannot rewrite a tracking reference the owner supplied", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Router",
      trackingRef: "OWNER-REF",
      status: "delivered",
      ...user(day(20)),
    });
    // The email also carries a first-ever delivery date, which does apply. That must
    // not let its stale status drag the owner's tracking reference along with it.
    const stale: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      trackingRef: "EMAIL-REF",
      carrier: "EmailCarrier",
      status: "shipped",
      eta: "2026-10-01",
      ...email("dd01", day(12)),
    });
    assert.equal(stale.trackingRef, "OWNER-REF");
    assert.equal(stale.status, "delivered");
    assert.equal(stale.statusApplied, false);
    assert.equal(stale.etaApplied, true);
    assert.equal(stale.eta, "2026-10-01");
    assert.match(stale.ignoredReason, /status not applied/);
  } finally {
    await f.pg.close();
  }
});

test("creating refuses to duplicate a tracking reference already saved", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Speaker",
      trackingRef: "SP-DUP",
      ...user(day(10)),
    });
    await assert.rejects(
      f.tools.call("a", {
        operation: "parcel_record",
        label: "Speaker again",
        trackingRef: "sp dup",
        ...user(day(11)),
      }),
      new RegExp(`already saved as parcel ${saved.id}`),
    );
    // Punctuation alone is not a reference and must not collide with anything.
    await f.tools.call("a", {
      operation: "parcel_record",
      label: "No reference",
      trackingRef: "-",
      ...user(day(11)),
    });
    // An archived parcel is still found rather than leaving a dead end.
    await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      archive: true,
      ...user(day(12)),
    });
    const found: any = await f.tools.call("a", {
      operation: "parcel_match",
      trackingRef: "SP-DUP",
    });
    assert.equal(found.resolvedId, saved.id);
  } finally {
    await f.pg.close();
  }
});

test("an email can neither archive nor reopen a parcel", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Kettle",
      ...user(day(10)),
    });
    await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      archive: true,
      ...user(day(11)),
    });
    for (const archive of [true, false])
      await assert.rejects(
        f.tools.call("a", {
          operation: "parcel_record",
          id: saved.id,
          archive,
          ...email(`ee0${archive ? 1 : 2}`, day(12)),
        }),
        /only you can archive or reopen/,
      );
    const all: any = await f.tools.call("a", {
      operation: "parcel_list",
      includeArchived: true,
    });
    assert.equal(all.parcels[0].archived, true);
  } finally {
    await f.pg.close();
  }
});

test("a long list stays readable to the model and keeps its notice", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 60; i++)
      await f.tools.call("a", {
        operation: "parcel_record",
        label: "L".repeat(200) + i,
        merchant: "M".repeat(120),
        carrier: "C".repeat(120),
        trackingRef: "T".repeat(100) + i,
        orderRef: "O".repeat(100) + i,
        note: "N".repeat(2000),
        ...user(day(10)),
      });
    const listed: any = await f.tools.call("a", { operation: "parcel_list" });
    assert.ok(listed.parcels.length >= 1 && listed.parcels.length <= 10);
    assert.equal(listed.total, 60);
    assert.equal(listed.nextOffset, listed.parcels.length);
    // Long notes belong to the single-parcel read, not the list.
    assert.ok(listed.parcels.every((p: any) => p.note === undefined));
    assert.ok(JSON.stringify(listed).length < 12000);
    const projected = projectObservation("parcel_list", listed).result;
    assert.match(projected.notice, /checked with the carrier/);
    assert.notEqual(projected.truncated, true);
  } finally {
    await f.pg.close();
  }
});

test("an observation half rejected says which half", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Mixed",
      status: "delivered",
      eta: "2026-09-30",
      ...user(day(20)),
    });
    // Older email: both halves lose, and both are named.
    const older: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "shipped",
      eta: "2026-10-09",
      ...email("ff01", day(12)),
    });
    assert.equal(older.statusApplied, false);
    assert.equal(older.etaApplied, false);
    assert.match(older.ignoredReason, /status not applied/);
    assert.match(older.ignoredReason, /delivery date not applied/);
    assert.equal(older.status, "delivered");
    assert.equal(older.eta, "2026-09-30");
    // Newer email: both halves win and nothing is reported as ignored.
    const newer: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "returned",
      eta: "2026-10-11",
      ...email("ff02", day(22)),
    });
    assert.equal(newer.statusApplied, true);
    assert.equal(newer.etaApplied, true);
    assert.equal(newer.ignoredReason, undefined);
  } finally {
    await f.pg.close();
  }
});

test("match candidates stay inside the model projection with their verdict", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++)
      await f.tools.call("a", {
        operation: "parcel_record",
        label: "L".repeat(200) + i,
        merchant: "Acme",
        carrier: "C".repeat(120),
        orderRef: "ORD-9",
        note: "N".repeat(2000),
        ...user(day(10)),
      });
    const found: any = await f.tools.call("a", {
      operation: "parcel_match",
      orderRef: "ORD-9",
      merchant: "Acme",
    });
    assert.ok(found.candidates.length >= 1);
    assert.ok(found.candidates.every((c: any) => c.note === undefined));
    assert.ok(JSON.stringify(found).length < 12000);
    const projected = projectObservation("parcel_match", found).result;
    // The ambiguity verdict is the whole point of the call; it must survive.
    assert.equal(projected.ambiguous, true);
    assert.equal(projected.resolvedId, null);
    assert.match(projected.notice, /checked with the carrier/);
  } finally {
    await f.pg.close();
  }
});

test("a long history is trimmed to fit and says where to continue", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Chatty",
      status: "ordered",
      ...user(day(1)),
    });
    for (let i = 0; i < 30; i++)
      await f.tools.call("a", {
        operation: "parcel_record",
        id: saved.id,
        note: "N".repeat(1500) + i,
        ...user(day(2)),
      });
    const read: any = await f.tools.call("a", {
      operation: "parcel_list",
      id: saved.id,
    });
    assert.ok(read.history.length >= 1 && read.history.length < 20);
    assert.equal(read.totalUpdates, 31);
    assert.equal(read.nextOffset, read.history.length);
    assert.ok(JSON.stringify(read).length < 12000);
    assert.match(
      projectObservation("parcel_list", read).result.notice,
      /checked with the carrier/,
    );
  } finally {
    await f.pg.close();
  }
});

test("a write that cannot be recorded in full is not recorded at all", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Atomic",
      status: "ordered",
      ...user(day(10)),
    });
    // Simulate a concurrent edit landing between the read and the write.
    const raced = new ParcelTools(
      {
        query: async (text: string, values?: unknown[]) => {
          if (text.startsWith("WITH p AS"))
            await f.db.query(
              "UPDATE parcels SET revision=revision+1 WHERE id=$1",
              [saved.id],
            );
          return f.db.query(text, values);
        },
      } as never,
      () => Date.UTC(2026, 8, 21, 2, 0, 0),
    );
    await assert.rejects(
      raced.call("a", {
        operation: "parcel_record",
        id: saved.id,
        status: "delivered",
        ...email("gg01", day(12)),
      }),
      /read it again before retrying/,
    );
    // No history row was written, so the message is still usable.
    const after: any = await f.tools.call("a", {
      operation: "parcel_list",
      id: saved.id,
    });
    assert.equal(after.totalUpdates, 1);
    const retry: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "delivered",
      ...email("gg01", day(12)),
    });
    assert.equal(retry.applied, true);
    assert.equal(retry.duplicate, undefined);
  } finally {
    await f.pg.close();
  }
});

test("the owner's correction of details applies without restating the status", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Coat",
      carrier: "UPS",
      trackingRef: "1Z-OLD",
      note: "front porch",
      status: "shipped",
      ...email("ka01", day(10)),
    });
    const fixed: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      carrier: "DHL",
      trackingRef: "JD-NEW",
      note: "leave with neighbour",
      ...user(day(11)),
    });
    assert.equal(fixed.applied, true);
    assert.equal(fixed.detailsApplied, true);
    assert.equal(fixed.carrier, "DHL");
    assert.equal(fixed.trackingRef, "JD-NEW");
    assert.equal(fixed.note, "leave with neighbour");
    // The status and its clock are untouched by a details-only correction.
    assert.equal(fixed.status, "shipped");
    assert.equal(fixed.statusSource, "email");
    // The corrected reference is now the decisive one.
    const found: any = await f.tools.call("a", {
      operation: "parcel_match",
      trackingRef: "jd new",
    });
    assert.equal(found.resolvedId, saved.id);
  } finally {
    await f.pg.close();
  }
});

test("an email may fill an empty detail but not overwrite one without its status applying", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Lamp",
      carrier: "Ninja Van",
      status: "delivered",
      ...user(day(20)),
    });
    const stale: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      carrier: "SingPost",
      orderRef: "ORD-EMPTY",
      status: "shipped",
      ...email("kb01", day(12)),
    });
    assert.equal(stale.carrier, "Ninja Van");
    assert.equal(stale.orderRef, "ORD-EMPTY");
    assert.equal(stale.detailsApplied, false);
    assert.match(stale.ignoredReason, /carrier not applied/);
  } finally {
    await f.pg.close();
  }
});

test("a parcel created without a status still takes one from an older email", async () => {
  const f = await fixture();
  try {
    // "Here is the tracking number for another package": no status stated.
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Another package",
      trackingRef: "SP-777",
      ...user(day(21)),
    });
    assert.equal(saved.status, "unknown");
    assert.equal(saved.asOf, undefined);
    assert.equal(saved.statusSource, undefined);
    // Then "find the details in my email": the shipping notice predates that message.
    const found: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "shipped",
      ...email("kc01", day(20)),
    });
    assert.equal(found.statusApplied, true);
    assert.equal(found.status, "shipped");
    assert.equal(found.ignoredReason, undefined);
  } finally {
    await f.pg.close();
  }
});

test("no email can walk back a delivery the owner confirmed, but a return still applies", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Shoes",
      status: "delivered",
      ...user(day(16)),
    });
    // A carrier notice written later the same day still says it is on its way.
    const lagging: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "out_for_delivery",
      ...email("kd01", day(17)),
    });
    assert.equal(lagging.statusApplied, false);
    assert.equal(lagging.status, "delivered");
    assert.match(lagging.ignoredReason, /confirmed this parcel was delivered/);
    const returned: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "returned",
      ...email("kd02", day(21)),
    });
    assert.equal(returned.statusApplied, true);
    assert.equal(returned.status, "returned");
  } finally {
    await f.pg.close();
  }
});

test("an older email is refused against the owner's more recent statement", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Blender",
      status: "delayed",
      ...user(day(17)),
    });
    const older: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      status: "out_for_delivery",
      ...email("ke01", day(16)),
    });
    assert.equal(older.statusApplied, false);
    assert.match(older.ignoredReason, /you told me something more recent/);
  } finally {
    await f.pg.close();
  }
});

test("updating to a tracking reference another parcel holds is refused", async () => {
  const f = await fixture();
  try {
    await f.tools.call("a", {
      operation: "parcel_record",
      label: "First",
      trackingRef: "SP-SHARED",
      ...user(day(10)),
    });
    const second: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Second",
      ...user(day(10)),
    });
    await assert.rejects(
      f.tools.call("a", {
        operation: "parcel_record",
        id: second.id,
        trackingRef: "sp shared",
        ...user(day(11)),
      }),
      /already saved as parcel/,
    );
  } finally {
    await f.pg.close();
  }
});

test("a future observation is refused because it would outrank every real one", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Chair",
      status: "shipped",
      ...user(day(20)),
    });
    await assert.rejects(
      f.tools.call("a", {
        operation: "parcel_record",
        id: saved.id,
        status: "out_for_delivery",
        ...user("2026-10-15T00:00:00Z"),
      }),
      /observedAt is in the future/,
    );
  } finally {
    await f.pg.close();
  }
});

test("carrier wording and the delivery date's own clock are visible on the parcel", async () => {
  const f = await fixture();
  try {
    const saved: any = await f.tools.call("a", {
      operation: "parcel_record",
      label: "Watch",
      status: "unknown",
      rawStatus: "held at customs",
      ...email("kf01", day(20)),
    });
    assert.equal(saved.rawStatus, "held at customs");
    const dated: any = await f.tools.call("a", {
      operation: "parcel_record",
      id: saved.id,
      eta: "2026-09-28",
      ...user(day(21)),
    });
    // The date carries its own moment; the status moment and deciding update stay put.
    assert.equal(new Date(dated.etaAsOf).getTime(), Date.parse(day(21)));
    assert.equal(new Date(dated.asOf).getTime(), Date.parse(day(20)));
    const read: any = await f.tools.call("a", {
      operation: "parcel_list",
      id: saved.id,
    });
    const dateRow = read.history.find((h: any) => h.eta === "2026-09-28");
    assert.equal(dateRow.applied, true);
    assert.equal(dateRow.etaApplied, true);
    assert.equal(dateRow.statusApplied, undefined);
    const row = (
      await f.db.query("SELECT deciding_update_id FROM parcels WHERE id=$1", [
        saved.id,
      ])
    ).rows[0];
    const first = read.history.find(
      (h: any) => h.rawStatus === "held at customs",
    );
    assert.equal(row.deciding_update_id, first.id);
  } finally {
    await f.pg.close();
  }
});

test("list and match trim to the serialised bound and keep their paging honest", async () => {
  const f = await fixture();
  try {
    const tight = new ParcelTools(f.db, () => Date.UTC(2026, 8, 21, 2), {
      ...parcelLimits,
      serialised: 2_500,
    });
    for (let i = 0; i < 8; i++)
      await tight.call("a", {
        operation: "parcel_record",
        label: "Parcel " + "x".repeat(150) + i,
        merchant: "Acme",
        orderRef: "ORD-T",
        ...user(day(10)),
      });
    const listed: any = await tight.call("a", { operation: "parcel_list" });
    assert.ok(listed.parcels.length < 8, "the list was trimmed");
    assert.ok(JSON.stringify(listed).length <= 2_500);
    assert.equal(listed.nextOffset, listed.parcels.length);
    assert.equal(listed.total, 8);
    const matched: any = await tight.call("a", {
      operation: "parcel_match",
      orderRef: "ORD-T",
      merchant: "Acme",
    });
    assert.ok(matched.candidates.length < 8, "the candidates were trimmed");
    assert.ok(JSON.stringify(matched).length <= 2_500);
    assert.equal(matched.ambiguous, true);
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
