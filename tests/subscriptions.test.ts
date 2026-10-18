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
import { Execution, readOperations, recoverRuntime } from "../src/execution.js";
import { server } from "../src/server.js";
import { projectObservation } from "../src/observations.js";
import { plugins } from "../src/plugin-registry.js";

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
  nextChargeEstimated: false,
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
        new URL("../db/025_subscriptions.sql", import.meta.url),
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
      nextChargeEstimated: false,
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
      {
        status: "active",
        trialEndDate: null,
        nextChargeDate: "2026-11-20",
        nextChargeEstimated: false,
      },
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
test("concurrent exact update retries reconcile the committed request and consume no extra slots", async () => {
  const f = await fixture();
  try {
    const item = await f.record({ ...annual, reminderEnabled: true });
    const retry = {
      id: item.id,
      baseRevision: item.revision,
      requestKey: randomUUID(),
    };
    const results = await Promise.all([
      f.record({ amount: "240" }, retry),
      f.record({ amount: "240" }, retry),
    ]);
    assert.ok(results.every((r) => r.revision === 2));
    assert.ok(results.some((r) => r.duplicate));
    assert.equal((await f.tools.read("a", item.id)).history.length, 2);
    assert.equal(
      (
        await f.db.query(
          "SELECT active_count FROM daily_schedule_capacity WHERE user_id='a'",
        )
      ).rows[0].active_count,
      2,
    );
  } finally {
    await f.pg.close();
  }
});
async function fillSchedules(db: Database, count: number, user = "a") {
  for (let i = 0; i < count; i++)
    await db.query(
      "INSERT INTO daily_schedules(id,user_id,kind,content,schedule,parsed,next_run) VALUES($1,$2,'reminder','Synthetic other reminder','2026-12-01','{}','2026-12-01')",
      [randomUUID(), user],
    );
}
test("generic and subscription writers compete for one shared atomic schedule capacity", async () => {
  const f = await fixture();
  try {
    await fillSchedules(f.db, 49);
    const daily = new DailyTools(
      f.db,
      new ScheduleParser(),
      { list: async () => [] },
      { sync: async () => ({}) },
    );
    const results = await Promise.allSettled([
      f.record({
        ...annual,
        cancellationDeadline: null,
        reminderEnabled: true,
      }),
      daily.call("a", {
        operation: "schedule_create",
        kind: "reminder",
        content: "Other",
        schedule: "2026-12-01T09:00:00+08:00",
        includeEmail: false,
        includeCalendar: false,
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    assert.match(rejected.reason.message, /50 active schedules/);
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) AS n FROM daily_schedules WHERE status IN ('scheduled','processing')",
          )
        ).rows[0].n,
      ),
      50,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT active_count FROM daily_schedule_capacity WHERE user_id='a'",
        )
      ).rows[0].active_count,
      50,
    );
  } finally {
    await f.pg.close();
  }
});
test("moving a date at full capacity withdraws the old slot before reserving its replacement", async () => {
  const f = await fixture();
  try {
    let item = await f.record({
      ...annual,
      cancellationDeadline: null,
      reminderEnabled: true,
    });
    await fillSchedules(f.db, 49);
    item = await f.record(
      { nextChargeDate: "2026-12-01", nextChargeEstimated: false },
      { id: item.id, baseRevision: 1 },
    );
    assert.equal(
      item.reminders.find((r: any) => r.status === "scheduled").date,
      "2026-12-01",
    );
    item = await f.record({ amount: "240" }, { id: item.id, baseRevision: 2 });
    assert.equal(item.amount, "240");
    await f.record({ label: "No reminder", status: "active" });
    assert.equal(
      (
        await f.db.query(
          "SELECT active_count FROM daily_schedule_capacity WHERE user_id='a'",
        )
      ).rows[0].active_count,
      50,
    );
    await f.record({ status: "cancelled" }, { id: item.id, baseRevision: 3 });
    assert.equal(
      (
        await f.db.query(
          "SELECT active_count FROM daily_schedule_capacity WHERE user_id='a'",
        )
      ).rows[0].active_count,
      49,
    );
  } finally {
    await f.pg.close();
  }
});
test("restoring a withdrawn attempted date warns without replaying an uncertain send", async () => {
  const f = await fixture();
  try {
    let item = await f.record({
      ...annual,
      cancellationDeadline: null,
      reminderEnabled: true,
    });
    await f.db.query(
      "UPDATE daily_schedules SET status='processing',started_at=now(),lease=$1 WHERE subscription_id=$2",
      [randomUUID(), item.id],
    );
    item = await f.record(
      { nextChargeDate: "2026-12-01", nextChargeEstimated: false },
      { id: item.id, baseRevision: 1 },
    );
    item = await f.record(
      { nextChargeDate: "2026-11-01", nextChargeEstimated: false },
      { id: item.id, baseRevision: 2 },
    );
    assert.ok(item.reminders.every((r: any) => r.status === "cancelled"));
    assert.ok(
      item.warnings.some((w: string) =>
        /already attempted|may have started/.test(w),
      ),
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT active_count FROM daily_schedule_capacity WHERE user_id='a'",
        )
      ).rows[0].active_count,
      0,
    );
  } finally {
    await f.pg.close();
  }
});
test("restored-date warnings do not depend on the bounded reminder display history", async () => {
  const f = await fixture();
  try {
    let item = await f.record({
      ...annual,
      cancellationDeadline: null,
      reminderEnabled: true,
    });
    await f.db.query(
      "UPDATE daily_schedules SET status='processing',started_at=now(),lease=$1 WHERE subscription_id=$2",
      [randomUUID(), item.id],
    );
    for (let day = 2; day <= 22; day++)
      item = await f.record(
        {
          nextChargeDate: `2026-11-${String(day).padStart(2, "0")}`,
          nextChargeEstimated: false,
        },
        { id: item.id, baseRevision: item.revision },
      );
    item = await f.record(
      { nextChargeDate: "2026-11-01", nextChargeEstimated: false },
      { id: item.id, baseRevision: item.revision },
    );
    assert.ok(item.warnings.some((w: string) => w.includes("2026-11-01")));
    assert.ok(item.deliveryNotice);
    assert.ok(
      item.reminders.some(
        (r: any) => r.date === "2026-11-01" && r.status === "cancelled",
      ),
    );
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) AS n FROM daily_schedules WHERE subscription_id=$1 AND status='scheduled'",
            [item.id],
          )
        ).rows[0].n,
      ),
      0,
    );
  } finally {
    await f.pg.close();
  }
});
test("a replacement charge date requires its own certainty and clearing the date clears certainty provenance", async () => {
  const f = await fixture();
  try {
    let item = await f.record({ ...annual, nextChargeEstimated: true });
    await assert.rejects(
      () =>
        f.record(
          { nextChargeDate: "2026-11-07" },
          { id: item.id, baseRevision: 1 },
        ),
      /requires nextChargeEstimated/,
    );
    assert.equal((await f.tools.read("a", item.id)).revision, 1);
    item = await f.record(
      { nextChargeDate: "2026-11-07", nextChargeEstimated: false },
      { id: item.id, baseRevision: 1 },
    );
    assert.equal(item.nextChargeEstimated, false);
    assert.equal(
      item.fieldSources.nextChargeDate.updateId,
      item.fieldSources.nextChargeEstimated.updateId,
    );
    item = await f.record(
      { nextChargeDate: null },
      { id: item.id, baseRevision: 2 },
    );
    assert.equal(item.nextChargeDate, null);
    assert.equal(item.nextChargeEstimated, false);
    assert.equal(item.history[0].changes.nextChargeEstimated, false);
  } finally {
    await f.pg.close();
  }
});
test("reminder inspection is a read and settings has no read mode that recovery can mark uncertain", async () => {
  const f = await fixture();
  try {
    const item = await f.record(annual);
    assert.equal(
      action.safeParse({ operation: "subscription_settings", id: item.id })
        .success,
      false,
    );
    await assert.rejects(
      () =>
        f.tools.call("a", f.run, {
          operation: "subscription_settings",
          id: item.id,
          requestKey: randomUUID(),
          baseRevision: 1,
        }),
      /subscription_list/,
    );
    const execution = new Execution(
      f.db,
      "a",
      f.run,
      new AbortController().signal,
    );
    await execution.start();
    const call = await execution.beginCall("inspect", "subscription_list", {
      id: item.id,
    });
    await recoverRuntime(f.db);
    const row = (
      await f.db.query("SELECT state,is_write FROM runtime_calls WHERE id=$1", [
        call,
      ])
    ).rows[0];
    assert.equal(row.is_write, false);
    assert.notEqual(row.state, "uncertain");
    assert.equal(
      (await f.tools.list("a", { operation: "subscription_list", id: item.id }))
        .reminderEnabled,
      false,
    );
    assert.equal(readOperations.has("subscription_settings"), false);
  } finally {
    await f.pg.close();
  }
});
test("long steered turns bind the exact original source and reject foreign or unrelated-run source IDs", async () => {
  const f = await fixture();
  try {
    await f.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'a')", [
      f.run,
    ]);
    const original = randomUUID();
    await f.db.query(
      "INSERT INTO conversation_inputs(id,user_id,message,run_id) VALUES($1,'a','Add gym: 120 SGD annually',$2)",
      [original, f.run],
    );
    for (let i = 0; i < 10; i++)
      await f.db.query(
        "INSERT INTO conversation_inputs(id,user_id,message,run_id) VALUES($1,'a','Unrelated followup',$2)",
        [randomUUID(), f.run],
      );
    await assert.rejects(() => f.record(annual), /exact sourceInputIds/);
    const page = await f.tools.call("a", f.run, {
      operation: "subscription_list",
      sourceInputs: true,
    });
    assert.equal(page.sourceInputs[0].id, original);
    assert.equal(page.nextOffset, 10);
    assert.equal(
      (
        await f.tools.call("a", f.run, {
          operation: "subscription_list",
          sourceInputs: true,
          offset: 10,
        })
      ).sourceInputs.length,
      1,
    );
    const item = await f.record(annual, { sourceInputIds: [original] });
    assert.deepEqual(item.history[0].source_ref.inputIds, [original]);
    const otherRun = randomUUID(),
      otherInput = randomUUID();
    await f.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'a')", [
      otherRun,
    ]);
    await f.db.query(
      "INSERT INTO conversation_inputs(id,user_id,message,run_id) VALUES($1,'a','Other run',$2)",
      [otherInput, otherRun],
    );
    await assert.rejects(
      () =>
        f.record(
          { amount: "240" },
          { id: item.id, baseRevision: 1, sourceInputIds: [otherInput] },
        ),
      /current turn/,
    );
    const foreignRun = randomUUID(),
      foreignInput = randomUUID();
    await f.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,'b')", [
      foreignRun,
    ]);
    await f.db.query(
      "INSERT INTO conversation_inputs(id,user_id,message,run_id) VALUES($1,'b','Foreign',$2)",
      [foreignInput, foreignRun],
    );
    await assert.rejects(
      () =>
        f.record(
          { amount: "240" },
          { id: item.id, baseRevision: 1, sourceInputIds: [foreignInput] },
        ),
      /current turn/,
    );
    assert.equal((await f.tools.read("a", item.id)).revision, 1);
  } finally {
    await f.pg.close();
  }
});
test("capacity bookkeeping follows owner deletion without preventing cascading cleanup", async () => {
  const f = await fixture();
  try {
    await ensureUser(f.db, "capacity_owner");
    await fillSchedules(f.db, 2, "capacity_owner");
    await f.db.query("DELETE FROM users WHERE id='capacity_owner'");
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) AS n FROM daily_schedule_capacity WHERE user_id='capacity_owner'",
          )
        ).rows[0].n,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await f.db.query(
            "SELECT count(*) AS n FROM daily_schedules WHERE user_id='capacity_owner'",
          )
        ).rows[0].n,
      ),
      0,
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
    4,
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
// A matched invoice exactly as gathering leaves it: candidate facts, receipt and current-scope item.
async function matchedInvoice(
  db: Database,
  o: {
    user?: string;
    label?: string;
    accountLabel?: string;
    month?: string;
    date: string;
    amounts: { currency: string; amount: string }[];
    productLabels?: string[];
    matched?: boolean;
    collection?: string;
  },
) {
  const user = o.user ?? "a",
    collection = o.collection ?? randomUUID(),
    artifact = randomUUID(),
    attempt = randomUUID(),
    receipt = randomUUID(),
    key = "t" + artifact.slice(0, 8);
  const target = {
    key,
    label: o.label ?? "Claude Max",
    month: o.month ?? o.date.slice(0, 7),
    ...(o.accountLabel ? { accountLabel: o.accountLabel } : {}),
    dateBasis: "invoice_date",
    browserOrigins: [],
  };
  if (!o.collection) {
    const task = randomUUID();
    await db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request,status) VALUES($1,$2,'Gather invoices','Gather invoices','done')",
      [task, user],
    );
    await db.query(
      "INSERT INTO gather_collections(id,user_id,task_id,task_revision,request_key,request_hash,scope,state) VALUES($1,$2,$3,1,$4,'h',$5::jsonb,'complete')",
      [
        collection,
        user,
        task,
        randomUUID(),
        JSON.stringify({
          objective: "Gather invoices",
          targets: [target],
          sources: ["provided"],
          mailboxes: [],
          providedFiles: [],
        }),
      ],
    );
  } else
    await db.query(
      "UPDATE gather_collections SET scope=jsonb_set(scope,'{targets}',(scope->'targets')||$3::jsonb) WHERE id=$1 AND user_id=$2",
      [collection, user, JSON.stringify([target])],
    );
  const task = (
    await db.query("SELECT task_id FROM gather_collections WHERE id=$1", [
      collection,
    ])
  ).rows[0].task_id;
  const facts = {
    pages: 1,
    truncated: false,
    selectableText: true,
    invoiceHeading: true,
    dates: [o.date],
    invoiceDates: [o.date],
    serviceDates: [],
    serviceMonths: [],
    amounts: o.amounts,
    invoiceNumbers: ["INV-" + artifact.slice(0, 6)],
    issuerLabels: ["Anthropic"],
    productLabels: o.productLabels ?? ["Claude Max"],
  };
  await db.query(
    "INSERT INTO gather_targets(collection_id,user_id,key,state,coverage_checked) VALUES($1,$2,$3,'covered',true)",
    [collection, user, key],
  );
  await db.query(
    "INSERT INTO file_artifacts(id,user_id,sha256,name,mime_type,bytes,encrypted,facts) VALUES($1,$2,$3,'invoice.pdf','application/pdf',10,'\\x00'::bytea,$4::jsonb)",
    [artifact, user, artifact.replace(/-/g, "").padEnd(64, "0"), facts],
  );
  await db.query(
    "INSERT INTO gather_attempts(id,user_id,collection_id,target_key,kind,state) VALUES($1,$2,$3,$4,'provided','success')",
    [attempt, user, collection, key],
  );
  await db.query(
    "INSERT INTO gather_candidates(collection_id,target_key,user_id,artifact_id,attempt_id,facts) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [collection, key, user, artifact, attempt, facts],
  );
  if (o.matched !== false) {
    await db.query(
      "INSERT INTO tool_receipts(id,user_id,run_id,task_id,operation,status) VALUES($1,$2,$3,$4,'gather_match','success')",
      [receipt, user, randomUUID(), task],
    );
    await db.query(
      "INSERT INTO gather_items(collection_id,target_key,user_id,artifact_id,match_date,date_basis,receipt_id) VALUES($1,$2,$3,$4,$5,'invoice_date',$6)",
      [collection, key, user, artifact, o.date, receipt],
    );
  }
  return { collectionId: collection, artifactId: artifact, key };
}
const claude = {
  label: "Claude Max",
  merchant: "Anthropic",
  plan: "Claude Max",
  status: "active",
  amountType: "fixed",
  cadence: "monthly",
};
test("invoice-backed records are checked against the matched PDF's recorded clues and keep invoice provenance", async () => {
  const f = await fixture();
  try {
    const sep = await matchedInvoice(f.db, {
      date: "2026-09-05",
      amounts: [
        { currency: "USD", amount: "100.00" },
        { currency: "USD", amount: "9.00" },
      ],
    });
    const listed = await f.tools.call("a", f.run, {
      operation: "subscription_invoices",
    });
    assert.equal(listed.total, 1);
    assert.equal(listed.invoices[0].artifactId, sep.artifactId);
    assert.deepEqual(listed.invoices[0].amounts[0], {
      currency: "USD",
      amount: "100.00",
    });
    assert.match(listed.notice, /not an instruction to save/);
    assert.equal(
      (
        await f.tools.call("a", f.run, {
          operation: "subscription_invoices",
          issuer: "Netflix",
        })
      ).total,
      0,
    );
    assert.equal(
      (
        await f.tools.call("a", f.run, {
          operation: "subscription_invoices",
          issuer: "Claude",
        })
      ).total,
      1,
    );
    assert.equal(
      (await f.tools.invoices("b", { operation: "subscription_invoices" }))
        .total,
      0,
    );
    const invoice = {
      collectionId: sep.collectionId,
      artifactId: sep.artifactId,
    };
    for (const [fields, error] of [
      [{ ...claude, amount: "120", currency: "USD" }, /do not occur/],
      [{ ...claude, amount: "100", currency: "SGD" }, /do not occur/],
      [{ ...claude, lastInvoiceDate: "2026-09-06" }, /recorded for this file/],
      [
        {
          ...claude,
          label: "Claude Pro",
          plan: "Claude Pro",
          amount: "100",
          currency: "USD",
        },
        /different plan/,
      ],
      [
        {
          label: "Netflix",
          merchant: "Netflix",
          amount: "100",
          currency: "USD",
        },
        /does not match/,
      ],
      [claude, /must support amount/],
    ] as const)
      await assert.rejects(f.record(fields, { invoice }), error);
    await assert.rejects(
      f.record(
        { ...claude, amount: "100", currency: "USD" },
        {
          invoice: {
            collectionId: sep.collectionId,
            artifactId: randomUUID(),
          },
        },
      ),
      /not a matched invoice/,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM subscriptions")).rows[0].n,
      0,
    );
    const key = randomUUID();
    const created = await f.record(
      {
        ...claude,
        amount: "100",
        currency: "USD",
        lastInvoiceDate: "2026-09-05",
      },
      { invoice, requestKey: key },
    );
    assert.equal(created.created, true);
    assert.equal(created.fieldSources.amount.sourceKind, "invoice");
    assert.equal(created.fieldSources.amount.artifactId, sep.artifactId);
    assert.equal(created.fieldSources.lastInvoiceDate.sourceKind, "invoice");
    assert.equal(created.fieldSources.cadence.sourceKind, "owner");
    assert.equal(created.history[0].source_kind, "owner");
    assert.equal(
      created.history[0].source_ref.invoice.artifactId,
      sep.artifactId,
    );
    assert.equal(created.history[0].source_ref.invoice.matchDate, "2026-09-05");
    assert.match(created.confidence, /matched invoices/);
    assert.match(created.notice, /owner statements/);
    const retry = await f.tools.call("a", f.run, {
      operation: "subscription_record",
      requestKey: key,
      invoice,
      fields: {
        ...claude,
        amount: "100",
        currency: "USD",
        lastInvoiceDate: "2026-09-05",
      } as any,
    });
    assert.equal(retry.duplicate, true);
    await assert.rejects(
      f.tools.call("a", f.run, {
        operation: "subscription_record",
        requestKey: key,
        fields: {
          ...claude,
          amount: "100",
          currency: "USD",
          lastInvoiceDate: "2026-09-05",
        } as any,
      }),
      /different subscription data/,
    );
    assert.deepEqual(
      (await f.tools.call("a", f.run, { operation: "subscription_invoices" }))
        .invoices[0].linkedSubscriptionIds,
      [created.id],
    );
    const oct = await matchedInvoice(f.db, {
      date: "2026-10-05",
      amounts: [{ currency: "USD", amount: "110" }],
    });
    const raised = await f.record(
      { amount: "110.00", currency: "USD", lastInvoiceDate: "2026-10-05" },
      {
        id: created.id,
        baseRevision: created.revision,
        invoice: { collectionId: oct.collectionId, artifactId: oct.artifactId },
      },
    );
    assert.deepEqual(raised.priceChange, {
      from: { amount: "100", currency: "USD" },
      to: { amount: "110.00", currency: "USD" },
      source: "invoice",
    });
    assert.ok(raised.warnings.some((w: string) => /price changed/.test(w)));
    assert.equal(raised.monthlyEquivalent, "110.00");
    await assert.rejects(
      f.record(
        { amount: "100", currency: "USD" },
        { id: created.id, baseRevision: raised.revision, invoice },
      ),
      /older than the saved last invoice/,
    );
    // A superseded collection scope is history, not evidence.
    await f.db.query(
      "UPDATE gather_collections SET task_revision=2 WHERE id=$1",
      [oct.collectionId],
    );
    await assert.rejects(
      f.record(
        { amount: "110", currency: "USD" },
        {
          id: created.id,
          baseRevision: raised.revision,
          invoice: {
            collectionId: oct.collectionId,
            artifactId: oct.artifactId,
          },
        },
      ),
      /not a matched invoice/,
    );
    assert.equal(
      (await f.tools.call("a", f.run, { operation: "subscription_invoices" }))
        .total,
      1,
    );
  } finally {
    await f.pg.close();
  }
});
test("invoice evidence is owner-scoped, needs a match and respects the gathered account label", async () => {
  const f = await fixture();
  try {
    const foreign = await matchedInvoice(f.db, {
      user: "b",
      date: "2026-09-05",
      amounts: [{ currency: "USD", amount: "100" }],
    });
    const candidate = await matchedInvoice(f.db, {
      date: "2026-09-05",
      amounts: [{ currency: "USD", amount: "100" }],
      matched: false,
    });
    const work = await matchedInvoice(f.db, {
      date: "2026-09-05",
      accountLabel: "Work",
      amounts: [{ currency: "USD", amount: "100" }],
    });
    for (const invoice of [foreign, candidate])
      await assert.rejects(
        f.record(
          { ...claude, amount: "100", currency: "USD" },
          {
            invoice: {
              collectionId: invoice.collectionId,
              artifactId: invoice.artifactId,
            },
          },
        ),
        /not a matched invoice/,
      );
    await assert.rejects(
      f.record(
        { ...claude, accountLabel: "Personal", amount: "100", currency: "USD" },
        {
          invoice: {
            collectionId: work.collectionId,
            artifactId: work.artifactId,
          },
        },
      ),
      /different account label/,
    );
    const ok = await f.record(
      { ...claude, accountLabel: "Work", amount: "100", currency: "USD" },
      {
        invoice: {
          collectionId: work.collectionId,
          artifactId: work.artifactId,
        },
      },
    );
    assert.equal(ok.fieldSources.amount.sourceKind, "invoice");
    const background = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'a','Background pass',true)",
      [background],
    );
    await assert.rejects(
      f.tools.call("a", background, {
        operation: "subscription_record",
        requestKey: randomUUID(),
        id: ok.id,
        baseRevision: ok.revision,
        invoice: {
          collectionId: work.collectionId,
          artifactId: work.artifactId,
        },
        fields: { amount: "100", currency: "USD" },
      }),
      /foreground owner request/,
    );
  } finally {
    await f.pg.close();
  }
});
test("the bills agent shares core skills with gathering and subscriptions and needs both capabilities", () => {
  const types = (availability: Record<string, boolean>) =>
    JSON.parse(runtimeContext(availability, null).context).agentCatalogue.map(
      (a: any) => a.type,
    );
  const both = types({ subscriptions: true, gathering: true, gmail: true });
  assert.ok(both.includes("bills"));
  assert.ok(both.includes("gathering"));
  assert.ok(both.includes("subscriptions"));
  const ledgerOnly = types({ subscriptions: true, gathering: false });
  assert.ok(!ledgerOnly.includes("bills"));
  assert.ok(ledgerOnly.includes("subscriptions"));
  assert.ok(
    !types({ subscriptions: false, gathering: true }).includes("bills"),
  );
  const skills = (id: string) =>
    plugins
      .catalogue()
      .find((a) => a.agentId === id)!
      .skills.map((s: any) => s.key);
  assert.deepEqual(skills("core/bills"), [
    "core/invoice-gathering",
    "core/subscription-ledger",
    "core/invoice-ledger",
  ]);
  assert.deepEqual(skills("core/gathering"), ["core/invoice-gathering"]);
  assert.deepEqual(skills("core/subscriptions"), [
    "core/subscription-ledger",
    "core/invoice-ledger",
  ]);
  const bills = plugins.get("core/bills");
  for (const op of [
    "gather_capture",
    "gather_finish",
    "subscription_invoices",
    "subscription_record",
  ])
    assert.ok(bills.tools.includes(op));
  assert.ok(!bills.tools.includes("gather_start"));
  assert.ok(readOperations.has("subscription_invoices"));
});
