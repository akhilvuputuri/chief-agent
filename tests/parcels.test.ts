import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { ensureUser, type Database } from "../src/db.js";
import { Parcels } from "../src/parcels.js";
import {
  parcelApply,
  parcelSave,
  type ParcelCandidate,
  type ParcelSource,
} from "../src/parcel-schema.js";

async function fixture() {
  const pg = new PGlite();
  for (const f of (await readdir(new URL("../db/", import.meta.url)))
    .filter((n) => /^\d.*\.sql$/.test(n))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
    );
  const db: Database = pg;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const run = randomUUID();
  await db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'a')", [run]);
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','Track my parcels')",
    [run],
  );
  const input = async (message: string) => {
    const id = randomUUID();
    await db.query(
      "INSERT INTO conversation_inputs(id,user_id,run_id,message,state) VALUES($1,'a',$2,$3,'running')",
      [id, run, message],
    );
    return id;
  };
  const parcels = new Parcels(db);
  const save = async (
    claims: ParcelCandidate["claims"],
    extra: Partial<z.input<typeof parcelSave>> = {},
  ) => {
    const text = "Track my parcel. " + claims.map((c) => c.quote).join(" ");
    const inputId = await input(text);
    return result.parse(
      await parcels.call(
        "a",
        run,
        parcelSave.parse({
          operation: "parcel_save",
          requestKey: randomUUID(),
          quote: "Track my parcel.",
          claims,
          inputId,
          ...extra,
        }),
      ),
    );
  };
  const email = (
    text: string,
    date = "2026-09-18T00:00:00.000Z",
    key = randomUUID(),
  ): ParcelSource => ({
    kind: "gmail",
    key,
    text,
    assertedAt: date,
    observedAt: new Date().toISOString(),
    originRun: run,
  });
  const apply = async (
    source: ParcelSource,
    claims: ParcelCandidate["claims"],
    extra: Partial<z.input<typeof parcelApply>> = {},
  ) => {
    const proposalId = await parcels.propose("a", run, source, {
      claims,
      effectiveAt: null,
    });
    return result.parse(
      await parcels.call(
        "a",
        run,
        parcelApply.parse({
          operation: "parcel_apply",
          requestKey: randomUUID(),
          proposalId,
          ...extra,
        }),
      ),
    );
  };
  return { pg, db, run, input, parcels, save, email, apply };
}
const result = z.object({
  id: z.string().nullable(),
  revision: z.number(),
  outcome: z.string(),
  replayed: z.boolean().optional(),
  data: z
    .object({ status: z.string(), trackingReference: z.string().nullable() })
    .passthrough()
    .optional(),
  decisions: z.record(z.string()),
});
const facts = (tracking = "0001"): ParcelCandidate["claims"] => [
  { field: "label", value: "Headphones", quote: "Headphones" },
  { field: "merchant", value: "Shop", quote: "Shop" },
  { field: "orderReference", value: "O42", quote: "O42" },
  { field: "carrier", value: "ParcelCo", quote: "ParcelCo" },
  { field: "trackingReference", value: tracking, quote: tracking },
  { field: "status", value: "in_transit", quote: "in transit" },
];
const textFor = (claims: ParcelCandidate["claims"]) =>
  claims.map((c) => c.quote).join("; ");

test("owner isolation, restart, source provenance and request-key replay", async () => {
  const f = await fixture();
  try {
    const claims = facts();
    const inputId = await f.input(textFor(claims));
    const a = parcelSave.parse({
      operation: "parcel_save",
      requestKey: randomUUID(),
      inputId,
      quote: "Headphones",
      claims,
    });
    const first = result.parse(await f.parcels.call("a", f.run, a));
    assert.equal(first.outcome, "applied");
    const second = result.parse(await new Parcels(f.db).call("a", f.run, a));
    assert.equal(second.id, first.id);
    assert.equal(second.replayed, true);
    await assert.rejects(
      () => f.parcels.call("a", f.run, { ...a, quote: "Shop" }),
      /different content/,
    );
    await assert.rejects(
      () =>
        f.parcels.call("b", f.run, {
          operation: "parcel_read",
          id: first.id!,
          offset: 0,
        }),
      /not found/,
    );
    await assert.rejects(() => f.parcels.call("b", f.run, a), /on-demand/);
    const saved = await new Parcels(f.db).call("a", f.run, {
      operation: "parcel_read",
      id: first.id!,
      offset: 0,
    });
    assert.match(JSON.stringify(saved), /inputId/);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM parcels")).rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("repeated email claims do not duplicate parcels, including new request keys", async () => {
  const f = await fixture();
  try {
    const source = f.email(textFor(facts()));
    const first = await f.apply(source, facts());
    const duplicate = await f.apply(source, facts());
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.replayed, true);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM parcels")).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM parcel_events WHERE kind='applied'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("two shipments in one email/order remain distinct; order-only updates ask", async () => {
  const f = await fixture();
  try {
    const source = f.email(textFor([...facts("0001"), ...facts("0002")]));
    const a = await f.apply(source, facts("0001"));
    const b = await f.apply(source, facts("0002"));
    assert.notEqual(a.id, b.id);
    assert.equal(b.outcome, "applied");
    const claims = facts().filter((c) => c.field !== "trackingReference");
    const ambiguous = await f.apply(f.email(textFor(claims)), claims);
    assert.equal(ambiguous.outcome, "ambiguous");
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM parcels")).rows[0].n,
      2,
    );
  } finally {
    await f.pg.close();
  }
});

test("older email cannot overwrite confirmed receipt; explicit corrections reopen and clear", async () => {
  const f = await fixture();
  try {
    const initial = await f.apply(f.email(textFor(facts())), facts());
    const confirmed = await f.save([], {
      id: initial.id!,
      baseRevision: 1,
      mode: "confirm",
    });
    assert.equal(confirmed.data?.status, "delivered");
    const stale = await f.apply(
      f.email(textFor(facts()), "2026-09-19T00:00:00.000Z"),
      facts(),
    );
    assert.equal(stale.outcome, "conflict");
    assert.equal(stale.decisions.status, "conflict");
    const clear = await f.save(
      [{ field: "status", value: null, quote: "status unknown" }],
      {
        id: initial.id!,
        baseRevision: 2,
        mode: "correct",
      },
    );
    assert.equal(clear.data?.status, "unknown");
    const oldAgain = await f.apply(
      f.email(textFor(facts()), "2026-09-19T01:00:00.000Z"),
      facts(),
    );
    assert.equal(oldAgain.decisions.status, "conflict");
  } finally {
    await f.pg.close();
  }
});

test("same source can add omitted facts; unknowns do not erase known data", async () => {
  const f = await fixture();
  try {
    const initialSource = f.email(textFor(facts()));
    const initial = await f.apply(initialSource, facts());
    const extra = [
      ...facts(),
      { field: "etaText" as const, value: "Friday", quote: "Friday" },
    ];
    const enriched = await f.apply(
      { ...initialSource, text: textFor(extra) },
      extra,
    );
    assert.equal(enriched.id, initial.id);
    assert.equal(enriched.revision, 2);
    const unknown = facts().map((c) =>
      c.field === "status" ? { ...c, value: "unknown", quote: "no status" } : c,
    );
    const ignored = await f.apply(
      f.email(textFor(unknown), "2026-09-19T00:00:00.000Z"),
      unknown,
    );
    assert.equal(ignored.decisions.status, "unsupported");
  } finally {
    await f.pg.close();
  }
});

test("ambiguous match needs an authenticated selection; archive remains archived", async () => {
  const f = await fixture();
  try {
    const initial = await f.save([
      { field: "label", value: "Headphones", quote: "Headphones" },
    ]);
    const source = f.email(textFor(facts()));
    const ambiguous = await f.apply(source, facts());
    assert.equal(ambiguous.outcome, "ambiguous");
    const bypass = await f.apply(source, facts(), {
      id: initial.id!,
      baseRevision: 1,
    });
    assert.equal(bypass.outcome, "ambiguous");
    await f.input("Use the Headphones parcel.");
    const selected = await f.apply(source, facts(), {
      id: initial.id!,
      baseRevision: 1,
      selectionQuote: "Use the Headphones parcel.",
    });
    assert.equal(selected.outcome, "applied");
    await f.save([], { id: initial.id!, baseRevision: 2, mode: "archive" });
    const older = await f.apply(
      f.email(textFor(facts()), "2026-09-19T00:00:00.000Z"),
      facts(),
    );
    assert.equal(older.outcome, "ambiguous");
    const listing = await f.parcels.call("a", f.run, {
      operation: "parcel_list",
      filter: "waiting",
      offset: 0,
    });
    assert.deepEqual(
      z.object({ items: z.array(z.unknown()) }).parse(listing).items,
      [],
    );
  } finally {
    await f.pg.close();
  }
});

test("source forgery, background runs and stale revisions fail before mutation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () =>
        f.parcels.propose("a", f.run, f.email("no facts"), {
          claims: facts(),
          effectiveAt: null,
        }),
      /quotation/,
    );
    const initial = await f.save(facts());
    await assert.rejects(
      () => f.save([], { id: initial.id!, baseRevision: 2, mode: "archive" }),
      /revision/,
    );
    await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
      f.run,
    ]);
    await assert.rejects(() => f.save(facts()), /on-demand/);
    assert.equal(
      (
        await f.db.query("SELECT revision FROM parcels WHERE id=$1", [
          initial.id,
        ])
      ).rows[0].revision,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("failed event insertion rolls back projection and requests; migration rerun preserves state", async () => {
  const f = await fixture();
  try {
    const initial = await f.save(facts());
    await f.pg.exec(
      "ALTER TABLE parcel_events ADD CONSTRAINT reject_archive CHECK(kind<>'applied') NOT VALID",
    );
    await assert.rejects(() =>
      f.save([], { id: initial.id!, baseRevision: 1, mode: "archive" }),
    );
    assert.equal(
      (
        await f.db.query("SELECT revision FROM parcels WHERE id=$1", [
          initial.id,
        ])
      ).rows[0].revision,
      1,
    );
    await f.pg.exec("ALTER TABLE parcel_events DROP CONSTRAINT reject_archive");
    await f.pg.exec(
      await readFile(new URL("../db/019_parcels.sql", import.meta.url), "utf8"),
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM parcels")).rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("event timestamps need source quotes, normalize offsets and reject impossible dates", async () => {
  const f = await fixture();
  try {
    const source = f.email("Headphones shipped 2026-09-18T01:00:00+01:00");
    const candidate = {
      claims: [
        { field: "label" as const, value: "Headphones", quote: "Headphones" },
        { field: "status" as const, value: "shipped", quote: "shipped" },
      ],
      effectiveAt: "2026-09-18T01:00:00+01:00",
    };
    await assert.rejects(
      () => f.parcels.propose("a", f.run, source, candidate),
      /event time needs an exact source quotation/,
    );
    const proposalId = await f.parcels.propose("a", f.run, source, {
      ...candidate,
      effectiveAtQuote: candidate.effectiveAt,
    });
    const applied = result.parse(
      await f.parcels.call(
        "a",
        f.run,
        parcelApply.parse({
          operation: "parcel_apply",
          requestKey: randomUUID(),
          proposalId,
        }),
      ),
    );
    const saved = z
      .object({
        provenance: z.object({ status: z.object({ assertedAt: z.string() }) }),
      })
      .parse(
        await f.parcels.call("a", f.run, {
          operation: "parcel_read",
          id: applied.id!,
          offset: 0,
        }),
      );
    assert.equal(
      saved.provenance.status.assertedAt,
      "2026-09-18T00:00:00.000Z",
    );
    await assert.rejects(
      () =>
        f.save([
          { field: "etaStart", value: "2026-02-31", quote: "2026-02-31" },
        ]),
      /ISO date/,
    );
  } finally {
    await f.pg.close();
  }
});
