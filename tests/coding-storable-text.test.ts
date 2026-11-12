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
import {
  messagesResponse,
  messagesStream,
} from "../coding_runtime_pi/tests/anthropic-sse.js";

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
  const job: any = await f.start("storable-model");
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

test("worker summaries and questions with such text are stored; code with it is refused, not changed", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("storable-finish");
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
        kind: "awaiting_input",
        summary: "Question prepared",
        question: "Which helper?",
        checkpoint: {
          plan: "",
          patch: "",
          summary: "Question prepared",
          files: [],
          ...code,
        },
      }),
      (error: Error) => rejectionReason(error) === "exact_content_not_storable",
    );
  await f.c.finish(running, {
    kind: "awaiting_input",
    summary: `Question prepared; ${nul}`,
    question: `Keep ${lone}`,
    checkpoint: {
      plan: "",
      patch: "",
      summary: `Checkpoint: ${lone}`,
      files: [],
    },
  });
  const row = await f.row(job.id);
  assert.equal(row.summary, "Question prepared; regex /^[^-\u001f]+$/");
  assert.equal(row.question, "Keep half an emoji �.");
  assert.equal(row.checkpoint.summary, "Checkpoint: half an emoji �.");
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
  const job: any = await f.start("storable-progress");
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
    () => reportDocument({ kind: "done", summary: "Done", detail: nul }),
    /no NUL characters/,
  );
  // As an older worker would send it: a correct hash over the text with the NUL.
  const body = { kind: "done" as const, summary: "Done", detail: nul };
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
        reportDocument: document,
      },
    }).success,
    false,
  );
});

test("on the Pi route, a reply with such text reaches Pi exactly and is stored readably", async (t) => {
  const f = await fixture(t);
  const started: any = await f.start("storable-pi");
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
  const turn = {
    content: [{ type: "text" as const, text: `${nul} ${lone}` }],
  };
  f.setMessages(async () => messagesResponse(turn));
  const response = await app.inject({
    method: "POST",
    url: `/coding/worker/${job.id}/pi/coder/v1/messages`,
    headers: { "x-api-key": f.c.token(job.id, job.attempt_id) },
    payload: {
      model: "claude-opus-5-5",
      max_tokens: 1000,
      stream: true,
      messages: [{ role: "user", content: `Task ${nul}` }],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  // Pi receives Anthropic's bytes exactly, the text JSON-escaped as the API sent it.
  assert.equal(response.body, messagesStream(turn));
  for (let i = 0; i < 100 && (await f.row(job.id)).model_busy; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = (
    await f.db.query(
      "SELECT state,input,result FROM coding_model_calls WHERE job_id=$1",
      [job.id],
    )
  ).rows[0];
  assert.equal(stored.state, "complete");
  assert.equal(
    stored.result.content[0].text,
    "regex /^[^-\u001f]+$/ half an emoji \ufffd.",
  );
  assert.equal(
    stored.input.request.messages[0].content,
    "Task regex /^[^-\u001f]+$/",
  );
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
