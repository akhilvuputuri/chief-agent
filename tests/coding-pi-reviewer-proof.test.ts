import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, settings } from "./helpers/coding-fixture.js";
import { seal } from "../src/secret-box.js";
import { artifactHash } from "../src/coding/github.js";

const detail = "The candidate implements the request exactly.";
const checkpoint = (content: string) => ({
  plan: "",
  patch: content,
  summary: "s",
  files: [{ path: "a.ts", content }],
  piState: {
    version: 1,
    delivered: [],
    reportDocument: { kind: "review", verdict: "APPROVE", detail },
  },
});

async function proofFixture(t: any) {
  const f = await fixture(t);
  const started = await f.start("pi-proof");
  const base = await f.row(started.id);
  const job = {
    ...base,
    attempt_id: randomUUID(),
    settings: {
      ...settings,
      limits: undefined,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    },
  };
  const controller = f.c as any;
  /** One sealed reviewer reply the host recorded, from a round that named `candidate`. */
  const record = async (
    args: unknown,
    candidate: string,
    attempt = job.attempt_id,
  ) => {
    // Calls are told apart by when they were recorded.
    await new Promise((resolve) => setTimeout(resolve, 3));
    const id = randomUUID();
    const response = {
      id: "msg_review",
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "c2ln" },
        { type: "tool_use", id: "toolu_r", name: "report", input: args },
      ],
      stop_reason: "tool_use",
    };
    await f.db.query(
      "INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,state,input,result_box) VALUES($1,$2,$3,'reviewer','fixture','complete',$4::jsonb,$5)",
      [
        id,
        job.id,
        attempt,
        JSON.stringify({ candidate }),
        seal(
          controller.resultKey(),
          JSON.stringify(response),
          controller.resultScope({ ...job, attempt_id: attempt }, id),
        ),
      ],
    );
  };
  const proof = (cp: any, findings = detail) =>
    controller.hasReviewerProof({
      ...job,
      result: { review: { verdict: "APPROVE", findings }, checkpoint: cp },
    });
  return { f, job, record, proof };
}

test("an approval is proof only for the exact candidate its round named, and a later verdict on it overrides", async (t) => {
  const { record, proof } = await proofFixture(t);
  const one = checkpoint("one\n");
  const two = checkpoint("two\n");
  const approve = {
    kind: "review",
    verdict: "APPROVE",
    summary: "Yes",
    detail,
  };
  assert.equal(await proof(one), false);
  await record(approve, artifactHash(one));
  assert.equal(await proof(one), true);
  // The coder changed the candidate: the earlier approval does not cover it.
  assert.equal(await proof(two), false);
  await record(
    { kind: "review", verdict: "APPROVE", summary: "Yes", detail: "Other" },
    artifactHash(two),
  );
  assert.equal(await proof(two), false);
  // An approval from an earlier attempt still counts for the same candidate.
  await record(approve, artifactHash(two), randomUUID());
  assert.equal(await proof(two), true);
  // A later REQUEST_CHANGES of the same candidate takes the approval back.
  await record(
    { kind: "review", verdict: "REQUEST_CHANGES", summary: "No", detail },
    artifactHash(one),
  );
  assert.equal(await proof(one), false);
  const forged = structuredClone(two);
  forged.piState.reportDocument.detail = "Forged";
  assert.equal(await proof(forged, "Forged"), false);
});

test("an approval older than the owner's latest message is not proof until a new round approves", async (t) => {
  const { f, job, record, proof } = await proofFixture(t);
  const one = checkpoint("one\n");
  const approve = {
    kind: "review",
    verdict: "APPROVE",
    summary: "Yes",
    detail,
  };
  await record(approve, artifactHash(one));
  assert.equal(await proof(one), true);
  // The owner sends a message after that approval.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'inbox:reply:later',$2::jsonb,'suppressed')",
    [
      job.id,
      JSON.stringify({ kind: "inbox", source: "owner", text: "Also do X" }),
    ],
  );
  assert.equal(await proof(one), false);
  // CI text does not count as the owner's word.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await record(approve, artifactHash(one));
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'inbox:gh:ci:1',$2::jsonb,'suppressed')",
    [job.id, JSON.stringify({ kind: "inbox", source: "ci", text: "failed" })],
  );
  assert.equal(await proof(one), true);
});
