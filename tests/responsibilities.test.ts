import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { MiniAuth } from "../src/miniapp-auth.js";
import { server } from "../src/server.js";
import { telegram, sendResponsibilityApprovals } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { Responsibilities, attention } from "../src/responsibilities.js";
import {
  ResponsibilityWorker,
  ResponsibilityDelivery,
} from "../src/responsibility-worker.js";
import { responsibilitySpec } from "../src/responsibility-schema.js";
import { ParcelTools } from "../src/parcels.js";
import { Assistant } from "../src/agent.js";
import { JobTools } from "../src/tools.js";
import { CustomAgent } from "../src/custom-agent.js";
import { WorkWorker } from "../src/work-worker.js";
import { runtimeContext } from "../src/runtime.js";
import { recoverRuntime } from "../src/execution.js";

async function fixture() {
  const pg = new PGlite();
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => /^\d.*sql$/.test(f))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + name, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','watch the parcel')",
    [run],
  );
  let now = new Date();
  const clock = () => now;
  const time = (d: Date) => {
    now = d;
  };
  const parcel = new ParcelTools(db);
  const p: any = await parcel.call(
    "a",
    {
      operation: "parcel_record",
      label: "Synthetic parcel",
      status: "shipped",
      sourceKind: "user",
    },
    run,
  );
  let hits: any[] = [];
  let sourceFail = false;
  let polls = 0;
  const gmail = {
    call: async (user: string, op: string, id: string) => {
      assert.equal(user, "a");
      if (op === "gmail_accounts")
        return {
          accounts: [{ account: "primary", email: "fixture@example.com" }],
        };
      return {
        id,
        threadId: "abc",
        account: "primary",
        headers: [
          { name: "date", value: now.toUTCString() },
          { name: "from", value: "sender@example.com" },
          { name: "subject", value: "Delivery update" },
        ],
        text: "The parcel is delivered.",
      };
    },
    poll: async () => {
      polls++;
      if (sourceFail) throw new Error("private provider failure");
      return { messages: hits };
    },
  };
  const service = new Responsibilities(db, { gmail } as any, clock),
    worker = new ResponsibilityWorker(
      service,
      (u) => u === "a",
      { gmail } as any,
      clock,
    );
  const spec = responsibilitySpec.parse({
    title: "Synthetic delivery",
    outcome: "Know when the parcel arrives",
    parcelIds: [p.id],
    gmail: { account: "primary", query: "from:sender@example.com" },
    notifyWhen: "Delivered, delayed or action required",
    end: "all_parcels_terminal",
    quietHours: { start: "00:00", end: "00:00" },
  });
  const create = async (overrides: any = {}) => {
    const proposal = await service.call("a", run, {
      operation: "responsibility_create",
      spec: { ...spec, ...overrides },
    });
    await service.confirm("a", proposal.approvalId, true);
    return proposal.id;
  };
  const due = async () =>
    db.query(
      "UPDATE responsibility_triggers SET next_check=now()-interval '1 minute'",
    );
  return {
    pg,
    db,
    run,
    p,
    parcel,
    service,
    worker,
    spec,
    create,
    due,
    clock,
    time,
    gmail,
    setHits: (v: any[]) => {
      hits = v;
    },
    failSource: () => {
      sourceFail = true;
    },
    polls: () => polls,
  };
}
test("confirmation binds owner, revision and exact policy; background writes cannot start monitoring", async () => {
  const f = await fixture();
  try {
    const proposal = await f.service.call("a", f.run, {
      operation: "responsibility_create",
      spec: f.spec,
    });
    assert.equal((await f.service.list("a")).length, 0);
    await assert.rejects(() =>
      f.service.confirm("b", proposal.approvalId, true),
    );
    await f.service.confirm("a", proposal.approvalId, true);
    await assert.rejects(() =>
      f.service.confirm("a", proposal.approvalId, true),
    );
    assert.equal((await f.service.list("b")).length, 0);
    await assert.rejects(() => f.service.history("b", proposal.id));
    await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
      f.run,
    ]);
    await assert.rejects(
      () =>
        f.service.call("a", f.run, {
          operation: "responsibility_update",
          id: proposal.id,
          baseRevision: 1,
          status: "cancelled",
        }),
      /foreground/,
    );
    await f.db.query("UPDATE work_turns SET background=false WHERE run_id=$1", [
      f.run,
    ]);
    const edit = await f.service.call("a", f.run, {
      operation: "responsibility_update",
      id: proposal.id,
      baseRevision: 1,
      spec: { ...f.spec, title: "Edited" },
    });
    assert.equal((await f.service.list("a"))[0].revision, 1);
    await f.service.confirm("a", edit.approvalId, true);
    assert.equal((await f.service.list("a"))[0].revision, 2);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM responsibility_revisions"))
        .rows[0].n,
      2,
    );
  } finally {
    await f.pg.close();
  }
});
test("cheap checks deduplicate emails and batch changes behind paused work; budgets survive launch", async () => {
  const f = await fixture();
  try {
    await f.create();
    f.setHits([{ id: "abc", threadId: "def" }]);
    await f.worker.tick();
    const task = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    assert.equal(task.budget_ms, 300000);
    assert.equal(task.budget_models, 10);
    assert.equal(task.budget_tools, 30);
    assert.equal(task.budget_initialized, true);
    await f.db.query(
      "UPDATE work_tasks SET status='paused',pause_reason='budget_exhausted'",
    );
    f.setHits([
      { id: "abc", threadId: "def" },
      { id: "abd", threadId: "def" },
    ]);
    await f.due();
    await f.worker.tick();
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_candidates",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM work_tasks")).rows[0].n,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM runtime_runs")).rows[0].n,
      0,
      "checks never invoke model/runtime",
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_candidates WHERE task_id IS NULL",
        )
      ).rows[0].n,
      1,
    );
    await f.worker.tick();
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM work_tasks")).rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});
test("U1 real runtime reads one admitted email, applies parcel provenance, resolves once and emits no progress", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.setHits([{ id: "abc", threadId: "def" }]);
    await f.worker.tick();
    f.time(new Date(f.clock().getTime() + 60000));
    await f.db.query(
      "INSERT INTO memories(user_id,key,value) VALUES('a','unrelated','private unrelated memory')",
    );
    const task = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    let index = 0;
    const actions = [
      { operation: "gmail_read", messageId: "abc", account: "primary" },
      {
        operation: "parcel_record",
        id: f.p.id,
        status: "delivered",
        sourceKind: "email",
        messageId: "abc",
        account: "primary",
        observedAt: new Date(f.clock().toUTCString()).toISOString(),
      },
      {
        operation: "responsibility_report",
        finding: {
          changed: "Parcel delivered",
          matters: "The delivery is complete",
          understanding: "Delivered",
          reply: "Your parcel arrived.",
          evidence: ["gmail:primary:abc", `parcel:${f.p.id}`],
          factKey: "delivered",
          proposedAttention: "now",
        },
      },
      {
        operation: "finish_turn",
        reply: "Saved the finding.",
        reason: "answer",
      },
    ];
    const assistant = new Assistant(
      f.db,
      new CustomAgent({
        generate: async (input) => {
          assert.doesNotMatch(
            JSON.stringify(input.messages),
            /private unrelated memory/,
          );
          assert.ok(
            !input.tools.some((t) =>
              [
                "agent_run",
                "conversation_read",
                "memory_set",
                "gmail_thread",
                "tools_load",
              ].includes(t.name),
            ),
          );
          const { operation, ...args } = actions[index++];
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: operation,
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
          };
        },
      }),
      new JobTools(
        f.db,
        {
          call: async () => {
            throw new Error("unwanted web");
          },
        },
        f.gmail as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.service,
      ),
      { responsibilities: true, gmail: true, parcels: true, delegation: false },
    );
    let sends = 0,
      progress = 0;
    const work = new WorkWorker(
      f.db,
      (u, t) =>
        assistant.resumeDetailed(u, t, async () => {
          progress++;
        }),
      async () => {
        throw new Error("generic send forbidden");
      },
      (u, t, p) => f.worker.capture(u, t, p),
    );
    await work.tick();
    assert.equal(index, 4);
    assert.equal(progress, 0);
    assert.equal(
      (await f.db.query("SELECT status FROM parcels WHERE id=$1", [f.p.id]))
        .rows[0].status,
      "delivered",
    );
    assert.equal((await f.service.list("a"))[0].status, "resolved");
    const delivery = new ResponsibilityDelivery(
      f.service,
      (u) => u === "a",
      async () => ({ message_id: ++sends }),
      f.clock,
    );
    await delivery.tick();
    await delivery.tick();
    await f.due();
    await f.worker.tick();
    assert.equal(sends, 1);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_findings WHERE closing",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM work_tasks")).rows[0].n,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks WHERE id=$1", [task.id]))
        .rows[0].status,
      "done",
    );
    assert.ok((await f.service.history("a", id)).findings.length);
  } finally {
    await f.pg.close();
  }
});
test("dispatcher scope refuses unrelated reads/writes and forged owner authority even when operation schemas are valid", async () => {
  const f = await fixture();
  try {
    await f.create();
    f.setHits([{ id: "abc", threadId: "def" }]);
    await f.worker.tick();
    const task = (await f.db.query("SELECT id FROM work_tasks")).rows[0].id;
    const run = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id,background) VALUES($1,'a','investigate',$2,true)",
      [run, task],
    );
    for (const input of [
      { operation: "gmail_read", messageId: "fff" },
      { operation: "gmail_read", messageId: "abc", account: "secondary" },
      { operation: "gmail_thread", threadId: "def" },
      { operation: "memory_set", key: "x", value: "x" },
      { operation: "calendar_draft" },
      {
        operation: "parcel_record",
        id: f.p.id,
        sourceKind: "user",
        status: "delivered",
      },
      { operation: "parcel_record", sourceKind: "email", messageId: "abc" },
      { operation: "parcel_list", id: randomUUID() },
      { operation: "responsibility_create", spec: f.spec },
    ])
      await assert.rejects(() => f.service.authorize("a", run, input));
    await f.service.authorize("a", run, {
      operation: "gmail_read",
      messageId: "abc",
    });
  } finally {
    await f.pg.close();
  }
});
test("restart pauses investigation and ambiguous delivery is never resent", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.setHits([{ id: "abc", threadId: "def" }]);
    await f.worker.tick();
    await recoverRuntime(f.db);
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks")).rows[0].status,
      "paused",
    );
    await f.due();
    await f.worker.tick();
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM work_tasks")).rows[0].n,
      1,
    );
    await f.db.query(
      "UPDATE responsibility_findings SET state='quiet' WHERE reason='investigation_paused'",
    );
    await f.db.query(
      `INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,payload,decision,reason,fact_key,state,due_at) VALUES($1,'a',$2,1,'{"reply":"An update"}','now','notify','x','sending',now())`,
      [randomUUID(), id],
    );
    let sends = 0;
    const delivery = new ResponsibilityDelivery(
      f.service,
      () => true,
      async () => ({ message_id: ++sends }),
      f.clock,
    );
    await delivery.recover();
    await delivery.tick();
    assert.equal(sends, 0);
    assert.equal(
      (
        await f.db.query(
          "SELECT state FROM responsibility_findings WHERE state='uncertain'",
        )
      ).rows[0].state,
      "uncertain",
    );
  } finally {
    await f.pg.close();
  }
});
test("source failures notify once per degraded episode without exposing provider text", async () => {
  const f = await fixture();
  try {
    await f.create();
    f.failSource();
    await f.worker.tick();
    await f.due();
    await f.worker.tick();
    const rows = (await f.db.query("SELECT * FROM responsibility_findings"))
      .rows;
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /private provider failure/);
    assert.equal((await f.service.list("a"))[0].degraded, true);
  } finally {
    await f.pg.close();
  }
});
test("quiet hours respect overnight boundaries, and deterministic meeting urgency can bypass them", () => {
  const spec = responsibilitySpec.parse({
    title: "x",
    outcome: "x",
    schedule: "daily at 8am",
    notifyWhen: "change",
    end: "until_cancelled",
  });
  const quiet = attention(spec, "now", new Date("2026-10-01T17:00:00Z"));
  assert.equal(quiet.reason, "quiet_hours");
  assert.equal(quiet.due?.toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(
    attention(spec, "now", new Date("2026-10-01T17:00:00Z"), true).reason,
    "time_critical",
  );
  assert.equal(attention(spec, "quiet", new Date()).due, null);
  const evening = {
    ...spec,
    deliveryTime: "19:00",
    urgentWhen: "Action needed today",
  };
  assert.equal(
    attention(evening, "now", new Date("2026-10-02T04:00:00Z")).reason,
    "delivery_slot",
  );
  assert.equal(
    attention(evening, "now", new Date("2026-10-02T04:00:00Z"), false, true)
      .reason,
    "notify",
  );
  assert.equal(
    attention(evening, "now", new Date("2026-10-01T17:00:00Z"), false, true)
      .reason,
    "quiet_hours",
  );
});
test("capability off offers no responsibility tools or domain catalogue", () => {
  const runtime = runtimeContext({ web: false }, null, undefined, new Set());
  assert.ok(!runtime.tools.some((t) => t.name.startsWith("responsibility_")));
  assert.doesNotMatch(runtime.context, /responsibilit/);
  assert.ok(
    runtimeContext({ responsibilities: true }, null).tools.some(
      (t) => t.name === "responsibility_create",
    ),
  );
  assert.ok(
    !runtimeContext({ responsibilities: true }, null).tools.some(
      (t) => t.name === "responsibility_report",
    ),
  );
});

async function complete(f: Awaited<ReturnType<typeof fixture>>, finding: any) {
  const task = (
    await f.db.query(
      "SELECT id FROM work_tasks WHERE status='queued' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0]?.id;
  assert.ok(task, "a queued investigation is expected");
  const run = randomUUID();
  await f.db.query(
    "INSERT INTO runtime_runs(id,user_id,task_id,state,stop_reason) VALUES($1,'a',$2,'stopped','answer')",
    [run, task],
  );
  await f.db.query(
    "INSERT INTO work_turns(run_id,user_id,request,task_id,background) VALUES($1,'a','investigate',$2,true)",
    [run, task],
  );
  const scope = await f.service.scope("a", task);
  for (const candidate of scope!.candidates.filter(
    (c) => c.payload.kind === "gmail",
  )) {
    const result = await f.gmail.call("a", "gmail_read", candidate.payload.id);
    await f.db.query(
      `INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,$3,'gmail_read','{}',false,'success',$4::jsonb)`,
      [randomUUID(), run, randomUUID(), JSON.stringify({ result })],
    );
  }
  await f.service.report("a", run, {
    changed: "An update",
    matters: "Relevant to the outcome",
    understanding: "Current state",
    reply: "Here is what changed.",
    factKey: "one fact",
    proposedAttention: "now",
    evidence: [],
    ...finding,
  });
  await f.worker.capture("a", task, {
    runId: run,
    reply: "report saved",
    reason: "answer",
  });
  return task;
}
test("U6 unchanged scheduled investigations stay quiet and retain their reason and baseline", async () => {
  const f = await fixture();
  try {
    const id = await f.create({
      parcelIds: [],
      gmail: undefined,
      schedule: "every 1h",
      end: "until_cancelled",
    });
    await f.due();
    await f.worker.tick();
    await complete(f, { changed: "", proposedAttention: "now" });
    let sends = 0;
    await new ResponsibilityDelivery(
      f.service,
      () => true,
      async () => ({ message_id: ++sends }),
      f.clock,
    ).tick();
    assert.equal(sends, 0);
    const history = await f.service.history("a", id);
    assert.equal(history.findings[0].decision, "quiet");
    assert.equal(history.findings[0].reason, "not_actionable");
    f.time(new Date(f.clock().getTime() + 3600000));
    await f.due();
    await f.worker.tick();
    const task = (
      await f.db.query("SELECT id FROM work_tasks WHERE status='queued'")
    ).rows[0];
    assert.ok(
      ((await f.service.scope("a", task.id)) as any).priorFindings.length,
    );
  } finally {
    await f.pg.close();
  }
});
test("U2 evening findings form a bounded digest without rerunning investigation", async () => {
  const f = await fixture();
  try {
    f.time(new Date("2026-10-02T04:00:00Z"));
    const id = await f.create({
      parcelIds: [],
      end: "until_cancelled",
      deliveryTime: "19:00",
    });
    f.setHits([{ id: "abc", threadId: "def" }]);
    await f.due();
    await f.worker.tick();
    await complete(f, { evidence: ["gmail:primary:abc"] });
    const saved = (await f.db.query("SELECT * FROM responsibility_findings"))
      .rows[0];
    assert.equal(saved.decision, "briefing");
    assert.equal(
      new Date(saved.due_at).toISOString(),
      "2026-10-02T11:00:00.000Z",
    );
    await f.db.query(
      `INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,payload,decision,reason,fact_key,due_at,state) VALUES($1,'a',$2,1,'{"reply":"Second finding"}','briefing','delivery_slot','second',$3,'pending')`,
      [randomUUID(), id, saved.due_at],
    );
    let sends = 0,
      members = 0;
    const d = new ResponsibilityDelivery(
      f.service,
      () => true,
      async (_u, finding) => {
        sends++;
        members = finding.members.length;
        return { message_id: 5 };
      },
      f.clock,
    );
    await d.tick();
    assert.equal(sends, 0);
    f.time(new Date("2026-10-02T11:00:00Z"));
    await d.tick();
    await d.tick();
    assert.equal(sends, 1);
    assert.equal(members, 2);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_findings WHERE state='sent' AND message_id=5",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_investigations",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});
test("U3 external meetings fire once per stable occurrence and moved meetings suppress stale preparation", async () => {
  const f = await fixture();
  try {
    const start = new Date(f.clock().getTime() + 3600000).toISOString();
    let current = start;
    const event = {
      id: "meeting",
      recurringEventId: "series",
      originalStartTime: { dateTime: start },
      start: { dateTime: start },
      end: { dateTime: new Date(Date.parse(start) + 3600000).toISOString() },
      title: "Synthetic meeting",
      status: "confirmed",
      attendees: [{ email: "guest@external.example", self: false }],
    };
    const calendar = {
      list: async () => ({
        truncated: false,
        events: [{ ...event, start: { dateTime: current } }],
      }),
    } as any;
    const service = new Responsibilities(f.db, { calendar }, f.clock),
      worker = new ResponsibilityWorker(
        service,
        () => true,
        { calendar },
        f.clock,
      );
    const proposal = await service.call("a", f.run, {
      operation: "responsibility_create",
      spec: {
        ...f.spec,
        parcelIds: [],
        gmail: undefined,
        calendar: { leadHours: 2, internalDomains: ["internal.example"] },
        end: "until_cancelled",
      },
    });
    await service.confirm("a", proposal.approvalId, true);
    await worker.tick();
    await f.due();
    await worker.tick();
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_candidates",
        )
      ).rows[0].n,
      1,
    );
    const key = (
      await f.db.query("SELECT source_key FROM responsibility_candidates")
    ).rows[0].source_key;
    const task = (await f.db.query("SELECT id FROM work_tasks")).rows[0].id,
      run = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id,state,stop_reason) VALUES($1,'a',$2,'stopped','answer')",
      [run, task],
    );
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id,background) VALUES($1,'a','prep',$2,true)",
      [run, task],
    );
    await service.report("a", run, {
      changed: "Upcoming external meeting",
      matters: "Prepare before it starts",
      understanding: "Meeting upcoming",
      reply: "Your preparation is ready.",
      factKey: "prep",
      evidence: [key],
      proposedAttention: "now",
    });
    await worker.capture("a", task, { runId: run, reply: "saved" });
    current = new Date(Date.parse(start) + 3600000).toISOString();
    let sends = 0;
    const d = new ResponsibilityDelivery(
      service,
      () => true,
      async () => ({ message_id: ++sends }),
      f.clock,
      calendar,
    );
    await d.tick();
    assert.equal(sends, 0);
    assert.equal(
      (await f.db.query("SELECT reason FROM responsibility_findings")).rows[0]
        .reason,
      "meeting_changed",
    );
  } finally {
    await f.pg.close();
  }
});
test("daily investigation exhaustion keeps pending events and a new day can launch the batch", async () => {
  const f = await fixture();
  try {
    await f.create({ parcelIds: [], end: "until_cancelled" });
    for (let i = 0; i < 7; i++) {
      const id = (100 + i).toString(16);
      f.setHits([{ id, threadId: "abc" }]);
      await f.due();
      await f.worker.tick();
      if (i < 6) await complete(f, { changed: "", factKey: `fact ${i}` });
    }
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_investigations",
        )
      ).rows[0].n,
      6,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_candidates WHERE task_id IS NULL",
        )
      ).rows[0].n,
      1,
    );
    await f.db.query(
      "UPDATE responsibility_investigations SET created_at=now()-interval '1 day'",
    );
    await f.worker.tick();
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_investigations",
        )
      ).rows[0].n,
      7,
    );
  } finally {
    await f.pg.close();
  }
});
test("global daily reservations serialize concurrent launch attempts", async () => {
  const f = await fixture();
  try {
    const seed = await f.create({ parcelIds: [], end: "until_cancelled" });
    await f.create({ parcelIds: [], end: "until_cancelled" });
    await f.create({ parcelIds: [], end: "until_cancelled" });
    const historical = (
      await f.db.query(
        `INSERT INTO work_tasks(id,user_id,objective,request,status) SELECT gen_random_uuid(),'a','previous','previous','done' FROM generate_series(1,24) RETURNING id`,
      )
    ).rows;
    for (const t of historical)
      await f.db.query(
        `INSERT INTO responsibility_investigations(task_id,user_id,responsibility_id,revision,state) VALUES($1,'a',$2,1,'complete')`,
        [t.id, seed],
      );
    f.setHits([{ id: "abc", threadId: "def" }]);
    await f.worker.tick();
    await Promise.all([f.worker.launch("a"), f.worker.launch("a")]);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_investigations",
        )
      ).rows[0].n,
      25,
    );
  } finally {
    await f.pg.close();
  }
});
test("interrupt caps defer extra findings and feedback is owner/message-bound and idempotent", async () => {
  const f = await fixture();
  try {
    const id = await f.create({ parcelIds: [], end: "until_cancelled" });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const key = randomUUID();
      ids.push(key);
      await f.db.query(
        `INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,payload,decision,reason,fact_key,due_at,state) VALUES($1,'a',$2,1,'{"reply":"An update"}','now','notify',$3,$4,'pending')`,
        [key, id, String(i), f.clock()],
      );
    }
    let sends = 0;
    const d = new ResponsibilityDelivery(
      f.service,
      () => true,
      async () => ({ message_id: ++sends }),
      f.clock,
    );
    await d.tick();
    assert.equal(sends, 3);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_findings WHERE reason='interrupt_cap' AND state='pending'",
        )
      ).rows[0].n,
      1,
    );
    const sent = (
      await f.db.query(
        "SELECT * FROM responsibility_findings WHERE state='sent' LIMIT 1",
      )
    ).rows[0];
    await d.feedback("b", sent.id, sent.message_id, "less");
    await d.feedback("a", sent.id, 999, "less");
    assert.equal((await f.service.list("a"))[0].attention_weight, 0);
    await Promise.all([
      d.feedback("a", sent.id, sent.message_id, "less"),
      d.feedback("a", sent.id, sent.message_id, "less"),
    ]);
    assert.equal((await f.service.list("a"))[0].attention_weight, -1);
    await Promise.all([
      d.feedback("a", sent.id, sent.message_id, "later"),
      d.feedback("a", sent.id, sent.message_id, "later"),
    ]);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_findings WHERE reason='owner_later'",
        )
      ).rows[0].n,
      1,
    );
    await d.feedback("a", sent.id, sent.message_id, "resolved");
    assert.equal((await f.service.list("a"))[0].status, "resolved");
  } finally {
    await f.pg.close();
  }
});
test("transactional parcel events retain provenance and suppressed investigations cannot become foreground work", async () => {
  const f = await fixture();
  try {
    const id = await f.create({ gmail: undefined, end: "until_cancelled" });
    await f.parcel.call(
      "a",
      {
        operation: "parcel_record",
        id: f.p.id,
        status: "delayed",
        sourceKind: "user",
      },
      f.run,
    );
    const events = (await f.db.query("SELECT * FROM responsibility_events"))
      .rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].run_id, f.run);
    await f.worker.tick();
    const task = (await f.db.query("SELECT id FROM work_tasks")).rows[0].id;
    const run = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id,background) VALUES($1,'a','investigate',$2,true)",
      [run, task],
    );
    await f.service.call("a", f.run, {
      operation: "responsibility_update",
      id,
      baseRevision: 1,
      status: "paused",
    });
    await assert.rejects(
      () =>
        f.service.authorize("a", run, { operation: "parcel_list", id: f.p.id }),
      /paused/,
    );
    await f.service.call("a", f.run, {
      operation: "responsibility_update",
      id,
      baseRevision: 1,
      status: "active",
    });
    assert.equal((await f.service.list("a"))[0].status, "active");
  } finally {
    await f.pg.close();
  }
});
test("Mini App responsibility reads require a signed owner session and expose no mutation routes", async () => {
  const f = await fixture();
  const token = "123456789:synthetic-test-token";
  const allowed = new Set(["123", "456"]);
  const auth = new MiniAuth(token, allowed);
  const session = (id: number) => {
    const p = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id }),
    });
    const body = [...p.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k + "=" + v)
      .join("\n");
    const key = createHmac("sha256", "WebAppData").update(token).digest();
    p.set("hash", createHmac("sha256", key).update(body).digest("hex"));
    return { authorization: "Bearer " + auth.authenticate(p.toString()).token };
  };
  await ensureUser(f.db, "123");
  await ensureUser(f.db, "456");
  const run = randomUUID();
  await f.db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'123','watch a topic')",
    [run],
  );
  const proposal = await f.service.call("123", run, {
    operation: "responsibility_create",
    spec: {
      ...f.spec,
      parcelIds: [],
      gmail: undefined,
      schedule: "every 1h",
      end: "until_cancelled",
    },
  });
  await f.service.confirm("123", proposal.approvalId, true);
  const app = server(f.db, {
    token,
    origin: "https://example.test",
    allowed,
    responsibilities: true,
  });
  try {
    assert.equal(
      (await app.inject({ url: "/api/miniapp/responsibilities" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/responsibilities",
          headers: session(123),
        })
      ).json().length,
      1,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/responsibilities/" + proposal.id,
          headers: session(456),
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/miniapp/responsibilities/" + proposal.id,
          headers: session(123),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/miniapp/responsibilities/" + proposal.id,
          headers: session(123),
          payload: { status: "resolved" },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    await f.pg.close();
  }
});
test("Telegram confirms only the exact owner-bound proposal card; generic approval text cannot activate it", async () => {
  const f = await fixture();
  await ensureUser(f.db, "123");
  const run = randomUUID();
  await f.db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'123','watch a topic')",
    [run],
  );
  const proposal = await f.service.call("123", run, {
    operation: "responsibility_create",
    spec: {
      ...f.spec,
      parcelIds: [],
      gmail: undefined,
      schedule: "every 1h",
      end: "until_cancelled",
    },
  });
  const config = readConfig({
    DATABASE_URL: "postgres://test:test@localhost/test",
    TELEGRAM_BOT_TOKEN: "123456789:synthetic-test-token",
    TELEGRAM_ALLOWED_USER_IDS: "123",
    RESPONSIBILITIES: "on",
  });
  const bot = telegram(
    config,
    { tools: { responsibilities: f.service } } as any,
    f.db,
  );
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as any;
  let message = 10;
  bot.api.config.use(
    async (_previous, method, payload) =>
      ({
        ok: true,
        result:
          method === "sendMessage"
            ? {
                message_id: message++,
                date: 0,
                chat: { id: 123, type: "private" },
                text: (payload as any).text,
              }
            : true,
      }) as any,
  );
  try {
    await sendResponsibilityApprovals(
      bot,
      f.db,
      "123",
      undefined,
      undefined,
      run,
    );
    const card = (
      await f.db.query("SELECT payload FROM approvals WHERE id=$1", [
        proposal.approvalId,
      ])
    ).rows[0].payload.telegramMessageId;
    await assert.rejects(() =>
      new JobTools(f.db, { call: async () => ({}) }).decide(
        "123",
        proposal.approvalId,
        true,
      ),
    );
    const tap = async (id: number, msg: number) =>
      bot.handleUpdate({
        update_id: id,
        callback_query: {
          id: String(id),
          from: { id: 123, is_bot: false, first_name: "Owner" },
          chat_instance: "private",
          data: "rsp:yes:" + proposal.approvalId,
          message: {
            message_id: msg,
            date: 0,
            chat: { id: 123, type: "private" },
            text: "proposal",
          },
        },
      });
    await tap(1, card + 1);
    assert.equal((await f.service.list("123")).length, 0);
    await tap(2, card);
    assert.equal((await f.service.list("123"))[0].status, "active");
  } finally {
    await f.pg.close();
  }
});
test("Gmail pagination advances its durable watermark only after the scan completes", async () => {
  const f = await fixture();
  try {
    const queries: string[] = [];
    const source = {
      ...f.gmail,
      poll: async (
        _user: string,
        _account: string,
        _email: string,
        q: string,
        token?: string,
      ) => {
        queries.push(q);
        return {
          messages: [{ id: token ? "abd" : "abc", threadId: "def" }],
          ...(token ? {} : { nextPageToken: "second" }),
        };
      },
    } as any;
    const service = new Responsibilities(f.db, { gmail: source }, f.clock),
      worker = new ResponsibilityWorker(
        service,
        () => true,
        { gmail: source },
        f.clock,
      );
    const proposal = await service.call("a", f.run, {
      operation: "responsibility_create",
      spec: { ...f.spec, parcelIds: [], end: "until_cancelled" },
    });
    await service.confirm("a", proposal.approvalId, true);
    const before = (
      await f.db.query(
        "SELECT cursor FROM responsibility_triggers WHERE kind='gmail'",
      )
    ).rows[0].cursor;
    await worker.tick();
    const partial = (
      await f.db.query(
        "SELECT cursor FROM responsibility_triggers WHERE kind='gmail'",
      )
    ).rows[0].cursor;
    assert.equal(partial.watermark, before.watermark);
    assert.equal(partial.pageToken, "second");
    f.time(new Date(f.clock().getTime() + 60000));
    await f.due();
    await worker.tick();
    const completed = (
      await f.db.query(
        "SELECT cursor FROM responsibility_triggers WHERE kind='gmail'",
      )
    ).rows[0].cursor;
    assert.equal(completed.watermark, partial.scanEnd);
    assert.ok(!completed.pageToken);
    assert.equal(queries[0], queries[1]);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_candidates",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await f.pg.close();
  }
});
test("scheduled research cannot exfiltrate private source text through a widened query or URL", async () => {
  const f = await fixture();
  try {
    await f.create({
      parcelIds: [],
      gmail: undefined,
      schedule: "every 1h",
      publicQuery: "robotics research",
      end: "until_cancelled",
    });
    await f.due();
    await f.worker.tick();
    const task = (await f.db.query("SELECT id FROM work_tasks")).rows[0].id,
      run = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,'a',$2)",
      [run, task],
    );
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id,background) VALUES($1,'a','research',$2,true)",
      [run, task],
    );
    await assert.rejects(
      () =>
        f.service.authorize("a", run, {
          operation: "web_search",
          query: "robotics private email body",
        }),
      /exact confirmed/,
    );
    await assert.rejects(
      () =>
        f.service.authorize("a", run, {
          operation: "web_read",
          url: "https://example.net/?private=email",
        }),
      /exact URLs/,
    );
    await f.service.authorize("a", run, {
      operation: "web_search",
      query: "robotics research",
    });
    await f.db.query(
      `INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,$3,'web_search','{}',false,'success',$4::jsonb)`,
      [
        randomUUID(),
        run,
        randomUUID(),
        JSON.stringify({
          result: {
            content: JSON.stringify([{ url: "https://example.net/article" }]),
          },
        }),
      ],
    );
    await f.service.authorize("a", run, {
      operation: "web_read",
      url: "https://example.net/article",
    });
    await assert.rejects(() =>
      f.service.authorize("a", run, {
        operation: "web_read",
        url: "https://example.net/article?email=private",
      }),
    );
  } finally {
    await f.pg.close();
  }
});
test("disabling responsibilities blocks generic background execution and grants for existing responsibility tasks", async () => {
  const f = await fixture();
  try {
    await f.create();
    f.setHits([{ id: "abc", threadId: "def" }]);
    await f.worker.tick();
    const task = (await f.db.query("SELECT id FROM work_tasks")).rows[0].id;
    const worker = new WorkWorker(
      f.db,
      async () => assert.fail("disabled task ran"),
      async () => assert.fail("disabled notification"),
      undefined,
      true,
    );
    await worker.tick();
    assert.equal(
      (await f.db.query("SELECT passes FROM work_tasks")).rows[0].passes,
      0,
    );
    await f.db.query("UPDATE work_tasks SET status='paused'");
    const assistant = new Assistant(
      f.db,
      { run: async () => assert.fail("model called") } as any,
      new JobTools(f.db, { call: async () => ({}) }),
      {},
    );
    await assert.rejects(() => assistant.grant("a", task), /disabled/);
    await assert.rejects(() => assistant.resumeDetailed("a", task), /disabled/);
  } finally {
    await f.pg.close();
  }
});
test("pausing a concern aborts its in-flight model and never resumes its investigation implicitly", async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.setHits([{ id: "abc", threadId: "def" }]);
    await f.worker.tick();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const assistant = new Assistant(
      f.db,
      new CustomAgent({
        generate: async (input) => {
          calls++;
          started();
          return new Promise((_resolve, reject) =>
            input.signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          );
        },
      }),
      new JobTools(
        f.db,
        { call: async () => ({}) },
        f.gmail as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.service,
      ),
      { responsibilities: true, gmail: true, parcels: true, delegation: false },
    );
    f.service.onInactive = (user, concern) =>
      assistant.interruptResponsibility(user, concern);
    const worker = new WorkWorker(
      f.db,
      (user, task) => assistant.resumeDetailed(user, task),
      async () => assert.fail("generic delivery"),
      (u, t, p) => f.worker.capture(u, t, p),
    );
    const running = worker.tick();
    await ready;
    await f.service.call("a", f.run, {
      operation: "responsibility_update",
      id,
      baseRevision: 1,
      status: "paused",
    });
    await running;
    assert.equal(calls, 1);
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks")).rows[0].status,
      "paused",
    );
    await f.service.call("a", f.run, {
      operation: "responsibility_update",
      id,
      baseRevision: 1,
      status: "active",
    });
    await f.worker.tick();
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_investigations",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks")).rows[0].status,
      "paused",
    );
  } finally {
    await f.pg.close();
  }
});
test("each meeting occurrence has independent preparation when another occurrence is cancelled", async () => {
  const f = await fixture();
  try {
    const start = new Date(f.clock().getTime() + 3600000).toISOString();
    let cancelled = "";
    const events = ["one", "two"].map((id) => ({
      id,
      title: id,
      start: { dateTime: start },
      end: { dateTime: new Date(Date.parse(start) + 3600000).toISOString() },
      status: "confirmed",
      attendees: [{ email: "guest@external.example" }],
    }));
    const calendar = {
      list: async () => ({
        truncated: false,
        events: events.map((e) => ({
          ...e,
          status: e.id === cancelled ? "cancelled" : "confirmed",
        })),
      }),
    } as any;
    const service = new Responsibilities(f.db, { calendar }, f.clock),
      worker = new ResponsibilityWorker(
        service,
        () => true,
        { calendar },
        f.clock,
      );
    const proposal = await service.call("a", f.run, {
      operation: "responsibility_create",
      spec: {
        ...f.spec,
        parcelIds: [],
        gmail: undefined,
        calendar: { leadHours: 2, internalDomains: ["internal.example"] },
        end: "until_cancelled",
      },
    });
    await service.confirm("a", proposal.approvalId, true);
    await worker.tick();
    const first = (
        await f.db.query("SELECT id FROM work_tasks WHERE status='queued'")
      ).rows[0].id,
      scope = await service.scope("a", first);
    assert.equal(scope!.candidates.length, 1);
    cancelled = scope!.candidates[0].payload.event.id;
    await complete(f, { evidence: [scope!.candidates[0].source_key] });
    let sends = 0;
    const delivery = new ResponsibilityDelivery(
      service,
      () => true,
      async () => ({ message_id: ++sends }),
      f.clock,
      calendar,
    );
    await delivery.tick();
    assert.equal(sends, 0);
    await worker.tick();
    const second = (
        await f.db.query("SELECT id FROM work_tasks WHERE status='queued'")
      ).rows[0].id,
      next = await service.scope("a", second);
    assert.equal(next!.candidates.length, 1);
    assert.notEqual(next!.candidates[0].payload.event.id, cancelled);
    await complete(f, { evidence: [next!.candidates[0].source_key] });
    await delivery.tick();
    assert.equal(sends, 1);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM responsibility_investigations",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await f.pg.close();
  }
});
test("ongoing Calendar events cannot receive preparation after their start", async () => {
  const f = await fixture();
  try {
    const start = new Date(f.clock().getTime() + 3600000).toISOString();
    const event = {
      id: "one",
      title: "Meeting",
      start: { dateTime: start },
      end: { dateTime: new Date(Date.parse(start) + 3600000).toISOString() },
      status: "confirmed",
      attendees: [{ email: "guest@external.example" }],
    };
    const calendar = {
        list: async () => ({ truncated: false, events: [event] }),
      } as any,
      service = new Responsibilities(f.db, { calendar }, f.clock),
      worker = new ResponsibilityWorker(
        service,
        () => true,
        { calendar },
        f.clock,
      );
    const proposal = await service.call("a", f.run, {
      operation: "responsibility_create",
      spec: {
        ...f.spec,
        parcelIds: [],
        gmail: undefined,
        calendar: { leadHours: 2, internalDomains: [] },
        end: "until_cancelled",
      },
    });
    await service.confirm("a", proposal.approvalId, true);
    await worker.tick();
    const key = (
      await f.db.query("SELECT source_key FROM responsibility_candidates")
    ).rows[0].source_key;
    await complete(f, { evidence: [key] });
    f.time(new Date(Date.parse(start) + 600000));
    let sends = 0;
    await new ResponsibilityDelivery(
      service,
      () => true,
      async () => ({ message_id: ++sends }),
      f.clock,
      calendar,
    ).tick();
    assert.equal(sends, 0);
    assert.equal(
      (await f.db.query("SELECT reason FROM responsibility_findings")).rows[0]
        .reason,
      "meeting_elapsed",
    );
  } finally {
    await f.pg.close();
  }
});
test("a confirmation racing lifecycle mutation rejects stale pause without suppressing new-revision findings", async () => {
  const f = await fixture();
  try {
    const id = await f.create({
      parcelIds: [],
      gmail: undefined,
      schedule: "every 1h",
      end: "until_cancelled",
    });
    const proposal = await f.service.call("a", f.run, {
      operation: "responsibility_update",
      id,
      baseRevision: 1,
      spec: {
        ...f.spec,
        parcelIds: [],
        gmail: undefined,
        schedule: "every 1h",
        end: "until_cancelled",
        title: "New revision",
      },
    });
    let intercepted = false;
    const proxy = {
      query: async (sql: string, args?: unknown[]) => {
        const result = await f.db.query(sql, args);
        if (
          !intercepted &&
          sql.startsWith("SELECT * FROM responsibilities WHERE id=")
        ) {
          intercepted = true;
          await f.service.confirm("a", proposal.approvalId, true);
          await f.db.query(
            `INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,payload,decision,reason,fact_key,due_at,state) VALUES($1,'a',$2,2,'{"reply":"New revision update"}','now','notify','new',now(),'pending')`,
            [randomUUID(), id],
          );
        }
        return result;
      },
      transaction: f.pg.transaction.bind(f.pg),
    } as any;
    const service = new Responsibilities(proxy, {}, f.clock);
    let interrupted = false;
    service.onInactive = async () => {
      interrupted = true;
    };
    await assert.rejects(
      () =>
        service.call("a", f.run, {
          operation: "responsibility_update",
          id,
          baseRevision: 1,
          status: "paused",
        }),
      /changed concurrently/,
    );
    const row = (await f.service.list("a"))[0];
    assert.equal(row.revision, 2);
    assert.equal(row.status, "active");
    assert.equal(interrupted, false);
    assert.equal(
      (await f.db.query("SELECT state FROM responsibility_findings")).rows[0]
        .state,
      "pending",
    );
  } finally {
    await f.pg.close();
  }
});
