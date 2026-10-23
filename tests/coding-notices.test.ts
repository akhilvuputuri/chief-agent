import { test } from "node:test";
import assert from "node:assert/strict";
import { candidate, fixture } from "./helpers/coding-fixture.js";
import { editCodingStatus } from "../src/coding/delivery.js";
import {
  StatusMessageGone,
  inQuietHours,
  parseQuietHours,
  renderStatus,
} from "../src/coding/notices.js";

const hour = 3600000;
/** Milliseconds from `from` to the next hh:00 in Asia/Singapore (UTC+8, no daylight saving). */
const untilSingapore = (from: Date, h: number) => {
  const local = (from.getTime() + 8 * hour) % (24 * hour);
  return (h * hour - local + 24 * hour) % (24 * hour) || 24 * hour;
};

type F = Awaited<ReturnType<typeof fixture>>;
function telegram() {
  let next = 500;
  const sends: { text: string; approval?: unknown }[] = [];
  const edits: { messageId: number; text: string }[] = [];
  let failEdit: Error | undefined;
  return {
    sends,
    edits,
    failNextEdit: (error: Error) => {
      failEdit = error;
    },
    send: async (
      _user: string,
      _target: unknown,
      text: string,
      approval?: unknown,
    ) => {
      sends.push({ text, approval });
      return { message_id: ++next };
    },
    edit: async (_user: string, messageId: number, text: string) => {
      if (failEdit) {
        const error = failEdit;
        failEdit = undefined;
        throw error;
      }
      edits.push({ messageId, text });
    },
  };
}
const deliveries = async (f: F, job: string) =>
  (
    await f.db.query(
      "SELECT event_key,delivery FROM coding_events WHERE job_id=$1 AND event_key NOT IN ('fixture-approved','status-message') ORDER BY created_at,id",
      [job],
    )
  ).rows as { event_key: string; delivery: string }[];
const clock = (f: F) => (f.c as unknown as { clock: () => Date }).clock();

test("progress is one status message edited in place; a separate notice starts a new one", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const tg = telegram();
  const options = { edit: tg.edit };
  await f.c.progress(j, {
    key: "build",
    stage: "implementing",
    summary: "Implementation started",
  });
  await f.c.progress(j, {
    key: "check",
    stage: "verifying",
    summary: "Check passed: npm run check",
  });
  await f.c.deliver(tg.send, options);
  // A burst of progress becomes one message.
  assert.equal(tg.sends.length, 1);
  assert.match(tg.sends[0]!.text, /Implementation started/);
  assert.match(tg.sends[0]!.text, /Check passed: npm run check/);
  assert.equal(tg.sends[0]!.approval, undefined);
  await f.c.progress(j, {
    key: "review",
    stage: "reviewing",
    summary: "Review started",
  });
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 1);
  assert.equal(tg.edits.length, 1);
  assert.equal(tg.edits[0]!.messageId, 501);
  for (const line of [
    /Implementation started/,
    /Check passed/,
    /Review started/,
  ])
    assert.match(tg.edits[0]!.text, line);
  // A worker's retried report adds nothing.
  await f.c.progress(j, {
    key: "review",
    stage: "reviewing",
    summary: "Review started",
  });
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length + tg.edits.length, 2);
  // A question is its own message, so the owner is notified.
  const running = await f.row(job.id);
  await f.c.finish(running, {
    kind: "awaiting_input",
    summary: "Needs a decision",
    question: "Which file should change?",
    checkpoint: running.checkpoint,
    checks: [],
  });
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 2);
  assert.match(tg.sends[1]!.text, /Which file should change\?/);
  // Progress after it goes into a new status message below the question.
  // (Explicit times: PGlite's clock can give two quick inserts the same timestamp.)
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,created_at) VALUES($1,'auto-retry:fixture',$2::jsonb,now()+interval '1 second')",
    [job.id, JSON.stringify({ summary: "Retrying once automatically" })],
  );
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 3);
  assert.equal(tg.edits.length, 1);
  assert.match(tg.sends[2]!.text, /Retrying once automatically/);
  assert.doesNotMatch(tg.sends[2]!.text, /Review started/);
  assert(
    (await deliveries(f, job.id)).every((e) => e.delivery === "sent"),
    JSON.stringify(await deliveries(f, job.id)),
  );
});

test("quiet hours hold progress that would start a message, but keep editing the current one", async (t) => {
  const quietHours = parseQuietHours("23:00-08:00")!;
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const tg = telegram();
  const options = { edit: tg.edit, quietHours };
  const progress = (key: string, summary: string) =>
    f.c.progress(j, { key, stage: "implementing", summary });
  f.advance(untilSingapore(clock(f), 12));
  assert.equal(inQuietHours(clock(f), quietHours), false);
  await progress("day", "Implementation started");
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 1);
  // At night the current status message is edited, which does not notify.
  f.advance(untilSingapore(clock(f), 2));
  assert.equal(inQuietHours(clock(f), quietHours), true);
  await progress("night-edit", "Check passed: npm run check");
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 1);
  assert.equal(tg.edits.length, 1);
  // A separate notice still goes out at night and ends that status message.
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,created_at) VALUES($1,'automation-notice:1:manual_review',$2::jsonb,now()-interval '1 second')",
    [job.id, JSON.stringify({ summary: "Inspect before merging." })],
  );
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 2);
  // New progress would need a new message, so it waits for the morning.
  await progress("night-held", "Review started");
  await f.c.deliver(tg.send, options);
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 2);
  assert.equal(tg.edits.length, 1);
  assert.equal(
    (await deliveries(f, job.id)).find((e) =>
      e.event_key.endsWith(":night-held"),
    )?.delivery,
    "pending",
  );
  f.advance(untilSingapore(clock(f), 9));
  assert.equal(inQuietHours(clock(f), quietHours), false);
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 3);
  assert.match(tg.sends[2]!.text, /Review started/);
  // Progress held overnight is superseded by a separate notice sent after it.
  f.advance(untilSingapore(clock(f), 1));
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,created_at) VALUES($1,'automation-notice:1:other',$2::jsonb,now()-interval '1 second')",
    [job.id, JSON.stringify({ summary: "Another stop." })],
  );
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 4);
  await progress("stale", "Stale progress");
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,created_at) VALUES($1,'automation-notice:1:later',$2::jsonb,now()+interval '1 second')",
    [job.id, JSON.stringify({ summary: "Merged; watching the release." })],
  );
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 5);
  assert.match(tg.sends[4]!.text, /Merged; watching the release/);
  f.advance(untilSingapore(clock(f), 9));
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 5);
  assert.equal(
    (await deliveries(f, job.id)).find((e) => e.event_key.endsWith(":stale"))
      ?.delivery,
    "suppressed",
  );
});

test("status edits keep the outbox rules: no replay after an uncertain edit or a restart", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const tg = telegram();
  const options = { edit: tg.edit };
  const progress = (key: string, summary: string) =>
    f.c.progress(j, { key, stage: "implementing", summary });
  await progress("one", "Implementation started");
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 1);
  // An edit with an unknown outcome is never replayed.
  tg.failNextEdit(new Error("network reset"));
  await progress("two", "Check passed: npm run check");
  await f.c.deliver(tg.send, options);
  assert.equal(
    (await deliveries(f, job.id)).find((e) => e.event_key.endsWith(":two"))
      ?.delivery,
    "uncertain",
  );
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length + tg.edits.length, 1);
  // ...but the next edit shows its line, because the intended text was saved first.
  await progress("three", "Review started");
  await f.c.deliver(tg.send, options);
  assert.equal(tg.edits.length, 1);
  assert.match(tg.edits[0]!.text, /Check passed: npm run check/);
  assert.match(tg.edits[0]!.text, /Review started/);
  // A restart in the middle of an edit leaves it uncertain, not resent.
  await progress("four", "Review approved");
  await f.db.query(
    "UPDATE coding_events SET delivery='sending' WHERE job_id=$1 AND delivery='pending'",
    [job.id],
  );
  await f.c.recoverDelivery();
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length + tg.edits.length, 2);
  assert.equal(
    (await deliveries(f, job.id)).find((e) => e.event_key.endsWith(":four"))
      ?.delivery,
    "uncertain",
  );
  // A deleted status message is replaced by a new one, which later edits target.
  tg.failNextEdit(new StatusMessageGone());
  await progress("five", "Publishing");
  await f.c.deliver(tg.send, options);
  assert.equal(tg.sends.length, 2);
  assert.match(tg.sends[1]!.text, /Publishing/);
  await progress("six", "Published");
  await f.c.deliver(tg.send, options);
  assert.equal(tg.edits.at(-1)!.messageId, 502);
});

test("Telegram edit answers map to unchanged, gone or unknown", async () => {
  const text = renderStatus(
    "job",
    [{ at: new Date().toISOString(), text: "Implementation started" }],
    1,
  );
  const refusal = (description: string) =>
    Object.assign(new Error(description), { description });
  await editCodingStatus(text, async () => {
    throw refusal("Bad Request: message is not modified");
  });
  await assert.rejects(
    editCodingStatus(text, async () => {
      throw refusal("Bad Request: message to edit not found");
    }),
    StatusMessageGone,
  );
  await assert.rejects(
    editCodingStatus(text, async () => {
      throw refusal("Too Many Requests: retry after 5");
    }),
    /Too Many Requests/,
  );
  assert.equal(parseQuietHours(""), undefined);
  assert.equal(parseQuietHours("08:00-08:00"), undefined);
  assert.throws(() => parseQuietHours("25:00-08:00"));
  const day = parseQuietHours("09:00-17:00")!;
  assert.equal(inQuietHours(new Date("2026-10-20T02:00:00Z"), day), true);
  assert.equal(inQuietHours(new Date("2026-10-20T10:00:00Z"), day), false);
});

test("several cancellations become one summary for the owner", async (t) => {
  const f = await fixture(t);
  const jobs = [];
  for (const key of ["one", "two", "three"]) jobs.push(await f.start(key));
  for (const job of jobs)
    await f.c.call("a", f.run, { operation: "coding_cancel", id: job.id });
  const tg = telegram();
  // Cancellations settle briefly so a bulk cancel can be summarised.
  await f.c.deliver(tg.send, { edit: tg.edit });
  assert.equal(tg.sends.length, 0);
  await f.db.query(
    "UPDATE coding_events SET created_at=created_at-interval '1 minute' WHERE event_key='cancelled'",
  );
  await f.c.deliver(tg.send, { edit: tg.edit });
  assert.equal(tg.sends.length, 1);
  assert.match(tg.sends[0]!.text, /3 coding jobs cancelled/);
  for (const job of jobs) assert.match(tg.sends[0]!.text, new RegExp(job.id));
  const states = (
    await f.db.query(
      "SELECT delivery FROM coding_events WHERE event_key='cancelled'",
    )
  ).rows.map((r) => r.delivery);
  assert.deepEqual(states, ["sent", "sent", "sent"]);
  await f.c.deliver(tg.send, { edit: tg.edit });
  assert.equal(tg.sends.length, 1);
});

test("an approved candidate folds into the status message and its PR is a separate message", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const tg = telegram();
  await f.c.finish(j, candidate());
  for (let i = 0; i < 4 && !(await f.row(job.id)).pr_url; i++) await f.c.tick();
  assert((await f.row(job.id)).pr_url);
  for (let i = 0; i < 4; i++) await f.c.deliver(tg.send, { edit: tg.edit });
  assert.equal(tg.sends.length, 2, JSON.stringify(tg.sends));
  assert.match(tg.sends[0]!.text, /Independent review approved; publishing/);
  assert.match(tg.sends[1]!.text, /pull\/1/);
  // The same PR rebuilt later (a rebase or feedback round) is progress, not a new announcement.
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,'later-attempt:pr',$2::jsonb)",
    [
      job.id,
      JSON.stringify({
        summary: "Draft PR prepared",
        url: "https://github.com/example/repo/pull/1",
      }),
    ],
  );
  await f.c.deliver(tg.send, { edit: tg.edit });
  assert.equal(tg.sends.length, 3);
  assert.match(
    tg.sends[2]!.text,
    /PR updated: https:\/\/github.com\/example\/repo\/pull\/1/,
  );
  assert.match(tg.sends[2]!.text, /: progress/);
});
