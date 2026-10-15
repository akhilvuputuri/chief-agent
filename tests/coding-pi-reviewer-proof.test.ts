import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, settings } from "./helpers/coding-fixture.js";
import { seal } from "../src/secret-box.js";

test("Pi merge proof requires a sealed reviewer APPROVE matching the acknowledged review document", async (t) => {
  const f = await fixture(t);
  const started = await f.start("pi-proof", "implement");
  const attempt = randomUUID();
  const detail = "The candidate implements the approved plan exactly.";
  const base = await f.row(started.id);
  const job = {
    ...base,
    attempt_id: attempt,
    settings: { ...settings, runtime: "pi", squad: false, autoMerge: false },
    result: {
      review: { verdict: "APPROVE", findings: detail },
      checkpoint: {
        piState: {
          reportDocument: { kind: "review", verdict: "APPROVE", detail },
        },
      },
    },
  };
  const controller = f.c as any;
  const record = async (args: unknown) => {
    const id = randomUUID();
    const response = {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "r",
            type: "function",
            function: { name: "report", arguments: JSON.stringify(args) },
          },
        ],
      },
    };
    await f.db.query(
      "INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,state,input,result_box) VALUES($1,$2,$3,'reviewer','fixture','complete','{}'::jsonb,$4)",
      [
        id,
        job.id,
        attempt,
        seal(
          controller.resultKey(),
          JSON.stringify(response),
          controller.resultScope(job, id),
        ),
      ],
    );
  };
  assert.equal(await controller.hasReviewerProof(job), false);
  await record({
    kind: "review",
    verdict: "REQUEST_CHANGES",
    summary: "No",
    detail,
  });
  assert.equal(await controller.hasReviewerProof(job), false);
  await record({
    kind: "review",
    verdict: "APPROVE",
    summary: "Yes",
    detail: "A different review",
  });
  assert.equal(await controller.hasReviewerProof(job), false);
  await record({ kind: "review", verdict: "APPROVE", summary: "Yes", detail });
  assert.equal(await controller.hasReviewerProof(job), true);
  const forged = structuredClone(job);
  forged.result.checkpoint.piState.reportDocument.detail = "Forged";
  assert.equal(await controller.hasReviewerProof(forged), false);
});
