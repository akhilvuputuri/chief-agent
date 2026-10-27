import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migratedPGlite } from "./helpers/pglite.js";
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
import {
  buildSubscriptionSummary,
  summaryScheduleId,
} from "../src/subscription-summary.js";
import { buildBriefing } from "../src/daily-briefing.js";

async function fixture() {
  const pg = await migratedPGlite();
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
    6,
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
      [
        { ...claude, lastInvoiceDate: "2026-09-06" },
        /recorded invoice date \(2026-09-05\)/,
      ],
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
      /gathered for account "Work"/,
    );
    await assert.rejects(
      f.record(
        { ...claude, accountLabel: "Work", amount: "100", currency: "USD" },
        {
          invoice: {
            collectionId: work.collectionId,
            artifactId: work.artifactId,
          },
        },
      ),
      /Include this invoice's lastInvoiceDate/,
    );
    // An unlabelled item cannot take an account-specific invoice.
    await assert.rejects(
      f.record(
        {
          ...claude,
          amount: "100",
          currency: "USD",
          lastInvoiceDate: "2026-09-05",
        },
        {
          invoice: {
            collectionId: work.collectionId,
            artifactId: work.artifactId,
          },
        },
      ),
      /gathered for account "Work"/,
    );
    const ok = await f.record(
      {
        ...claude,
        accountLabel: "Work",
        amount: "100",
        currency: "USD",
        lastInvoiceDate: "2026-09-05",
      },
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
test("invoice identity needs the merchant's issuer, plan conflicts use combined names and order covers every invoice field", async () => {
  const f = await fixture();
  try {
    const pro = await matchedInvoice(f.db, {
      label: "Claude Pro",
      date: "2026-09-05",
      amounts: [{ currency: "USD", amount: "20.00" }],
      productLabels: ["Claude Pro", "Claude subscription"],
    });
    const cite = (x: { collectionId: string; artifactId: string }) => ({
      invoice: { collectionId: x.collectionId, artifactId: x.artifactId },
    });
    // Label and plan stored separately still name Claude Max.
    const max = await f.record({
      label: "Claude",
      merchant: "Anthropic",
      plan: "Max",
      status: "active",
      amount: "100",
      currency: "USD",
      lastInvoiceDate: "2026-08-05",
    });
    await assert.rejects(
      f.record(
        { amount: "20.00", currency: "USD", lastInvoiceDate: "2026-09-05" },
        { id: max.id, baseRevision: max.revision, ...cite(pro) },
      ),
      /different plan/,
    );
    // Real plan names ("Max 5x", "Max20", "Claude Max (5x)") still conflict with a Pro invoice.
    for (const item of [
      { label: "Claude Max 5x", merchant: "Anthropic", plan: "Max 5x" },
      { label: "Claude Max (5x)" },
      { label: "Claude", merchant: "Anthropic", plan: "Max20" },
    ])
      await assert.rejects(
        f.record(
          {
            ...item,
            amount: "20.00",
            currency: "USD",
            lastInvoiceDate: "2026-09-05",
          },
          cite(pro),
        ),
        /different plan/,
      );
    // Suffixed merchants keep their plan family, so the conflict check still applies.
    for (const item of [
      { label: "Anthropic", merchant: "Anthropic PBC", plan: "Max" },
      {
        label: "Anthropic subscription",
        merchant: "Anthropic, PBC",
        plan: "Max",
      },
      { label: "Anthropic PBC", plan: "Max" },
    ])
      await assert.rejects(
        f.record(
          {
            ...item,
            amount: "20.00",
            currency: "USD",
            lastInvoiceDate: "2026-09-05",
          },
          cite(pro),
        ),
        /different plan/,
      );
    // A merchant naming another issuer is refused even when the label matches.
    await assert.rejects(
      f.record(
        {
          label: "Claude Pro",
          merchant: "Netflix",
          amount: "20.00",
          currency: "USD",
          lastInvoiceDate: "2026-09-05",
        },
        cite(pro),
      ),
      /does not match this item's merchant/,
    );
    // A suffix is kept when the rest is too short to name an issuer.
    const xai = await matchedInvoice(f.db, {
      label: "X.ai",
      date: "2026-09-11",
      amounts: [{ currency: "USD", amount: "8" }],
      productLabels: [],
    });
    await assert.rejects(
      f.record(
        {
          label: "X Corp",
          merchant: "X Corp",
          amount: "8",
          currency: "USD",
          lastInvoiceDate: "2026-09-11",
        },
        cite(xai),
      ),
      /does not match this item's merchant/,
    );
    // Legal and domain suffixes do not change the issuer.
    for (const item of [
      { label: "Claude Pro", merchant: "Anthropic PBC", plan: "Pro" },
      { label: "Claude Pro", merchant: "Claude.ai" },
    ]) {
      const r = await f.record(
        {
          ...item,
          amount: "20.00",
          currency: "USD",
          lastInvoiceDate: "2026-09-05",
        },
        cite(pro),
      );
      assert.equal(r.fieldSources.amount.sourceKind, "invoice");
      await f.db.query("DELETE FROM subscriptions WHERE id=$1", [r.id]);
    }
    // A shared plan word or a later word of another issuer's name is not the same issuer.
    const youtube = await matchedInvoice(f.db, {
      label: "YouTube Premium",
      date: "2026-09-07",
      amounts: [{ currency: "SGD", amount: "15.98" }],
      productLabels: [],
    });
    for (const item of [
      { label: "Netflix", merchant: "Netflix", plan: "Premium" },
      { label: "Premium" },
    ])
      await assert.rejects(
        f.record(
          {
            ...item,
            amount: "15.98",
            currency: "SGD",
            lastInvoiceDate: "2026-09-07",
          },
          cite(youtube),
        ),
        /does not match this item's merchant/,
      );
    const hboMax = await matchedInvoice(f.db, {
      label: "Claude Max",
      date: "2026-09-09",
      amounts: [{ currency: "USD", amount: "100" }],
    });
    await assert.rejects(
      f.record(
        {
          label: "Max",
          amount: "100",
          currency: "USD",
          lastInvoiceDate: "2026-09-09",
        },
        cite(hboMax),
      ),
      /does not match this item's merchant/,
    );
    const yt = await f.record(
      {
        label: "YouTube",
        merchant: "YouTube",
        amount: "15.98",
        currency: "SGD",
        lastInvoiceDate: "2026-09-07",
      },
      cite(youtube),
    );
    assert.equal(yt.fieldSources.amount.sourceKind, "invoice");
    // An older invoice cannot move lastInvoiceDate back, alone or with an amount.
    const oct = await matchedInvoice(f.db, {
      label: "YouTube Premium",
      date: "2026-10-07",
      amounts: [{ currency: "SGD", amount: "16.98" }],
      productLabels: [],
    });
    const newer = await f.record(
      { amount: "16.98", currency: "SGD", lastInvoiceDate: "2026-10-07" },
      { id: yt.id, baseRevision: yt.revision, ...cite(oct) },
    );
    await assert.rejects(
      f.record(
        { lastInvoiceDate: "2026-09-07" },
        { id: yt.id, baseRevision: newer.revision, ...cite(youtube) },
      ),
      /older than the saved last invoice/,
    );
    // A service-period match without one recorded invoice date cannot be ordered.
    const undated = await matchedInvoice(f.db, {
      label: "YouTube Premium",
      date: "2026-08-07",
      amounts: [{ currency: "SGD", amount: "14.98" }],
      productLabels: [],
    });
    await f.db.query(
      "UPDATE gather_items SET match_date='2026-08',date_basis='service_period' WHERE artifact_id=$1",
      [undated.artifactId],
    );
    await f.db.query(
      "UPDATE gather_candidates SET facts=jsonb_set(facts,'{invoiceDates}','[]'::jsonb) WHERE artifact_id=$1",
      [undated.artifactId],
    );
    await assert.rejects(
      f.record(
        { amount: "14.98", currency: "SGD" },
        { id: yt.id, baseRevision: newer.revision, ...cite(undated) },
      ),
      /no single recorded invoice date/,
    );
    await assert.rejects(
      f.record({ label: "Bad date", lastInvoiceDate: "2026-02-30" }),
      /real calendar date for lastInvoiceDate/,
    );
  } finally {
    await f.pg.close();
  }
});
test("an agent bound to a gathering task reads and cites only its assigned collection's invoices", async () => {
  const f = await fixture();
  try {
    const mine = await matchedInvoice(f.db, {
      date: "2026-09-05",
      amounts: [{ currency: "USD", amount: "100" }],
    });
    const other = await matchedInvoice(f.db, {
      date: "2026-10-05",
      amounts: [{ currency: "USD", amount: "110" }],
    });
    const task = (
      await f.db.query("SELECT task_id FROM gather_collections WHERE id=$1", [
        mine.collectionId,
      ])
    ).rows[0].task_id;
    const child = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,background,task_id,revision) VALUES($1,'a','Bills agent',false,$2,1)",
      [child, task],
    );
    await f.db.query(
      "INSERT INTO events(run_id,user_id,type,data) VALUES($1,'a','agent.child_started',$2::jsonb)",
      [child, JSON.stringify({ parentRunId: f.run })],
    );
    const listed = await f.tools.call("a", child, {
      operation: "subscription_invoices",
    });
    assert.deepEqual(
      listed.invoices.map((i: any) => i.artifactId),
      [mine.artifactId],
    );
    await assert.rejects(
      f.tools.call("a", child, {
        operation: "subscription_invoices",
        collectionId: other.collectionId,
      }),
      /only its assigned collection/,
    );
    await assert.rejects(
      f.tools.call("a", child, {
        operation: "subscription_record",
        requestKey: randomUUID(),
        invoice: {
          collectionId: other.collectionId,
          artifactId: other.artifactId,
        },
        fields: {
          ...claude,
          amount: "110",
          currency: "USD",
          lastInvoiceDate: "2026-10-05",
        } as any,
      }),
      /only its assigned collection/,
    );
    const ok = await f.tools.call("a", child, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      invoice: { collectionId: mine.collectionId, artifactId: mine.artifactId },
      fields: {
        ...claude,
        amount: "100",
        currency: "USD",
        lastInvoiceDate: "2026-09-05",
      } as any,
    });
    assert.equal(ok.fieldSources.amount.sourceKind, "invoice");
    // The coordinator itself is not bound and sees every collection.
    assert.equal(
      (await f.tools.call("a", f.run, { operation: "subscription_invoices" }))
        .total,
      2,
    );
  } finally {
    await f.pg.close();
  }
});
test("ambiguous invoice dates never order an invoice and every price-pair change is reported", async () => {
  const f = await fixture();
  try {
    const item = await f.record({
      ...claude,
      amount: "100",
      currency: "USD",
      lastInvoiceDate: "2026-10-05",
    });
    // A service-period PDF naming two invoice dates cannot set or order lastInvoiceDate.
    const twoDates = await matchedInvoice(f.db, {
      date: "2026-11-05",
      amounts: [{ currency: "USD", amount: "120" }],
    });
    await f.db.query(
      "UPDATE gather_items SET match_date='2026-11',date_basis='service_period' WHERE artifact_id=$1",
      [twoDates.artifactId],
    );
    await f.db.query(
      `UPDATE gather_candidates SET facts=jsonb_set(facts,'{invoiceDates}','["2026-08-05","2026-11-05"]'::jsonb) WHERE artifact_id=$1`,
      [twoDates.artifactId],
    );
    const cite = {
      invoice: {
        collectionId: twoDates.collectionId,
        artifactId: twoDates.artifactId,
      },
    };
    await assert.rejects(
      f.record(
        { amount: "120", currency: "USD", lastInvoiceDate: "2026-11-05" },
        { id: item.id, baseRevision: item.revision, ...cite },
      ),
      /no single recorded invoice date, so lastInvoiceDate cannot come from it/,
    );
    await assert.rejects(
      f.record(
        { amount: "120", currency: "USD" },
        { id: item.id, baseRevision: item.revision, ...cite },
      ),
      /cannot be ordered against the saved last invoice/,
    );
    // Currency-only, unknown-to-known and known-to-unknown changes are price changes too.
    const sgd = await f.record(
      { currency: "SGD" },
      { id: item.id, baseRevision: item.revision },
    );
    assert.deepEqual(sgd.priceChange.to, { amount: "100", currency: "SGD" });
    assert.ok(sgd.warnings.some((w: string) => /100 USD to 100 SGD/.test(w)));
    const cleared = await f.record(
      { amount: null, currency: null },
      { id: item.id, baseRevision: sgd.revision },
    );
    assert.deepEqual(cleared.priceChange.to, { amount: null, currency: null });
    assert.ok(cleared.warnings.some((w: string) => /to unknown/.test(w)));
    const known = await f.record(
      { amount: "9", currency: "SGD" },
      { id: item.id, baseRevision: cleared.revision },
    );
    assert.ok(
      known.warnings.some((w: string) => /from unknown to 9 SGD/.test(w)),
    );
    const same = await f.record(
      { amount: "9.00", currency: "SGD" },
      { id: item.id, baseRevision: known.revision },
    );
    assert.equal(same.priceChange, undefined);
  } finally {
    await f.pg.close();
  }
});
test("invoice listings return every recorded amount and page past large histories", async () => {
  const f = await fixture();
  try {
    const amounts = Array.from({ length: 20 }, (_, i) => ({
      currency: "USD",
      amount: String(i + 1),
    }));
    const one = await matchedInvoice(f.db, { date: "2026-09-05", amounts });
    for (let i = 0; i < 24; i++)
      await matchedInvoice(f.db, {
        collection: one.collectionId,
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        amounts: [{ currency: "USD", amount: "1" }],
      });
    const first = await f.tools.call("a", f.run, {
      operation: "subscription_invoices",
      collectionId: one.collectionId,
    });
    assert.equal(first.total, 25);
    assert.equal(first.invoices[0].amounts.length, 20);
    const seen = new Set<string>();
    for (let offset: number | null = 0; offset !== null;) {
      const page: any = await f.tools.call("a", f.run, {
        operation: "subscription_invoices",
        collectionId: one.collectionId,
        offset,
      });
      for (const i of page.invoices) seen.add(i.artifactId);
      offset = page.nextOffset;
    }
    assert.equal(seen.size, 25);
  } finally {
    await f.pg.close();
  }
});
const netflix = {
  label: "Netflix",
  merchant: "Netflix",
  status: "active",
  amount: "22.98",
  currency: "SGD",
  amountType: "fixed",
  cadence: "monthly",
};
test("a pending price change is shown before its date, noticed even with reminders off, and applied from it", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.record({ ...netflix, pendingAmount: "24.98" }),
      /together/,
    );
    const r = await f.record({
      ...netflix,
      pendingAmount: "24.98",
      pendingCurrency: "SGD",
      pendingEffectiveDate: "2026-12-01",
    });
    // Before the date: the current price stays, and one notice is planned 3 days ahead at 09:00 SGT.
    assert.equal(r.amount, "22.98");
    assert.equal(r.monthlyEquivalent, "22.98");
    assert.equal(r.pendingAmount, "24.98");
    assert.deepEqual(
      r.reminders.map((x: any) => [x.date, x.status]),
      [["2026-12-01", "scheduled"]],
    );
    assert.equal(
      new Date(r.reminders[0].firesAt).toISOString(),
      "2026-11-28T01:00:00.000Z",
    );
    // The scheduler delivers it with reminders off, model-free.
    await f.db.query(
      "UPDATE daily_schedules SET next_run=now()-interval '1 second' WHERE subscription_id=$1",
      [r.id],
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
    assert.equal(sent.length, 1);
    assert.match(
      sent[0]!,
      /price changes on 2026-12-01 from 22.98 SGD to 24.98 SGD/,
    );
    // Turning price alerts off withdraws the notice; turning them on plans it again.
    const off = await f.tools.call("a", f.run, {
      operation: "subscription_settings",
      id: r.id,
      requestKey: randomUUID(),
      baseRevision: r.revision,
      priceAlerts: false,
    } as any);
    assert.equal(off.priceAlerts, false);
    assert.ok(off.reminders.every((x: any) => x.status !== "scheduled"));
    // From the effective date the new price is current in reads and totals.
    const later = new SubscriptionTools(f.db, () =>
      Date.parse("2026-12-02T00:00:00Z"),
    );
    const read = await later.read("a", r.id);
    assert.equal(read.amount, "24.98");
    assert.equal(read.pendingAmount, undefined);
    assert.equal(read.appliedPendingPrice.effectiveDate, "2026-12-01");
    assert.equal(read.fieldSources.amount.appliedOn, "2026-12-01");
    assert.deepEqual(
      (await later.list("a", { operation: "subscription_list" })).totals,
      [{ currency: "SGD", monthlyEquivalent: "24.98", items: 1 }],
    );
    // The next update records the applied change in history.
    const updated = await later.call("a", f.run, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      id: r.id,
      baseRevision: off.revision,
      fields: { plan: "Standard" },
    } as any);
    assert.equal(updated.amount, "24.98");
    assert.equal(updated.pendingEffectiveDate, undefined);
    assert.deepEqual(updated.history[0].source_ref.appliedPending.to, {
      amount: "24.98",
      currency: "SGD",
    });
    // The write that first records the applied change reports it.
    assert.deepEqual(updated.priceChange, {
      from: { amount: "22.98", currency: "SGD" },
      to: { amount: "24.98", currency: "SGD" },
      source: "saved price change",
    });
    // A pending date that is not in the future is refused.
    await assert.rejects(
      later.call("a", f.run, {
        operation: "subscription_record",
        requestKey: randomUUID(),
        id: r.id,
        baseRevision: updated.revision,
        fields: {
          pendingAmount: "26.98",
          pendingCurrency: "SGD",
          pendingEffectiveDate: "2026-12-02",
        },
      } as any),
      /future effective date/,
    );
  } finally {
    await f.pg.close();
  }
});
test("renewal reminders after a saved price change quote the new price", () => {
  const plans = subscriptionReminders(
    {
      label: "Gym",
      status: "active",
      amount: "120",
      currency: "SGD",
      amountType: "fixed",
      cadence: "annual",
      nextChargeDate: "2026-12-10",
      nextChargeEstimated: false,
      pendingAmount: "150",
      pendingCurrency: "SGD",
      pendingEffectiveDate: "2026-12-01",
      reminderEnabled: true,
    },
    Date.parse("2026-10-01T00:00:00Z"),
  ).plans;
  const renewal = plans.find((p) => p.date === "2026-12-10")!;
  assert.match(renewal.content, /150 SGD .*after the saved price change/);
  const notice = plans.find((p) => p.date === "2026-12-01")!;
  assert.match(notice.content, /from 120 SGD to 150 SGD/);
});
test("invoice price checks compare with the one owning item and alert once per invoice", async () => {
  const f = await fixture();
  try {
    const sep = await matchedInvoice(f.db, {
      label: "Netflix",
      date: "2026-09-05",
      amounts: [{ currency: "SGD", amount: "22.98" }],
      productLabels: [],
    });
    const oct = await matchedInvoice(f.db, {
      label: "Netflix",
      date: "2026-10-05",
      amounts: [
        { currency: "SGD", amount: "24.98" },
        { currency: "SGD", amount: "2.06" },
      ],
      productLabels: [],
    });
    const check = (x: {
      collectionId: string;
      key: string;
      artifactId: string;
    }) => f.tools.priceCheck("a", x.collectionId, x.key, x.artifactId);
    assert.equal(await check(sep), null);
    const item = await f.record({ ...netflix, lastInvoiceDate: "2026-09-05" });
    assert.equal((await check(sep)).status, "unchanged");
    const differs: any = await check(oct);
    assert.equal(differs.status, "differs");
    assert.equal(differs.subscriptionId, item.id);
    assert.deepEqual(differs.saved, {
      amount: "22.98",
      currency: "SGD",
      pendingApplied: false,
    });
    assert.equal(differs.invoiceAmounts[0].amount, "24.98");
    // One alert per item and invoice, never repeated, and the tracker is unchanged.
    assert.equal(
      await f.tools.queuePriceAlert("a", differs, oct.artifactId),
      true,
    );
    assert.equal(
      await f.tools.queuePriceAlert("a", differs, oct.artifactId),
      false,
    );
    const alerts = (
      await f.db.query(
        "SELECT content FROM daily_schedules WHERE user_id='a' AND subscription_id IS NULL",
      )
    ).rows;
    assert.equal(alerts.length, 1);
    assert.match(
      alerts[0].content,
      /possible price change.*22\.98 SGD.*24\.98 SGD.*not changed/,
    );
    assert.equal((await f.tools.read("a", item.id)).amount, "22.98");
    // A saved price change in force on the invoice date is the price compared.
    const pending = await f.record(
      {
        pendingAmount: "24.98",
        pendingCurrency: "SGD",
        pendingEffectiveDate: "2026-10-02",
      },
      { id: item.id, baseRevision: item.revision },
    );
    assert.equal((await check(oct)).status, "unchanged");
    // An older invoice than the saved one is not compared.
    await f.record(
      {
        pendingAmount: null,
        pendingCurrency: null,
        pendingEffectiveDate: null,
        lastInvoiceDate: "2026-11-05",
      },
      { id: item.id, baseRevision: pending.revision },
    );
    assert.equal((await check(oct)).status, "not_newer");
    // Two items that could own the invoice: no comparison.
    await f.record({
      ...netflix,
      plan: "Family",
      amount: "30",
      lastInvoiceDate: null,
    });
    assert.equal((await check(oct)).status, "ambiguous");
  } finally {
    await f.pg.close();
  }
});
test("price alerts respect the item's setting", async () => {
  const f = await fixture();
  try {
    const nov = await matchedInvoice(f.db, {
      label: "Netflix",
      date: "2026-11-05",
      amounts: [{ currency: "SGD", amount: "26.98" }],
      productLabels: [],
    });
    await f.record({ ...netflix, priceAlerts: false });
    const c: any = await f.tools.priceCheck(
      "a",
      nov.collectionId,
      nov.key,
      nov.artifactId,
    );
    assert.equal(c.status, "differs");
    assert.equal(c.alerts, false);
    assert.equal(await f.tools.queuePriceAlert("a", c, nov.artifactId), false);
  } finally {
    await f.pg.close();
  }
});
test("price alerts off removes the notice even with reminders on, and grouped dates keep their own leads", async () => {
  const f = await fixture();
  try {
    const r = await f.record({
      ...netflix,
      reminderEnabled: true,
      priceAlerts: false,
      pendingAmount: "24.98",
      pendingCurrency: "SGD",
      pendingEffectiveDate: "2026-12-01",
    });
    assert.equal(r.reminders.length, 0);
    const plans = (data: object) =>
      subscriptionReminders(
        {
          label: "TV",
          status: "active",
          amount: "10",
          currency: "SGD",
          amountType: "fixed",
          cadence: "monthly",
          nextChargeDate: "2026-12-01",
          nextChargeEstimated: false,
          pendingAmount: "12",
          pendingCurrency: "SGD",
          pendingEffectiveDate: "2026-12-01",
          reminderEnabled: true,
          ...data,
        },
        Date.parse("2026-10-01T00:00:00Z"),
      ).plans;
    // A monthly renewal (no lead) sharing the date keeps no lead once alerts are off.
    assert.deepEqual(plans({ priceAlerts: false }), []);
    const both = plans({});
    assert.equal(both.length, 1);
    assert.equal(both[0]!.fire, "2026-11-28T01:00:00.000Z");
    assert.match(both[0]!.content, /Also on that date: renewal/);
  } finally {
    await f.pg.close();
  }
});
test("after a saved change takes effect: its day stays in the timeline, edits compare with the price in force, and older invoices use the price they replaced", async () => {
  const f = await fixture();
  try {
    const r = await f.record({
      ...netflix,
      amount: "20",
      lastInvoiceDate: "2026-11-01",
      pendingAmount: "25",
      pendingCurrency: "SGD",
      pendingEffectiveDate: "2026-12-01",
    });
    const on = (iso: string) =>
      new SubscriptionTools(f.db, () => Date.parse(iso));
    // Effective day (1 December, Singapore): new price, and the change is still listed for today.
    const day = await on("2026-12-01T01:00:00Z").list("a", {
      operation: "subscription_list",
    });
    assert.equal(day.items[0].amount, "25");
    assert.ok(
      day.upcoming.some(
        (u: any) =>
          u.date === "2026-12-01" && u.events.includes("price change"),
      ),
    );
    // The change is recorded by a plan edit on 2 December.
    const later = on("2026-12-02T01:00:00Z");
    const recorded = await later.call("a", f.run, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      id: r.id,
      baseRevision: r.revision,
      fields: { plan: "Standard" },
    } as any);
    assert.equal(recorded.priceChange.source, "saved price change");
    // A November invoice for the old price, matched afterwards, is not a price change.
    const nov = await matchedInvoice(f.db, {
      label: "Netflix",
      date: "2026-11-20",
      amounts: [{ currency: "SGD", amount: "20" }],
      productLabels: [],
    });
    assert.equal(
      (await on("2026-12-03T01:00:00Z").priceCheck(
        "a",
        nov.collectionId,
        nov.key,
        nov.artifactId,
      ))!.status,
      "unchanged",
    );
    const dec = await matchedInvoice(f.db, {
      label: "Netflix",
      date: "2026-12-05",
      amounts: [{ currency: "SGD", amount: "20" }],
      productLabels: [],
    });
    assert.equal(
      (await on("2026-12-06T01:00:00Z").priceCheck(
        "a",
        dec.collectionId,
        dec.key,
        dec.artifactId,
      ))!.status,
      "differs",
    );
  } finally {
    await f.pg.close();
  }
});
test("an owner price edit after a change takes effect reports the price in force as its start", async () => {
  const f = await fixture();
  try {
    const r = await f.record({
      ...netflix,
      pendingAmount: "24.98",
      pendingCurrency: "SGD",
      pendingEffectiveDate: "2026-12-01",
    });
    const edit = await new SubscriptionTools(f.db, () =>
      Date.parse("2026-12-02T01:00:00Z"),
    ).call("a", f.run, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      id: r.id,
      baseRevision: r.revision,
      fields: { amount: "22.98", currency: "SGD" },
    } as any);
    assert.deepEqual(edit.priceChange, {
      from: { amount: "24.98", currency: "SGD" },
      to: { amount: "22.98", currency: "SGD" },
      source: "owner",
    });
    assert.ok(edit.history[0].source_ref.appliedPending);
  } finally {
    await f.pg.close();
  }
});
test("the monthly summary is an owner opt-in schedule set only in the foreground", async () => {
  const f = await fixture();
  try {
    assert.ok(readOperations.has("subscription_summary"));
    assert.ok(!readOperations.has("subscription_summary_set"));
    assert.throws(() =>
      action.parse({
        operation: "subscription_summary_set",
        enabled: true,
        day: 29,
      }),
    );
    const on = await f.tools.call("a", f.run, {
      operation: "subscription_summary_set",
      enabled: true,
    } as any);
    assert.equal(on.enabled, true);
    // 1 October 08:00 Singapore → today's 09:00 run.
    assert.equal(
      new Date(on.nextRun).toISOString(),
      "2026-10-01T01:00:00.000Z",
    );
    const row = (
      await f.db.query(
        "SELECT kind,schedule,status FROM daily_schedules WHERE id=$1",
        [summaryScheduleId("a")],
      )
    ).rows[0];
    assert.deepEqual(row, {
      kind: "briefing",
      schedule: "0 9 1 * *",
      status: "scheduled",
    });
    const moved = await f.tools.call("a", f.run, {
      operation: "subscription_summary_set",
      enabled: true,
      day: 5,
      time: "20:30",
    } as any);
    assert.equal(
      new Date(moved.nextRun).toISOString(),
      "2026-10-05T12:30:00.000Z",
    );
    const off = await f.tools.call("a", f.run, {
      operation: "subscription_summary_set",
      enabled: false,
    } as any);
    assert.equal(off.enabled, false);
    assert.equal(off.nextRun, null);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM daily_schedules WHERE user_id='a'",
        )
      ).rows[0].n,
      1,
    );
    const preview = await f.tools.call("a", f.run, {
      operation: "subscription_summary",
    } as any);
    assert.equal(preview.enabled, false);
    assert.match(preview.summary.reply, /September 2026 summary/);
    const background = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'a','Background pass',true)",
      [background],
    );
    await assert.rejects(
      f.tools.call("a", background, {
        operation: "subscription_summary_set",
        enabled: true,
      } as any),
      /foreground owner request/,
    );
  } finally {
    await f.pg.close();
  }
});
test("the summary reports totals, the month's recorded changes and the next 30 days from saved records", async () => {
  const f = await fixture();
  try {
    const at = (iso: string) => async (id: string, revision: number) =>
      f.db.query(
        "UPDATE subscription_updates SET recorded_at=$3 WHERE subscription_id=$1 AND revision=$2",
        [id, revision, iso],
      );
    const gym = await f.record(annual);
    await at("2026-08-20T04:00:00Z")(gym.id, 1);
    const music = await f.record({
      label: "Music",
      status: "active",
      amount: "4.50",
      currency: "USD",
      amountType: "fixed",
      cadence: "monthly",
    });
    await at("2026-08-20T04:00:00Z")(music.id, 1);
    // September (Singapore): a new item, a cancellation and a price change.
    const tv = await f.record({ ...netflix });
    await at("2026-09-02T04:00:00Z")(tv.id, 1);
    const raised = await f.record(
      { amount: "5.50" },
      { id: music.id, baseRevision: music.revision },
    );
    await at("2026-09-10T04:00:00Z")(music.id, raised.revision);
    const gone = await f.record(
      { status: "cancelled" },
      { id: gym.id, baseRevision: gym.revision },
    );
    await at("2026-09-30T15:30:00Z")(gym.id, gone.revision); // 30 Sep 23:30 SGT
    // Recorded on 1 October Singapore time: not a September change.
    const water = await f.record({
      label: "Water",
      status: "active",
      amountType: "variable",
    });
    await at("2026-09-30T16:30:00Z")(water.id, 1);
    const s = await buildSubscriptionSummary(
      f.db,
      "a",
      Date.parse("2026-10-01T01:00:00Z"),
    );
    assert.match(s.reply, /^Subscriptions — September 2026 summary/);
    assert.match(s.reply, /September 2026: 1 new, 1 ended, 1 price change\./);
    const body = (t: string) =>
      s.sections!.find((x) => x.title.startsWith(t))!.body;
    assert.match(body("Monthly equivalents"), /22\.98 SGD a month/);
    assert.match(body("Monthly equivalents"), /5\.50 USD a month/);
    const changes = body("Changes in September 2026");
    assert.match(changes, /New · Netflix: added 2026-09-02/);
    assert.match(changes, /Ended · Gym: cancelled \(recorded 2026-09-30\)/);
    assert.match(
      changes,
      /Price · Music: 4\.50 USD → 5\.50 USD \(owner, recorded 2026-09-10\)/,
    );
    assert.doesNotMatch(changes, /Water/);
    assert.match(body("Not in the totals"), /Water: amount unknown/);
    assert.match(s.reply, /From saved records only/);
    // Another owner sees none of it.
    const other = await buildSubscriptionSummary(
      f.db,
      "b",
      Date.parse("2026-10-01T01:00:00Z"),
    );
    assert.match(other.reply, /no recorded changes/);
    assert.doesNotMatch(JSON.stringify(other), /Netflix|Music|Gym/);
  } finally {
    await f.pg.close();
  }
});
test("saved price changes appear in the month they take effect and upcoming ones in the next 30 days", async () => {
  const f = await fixture();
  try {
    // Saved on 1 September, before the change takes effect.
    const tv = await new SubscriptionTools(f.db, () =>
      Date.parse("2026-09-01T00:00:00Z"),
    ).call("a", f.run, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      fields: {
        ...netflix,
        nextChargeDate: "2026-10-05",
        nextChargeEstimated: false,
        pendingAmount: "24.98",
        pendingCurrency: "SGD",
        pendingEffectiveDate: "2026-09-15",
      },
    } as any);
    const gym = await f.record({
      ...annual,
      pendingAmount: "150",
      pendingCurrency: "SGD",
      pendingEffectiveDate: "2026-10-20",
    });
    void gym;
    const s = await buildSubscriptionSummary(
      f.db,
      "a",
      Date.parse("2026-10-01T01:00:00Z"),
    );
    const body = (t: string) =>
      s.sections!.find((x) => x.title.startsWith(t))!.body;
    assert.match(
      body("Changes"),
      /Price · Netflix: 22\.98 SGD → 24\.98 SGD from 2026-09-15 \(saved price change\)/,
    );
    const next = body("Next 30 days");
    assert.match(next, /2026-10-05 · Netflix: renewal · 24\.98 SGD/);
    assert.match(next, /2026-10-20 · Gym: price change/);
    // After the next update records it, it is still reported once, in September.
    const updated = await new SubscriptionTools(f.db, () =>
      Date.parse("2026-10-01T01:00:00Z"),
    ).call("a", f.run, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      id: tv.id,
      baseRevision: tv.revision,
      fields: { plan: "Standard" },
    } as any);
    assert.ok(updated.history[0].source_ref.appliedPending);
    const again = await buildSubscriptionSummary(
      f.db,
      "a",
      Date.parse("2026-10-01T01:00:00Z"),
    );
    const prices = again
      .sections!.find((x) => x.title.startsWith("Changes"))!
      .body.match(/Price · Netflix/g);
    assert.equal(prices?.length, 1);
  } finally {
    await f.pg.close();
  }
});
test("the scheduler delivers the summary with no model, Gmail or Calendar call", async () => {
  const f = await fixture();
  try {
    await f.record({ ...netflix });
    await f.tools.call("a", f.run, {
      operation: "subscription_summary_set",
      enabled: true,
    } as any);
    await f.db.query(
      "UPDATE daily_schedules SET next_run=now()-interval '1 second' WHERE id=$1",
      [summaryScheduleId("a")],
    );
    const forbidden = () => {
      throw new Error("No model, Gmail or Calendar call");
    };
    const sent: any[] = [];
    await new DailyWorker(
      f.db,
      new ScheduleParser(),
      async (_u, text) => {
        sent.push(text);
      },
      (j) =>
        buildBriefing(j, {
          db: f.db,
          calendar: { list: forbidden } as any,
          gmail: { call: forbidden } as any,
        }),
      async () => {},
    ).tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0].reply, /Subscriptions — .* summary/);
    assert.match(sent[0].reply, /22\.98 SGD a month/);
    const row = (
      await f.db.query(
        "SELECT status,last_delivered FROM daily_schedules WHERE id=$1",
        [summaryScheduleId("a")],
      )
    ).rows[0];
    assert.equal(row.status, "scheduled");
    assert.ok(row.last_delivered);
  } finally {
    await f.pg.close();
  }
});
test("summary settings: generic schedule tools refuse it, delivery in progress blocks changes, saved day/time persist and failures are visible", async () => {
  const f = await fixture();
  try {
    const set = (x: object) =>
      f.tools.call("a", f.run, {
        operation: "subscription_summary_set",
        ...x,
      } as any);
    await set({ enabled: true, day: 15, time: "20:30" });
    const kept = await set({ enabled: true });
    assert.equal(kept.schedule, "monthly on day 15 at 20:30 Singapore time");
    const daily = new DailyTools(
      f.db,
      new ScheduleParser(),
      { list: async () => [] },
      { sync: async () => ({}) } as any,
    );
    await assert.rejects(
      () =>
        daily.call("a", {
          operation: "schedule_update",
          id: summaryScheduleId("a"),
          schedule: "0 9 * * *",
        } as any),
      /subscription_summary_set/,
    );
    await f.db.query(
      "UPDATE daily_schedules SET status='processing' WHERE id=$1",
      [summaryScheduleId("a")],
    );
    await assert.rejects(set({ enabled: false }), /being sent right now/);
    await f.db.query(
      "UPDATE daily_schedules SET status='failed',last_error='Run or delivery failed; check Telegram before rescheduling' WHERE id=$1",
      [summaryScheduleId("a")],
    );
    const preview = await f.tools.call("a", f.run, {
      operation: "subscription_summary",
    } as any);
    assert.equal(preview.status, "failed");
    assert.match(preview.lastError, /delivery failed/);
    assert.match(preview.statusNotice, /stays stopped/);
    assert.equal((await set({ enabled: true })).enabled, true);
  } finally {
    await f.pg.close();
  }
});
test("summary changes: net status per item, decimal-equal prices, ended items' saved changes and every excluded item", async () => {
  const f = await fixture();
  try {
    const at = (iso: string) => async (id: string, revision: number) =>
      f.db.query(
        "UPDATE subscription_updates SET recorded_at=$3 WHERE subscription_id=$1 AND revision=$2",
        [id, revision, iso],
      );
    // Cancelled in August, active again in September: one "Back" line.
    const gym = await f.record(annual);
    await at("2026-08-01T04:00:00Z")(gym.id, 1);
    const c = await f.record(
      { status: "cancelled" },
      { id: gym.id, baseRevision: 1 },
    );
    await at("2026-08-10T04:00:00Z")(gym.id, c.revision);
    const back = await f.record(
      { status: "active" },
      { id: gym.id, baseRevision: c.revision },
    );
    await at("2026-09-10T04:00:00Z")(gym.id, back.revision);
    // Cancelling then cancelled in September: one "Ended" line.
    const tv = await f.record({ ...netflix });
    await at("2026-08-01T04:00:00Z")(tv.id, 1);
    const ing = await f.record(
      { status: "cancelling" },
      { id: tv.id, baseRevision: 1 },
    );
    await at("2026-09-05T04:00:00Z")(tv.id, ing.revision);
    const ed = await f.record(
      { status: "cancelled" },
      { id: tv.id, baseRevision: ing.revision },
    );
    await at("2026-09-20T04:00:00Z")(tv.id, ed.revision);
    // Restating 10 as 10.00 is not a price change.
    const music = await f.record({
      label: "Music",
      status: "active",
      amount: "10",
      currency: "SGD",
      amountType: "fixed",
      cadence: "monthly",
    });
    await at("2026-08-01T04:00:00Z")(music.id, 1);
    const same = await f.record(
      { amount: "10.00" },
      { id: music.id, baseRevision: 1 },
    );
    await at("2026-09-12T04:00:00Z")(music.id, same.revision);
    // Excluded items of every kind are listed.
    await f.record({
      label: "Trial",
      status: "trial",
      amount: "5",
      currency: "SGD",
      amountType: "fixed",
      cadence: "monthly",
    });
    await f.record({
      label: "Cadence",
      status: "active",
      amount: "7",
      currency: "SGD",
      amountType: "fixed",
    });
    await f.record({
      label: "Status",
      amount: "3",
      currency: "SGD",
      amountType: "fixed",
      cadence: "monthly",
    });
    const s = await buildSubscriptionSummary(
      f.db,
      "a",
      Date.parse("2026-10-01T01:00:00Z"),
    );
    const body = (t: string) =>
      s.sections!.find((x) => x.title.startsWith(t))!.body;
    const changes = body("Changes");
    assert.equal(changes.match(/Ended · Netflix/g)?.length, 1);
    assert.match(changes, /Back · Gym: active again/);
    assert.doesNotMatch(changes, /Price · Music/);
    const left = body("Not in the totals");
    assert.match(left, /Trial: 5 SGD, trial/);
    assert.match(left, /Cadence: 7 SGD, cadence unknown/);
    assert.match(left, /Status: 3 SGD, status unknown/);
    assert.match(body("Monthly equivalents"), /3 items excluded/);
  } finally {
    await f.pg.close();
  }
});
test("a saved price change on an ended item is not reported", async () => {
  const f = await fixture();
  try {
    const early = new SubscriptionTools(f.db, () =>
      Date.parse("2026-09-01T00:00:00Z"),
    );
    const r = await early.call("a", f.run, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      fields: {
        ...netflix,
        pendingAmount: "24.98",
        pendingCurrency: "SGD",
        pendingEffectiveDate: "2026-09-20",
      },
    } as any);
    await early.call("a", f.run, {
      operation: "subscription_record",
      requestKey: randomUUID(),
      id: r.id,
      baseRevision: r.revision,
      fields: { status: "cancelled" },
    } as any);
    const s = await buildSubscriptionSummary(
      f.db,
      "a",
      Date.parse("2026-10-01T01:00:00Z"),
    );
    assert.doesNotMatch(JSON.stringify(s), /24\.98/);
  } finally {
    await f.pg.close();
  }
});
test("a create recorded as already cancelled is new, not ended, and a back-only month shows in the headline", async () => {
  const f = await fixture();
  try {
    const at = (iso: string) => async (id: string, revision: number) =>
      f.db.query(
        "UPDATE subscription_updates SET recorded_at=$3 WHERE subscription_id=$1 AND revision=$2",
        [id, revision, iso],
      );
    const old = await f.record({ ...annual, status: "cancelled" });
    await at("2026-09-08T04:00:00Z")(old.id, 1);
    const tv = await f.record({ ...netflix });
    await at("2026-09-09T04:00:00Z")(tv.id, 1);
    const ended = await f.record(
      { status: "cancelled" },
      { id: tv.id, baseRevision: 1 },
    );
    await at("2026-09-20T04:00:00Z")(tv.id, ended.revision);
    const s = await buildSubscriptionSummary(
      f.db,
      "a",
      Date.parse("2026-10-01T01:00:00Z"),
    );
    const changes = s.sections!.find((x) =>
      x.title.startsWith("Changes"),
    )!.body;
    assert.match(changes, /New · Gym/);
    assert.doesNotMatch(changes, /Ended · Gym/);
    assert.match(changes, /Ended · Netflix: cancelled/);
    // October: only a reactivation.
    const back = await f.record(
      { status: "active" },
      { id: tv.id, baseRevision: ended.revision },
    );
    await at("2026-10-10T04:00:00Z")(tv.id, back.revision);
    const oct = await buildSubscriptionSummary(
      f.db,
      "a",
      Date.parse("2026-11-01T01:00:00Z"),
    );
    assert.match(
      oct.reply,
      /October 2026: 0 new, 0 ended, 1 back, 0 price changes\./,
    );
  } finally {
    await f.pg.close();
  }
});
