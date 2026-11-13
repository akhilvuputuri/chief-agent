// The go gate (journal 191): coding_start waits for the owner's Start, and nothing runs before it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, settings, startCard } from "./helpers/coding-fixture.js";
import { runPiWorker } from "../src/coding/pi-worker.js";
import { requirementScope } from "../src/coding/requirements.js";
import { sendCodingDelivery } from "../src/coding/delivery.js";
import type { FormattedMessage } from "../src/telegram-format.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

const modelCallRows = async (f: Fixture) =>
  (await f.db.query("SELECT count(*)::int AS n FROM coding_model_calls"))
    .rows[0].n as number;
const cards = async (f: Fixture, job: string) =>
  (
    await f.db.query(
      "SELECT id,event_key,payload,delivery FROM coding_events WHERE job_id=$1 AND payload ? 'requirements' ORDER BY created_at,id",
      [job],
    )
  ).rows;
/** Delivers pending notices until one carries buttons; returns its approval id and message id. */
async function deliverCard(f: Fixture, from: number) {
  let messageId = from;
  let approvalId = "";
  let text = "";
  for (let i = 0; i < 5 && !approvalId; i++)
    await f.c.deliver(async (_user, _target, sent, id, plain) => {
      messageId++;
      if (id) {
        approvalId = id.id;
        text = plain ? `${sent}\n\n${plain}` : sent;
      }
      return { message_id: messageId };
    });
  return { approvalId, messageId, text };
}

test("coding_start creates a job waiting for Start, with one Start card and nothing running", async (t) => {
  const f = await fixture(t);
  const job: any = await f.c.call("a", f.run, {
    operation: "coding_start",
    requestKey: "gate",
    objective: "Fix a synthetic bug",
    context: "Synthetic evidence",
  });
  assert.equal(job.state, "plan_ready");
  assert.equal(job.stage, "awaiting_start");
  const row = await f.row(job.id);
  assert.equal(row.mode, "plan");
  assert.equal(row.attempt_id, null);
  assert.equal(row.checkpoint.plan, "");
  const [card, ...more] = await cards(f, job.id);
  assert.equal(more.length, 0);
  assert.equal(card.delivery, "pending");
  assert.equal(card.payload.requirements.revision, 1);
  assert.equal(card.payload.requirements.plan, "");
  assert.equal(card.payload.requirements.scope, requirementScope(row));
  for (let i = 0; i < 3; i++) await f.c.tick();
  assert.equal(f.creates(), 0);
  assert.equal(f.modelCalls(), 0);
  assert.equal(await modelCallRows(f), 0);
  assert.equal((await f.row(job.id)).state, "plan_ready");
  // An identical retry is the same job; the same key for another request is refused.
  const again: any = await f.c.call("a", f.run, {
    operation: "coding_start",
    requestKey: "gate",
    objective: "Fix a synthetic bug",
    context: "Synthetic evidence",
  });
  assert.equal(again.id, job.id);
  assert.equal((await cards(f, job.id)).length, 1);
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_start",
      requestKey: "gate",
      objective: "Something else",
      context: "",
    }),
    /different request/,
  );
  // The tool takes no mode any more.
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_start",
      requestKey: "with-mode",
      objective: "Fix a synthetic bug",
      context: "",
      mode: "implement",
    } as any),
  );
});

test("Start queues the build with the owner's request as its scope and an empty plan", async (t) => {
  const f = await fixture(t);
  const r = await startCard(f);
  const result = await f.c.requirements.confirm(
    "a",
    r.approvalId,
    "a",
    r.messageId,
  );
  assert.equal(result.status, "approved");
  const queued = await f.row(r.jobId);
  assert.equal(queued.state, "queued");
  assert.equal(queued.mode, "implement");
  assert.equal(await f.c.requirements.approved(queued), true);
  await f.c.tick();
  assert.equal(f.creates(), 1);
  const running = await f.row(r.jobId);
  const assignment = await f.c.assignment(running);
  assert.equal(assignment.mode, "implement");
  assert.equal(assignment.checkpoint.plan, "");
  assert.equal(assignment.objective, "Build the requested feature");
  assert.equal(assignment.context, "Synthetic scope");
});

test("a message before Start joins the request and replaces the card; the old card cannot start it", async (t) => {
  const f = await fixture(t);
  const r = await startCard(f);
  const reply = (requestKey: string, message: string) =>
    f.c.call("a", f.run, {
      operation: "coding_reply",
      id: r.jobId,
      baseRevision: 1,
      requestKey,
      message,
    }) as Promise<any>;
  const replied = await reply("more", "Also cover the empty list");
  assert.equal(replied.state, "plan_ready");
  assert.equal(replied.revision, 2);
  const row = await f.row(r.jobId);
  assert.equal(
    row.context,
    "Synthetic scope\nOwner follow-up: Also cover the empty list",
  );
  assert.equal(row.mode, "plan");
  // An identical retry changes nothing; the same key for another message is refused.
  assert.equal((await reply("more", "Also cover the empty list")).revision, 2);
  await assert.rejects(
    reply("more", "Something different"),
    /request key conflict/,
  );
  const all = await cards(f, r.jobId);
  assert.equal(all.length, 2);
  assert.equal(all[1].payload.requirements.revision, 2);
  assert.equal(all[1].payload.requirements.scope, requirementScope(row));
  // The card the owner saw before the message no longer starts anything.
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, "a", r.messageId),
    /changed/,
  );
  assert.equal((await f.row(r.jobId)).state, "plan_ready");
  await f.c.tick();
  assert.equal(f.creates(), 0);
  const fresh = await deliverCard(f, r.messageId);
  assert.equal(fresh.approvalId, all[1].id);
  assert.match(fresh.text, /^\*\*Ready to start\*\*/);
  const started = await f.c.requirements.confirm(
    "a",
    fresh.approvalId,
    "a",
    fresh.messageId,
  );
  assert.equal(started.status, "approved");
  const queued = await f.row(r.jobId);
  assert.equal(queued.mode, "implement");
  assert.equal(queued.context, row.context);
  await f.c.tick();
  assert.equal(f.creates(), 1);
});

test("an unsent card for an older request is never delivered", async (t) => {
  const f = await fixture(t);
  const job: any = await f.c.call("a", f.run, {
    operation: "coding_start",
    requestKey: "unsent",
    objective: "Fix a synthetic bug",
    context: "",
  });
  await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: job.id,
    baseRevision: 1,
    requestKey: "before-delivery",
    message: "Keep the old name",
  });
  const sent: string[] = [];
  for (let i = 0; i < 3; i++)
    await f.c.deliver(async (_user, _target, text, id) => {
      if (id) sent.push(id.id);
      return { message_id: 10 + i };
    });
  const [first, second] = await cards(f, job.id);
  assert.equal(first.delivery, "suppressed");
  assert.deepEqual(sent, [second.id]);
});

test("coding_resume on an expired Start card sends a new one, which starts the job", async (t) => {
  const f = await fixture(t);
  const r = await startCard(f);
  f.advance(86400001);
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, "a", r.messageId),
    /expired/,
  );
  const resent: any = await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: r.jobId,
    baseRevision: 1,
    requestKey: "fresh-card",
    confirmStale: true,
  });
  assert.equal(resent.approvalRequired, true);
  assert.equal(f.creates(), 0);
  const fresh = await deliverCard(f, r.messageId);
  assert.equal(fresh.approvalId, resent.approvalId);
  assert.equal(
    (
      await f.c.requirements.confirm(
        "a",
        fresh.approvalId,
        "a",
        fresh.messageId,
      )
    ).status,
    "approved",
  );
  assert.equal((await f.row(r.jobId)).state, "queued");
});

test("the host refuses a build the owner did not start: no box, no worker, no model call", async (t) => {
  const f = await fixture(t);
  const waiting: any = await f.start("not-started", true);
  // Even a job forced into the queue without the owner's Start gets no box.
  await f.db.query(
    "UPDATE coding_jobs SET state='queued',stage='queued' WHERE id=$1",
    [waiting.id],
  );
  await f.c.tick();
  assert.equal(f.creates(), 0);
  assert.equal((await f.row(waiting.id)).state, "paused");
  // A running attempt whose job lost its Start cannot authenticate or call a model.
  const started: any = await f.start("started");
  await f.c.tick();
  assert.equal(f.creates(), 1);
  const running = await f.row(started.id);
  const token = f.c.token(running.id, running.attempt_id);
  await f.c.authenticate(running.id, token);
  await f.db.query("UPDATE coding_jobs SET mode='plan' WHERE id=$1", [
    running.id,
  ]);
  await assert.rejects(
    f.c.authenticate(running.id, token),
    /not started this request/,
  );
  await f.db.query(
    "UPDATE coding_jobs SET mode='implement',context='Changed after Start' WHERE id=$1",
    [running.id],
  );
  await assert.rejects(
    f.c.authenticate(running.id, token),
    /not started this request/,
  );
  assert.equal(await modelCallRows(f), 0);
});

test("the Pi worker refuses a plan assignment", async (t) => {
  const requests: string[] = [];
  const assignment = {
    id: randomUUID(),
    attemptId: randomUUID(),
    revision: 1,
    objective: "Fix a synthetic bug",
    context: "",
    mode: "plan",
    baseSha: "a".repeat(40),
    settings: { ...settings, runtime: "pi", squad: false, autoMerge: false },
    checkpoint: { plan: "", patch: "", summary: "" },
    deadline: new Date(Date.now() + 600000).toISOString(),
    usedModels: 0,
  };
  await assert.rejects(
    runPiWorker(
      {
        origin: "https://coding.example.com",
        token: "c".repeat(64),
        request: async (path: string) => {
          requests.push(path);
          if (path === "assignment") return assignment;
          throw new Error(`Unexpected worker request: ${path}`);
        },
      },
      () => {},
      new AbortController().signal,
    ),
    /plan assignment is refused/,
  );
  // It stops before its first heartbeat, clone or model call.
  assert.deepEqual(requests, ["assignment"]);
  t.diagnostic("refused before any heartbeat");
});

test("on a legacy runtime, a reply to a stopped job after Start returns it to a new Start card (a Pi job uses its inbox, journal 192)", async (t) => {
  const f = await fixture(t);
  const started: any = await f.start("interim");
  await f.c.tick();
  const files = [{ path: "src/kept.ts", content: "export const kept = 1;\n" }];
  await f.db.query(
    "UPDATE coding_jobs SET state='awaiting_input',stage='awaiting_input',question='Which list?',cleanup='complete',checkpoint=checkpoint || $2::jsonb WHERE id=$1",
    [started.id, JSON.stringify({ files, patch: "kept diff" })],
  );
  const replied: any = await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: started.id,
    baseRevision: 1,
    requestKey: "answer",
    message: "The shopping list",
  });
  assert.equal(replied.state, "plan_ready");
  assert.equal(replied.stage, "awaiting_start");
  const row = await f.row(started.id);
  assert.equal(row.mode, "plan");
  assert.equal(row.question, "");
  assert.deepEqual(row.checkpoint.files, files);
  assert.equal(await f.c.requirements.approved(row), false);
  await f.c.tick();
  assert.equal(f.creates(), 1);
  const card = await deliverCard(f, 200);
  assert(card.approvalId);
  await f.c.requirements.confirm("a", card.approvalId, "a", card.messageId);
  const queued = await f.row(started.id);
  assert.equal(queued.mode, "implement");
  assert.deepEqual(queued.checkpoint.files, files);
});

test("a dormant job of the old shape does not break a tick, delivery or status", async (t) => {
  const f = await fixture(t);
  const started: any = await f.start("dormant");
  // The production job left from before the revamp: Pi, PR open, no owner-merge workflow,
  // a planner model, a plan check and a saved plan.
  await f.db.query(
    `UPDATE coding_jobs SET state='pr_ready',stage='pr_ready',pr_url='https://github.com/example/repo/pull/232',head_sha=$2,cleanup='complete',
      settings=$3::jsonb,checkpoint=$4::jsonb,updated_at=now()-interval '29 days' WHERE id=$1`,
    [
      started.id,
      "b".repeat(40),
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
        leaderModel: "anthropic/claude-opus-5.5",
        planCheck: true,
      }),
      JSON.stringify({
        plan: "An old approved plan",
        patch: "old diff",
        summary: "Old summary",
        files: [{ path: "src/old.ts", content: "old\n" }],
        piState: {
          version: 1,
          toolsUsed: 12,
          phase: "plan",
          planCheck: { status: "passed" },
        },
      }),
    ],
  );
  const before = await f.row(started.id);
  for (let i = 0; i < 3; i++) {
    await f.c.tick();
    await f.c.automationTick();
    await f.c.deliver(async () => ({ message_id: 1 }));
  }
  const status: any = await f.c.status("a", started.id);
  assert.equal(status.state, "pr_ready");
  assert.equal((await f.c.status("a")).length, 1);
  const after = await f.row(started.id);
  assert.deepEqual(after.checkpoint, before.checkpoint);
  assert.equal(after.state, "pr_ready");
  assert.equal(f.creates(), 0);
});

test("the Start card shows the goal as written: no link, no markup, and a cut cannot break it", async (t) => {
  const linked = "Fix [the docs](https://example.com/x) and `code` and *this*";
  // The 300-unit cut falls inside the bold markup.
  const cut = "a".repeat(295) + "**bold words**";
  for (const objective of [linked, cut]) {
    const f = await fixture(t);
    await f.c.call("a", f.run, {
      operation: "coding_start",
      requestKey: "markup",
      objective,
      context: "",
    });
    let sent: FormattedMessage | undefined;
    await f.c.deliver(async (_user, _target, text, approval, plain) =>
      sendCodingDelivery(
        text,
        approval,
        {
          text: async (part) => {
            sent = part;
            return { message_id: 7 };
          },
        },
        plain,
      ),
    );
    assert(sent);
    // Only the header is formatted; the goal and models are plain text.
    assert.deepEqual(sent.entities, [
      { type: "bold", offset: 0, length: "Ready to start".length },
    ]);
    if (objective === linked) assert(sent.text.includes(linked), sent.text);
    else {
      assert(sent.text.includes("a".repeat(295) + "**bol"), sent.text);
      assert(!sent.text.includes("words"));
    }
  }
});
