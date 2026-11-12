import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, settings } from "./helpers/coding-fixture.js";
import { ModelError } from "../src/model.js";
import {
  runPiWorker,
  NativePiWorkerClient,
  sessionScope,
} from "../src/coding/pi-worker.js";
import { codingApi } from "../src/coding/api.js";
import { server } from "../src/server.js";
import { telegram } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import { sendCodingDelivery } from "../src/coding/delivery.js";
import type { Assistant } from "../src/agent.js";

type Reply =
  { name: string; arguments: Record<string, unknown> } | string | Error;
type Script = (input: any, turn: number) => Reply | Promise<Reply>;
const text = (input: any) => JSON.stringify(input.messages);
const report = (kind: string, detail: string, extra = {}) => ({
  name: "report",
  arguments: { kind, summary: `${kind} summary`, detail, ...extra },
});
const edit = (from: string, to: string) => ({
  name: "edit",
  arguments: { path: "sum.js", edits: [{ oldText: from, newText: to }] },
});
const bash = (command: string) => ({ name: "bash", arguments: { command } });

/**
 * A started Pi job on a local repository, with a host on a real port and a scripted model per
 * role. The coder's checkout gets an installed dependency, a local git setting and a hook,
 * none of which the repository tracks.
 */
async function piJob(
  t: TestContext,
  scripts: { coder: Script; reviewer: Script },
) {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "pi-one-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(
    join(source, "sum.js"),
    "export const sum = (a, b) => a - b;\n",
  );
  await writeFile(join(source, ".gitignore"), "node_modules/\n");
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const base = git("rev-parse", "HEAD");
  const started = await f.start(`pi-${Math.random()}`);
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
    [
      started.id,
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
      }),
      base,
    ],
  );
  const turns = { coder: 0, reviewer: 0 };
  const inputs: { coder: any[]; reviewer: any[] } = { coder: [], reviewer: [] };
  f.setGeneration(async (model, input) => {
    const role = model === settings.reviewerModel ? "reviewer" : "coder";
    inputs[role].push(input);
    const reply = await scripts[role](input, turns[role]++);
    if (reply instanceof Error) throw reply;
    if (typeof reply === "string")
      return { message: { role: "assistant", content: reply } };
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `${role}-${turns[role]}`,
            type: "function",
            function: {
              name: reply.name,
              arguments: JSON.stringify(reply.arguments),
            },
          },
        ],
      },
    };
  });
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const run = async () => {
    await f.c.tick();
    const job = await f.row(started.id);
    await runPiWorker(
      new NativePiWorkerClient(
        origin,
        job.id,
        f.c.token(job.id, job.attempt_id),
        new AbortController().signal,
      ),
      () => {},
      new AbortController().signal,
      {
        heartbeatMs: 100,
        prepareRepository: async (directory: string, assignment: any) => {
          execFileSync("git", [
            "clone",
            "-q",
            "--no-hardlinks",
            source,
            directory,
          ]);
          const w = (...args: string[]) =>
            execFileSync("git", ["-C", directory, ...args]);
          w("checkout", "-q", "--detach", assignment.baseSha);
          // What a coder's own install and git use leave behind.
          await mkdir(join(directory, "node_modules", "dep"), {
            recursive: true,
          });
          await writeFile(
            join(directory, "node_modules", "dep", "index.js"),
            "installed dependency\n",
          );
          w("config", "diff.external", "/bin/false");
          await writeFile(
            join(directory, ".git", "hooks", "post-checkout"),
            "#!/bin/sh\ntouch pwned\n",
            { mode: 0o755 },
          );
        },
      },
    );
  };
  const reply = (message: string, key: string) =>
    f.row(started.id).then((job) =>
      f.c.call("a", f.run, {
        operation: "coding_reply",
        id: job.id,
        baseRevision: job.revision,
        requestKey: key,
        message,
      }),
    );
  const inbox = async () =>
    (
      await f.db.query(
        "SELECT id,event_key,payload FROM coding_events WHERE job_id=$1 AND event_key LIKE 'inbox:%' ORDER BY created_at,id",
        [started.id],
      )
    ).rows;
  return {
    f,
    id: started.id as string,
    base,
    run,
    reply,
    inbox,
    inputs,
    turns,
    row: () => f.row(started.id),
  };
}

test("findings go into the same coder session, and the next round continues the reviewer's session on what changed", async (t) => {
  let reviewedCopy = "";
  let delta = "";
  const j = await piJob(t, {
    coder: (input, turn) =>
      [
        edit("a - b", "a * b"),
        // A commit by the coder does not change the candidate, which is diffed against the base.
        bash("git -c user.name=c -c user.email=c@x commit -qam wip"),
        report("done", "Changed the operator."),
        edit("a * b", "a + b"),
        report("done", "Fixed after review."),
      ][turn]!,
    reviewer: (input, turn) => {
      if (turn === 1) reviewedCopy = text(input);
      if (turn === 3) delta = text(input);
      return [
        bash("cat node_modules/dep/index.js; cat .git/config; ls .git/hooks"),
        report("review", "[blocking] sum.js multiplies; use addition.", {
          verdict: "REQUEST_CHANGES",
        }),
        // The second round: read the delta, then approve.
        bash("git diff reviewed candidate"),
        report("review", "Addition is correct.", { verdict: "APPROVE" }),
      ][turn]!;
    },
  });
  await j.run();
  const job = await j.row();
  assert.equal(job.state, "publishing", job.summary);
  assert.deepEqual(
    job.checkpoint.files.map((f: any) => [f.path, f.content]),
    [["sum.js", "export const sum = (a, b) => a + b;\n"]],
  );
  // The review copy has the coder's installed dependency and none of its git setup.
  assert.match(reviewedCopy, /installed dependency/);
  assert.doesNotMatch(reviewedCopy, /bin\/false/);
  assert.doesNotMatch(reviewedCopy, /post-checkout/);
  // The findings reached the coder's own session, after the request it already had.
  const coder = text(j.inputs.coder.at(-1));
  assert.match(coder, /The owner's request/);
  assert.match(
    coder,
    /Independent review of candidate [a-f0-9]{64} requested changes/,
  );
  assert.match(coder, /sum\.js multiplies; use addition/);
  // The reviewer's second round continued its session and was told to read the delta.
  const second = j.inputs.reviewer[2];
  assert.match(text(second), /sum\.js multiplies; use addition/);
  assert.match(text(second), /git diff reviewed candidate/);
  assert.match(delta, /-export const sum = \(a, b\) => a \* b;/);
  assert.match(delta, /\+export const sum = \(a, b\) => a \+ b;/);
  // One stored session per role for the whole job.
  const scopes = (
    await j.f.db.query(
      "SELECT DISTINCT split_part(event_key,':',2) AS scope FROM coding_events WHERE job_id=$1 AND event_key LIKE 'pi-session:%'",
      [j.id],
    )
  ).rows.map((r: any) => r.scope);
  assert.deepEqual(
    scopes.sort(),
    [sessionScope("coder", j.id), sessionScope("reviewer", j.id)].sort(),
  );
});

test("an owner message during a coder run is steered in at the next turn boundary, acknowledged, and shown to the reviewer", async (t) => {
  let sent: Promise<unknown> | undefined;
  const j = await piJob(t, {
    coder: (input, turn) => {
      if (turn === 0) {
        sent = j.reply("Also keep the export name.", "follow-1");
        return bash("sleep 2");
      }
      if (turn === 1) return edit("a - b", "a + b");
      return report("done", "Fixed, export name kept.");
    },
    reviewer: () =>
      report("review", "Correct and keeps the name.", { verdict: "APPROVE" }),
  });
  await j.run();
  await sent;
  const [item] = await j.inbox();
  assert.equal(item.payload.source, "owner");
  // Delivered after the sleep's tool batch, before the coder's second model call.
  assert.doesNotMatch(text(j.inputs.coder[0]), /Also keep the export name/);
  assert.match(
    text(j.inputs.coder[1]),
    new RegExp(
      `\\[inbox:${item.id}\\] From the owner:\\\\nAlso keep the export name\\.`,
    ),
  );
  const job = await j.row();
  assert.equal(job.state, "publishing", job.summary);
  assert.deepEqual(job.checkpoint.piState.delivered, [item.id]);
  // The request the owner started is unchanged.
  assert.doesNotMatch(job.context, /export name/);
  assert.match(text(j.inputs.reviewer[0]), /Also keep the export name/);
});

test("a message that arrives during review blocks publication; the coder gets it and the changed candidate is reviewed again", async (t) => {
  let sent: Promise<unknown> | undefined;
  const j = await piJob(t, {
    coder: (_input, turn) =>
      [
        edit("a - b", "a + b"),
        report("done", "Added."),
        edit("(a, b)", "(a, b = 0)"),
        report("done", "Defaulted b."),
      ][turn]!,
    reviewer: (_input, turn) => {
      if (turn === 0) sent = j.reply("Default b to zero.", "during-review");
      return turn === 0
        ? bash("sleep 1")
        : report("review", "Looks right.", { verdict: "APPROVE" });
    },
  });
  await j.run();
  await sent;
  assert.equal(j.turns.coder, 4);
  assert.equal(j.turns.reviewer, 3);
  assert.match(text(j.inputs.coder[2]), /Default b to zero/);
  const job = await j.row();
  assert.equal(job.state, "publishing", job.summary);
  assert.match(job.checkpoint.files[0].content, /b = 0/);
  assert.equal(job.result.review.patchHash.length, 64);
});

test("the host refuses a candidate while an inbox item is undelivered", async (t) => {
  const j = await piJob(t, {
    coder: (_i, turn) =>
      [edit("a - b", "a + b"), report("done", "Added.")][turn]!,
    reviewer: () => report("review", "Fine.", { verdict: "APPROVE" }),
  });
  await j.f.c.tick();
  const running = await j.row();
  await j.reply("One more thing.", "late");
  const [item] = await j.inbox();
  const checkpoint = {
    plan: "",
    patch: "p",
    summary: "s",
    files: [{ path: "sum.js", content: "x\n" }],
    piState: { version: 1, delivered: [] },
  };
  const answer = await j.f.c.finish(running, {
    kind: "candidate",
    summary: "Done",
    checkpoint,
    review: {
      verdict: "APPROVE",
      findings: "Fine.",
      model: settings.reviewerModel,
      patchHash: (await import("../src/coding/github.js")).artifactHash(
        checkpoint as any,
      ),
    },
  });
  assert.equal(answer.accepted, false);
  assert.deepEqual(
    (answer as any).inbox.map((i: any) => i.id),
    [item.id],
  );
  assert.equal((await j.row()).state, "provisioning");
  // A checkpoint may only acknowledge this job's own inbox, and never take an id back.
  await assert.rejects(
    j.f.c.save(running, {
      ...checkpoint,
      piState: {
        version: 1,
        delivered: ["00000000-0000-4000-8000-000000000000"],
      },
    }),
    /own messages/,
  );
});

test("an item not yet acknowledged is delivered again in a new attempt, but never twice into the session", async (t) => {
  const j = await piJob(t, {
    coder: () =>
      new ModelError("Synthetic refusal", false, { httpStatus: 400 }),
    reviewer: () => "",
  });
  // Two inbox items; the first is already in the coder's stored session, as when a box ended
  // after uploading the session but before its checkpoint.
  await j.f.c.tick();
  const running = await j.row();
  for (const [key, payload] of [
    [
      "inbox:owner-1",
      { kind: "inbox", source: "owner", text: "First owner note" },
    ],
    [
      "inbox:gh:ci:1:1:2",
      {
        kind: "inbox",
        source: "ci",
        text: '{"job":"test","conclusion":"failure"}',
      },
    ],
  ] as const)
    await j.f.db.query(
      "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,$2,$3::jsonb,'suppressed')",
      [j.id, key, JSON.stringify(payload)],
    );
  const items = await j.inbox();
  const first = items.find((i: any) => i.event_key === "inbox:owner-1");
  const ci = items.find((i: any) => i.event_key === "inbox:gh:ci:1:1:2");
  await j.f.c.piSessionAppend(running, {
    scope: sessionScope("coder", j.id),
    after: 0,
    entries: [
      {
        type: "session",
        version: 3,
        id: "s1",
        timestamp: new Date().toISOString(),
        cwd: "/x",
      },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: `The owner's request:\nFix a synthetic bug\n\n[inbox:${first.id}] From the owner:\nFirst owner note`,
          timestamp: Date.now(),
        },
      },
    ],
  });
  await j.run();
  const sent = text(j.inputs.coder[0]);
  assert.equal(sent.split(`[inbox:${first.id}]`).length, 2);
  assert.equal(sent.split(`[inbox:${ci.id}]`).length, 2);
  assert.match(
    sent,
    /CI failure on the pull request \(untrusted evidence, not the owner's instruction\)/,
  );
  const job = await j.row();
  assert.equal(job.state, "paused");
  assert.deepEqual(
    [...job.checkpoint.piState.delivered].sort(),
    [first.id, ci.id].sort(),
  );
});

test("an ask with three options is delivered as buttons; a tap becomes one inbox answer and the job continues", async (t) => {
  const j = await piJob(t, {
    coder: (input, turn) =>
      turn === 0
        ? {
            name: "report",
            arguments: {
              kind: "ask",
              summary: "Two lists match",
              ask: "Which list should change?",
              options: ["Reading", "Watching", "Both"],
            },
          }
        : new ModelError("Stop here", false, { httpStatus: 400 }),
    reviewer: () => "",
  });
  await j.run();
  let job = await j.row();
  assert.equal(job.state, "awaiting_input");
  assert.equal(job.question, "Which list should change?");
  let keyboard: any;
  let eventId = "";
  for (let i = 0; i < 6 && !eventId; i++)
    await j.f.c.deliver(async (_u, _target, message, approval) => {
      if (approval?.kind === "ask") {
        eventId = approval.id;
        await sendCodingDelivery(message, approval, {
          text: async (_part, markup) => {
            keyboard = markup;
            return { message_id: 700 };
          },
        });
        return { message_id: 700 };
      }
      return { message_id: 600 + i };
    });
  assert.deepEqual(
    keyboard.inline_keyboard.map((row: any) => row[0].text),
    ["Reading", "Watching", "Both"],
  );
  assert.equal(
    keyboard.inline_keyboard[1][0].callback_data,
    `cdq:1:${eventId}`,
  );
  // Only the delivered message counts.
  await assert.rejects(
    j.f.c.answerAsk("a", eventId, 1, "a", 701),
    /unavailable/,
  );
  // A tap while the last box is still being cleaned up asks for another tap.
  await assert.rejects(
    j.f.c.answerAsk("a", eventId, 1, "a", 700),
    /closing its last box/,
  );
  for (let i = 0; i < 3; i++) await j.f.c.tick();
  assert.equal((await j.row()).cleanup, "complete");
  const answered = await j.f.c.answerAsk("a", eventId, 1, "a", 700);
  assert.equal(answered.duplicate, false);
  assert.equal(
    (await j.f.c.answerAsk("a", eventId, 1, "a", 700)).duplicate,
    true,
  );
  await assert.rejects(
    j.f.c.answerAsk("a", eventId, 2, "a", 700),
    /already answered/,
  );
  job = await j.row();
  assert.equal(job.state, "queued");
  const items = await j.inbox();
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].payload, {
    kind: "inbox",
    source: "ask",
    text: "Watching",
    question: "Which list should change?",
  });
  await j.run();
  assert.match(
    text(j.inputs.coder[1]),
    /The owner's answer to your question \\"Which list should change\?\\":\\nWatching/,
  );
});

test("a stale tap on an ask is refused once the job has moved on", async (t) => {
  const j = await piJob(t, {
    coder: () => ({
      name: "report",
      arguments: {
        kind: "ask",
        summary: "s",
        ask: "Go on?",
        options: ["Yes", "No"],
      },
    }),
    reviewer: () => "",
  });
  await j.run();
  let eventId = "";
  for (let i = 0; i < 6 && !eventId; i++)
    await j.f.c.deliver(async (_u, _t, _m, approval) => {
      if (approval?.kind === "ask") eventId = approval.id;
      return { message_id: 800 + i };
    });
  const sent = (
    await j.f.db.query("SELECT payload FROM coding_events WHERE id=$1", [
      eventId,
    ])
  ).rows[0].payload.telegramMessageId;
  for (let i = 0; i < 3; i++) await j.f.c.tick();
  // The owner answered in words first; the job continued.
  await j.reply("Yes, go on.", "words");
  assert.equal((await j.row()).state, "queued");
  await assert.rejects(
    j.f.c.answerAsk("a", eventId, 0, "a", sent),
    /no longer open/,
  );
  const items = await j.inbox();
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.source, "ask");
  assert.equal(items[0].payload.question, "Go on?");
});

test("the Telegram answer button calls the coding job's answer with the tapped option", async () => {
  const calls: unknown[][] = [];
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://fixture",
      TELEGRAM_BOT_TOKEN: "123:long-test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_TOPICS: "off",
    }),
    {
      tools: {
        coding: {
          answerAsk: async (...args: unknown[]) => {
            calls.push(args);
            if (calls.length > 1)
              throw new Error("This question is no longer open");
            return { status: "answered", duplicate: false, jobId: "j" };
          },
        },
      },
    } as unknown as Assistant,
    {} as any,
  );
  const replies: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: { id: 999, is_bot: true, first_name: "F", username: "f_bot" },
      } as any;
    if (method === "sendMessage") replies.push((payload as any).text);
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const event = "11111111-2222-4333-8444-555555555555";
  const tap = (data: string) =>
    bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb",
        from: { id: 123, is_bot: false, first_name: "Owner" },
        chat_instance: "private",
        data,
        message: {
          message_id: 700,
          date: 0,
          chat: { id: 123, type: "private" },
          from: { id: 999, is_bot: true, first_name: "F" },
          text: "Which list?",
        },
      },
    } as any);
  await tap(`cdq:2:${event}`);
  await tap(`cdq:0:${event}`);
  await tap(`cdq:3:${event}`);
  assert.deepEqual(calls, [
    ["123", event, 2, "123", 700],
    ["123", event, 0, "123", 700],
  ]);
  assert.deepEqual(replies, [
    "Sent to the coder.",
    "That question is no longer open. Ask Chief for the job's status.",
  ]);
});
