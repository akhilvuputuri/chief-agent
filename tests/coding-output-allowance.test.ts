import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  // Owner-approved 11 November 2026 (journal 161): a 64,000-token reviewer, so a call may run
  // for up to about 10.7 minutes on the host.
  assert.equal(outputAllowance(shipped, "reviewer"), 64000);
  assert.equal(
    modelCallTimeoutMs(outputAllowance(shipped, "reviewer")),
    640000,
  );
});

test("each role's model call is sent its own allowance", async (t) => {
  const f = await fixture(t);
  const started: any = await f.start("output-allowance", "plan");
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify({ ...pi, maxOutputTokens: 128000, planCheck: true }),
  ]);
  await f.c.tick();
  const job = await f.row(started.id);
  const sent: number[] = [];
  f.setGeneration((_model, input) => {
    sent.push(input.maxOutputTokens);
    return { message: { role: "assistant", content: "Complete" } };
  });
  for (const [role, requested] of [
    ["leader", undefined],
    ["leader", 200000],
    ["leader", 6553],
    ["reviewer", 128000],
  ] as const)
    await f.c.generate(job, {
      callId: randomUUID(),
      role,
      messages: [{ role: "user", content: "Synthetic" }],
      tools: [],
      ...(requested ? { maxOutputTokens: requested } : {}),
    });
  assert.deepEqual(sent, [128000, 128000, 6553, 16000]);
});

// Journal 171: Pi calls ask for summarized thinking, and the summary lands in the call record.
test("Pi coding calls ask for summarized thinking and keep the summary in the call record", async (t) => {
  const f = await fixture(t);
  const started: any = await f.start("thinking-summaries", "plan");
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify({ ...pi, planCheck: true }),
  ]);
  await f.c.tick();
  const job = await f.row(started.id);
  const sent: unknown[] = [];
  const summary = "**Planning**\n\nRead the schema before editing.";
  f.setGeneration((_model, input) => {
    sent.push(input.thinkingDisplay);
    return {
      message: {
        role: "assistant",
        content: "Complete",
        reasoning_details: [
          {
            type: "anthropic.thinking",
            format: "anthropic-direct-v1",
            block: { type: "thinking", thinking: summary, signature: "sig" },
            position: 0,
          },
        ],
      },
    };
  });
  const ids: string[] = [];
  for (const role of ["leader", "reviewer"] as const) {
    const callId = randomUUID();
    ids.push(callId);
    await f.c.generate(job, {
      callId,
      role,
      messages: [{ role: "user", content: "Synthetic" }],
      tools: [],
    });
  }
  assert.deepEqual(sent, ["summarized", "summarized"]);
  // The field path a profiling script reads from the readable call record.
  const rows = (
    await f.db.query(
      `SELECT d->'block'->>'thinking' AS summary FROM coding_model_calls c,
         jsonb_array_elements(c.result->'message'->'reasoning_details') d
       WHERE c.id = ANY($1::uuid[]) AND d->>'type'='anthropic.thinking'
         AND d->'block'->>'type'='thinking'`,
      [ids],
    )
  ).rows;
  assert.deepEqual(
    rows.map((r: any) => r.summary),
    [summary, summary],
  );
});

test("non-Pi coding calls keep the default thinking display", async (t) => {
  const f = await fixture(t);
  const started: any = await f.start("thinking-default");
  await f.c.tick();
  const job = await f.row(started.id);
  assert.notEqual(job.settings.runtime, "pi");
  const sent: unknown[] = [];
  f.setGeneration((_model, input) => {
    sent.push("thinkingDisplay" in input ? input.thinkingDisplay : "absent");
    return { message: { role: "assistant", content: "Complete" } };
  });
  await f.c.generate(job, {
    callId: randomUUID(),
    role: "coder",
    messages: [{ role: "user", content: "Synthetic" }],
    tools: [],
  });
  assert.deepEqual(sent, ["absent"]);
});
