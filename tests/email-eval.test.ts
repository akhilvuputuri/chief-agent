import test from "node:test";
import assert from "node:assert/strict";
import {
  gmailToolDefinitions,
  parseFlags,
  parseTasks,
  resolveArm,
  runTask,
  scoreTask,
  summarise,
  type EvalTask,
} from "../src/email-eval.js";
import { GmailTools } from "../src/gmail.js";
import type { Generation, ModelAdapter, ToolDefinition } from "../src/model.js";
import { plugins } from "../src/plugin-registry.js";

const config = {
  owner: "123",
  email: "owner@example.com",
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh",
};
const BODY = "Your monthly receipt. ".repeat(30);
const encode = (text: string) => Buffer.from(text).toString("base64url");
const headers = (subject: string) => [
  { name: "From", value: "Store <billing@example.com>" },
  { name: "Subject", value: subject },
  { name: "Date", value: "Sun, 1 Nov 2026 09:00:00 +0800" },
];
/** A message with a plain-text body, or HTML only (which today's read tools cannot show). */
function message(id: string, html = false) {
  return {
    id,
    threadId: `b${id}`,
    snippet: "Your monthly receipt",
    internalDate: "1",
    labelIds: [],
    payload: {
      headers: headers(`Receipt ${id}`),
      mimeType: html ? "text/html" : "text/plain",
      body: { data: encode(html ? `<p>${BODY}</p>` : BODY) },
    },
  };
}
/** Real GmailTools over a fake Gmail: budget, fitting and warnings are the real ones. */
function fakeGmail(mail: Record<string, { html?: boolean }>, hits: string[]) {
  const request = (async (u: unknown) => {
    const url = new URL(String(u));
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "a", expires_in: 3600 });
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: config.email });
    if (url.pathname.endsWith("/messages"))
      return Response.json({
        messages: hits.map((id) => ({ id, threadId: `b${id}` })),
        resultSizeEstimate: hits.length,
      });
    const thread = /\/threads\/b([a-f0-9]+)$/.exec(url.pathname)?.[1];
    if (thread)
      return Response.json({
        id: `b${thread}`,
        messages: [message(thread, mail[thread]?.html)],
      });
    const id = /\/messages\/([a-f0-9]+)$/.exec(url.pathname)![1]!;
    return Response.json(message(id, mail[id]?.html));
  }) as typeof fetch;
  return new GmailTools(config, request);
}
type Call = { name: string; args: object };
/** Replays one step of tool calls per model call and records what each call was offered. */
function scripted(steps: Call[][]) {
  const offered: string[][] = [];
  const seen: string[] = [];
  let n = 0;
  const model: ModelAdapter = {
    model: "test/model",
    async generate(input): Promise<Generation> {
      offered.push(input.tools.map((t: ToolDefinition) => t.name));
      seen.push(JSON.stringify(input.messages));
      const step = steps[Math.min(n++, steps.length - 1)]!;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: step.map((c, i) => ({
            id: `call_${n}_${i}`,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 40 },
          cost: 0.001,
        },
      };
    },
  };
  return { model, offered, seen };
}
const task: EvalTask = {
  id: "receipts-1",
  kind: "collect",
  request: "Find every monthly receipt from the store",
  accounts: ["primary"],
  expected: ["a1", "a2", "a3", "a4"].map((messageId) => ({
    account: "primary" as const,
    messageId,
  })),
  answerContains: ["monthly", "refund"],
};
const options = (gmail: GmailTools, model: ModelAdapter, maxSteps = 10) => ({
  owner: "123",
  gmail,
  model,
  instructions: "You are the email agent.",
  tools: gmailToolDefinitions(),
  maxSteps,
  effort: "medium" as const,
});

test("found, surfaced, readable and extra follow what the model saw and reported", async () => {
  // a1 has a plain-text body, a2 and a3 are HTML only, a4 is never surfaced.
  const gmail = fakeGmail({ a2: { html: true }, a3: { html: true } }, [
    "a1",
    "a2",
    "a3",
  ]);
  const { model, seen } = scripted([
    [{ name: "gmail_search", args: { query: "from:store receipt" } }],
    [
      { name: "gmail_thread", args: { threadId: "ba1" } },
      { name: "gmail_thread", args: { threadId: "ba2" } },
      { name: "gmail_read", args: { messageId: "a3" } },
    ],
    [
      {
        name: "eval_report",
        args: {
          messageIds: [
            { account: "primary", messageId: "a1" },
            { account: "primary", messageId: "a2" },
            { account: "primary", messageId: "e9" },
          ],
          answer: "Two Monthly receipts.",
        },
      },
    ],
  ]);
  const record = await runTask(task, options(gmail, model));
  const score = scoreTask(task, record);
  assert.equal(score.ended, "reported");
  assert.equal(score.found, 2);
  assert.equal(score.surfaced, 3);
  // a2's thread entry is bodyless and a3's read falls back to the snippet.
  assert.equal(score.readable, 1);
  assert.deepEqual(
    score.messages.map((m) => [m.messageId, m.readable]),
    [
      ["a1", true],
      ["a2", false],
      ["a3", false],
      ["a4", false],
    ],
  );
  assert.equal(score.extra, 1);
  assert.deepEqual(score.extraIds, ["primary:e9"]);
  assert.equal(score.answerHits, 1);
  assert.equal(score.searches, 1);
  assert.equal(score.gmailCalls, 4);
  assert.equal(score.modelCalls, 3);
  assert.equal(score.inputTokens, 300);
  assert.equal(score.cachedTokens, 120);
  assert.equal(score.costUsd, 0.003);
  // The model received the projected results, warning included.
  assert.match(seen[1]!, /Untrusted email content/);
});

test("a task that spends the Gmail request budget is called out", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const gmail = fakeGmail({}, ids);
  const searches = ["one", "two", "three", "four", "five"].map((q) => [
    { name: "gmail_search", args: { query: q } },
  ]);
  const { model } = scripted([
    ...searches,
    [{ name: "eval_report", args: { messageIds: [], answer: "none" } }],
  ]);
  const score = scoreTask(task, await runTask(task, options(gmail, model)));
  // Each page costs 11 requests of 40: the fourth is partial, the fifth is refused.
  assert.equal(score.budgetExhausted, true);
  assert.deepEqual(score.toolErrors, { VALIDATION_FAILED: 1 });
  assert.equal(score.searches, 5);
  assert.equal(score.ended, "reported");
  assert.equal(score.found, 0);
});

test("a model that never reports stops at the step limit; its last call offers only the report", async () => {
  const gmail = fakeGmail({}, ["a1"]);
  const { model, offered, seen } = scripted([
    [{ name: "gmail_search", args: { query: "receipt" } }],
  ]);
  const record = await runTask(task, options(gmail, model, 3));
  assert.equal(record.ended, "step_limit");
  assert.equal(record.modelCalls, 3);
  assert.deepEqual(offered[2], ["eval_report"]);
  assert.match(seen[2]!, /This is your last model call/);
  // The refused search on the last call is not dispatched.
  assert.equal(record.searches, 2);
  assert.deepEqual(record.toolErrors, { UNKNOWN_TOOL: 1 });
  assert.equal(scoreTask(task, record).surfaced, 1);
});

test("malformed task input is refused with its line and field", () => {
  const good = JSON.stringify(task);
  assert.equal(parseTasks(`${good}\n\n`).length, 1);
  assert.throws(() => parseTasks(`${good}\nnot json`), /line 2 is not valid/);
  assert.throws(
    () =>
      parseTasks(
        JSON.stringify({ ...task, expected: [{ account: "primary" }] }),
      ),
    /line 1 is malformed: expected\.0\.messageId/,
  );
  assert.throws(
    () =>
      parseTasks(
        JSON.stringify({
          ...task,
          expected: [{ account: "secondary", messageId: "a1" }],
        }),
      ),
    /must be in one of the task's accounts/,
  );
  assert.throws(() => parseTasks(`${good}\n${good}`), /repeats/);
  assert.throws(() => parseTasks(""), /No tasks/);
  assert.throws(() => parseFlags(["--instructions", "file:-"]), /agent:/);
  assert.throws(() => parseFlags(["--model", "huge"]), /--model/);
});

test("the summary carries aggregates only, without request text or IDs", async () => {
  const gmail = fakeGmail({}, ["a1"]);
  const { model } = scripted([
    [{ name: "gmail_search", args: { query: "receipt" } }],
    [
      {
        name: "eval_report",
        args: {
          messageIds: [
            { account: "primary", messageId: "a1" },
            { account: "primary", messageId: "e9" },
          ],
          answer: "One receipt",
        },
      },
    ],
  ]);
  const score = scoreTask(task, await runTask(task, options(gmail, model)));
  const summary = summarise([score], { instructions: "agent:email" });
  const text = JSON.stringify(summary);
  for (const secret of [task.id, task.request, "a1", "e9", "receipt"])
    assert.equal(text.includes(secret), false, secret);
  assert.equal(summary.found, 1);
  assert.equal(summary.extra, 1);
  assert.equal(summary.foundRate, 0.25);
  assert.deepEqual(summary.searchesPerTask, { median: 1, max: 1 });
});

test("arms take tools from the runtime and instructions from the shipped plugin", () => {
  assert.deepEqual(
    gmailToolDefinitions().map((t) => t.name),
    ["gmail_accounts", "gmail_search", "gmail_thread", "gmail_read"],
  );
  const arm = resolveArm(parseFlags(["--instructions", "agent:email"]));
  const agent = plugins.get("core/email");
  assert.equal(arm.instructions, agent.instructions);
  assert.equal(arm.maxSteps, agent.limits.models);
  assert.equal(arm.tier, agent.model);
  assert.throws(
    () => resolveArm(parseFlags(["--instructions", "skill:missing"])),
    /No plugin skill/,
  );
});
