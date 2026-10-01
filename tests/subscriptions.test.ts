import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  SubscriptionTools,
  subscriptionReminders,
} from "../src/subscriptions.js";
import { ensureUser, type Database } from "../src/db.js";
import { DailyTools, DailyWorker, ScheduleParser } from "../src/daily.js";
import { action } from "../src/protocol.js";
import { runtimeContext } from "../src/runtime.js";
import { readOperations } from "../src/execution.js";
import { server } from "../src/server.js";
import { projectObservation } from "../src/observations.js";

async function fixture() {
  const pg = new PGlite();
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((n) => /^\d.*sql$/.test(n))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + name, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'a','Track my subscriptions',false)",
    [run],
  );
  const tools = new SubscriptionTools(db, () =>
    Date.parse("2026-10-01T00:00:00Z"),
  );
  const record = (fields: object, extra: object = {}) =>
    tools.call(
      "a",
      run,
      action.parse({
        operation: "subscription_record",
        requestKey: randomUUID(),
        fields,
        ...extra,
      }) as any,
    );
  return { pg, db, run, tools, record };
}
const annual = {
  label: "Gym",
  merchant: "Gym",
  plan: "Annual",
  status: "active",
  amount: "120",
  currency: "SGD",
  amountType: "fixed",
  cadence: "annual",
  nextChargeDate: "2026-11-01",
  cancellationDeadline: "2026-10-15",
};

test("manual capture persists provenance, exact price, per-currency totals and distinct decision dates", async () => {
  const f = await fixture();
  try {
    const r = await f.record(annual);
    assert.equal(r.created, true);
    assert.equal(r.amount, "120");
    assert.equal(r.monthlyEquivalent, "10.00");
    assert.equal(r.reminders.length, 0);
    assert.equal(r.history[0].source_kind, "owner");
    assert.equal(r.history[0].source_ref.runId, f.run);
    assert.equal(r.fieldSources.amount.updateId, r.updateId);
    await f.record({
      label: "Music",
      status: "active",
      amount: "4.50",
      currency: "USD",
      amountType: "fixed",
      cadence: "monthly",
    });
    await f.record({
      label: "Water",
      status: "active",
      amount: "80",
      currency: "SGD",
      amountType: "variable",
      cadence: "monthly",
    });
    await f.record({
      label: "Trial",
      status: "trial",
      trialEndDate: "2026-10-10",
    });
    const result = await new SubscriptionTools(f.db, () =>
      Date.parse("2026-10-01T00:00:00Z"),
    ).list("a", { operation: "subscription_list" });
    assert.deepEqual(result.totals, [
      { currency: "SGD", monthlyEquivalent: "10.00", items: 1 },
      { currency: "USD", monthlyEquivalent: "4.50", items: 1 },
    ]);
    assert.equal(result.excluded, 2);
    assert.deepEqual(
      result.upcoming.map((d: any) => d.events),
      [["trial ends"], ["cancellation deadline"]],
    );
    await f.pg.exec(
      await readFile(
        new URL("../db/023_subscriptions.sql", import.meta.url),
        "utf8",
      ),
    );
    assert.equal((await f.tools.read("a", r.id)).amount, "120");
  } finally {
    await f.pg.close();
  }
});
test("matching asks for plan/account and refuses duplicate creates including cancelled identities", async () => {
  const f = await fixture();
  try {
    const a = await f.record(annual);
    await f.record({
      ...annual,
      plan: "Monthly",
      accountLabel: "Family",
      cadence: "monthly",
    });
    const ambiguous = await f.tools.list("a", {
      operation: "subscription_list",
      merchant: "gym",
    });
    assert.equal(ambiguous.ambiguous, true);
    assert.equal(ambiguous.resolvedId, null);
    assert.equal(
      (
        await f.tools.list("a", {
          operation: "subscription_list",
          merchant: "GYM",
          plan: "annual",
        })
      ).resolvedId,
      a.id,
    );
    await assert.rejects(() => f.record(annual), /already has a saved item/);
    await f.record(
      { status: "cancelled" },
      { id: a.id, baseRevision: a.revision },
    );
    await assert.rejects(() => f.record(annual), /already has a saved item/);
    assert.equal(
      (
        await f.tools.list("a", {
          operation: "subscription_list",
          includeInactive: true,
        })
      ).total,
      2,
    );
  } finally {
    await f.pg.close();
  }
});
test("request-key retries do not duplicate history or reminders and altered retries are refused", async () => {
  const f = await fixture();
  try {
    const requestKey = randomUUID(),
      fields = { ...annual, reminderEnabled: true };
    const a = await f.record(fields, { requestKey }),
      b = await f.record(fields, { requestKey });
    assert.equal(b.id, a.id);
    assert.equal(b.duplicate, true);
    assert.equal(b.history.length, 1);
    assert.equal(b.reminders.length, 2);
    await assert.rejects(
      () => f.record({ ...fields, amount: "240" }, { requestKey }),
      /different subscription data/,
    );
    assert.equal((await f.tools.read("a", a.id)).revision, 1);
  } finally {
    await f.pg.close();
  }
});
test("date edits and cancellation atomically move or withdraw reminders and keep history", async () => {
  const f = await fixture();
  try {
    let a = await f.record({ ...annual, reminderEnabled: true });
    assert.equal(
      a.reminders
        .find((r: any) => r.date === "2026-10-15")
        .firesAt.toISOString(),
      "2026-10-08T01:00:00.000Z",
    );
    a = await f.record(
      { cancellationDeadline: "2026-10-20" },
      { id: a.id, baseRevision: a.revision },
    );
    assert.equal(
      a.reminders.find((r: any) => r.date === "2026-10-15").status,
      "cancelled",
    );
    assert.equal(
      a.reminders.find((r: any) => r.date === "2026-10-20").status,
      "scheduled",
    );
    a = await f.record(
      { status: "cancelling", paidThroughDate: "2026-11-01" },
      { id: a.id, baseRevision: a.revision },
    );
    assert.ok(a.reminders.every((r: any) => r.status === "cancelled"));
    assert.equal(a.paidThroughDate, "2026-11-01");
    assert.equal(a.history.length, 3);
    assert.deepEqual(
      (await f.tools.list("a", { operation: "subscription_list" })).totals,
      [],
    );
  } finally {
    await f.pg.close();
  }
});
test("trial and renewal on the same date produce one reminder; monthly reminders require a lead time", async () => {
  const f = await fixture();
  try {
    let a = await f.record({
      label: "Trial",
      status: "trial",
      cadence: "monthly",
      trialEndDate: "2026-10-20",
      nextChargeDate: "2026-10-20",
      reminderEnabled: true,
    });
    assert.equal(a.reminders.length, 1);
    const row = (
      await f.db.query(
        "SELECT content FROM daily_schedules WHERE subscription_id=$1",
        [a.id],
      )
    ).rows[0];
    assert.match(row.content, /renewal \/ trial ends/);
    a = await f.record(
      { status: "active", trialEndDate: null, nextChargeDate: "2026-11-20" },
      { id: a.id, baseRevision: a.revision },
    );
    assert.ok(a.reminders.every((r: any) => r.status === "cancelled"));
    a = await f.tools.call("a", f.run, {
      operation: "subscription_settings",
      id: a.id,
      requestKey: randomUUID(),
      baseRevision: a.revision,
      daysBefore: 2,
      time: "10:30",
    });
    assert.equal(
      a.reminders
        .find((r: any) => r.status === "scheduled")
        .firesAt.toISOString(),
      "2026-11-18T02:30:00.000Z",
    );
  } finally {
    await f.pg.close();
  }
});
test("validation and stale revisions save neither observations nor schedules", async () => {
  const f = await fixture();
  try {
    for (const fields of [
      { ...annual, nextChargeDate: "2026-02-30" },
      { ...annual, currency: null },
      { ...annual, cadence: "days" },
      { ...annual, label: "Card 4111 1111 1111 1111" },
      { ...annual, accountLabel: "Bank account number 1234567890" },
      { ...annual, plan: "Billing address 12 Long Road" },
    ])
      await assert.rejects(() => f.record(fields));
    assert.equal(
      (await f.db.query("SELECT count(*) AS n FROM subscriptions")).rows[0].n,
      0,
    );
    const a = await f.record(annual);
    await assert.rejects(
      () => f.record({ amount: "240" }, { id: a.id }),
      /baseRevision/,
    );
    await assert.rejects(
      () => f.record({ amount: "240" }, { id: a.id, baseRevision: 2 }),
      /changed/,
    );
    assert.equal((await f.tools.read("a", a.id)).history.length, 1);
    assert.equal(
      (await f.db.query("SELECT count(*) AS n FROM daily_schedules")).rows[0].n,
      0,
    );
  } finally {
    await f.pg.close();
  }
});
test("owner isolation and inherited background-write denial cover every operation", async () => {
  const f = await fixture();
  try {
    const a = await f.record(annual);
    assert.equal(
      (await f.tools.list("b", { operation: "subscription_list" })).total,
      0,
    );
    await assert.rejects(() => f.tools.read("b", a.id), /not found/);
    await assert.rejects(
      () =>
        f.tools.call("b", f.run, {
          operation: "subscription_record",
          requestKey: randomUUID(),
          id: a.id,
          baseRevision: 1,
          fields: { status: "cancelled" },
        }),
      /foreground/,
    );
    await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
      f.run,
    ]);
    await assert.rejects(
      () => f.record({ status: "cancelled" }, { id: a.id, baseRevision: 1 }),
      /foreground/,
    );
    await assert.rejects(
      () =>
        f.tools.call("a", f.run, {
          operation: "subscription_settings",
          id: a.id,
          requestKey: randomUUID(),
          baseRevision: 1,
          enabled: true,
        }),
      /foreground/,
    );
    assert.equal((await f.tools.read("a", a.id)).revision, 1);
  } finally {
    await f.pg.close();
  }
});
test("concurrent updates preserve one exact revision and an atomic history/reminder state", async () => {
  const f = await fixture();
  try {
    const a = await f.record({ ...annual, reminderEnabled: true });
    const results = await Promise.allSettled([
      f.record(
        { cancellationDeadline: "2026-10-20" },
        { id: a.id, baseRevision: 1 },
      ),
      f.record(
        { cancellationDeadline: "2026-10-25" },
        { id: a.id, baseRevision: 1 },
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const saved = await f.tools.read("a", a.id);
    assert.equal(saved.revision, 2);
    assert.equal(saved.history.length, 2);
    assert.equal(
      saved.reminders.filter(
        (r: any) => r.status === "scheduled" && r.date !== "2026-11-01",
      ).length,
      1,
    );
    assert.equal(
      saved.reminders.find(
        (r: any) => r.status === "scheduled" && r.date !== "2026-11-01",
      ).date,
      saved.cancellationDeadline,
    );
  } finally {
    await f.pg.close();
  }
});
test("linked reminders cannot be edited through generic schedules and delivery is model-free", async () => {
  const f = await fixture();
  try {
    const a = await f.record({ ...annual, reminderEnabled: true });
    const daily = new DailyTools(
      f.db,
      new ScheduleParser(),
      { list: async () => [] },
      { sync: async () => ({}) },
    );
    await assert.rejects(
      () =>
        daily.call("a", {
          operation: "schedule_update",
          id: a.reminders[0].id,
          status: "cancelled",
        }),
      /subscription_settings/,
    );
    await f.db.query(
      "UPDATE daily_schedules SET next_run=now()-interval '1 second' WHERE subscription_id=$1",
      [a.id],
    );
    const sent: string[] = [];
    await new DailyWorker(
      f.db,
      new ScheduleParser(),
      async (_u, text) => {
        sent.push(String(text));
      },
      async () => {
        throw new Error("Model/briefing must not be used");
      },
      async () => {},
    ).tick();
    assert.equal(sent.length, 2);
    assert.ok(sent.every((s) => s.includes("Gym")));
    await f.record({ label: "My gym" }, { id: a.id, baseRevision: 1 });
    await new DailyWorker(
      f.db,
      new ScheduleParser(),
      async () => {
        throw new Error("Must not replay");
      },
      async () => "",
      async () => {},
    ).tick();
    assert.ok(
      (await f.tools.read("a", a.id)).reminders.every(
        (r: any) => r.status === "completed",
      ),
    );
  } finally {
    await f.pg.close();
  }
});
test("restart and a record change during delivery do not replay uncertain reminders", async () => {
  const f = await fixture();
  try {
    let a = await f.record({ ...annual, reminderEnabled: true });
    await f.db.query(
      "UPDATE daily_schedules SET status='processing',started_at=now()-interval '11 minutes',lease=$2 WHERE subscription_id=$1",
      [a.id, randomUUID()],
    );
    await new DailyWorker(
      f.db,
      new ScheduleParser(),
      async () => {
        throw new Error("Must not send");
      },
      async () => "",
      async () => {},
    ).tick();
    a = await f.record(
      { reminderTime: "10:00" },
      { id: a.id, baseRevision: 1 },
    );
    assert.ok(a.reminders.every((r: any) => r.status === "failed"));
    assert.equal((await f.tools.read("a", a.id)).history.length, 2);
  } finally {
    await f.pg.close();
  }
});
test("late notices stay unscheduled and dates are not inferred from a cadence", () => {
  assert.equal(
    subscriptionReminders(
      { ...annual, reminderEnabled: true },
      Date.parse("2026-11-02T00:00:00Z"),
    ).plans.length,
    0,
  );
  assert.equal(
    subscriptionReminders(
      { ...annual, reminderEnabled: true },
      Date.parse("2026-11-02T00:00:00Z"),
    ).warnings.length,
    2,
  );
  assert.equal(
    subscriptionReminders(
      {
        label: "Monthly",
        status: "active",
        cadence: "monthly",
        reminderEnabled: true,
      },
      0,
    ).plans.length,
    0,
  );
});
test("tools and agent are gated independently of Gmail, results retain their notice and identifiers", async () => {
  const disabled = runtimeContext({ gmail: false }, null);
  assert.ok(!disabled.tools.some((t) => t.name.startsWith("subscription_")));
  assert.ok(!disabled.context.includes('"core/subscriptions"'));
  const absent = runtimeContext(
    { gmail: false },
    null,
    undefined,
    new Set(),
    true,
  );
  const off = runtimeContext(
    { gmail: false, subscriptions: false },
    null,
    undefined,
    new Set(["subscriptions"]),
    true,
  );
  assert.deepEqual(absent.tools, off.tools);
  assert.equal(absent.context, off.context);
  const enabled = runtimeContext({ subscriptions: true, gmail: false }, null);
  assert.equal(
    enabled.tools.filter((t) => t.name.startsWith("subscription_")).length,
    3,
  );
  assert.ok(
    JSON.parse(enabled.context).agentCatalogue.some(
      (a: any) => a.type === "subscriptions",
    ),
  );
  assert.ok(readOperations.has("subscription_list"));
  const f = await fixture();
  try {
    const a = await f.record(annual);
    const projected = projectObservation(
      "subscription_list",
      await f.tools.read("a", a.id),
    );
    assert.equal(projected.result.id, a.id);
    assert.match(projected.result.notice, /owner statements/);
  } finally {
    await f.pg.close();
  }
});
test("delegated manual records retain exact host input references without copying statement bodies", async () => {
  const f = await fixture();
  try {
    const input = randomUUID(),
      child = randomUUID();
    await f.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'a')", [
      f.run,
    ]);
    await f.db.query(
      "INSERT INTO conversation_inputs(id,user_id,message,run_id) VALUES($1,'a','Private original owner statement',$2)",
      [input, f.run],
    );
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'a','Delegate subscription capture',false)",
      [child],
    );
    await f.db.query(
      "INSERT INTO events(run_id,user_id,type,data) VALUES($1,'a','agent.child_started',$2::jsonb)",
      [child, JSON.stringify({ parentRunId: f.run })],
    );
    const r = await f.tools.call("a", child, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      fields: annual as any,
    });
    assert.deepEqual(r.history[0].source_ref.inputIds, [input]);
    assert.ok(!JSON.stringify(r).includes("Private original"));
  } finally {
    await f.pg.close();
  }
});
test("bounded pages preserve identifiers, provenance and the honesty notice for dense labels and long history", async () => {
  const f = await fixture();
  try {
    let first: any;
    for (let i = 0; i < 15; i++) {
      const row = await f.record({
        ...annual,
        label: `Plan ${i} ` + '"'.repeat(70),
        merchant: `Merchant ${i} ` + '"'.repeat(70),
        plan: '"'.repeat(90),
        accountLabel: '"'.repeat(90),
      });
      first ??= row;
    }
    for (let i = 0; i < 12; i++)
      first = await f.record(
        { label: `Changed ${i} ` + '"'.repeat(70) },
        { id: first.id, baseRevision: first.revision },
      );
    const list = await f.tools.list("a", { operation: "subscription_list" });
    assert.ok(JSON.stringify(list).length < 12000);
    assert.ok(list.nextOffset !== null);
    const read = await f.tools.read("a", first.id);
    assert.ok(JSON.stringify(read).length < 12000);
    assert.equal(
      projectObservation("subscription_list", read).result.id,
      first.id,
    );
    let offset = read.nextOffset;
    let revisions = read.history.map((u: any) => u.revision);
    while (offset !== null) {
      const page = await f.tools.read("a", first.id, offset);
      revisions.push(...page.history.map((u: any) => u.revision));
      offset = page.nextOffset;
    }
    assert.deepEqual(
      revisions,
      Array.from({ length: 13 }, (_, i) => 13 - i),
    );
  } finally {
    await f.pg.close();
  }
});
test("Mini App subscription reads require authentication, owner isolation and no public writes", async () => {
  const f = await fixture();
  const app = server(f.db, {
    origin: "https://example.test",
    token: "test",
    allowed: new Set(["123", "456"]),
  });
  try {
    // Mint the same bounded session format as MiniAuth without impersonating a Telegram login.
    const { createHmac } = await import("node:crypto");
    const auth = (user: string) => {
      const body = Buffer.from(
        JSON.stringify({ user, expires: Math.floor(Date.now() / 1000) + 60 }),
      ).toString("base64url");
      const key = createHmac("sha256", "test")
        .update("companion-miniapp-session-v1")
        .digest();
      return {
        authorization:
          "Bearer " +
          body +
          "." +
          createHmac("sha256", key).update(body).digest("base64url"),
      };
    };
    await ensureUser(f.db, "123");
    await ensureUser(f.db, "456");
    const run = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'123','Add gym',false)",
      [run],
    );
    const item = await f.tools.call("123", run, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      fields: annual as any,
    });
    assert.equal(
      (await app.inject({ url: "/api/miniapp/subscriptions" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/subscriptions",
          headers: auth("123"),
        })
      ).json().items[0].id,
      item.id,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/subscriptions/" + item.id,
          headers: auth("456"),
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/subscriptions?user=456",
          headers: auth("123"),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/miniapp/subscriptions",
          headers: auth("123"),
          payload: {},
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    await f.pg.close();
  }
});
