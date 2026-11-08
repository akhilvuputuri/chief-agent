import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { codingApi } from "../src/coding/api.js";
import { server } from "../src/server.js";
import { rejectionReason } from "../src/coding/rejection-reason.js";
import { storable } from "../src/storable.js";
import { checkpoint } from "../src/coding/schema.js";
import { reportDocument } from "@chief-agent/pi-runtime/report";
import { candidate, fixture, settings } from "./helpers/coding-fixture.js";

// Job 280f2d70 paused when a coder reply held a NUL: Postgres refused the readable copy (journal 155).
const nul = "regex /^[^\u0000-\u001f]+$/";
const lone = "half an emoji \ud83d.";

test("storable text drops NUL and replaces lone surrogates, keeping whole characters", () => {
  assert.equal(storable(nul), "regex /^[^-\u001f]+$/");
  assert.equal(storable(lone), "half an emoji �.");
  assert.equal(storable("whole 😀"), "whole 😀");
  assert.deepEqual(storable({ a: [nul, 1, null], b: { c: lone } }), {
    a: ["regex /^[^-\u001f]+$/", 1, null],
    b: { c: "half an emoji �." },
  });
});

test("a model reply or request with text Postgres cannot store is kept, and the worker gets it exactly", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("storable-model", "plan");
  await f.c.tick();
  const active = await f.row(job.id);
  await f.c.heartbeat(active);
  const token = (f.c as any).token(job.id, active.attempt_id);
  const app = await server({} as any);
  t.after(() => app.close());
  await codingApi(app, f.c);
  f.setReply(`${nul} ${lone}`);
  const call = (content: string) =>
    app.inject({
      method: "POST",
      url: `/coding/worker/${job.id}/model`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        callId: randomUUID(),
        role: "coder",
        messages: [{ role: "user", content }],
        tools: [],
      },
    });
  const first = await call("Synthetic task");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().message.content, `${nul} ${lone}`);
  // The reply goes back into the next request, as Pi does.
  const second = await call(`Earlier: ${nul} ${lone}`);
  assert.equal(second.statusCode, 200, second.body);
  const calls = (
    await f.db.query(
      "SELECT state,input,result FROM coding_model_calls WHERE job_id=$1 ORDER BY created_at",
      [job.id],
    )
  ).rows;
  assert.deepEqual(
    calls.map((c: any) => c.state),
    ["complete", "complete"],
  );
  assert.equal(
    calls[0].result.message.content,
    "regex /^[^-\u001f]+$/ half an emoji �.",
  );
  assert.equal(
    calls[1].input.messages[0].content,
    "Earlier: regex /^[^-\u001f]+$/ half an emoji �.",
  );
  assert.equal(((await f.c.status("a", job.id)) as any).lastFailure, undefined);
});

test("worker summaries and plans with such text are stored; code with it is refused, not changed", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("storable-finish", "plan");
  await f.c.tick();
  const running = await f.row(job.id);
  // Code must stay exact: content, a path or the patch with such text is refused.
  for (const code of [
    { files: [{ path: "src/a.ts", content: `const r = /${nul}/;` }] },
    { files: [{ path: "src/a\u0000.ts", content: "ok" }] },
    { patch: `+${nul}` },
  ])
    await assert.rejects(
      f.c.finish(running, {
        kind: "plan_ready",
        summary: "Brief prepared",
        checkpoint: {
          plan: "Scope: synthetic.",
          patch: "",
          summary: "Brief prepared",
          files: [],
          ...code,
        },
      }),
      (error: Error) => rejectionReason(error) === "exact_content_not_storable",
    );
  await f.c.finish(running, {
    kind: "plan_ready",
    summary: `Brief prepared; ${nul}`,
    checkpoint: {
      plan: `Scope: ${lone}`,
      patch: "",
      summary: "Brief prepared",
      files: [],
    },
  });
  const row = await f.row(job.id);
  assert.equal(row.summary, "Brief prepared; regex /^[^-\u001f]+$/");
  assert.equal(row.checkpoint.plan, "Scope: half an emoji �.");
});

test("a value Postgres refuses is named, not unclassified", () => {
  assert.equal(
    rejectionReason(
      Object.assign(new Error("unsupported Unicode escape sequence"), {
        code: "22P05",
      }),
    ),
    "database_value_rejected",
  );
  assert.equal(
    rejectionReason(Object.assign(new Error("other"), { code: "23505" })),
    "unclassified",
  );
});

test("worker progress with such text is stored", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("storable-progress", "plan");
  await f.c.tick();
  const running = await f.row(job.id);
  await f.c.progress(running, {
    key: "planning",
    stage: "planning",
    summary: `Reading ${nul}`,
  });
  const saved = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key=$2",
      [job.id, `${running.attempt_id}:planning`],
    )
  ).rows[0];
  assert.equal(saved.payload.summary.includes("\u0000"), false);
  assert.match(saved.payload.summary, /regex \/\^\[\^-/);
});

test("a report document is bound to its hash, so one with a NUL is refused, not changed", () => {
  assert.throws(
    () => reportDocument({ kind: "plan", summary: "Plan", detail: nul }),
    /no NUL characters/,
  );
  // As an older worker would send it: a correct hash over the text with the NUL.
  const body = { kind: "plan" as const, summary: "Plan", detail: nul };
  const document = {
    ...body,
    version: 1 as const,
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
  assert.equal(
    checkpoint.safeParse({
      plan: nul,
      patch: "",
      summary: "s",
      files: [],
      piState: {
        version: 1,
        toolsUsed: 0,
        reportDocument: document,
      },
    }).success,
    false,
  );
});

test("on the Pi route, a reply with such text reaches Pi exactly and replays exactly", async (t) => {
  const f = await fixture(t);
  const started: any = await f.start("storable-pi", "plan");
  await f.c.tick();
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }),
  ]);
  const job = await f.row(started.id);
  const app = await server({} as any);
  t.after(() => app.close());
  await codingApi(app, f.c);
  f.setGeneration(() => ({
    message: { role: "assistant", content: `${nul} ${lone}` },
  }));
  const request = {
    method: "POST" as const,
    url: `/coding/worker/${job.id}/pi/coder/v1/chat/completions`,
    headers: { authorization: `Bearer ${f.c.token(job.id, job.attempt_id)}` },
    payload: {
      runtime_call_id: randomUUID(),
      model: settings.model,
      messages: [{ role: "user", content: `Task ${nul}` }],
      tools: [],
    },
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().choices[0].message.content, `${nul} ${lone}`);
  // The same call replays the sealed, exact reply without a new model call.
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().choices[0].message.content, `${nul} ${lone}`);
  assert.equal(f.modelCalls(), 1);
  const stored = (
    await f.db.query(
      "SELECT input,result FROM coding_model_calls WHERE job_id=$1",
      [job.id],
    )
  ).rows[0];
  assert.equal(
    stored.result.message.content,
    "regex /^[^-\u001f]+$/ half an emoji \ufffd.",
  );
  assert.equal(stored.input.messages[0].content, "Task regex /^[^-\u001f]+$/");
  // Streamed framing carries the same exact text, JSON-escaped.
  const streamed = await app.inject({
    ...request,
    payload: {
      ...request.payload,
      runtime_call_id: randomUUID(),
      stream: true,
    },
  });
  assert.equal(streamed.statusCode, 200, streamed.body);
  assert(streamed.body.includes(JSON.stringify(`${nul} ${lone}`).slice(1, -1)));
});

test("review findings are compared with the exact reviewer reply, so such findings are refused", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("storable-review");
  await f.c.tick();
  const running = await f.row(job.id);
  const outcome = candidate();
  await assert.rejects(
    f.c.finish(running, {
      ...outcome,
      review: { ...outcome.review!, findings: `Reviewed ${nul}` },
    }),
    (error: Error) => rejectionReason(error) === "exact_content_not_storable",
  );
});
