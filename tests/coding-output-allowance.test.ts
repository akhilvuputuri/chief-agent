import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reportLimits } from "@chief-agent/pi-runtime/report";
import {
  codingSettings,
  modelCallTimeoutMs,
  outputAllowance,
} from "../src/coding/schema.js";
import { fixture, settings } from "./helpers/coding-fixture.js";

// Job d5a8bd74 paused when its planning report reached 16,000 output tokens (journal 156).
const pi = { ...settings, runtime: "pi", squad: false, autoMerge: false };

test("coder and planner allowances reach 128,000; the reviewer keeps 16,000 unless set", () => {
  assert(codingSettings.safeParse({ ...pi, maxOutputTokens: 128000 }).success);
  for (const changes of [
    { maxOutputTokens: 128001 },
    { reviewerMaxOutputTokens: 128001 },
    { reviewerMaxOutputTokens: 0 },
  ])
    assert(!codingSettings.safeParse({ ...pi, ...changes }).success);
  assert(
    !codingSettings.safeParse({ ...settings, reviewerMaxOutputTokens: 16000 })
      .success,
  );
  const wide = { maxOutputTokens: 128000 };
  assert.equal(outputAllowance(wide, "leader"), 128000);
  assert.equal(outputAllowance(wide, "coder"), 128000);
  assert.equal(outputAllowance(wide, "reviewer"), 16000);
  assert.equal(
    outputAllowance({ ...wide, reviewerMaxOutputTokens: 64000 }, "reviewer"),
    64000,
  );
  // Earlier jobs keep their behaviour.
  assert.equal(outputAllowance({ maxOutputTokens: 16000 }, "reviewer"), 16000);
  assert.equal(outputAllowance({ maxOutputTokens: 8000 }, "reviewer"), 8000);
  assert.equal(outputAllowance({}, "coder"), 8000);
  // A call may take as long as its allowance needs at 100 tokens a second, never under 5 minutes.
  assert.equal(modelCallTimeoutMs(16000), 300000);
  assert.equal(modelCallTimeoutMs(128000), 1280000);
});

test("the shipped profile leaves room for the largest report plus heavy reasoning", () => {
  const shipped = codingSettings.parse(
    JSON.parse(
      readFileSync(
        new URL("../config/coding-pi.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  // A token is at least one character of report text; observed planning reasoning reached 11,169 tokens.
  const needed = reportLimits.document + 32000;
  for (const role of ["leader", "coder"] as const)
    assert(
      outputAllowance(shipped, role) >= needed,
      `${role} allowance ${outputAllowance(shipped, role)} is below ${needed}`,
    );
  // Owner-approved 11 November 2026 (journal 161): a 64,000-token reviewer.
  assert.equal(outputAllowance(shipped, "reviewer"), 64000);
});

test("each role's model call is sent its own allowance", async (t) => {
  const f = await fixture(t);
  const started: any = await f.start("output-allowance");
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify({ ...pi, maxOutputTokens: 128000, planCheck: true }),
  ]);
  await f.c.tick();
  const job = await f.row(started.id);
  const route = (model: string) =>
    (f.c as any).anthropic.route(model).nativeModel;
  for (const [role, model, requested] of [
    ["coder", settings.model, 200000],
    ["coder", settings.model, 6553],
    ["reviewer", settings.reviewerModel, 128000],
  ] as const) {
    const reply = await f.c.piMessages(
      job,
      role,
      {
        model: route(model),
        max_tokens: requested,
        stream: true,
        messages: [{ role: "user", content: "Synthetic" }],
      },
      { signal: new AbortController().signal },
    );
    assert.equal(reply.status, 200);
    await new Response(reply.body).text();
    for (let i = 0; i < 100 && (await f.row(job.id)).model_busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Pi's own value is kept when it is below the role's allowance (as near a full context).
  assert.deepEqual(
    f.messagesRequests().map((r) => r.body.max_tokens),
    [128000, 6553, 16000],
  );
});
