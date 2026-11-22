import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { instructions } from "../src/context.js";
import { defaultBudget } from "../src/execution.js";
import {
  coordinatorContext,
  coordinatorTools,
  gmailToolDefinitions,
  normalise,
  parseFlags,
  parseTasks,
  resolveArm,
  runTask,
  scoreTask,
  summarise,
  type EvalTask,
  type LoopOptions,
} from "../src/email-eval.js";
import { GmailTools } from "../src/gmail.js";
import {
  ModelError,
  type Generation,
  type ModelAdapter,
  type ToolDefinition,
} from "../src/model.js";
import { resolveAgentModel } from "../src/model-policy.js";
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
type Mail = {
  html?: boolean;
  body?: string;
  snippet?: string;
  /** Gmail refuses this message's reads: a rate limit, or the daily quota. */
  refuse?: "rate" | "daily";
};
/** A message with a plain-text body, or HTML only (which the read tools convert since Phase 1). */
function message(id: string, mail: Mail = {}) {
  const body = mail.body ?? BODY;
  return {
    id,
    threadId: `b${id}`,
    snippet: mail.snippet ?? "Your monthly receipt",
    internalDate: "1",
    labelIds: [],
    payload: {
      headers: [
        { name: "From", value: "Store <billing@example.com>" },
        { name: "Subject", value: `Receipt ${id}` },
        { name: "Date", value: "Sun, 1 Nov 2026 09:00:00 +0800" },
      ],
      mimeType: mail.html ? "text/html" : "text/plain",
      body: { data: encode(mail.html ? `<p>${body}</p>` : body) },
    },
  };
}
/**
 * Real GmailTools over a fake Gmail: fitting, warnings and rate-limit handling are the real
 * ones. The batch endpoint is refused, so metadata comes from single fetches. `calls` records
 * every request path.
 */
function fakeGmail(
  mail: Record<string, Mail>,
  hits: string[] | ((query: string) => string[]),
  calls: string[] = [],
) {
  const request = (async (u: unknown) => {
    const url = new URL(String(u));
    calls.push(url.pathname + url.search);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "a", expires_in: 3600 });
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: config.email });
    if (url.pathname === "/batch/gmail/v1")
      return new Response("unavailable", { status: 503 });
    if (url.pathname.endsWith("/messages")) {
      const ids =
        typeof hits === "function" ? hits(url.searchParams.get("q")!) : hits;
      return Response.json({
        messages: ids.map((id) => ({ id, threadId: `b${id}` })),
        resultSizeEstimate: ids.length,
      });
    }
    const thread = /\/threads\/b([a-f0-9]+)$/.exec(url.pathname)?.[1];
    if (thread)
      return Response.json({
        id: `b${thread}`,
        messages: [message(thread, mail[thread])],
      });
    const id = /\/messages\/([a-f0-9]+)$/.exec(url.pathname)![1]!;
    const refuse = mail[id]?.refuse;
    if (refuse)
      return Response.json(
        {
          error: {
            code: 403,
            errors: [
              {
                reason:
                  refuse === "daily"
                    ? "dailyLimitExceeded"
                    : "rateLimitExceeded",
              },
            ],
          },
        },
        { status: 403 },
      );
    return Response.json(message(id, mail[id]));
  }) as typeof fetch;
  // Rate-limit backoff waits are skipped, so refusals are scored without real delays.
  return new GmailTools(config, request, Date.now, async () => {});
}
/**
 * A stand-in for GmailTools.call, for result shapes the real tools cannot produce, such as
 * those of the tools before Phase 1. `options` is the call's last argument.
 */
function stubGmail(
  answer: (
    operation: string,
    value: string,
    account?: string,
    options?: any,
  ) => unknown,
): LoopOptions["gmail"] {
  return {
    call: async (_user, operation, value, _page, _run, account, options) =>
      answer(operation, value, account, options),
  };
}
type Call = { name: string; args: object };
type Step = Call[] | string | Error;
/**
 * Replays one step per model call: tool calls, a text reply, or a thrown error. Records what
 * each call was offered and the messages it received.
 */
function scripted(steps: Step[]) {
  const offered: string[][] = [];
  const seen: string[] = [];
  let n = 0;
  const model: ModelAdapter = {
    model: "test/model",
    async generate(input): Promise<Generation> {
      offered.push(input.tools.map((t: ToolDefinition) => t.name));
      seen.push(JSON.stringify(input.messages));
      const step = steps[Math.min(n++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 40 },
        cost: 0.001,
      };
      if (typeof step === "string")
        return { message: { role: "assistant", content: step }, usage };
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
        usage,
      };
    },
  };
  return { model, offered, seen };
}
const ref = (messageId: string, account = "primary") => ({
  account,
  messageId,
});
const report = (ids: { account: string; messageId: string }[], answer = "") => [
  { name: "eval_report", args: { messageIds: ids, answer } },
];
const search = (query: string, account?: string) => [
  { name: "gmail_search", args: { query, ...(account ? { account } : {}) } },
];
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
const only = (
  messageId: string,
  extra: Partial<EvalTask["expected"][number]> = {},
): EvalTask => ({
  ...task,
  expected: [{ account: "primary", messageId, ...extra }],
});
const options = (
  gmail: LoopOptions["gmail"],
  model: ModelAdapter,
  maxSteps = 10,
): LoopOptions => ({
  owner: "123",
  gmail,
  model,
  instructions: "You are the email agent.",
  tools: gmailToolDefinitions(),
  maxSteps,
  effort: "medium",
});
const run = async (t: EvalTask, gmail: LoopOptions["gmail"], steps: Step[]) =>
  scoreTask(t, await runTask(t, options(gmail, scripted(steps).model)));

test("found, surfaced, readable and extra follow what the model saw and reported", async () => {
  // a1 has a plain-text body, a2 and a3 are HTML only (read as converted text since Phase 1),
  // a4 is never surfaced.
  const gmail = fakeGmail({ a2: { html: true }, a3: { html: true } }, [
    "a1",
    "a2",
    "a3",
  ]);
  const { model, seen } = scripted([
    search("from:store receipt"),
    [
      { name: "gmail_thread", args: { threadId: "ba1" } },
      { name: "gmail_thread", args: { threadId: "ba2" } },
      { name: "gmail_read", args: { messageId: "a3" } },
    ],
    report([ref("a1"), ref("a2"), ref("e9")], "Two Monthly receipts."),
  ]);
  const score = scoreTask(task, await runTask(task, options(gmail, model)));
  assert.equal(score.ended, "reported");
  assert.equal(score.found, 2);
  assert.equal(score.surfaced, 3);
  assert.equal(score.surfacedIdOnly, 0);
  // a2's thread entry and a3's read are the HTML bodies converted to text.
  assert.equal(score.readable, 3);
  assert.deepEqual(
    score.messages.map((m) => [m.messageId, m.readable]),
    [
      ["a1", true],
      ["a2", true],
      ["a3", true],
      ["a4", false],
    ],
  );
  assert.equal(score.scoredByHeuristic, 4);
  assert.equal(score.scoredByBodyChars, 0);
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

test("many searches in one task are never refused now that the request budget is gone", async () => {
  // Under the removed 40-request budget, the fifth of these searches was refused.
  const gmail = fakeGmail({}, (q) =>
    Array.from({ length: 9 }, (_, i) => `${q}${i}`),
  );
  const score = await run(only("e8"), gmail, [
    search("a"),
    search("b"),
    search("c"),
    search("d"),
    search("e"),
    search("f"),
    report([]),
  ]);
  assert.deepEqual(score.toolErrors, {});
  assert.equal(score.searches, 6);
  assert.equal(score.surfaced, 1);
  assert.equal(score.rateLimitedCalls, 0);
  assert.equal(score.rateLimitedRows, 0);
  assert.equal("budgetExhausted" in score, false);
});

test("Gmail rate limits are counted: refused calls and rows left unretrieved", async () => {
  const gmail = fakeGmail({ a2: { refuse: "rate" }, a3: { refuse: "daily" } }, [
    "a1",
    "a2",
    "a3",
  ]);
  const score = await run(task, gmail, [
    search("receipt"),
    [
      { name: "gmail_read", args: { messageId: "a2" } },
      { name: "gmail_read", args: { messageIds: ["a1", "a2", "a3"] } },
    ],
    report([]),
  ]);
  // The single read is one RATE_LIMITED call; two search rows and two batch-read messages
  // were left out by the rate and daily limits.
  assert.deepEqual(score.toolErrors, { RATE_LIMITED: 1 });
  assert.equal(score.rateLimitedCalls, 1);
  assert.equal(score.rateLimitedRows, 4);
  assert.equal(score.surfaced, 1);
  assert.equal(score.surfacedIdOnly, 2);
  // a1 was read in the batch; the refused messages' detail is not a body.
  assert.deepEqual(
    score.messages.map((m) => [m.messageId, m.readable]),
    [
      ["a1", true],
      ["a2", false],
      ["a3", false],
      ["a4", false],
    ],
  );
  const summary = summarise([score], {});
  assert.equal(summary.rateLimitedCalls, 1);
  assert.equal(summary.rateLimitedRows, 4);
  assert.equal(summary.rateLimitedTasks, 1);
});

test("a model that never reports stops at the step limit; its last call offers only the report", async () => {
  const gmail = fakeGmail({}, ["a1"]);
  const { model, offered, seen } = scripted([search("receipt")]);
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

test("model errors end a task, transient ones are retried, and a text reply is unreported", async () => {
  const gmail = fakeGmail({}, []);
  const failed = await run(task, gmail, [new ModelError("refused", false)]);
  assert.equal(failed.ended, "error");
  assert.equal(failed.error, "model");
  assert.equal(failed.modelCalls, 1);
  const retried = await run(task, gmail, [
    new ModelError("busy", true),
    report([ref("a1")]),
  ]);
  assert.equal(retried.ended, "reported");
  assert.equal(retried.modelCalls, 2);
  assert.equal(retried.found, 1);
  const unreported = await run(task, gmail, ["Nothing found."]);
  assert.equal(unreported.ended, "unreported");
  assert.equal(unreported.found, 0);
});

test("an invalid eval_report is refused and counts nothing", async () => {
  const score = await run(task, fakeGmail({}, []), [
    report([{ account: "primary", messageId: "not-hex" }]),
    "Giving up.",
  ]);
  assert.deepEqual(score.toolErrors, { INVALID_INPUT: 1 });
  assert.equal(score.ended, "unreported");
  assert.equal(score.found, 0);
  assert.equal(score.extra, 0);
});

test("a report ends its step: sibling calls are not dispatched or scored", async () => {
  const gmail = fakeGmail({}, ["a1"]);
  const score = await run(task, gmail, [
    [
      { name: "gmail_search", args: { query: "receipt" } },
      { name: "gmail_thread", args: { threadId: "ba1" } },
      ...report([ref("a1")]),
    ],
  ]);
  assert.equal(score.ended, "reported");
  assert.equal(score.found, 1);
  assert.equal(score.skippedWithReport, 2);
  // The model never saw these results, so they count for nothing.
  assert.equal(score.searches, 0);
  assert.equal(score.gmailCalls, 0);
  assert.equal(score.surfaced, 0);
  assert.equal(score.readable, 0);
});

test("an invalid report beside other calls lets them run and be returned", async () => {
  const gmail = fakeGmail({}, ["a1"]);
  const score = await run(task, gmail, [
    [
      { name: "gmail_search", args: { query: "receipt" } },
      ...report([{ account: "primary", messageId: "not-hex" }]),
    ],
    report([ref("a1")]),
  ]);
  assert.equal(score.skippedWithReport, 0);
  assert.equal(score.surfaced, 1);
  assert.deepEqual(score.toolErrors, { INVALID_INPUT: 1 });
});

test("an excerpted result counts its search rows but no body", async () => {
  // Above the email projection's 110,000-character limit, a result becomes an excerpt.
  const padding = "x".repeat(120_000);
  const gmail = stubGmail((operation) =>
    operation === "gmail_search"
      ? {
          results: [
            { id: "a1", threadId: "ba1", snippet: "Receipt" },
            { id: "a2", threadId: "ba2", detail: "not retrieved: unavailable" },
          ],
          padding,
          account: "primary",
        }
      : {
          messages: [{ id: "a1", text: BODY }],
          padding,
          account: "primary",
        },
  );
  const { model, seen } = scripted([
    search("receipt"),
    [{ name: "gmail_thread", args: { threadId: "ba1" } }],
    report([]),
  ]);
  const score = scoreTask(task, await runTask(task, options(gmail, model)));
  assert.match(seen[1]!, /excerpt/);
  assert.equal(score.surfaced, 1);
  assert.equal(score.surfacedIdOnly, 1);
  assert.equal(score.readable, 0);
});

test("messages are keyed by account and lowercase ID; duplicate reports count once", async () => {
  const both: EvalTask = {
    ...task,
    accounts: ["primary", "secondary"],
    expected: [{ account: "primary", messageId: "a1" }],
  };
  const gmail = stubGmail((_operation, _value, account) => ({
    results: [{ id: "A1", threadId: "ba1", snippet: "Receipt" }],
    account: account ?? "primary",
  }));
  const score = await run(both, gmail, [
    search("receipt", "secondary"),
    report([ref("a1", "secondary"), ref("A1"), ref("a1"), ref("a1")]),
  ]);
  // Seen only in the other mailbox, so not surfaced; reported once in the right one.
  assert.equal(score.surfaced, 0);
  assert.equal(score.found, 1);
  assert.equal(score.extra, 1);
  assert.deepEqual(score.extraIds, ["secondary:a1"]);
});

/**
 * The tools before Phase 1: a search row with a snippet, and a gmail_read that returns that
 * snippet for an HTML-only message without flagging it.
 */
function legacyGmail(id: string, snippet: string) {
  return stubGmail((operation) =>
    operation === "gmail_search"
      ? {
          results: [{ id, threadId: `b${id}`, snippet: snippet.slice(0, 120) }],
          account: "primary",
        }
      : {
          id,
          threadId: `b${id}`,
          text: snippet,
          truncated: false,
          account: "primary",
        },
  );
}

test("a long entity-laden snippet returned by gmail_read is not a readable body", async () => {
  const snippet =
    "Receipt &amp; invoice for &#39;Example&#39; &quot;monthly&quot; plan ".repeat(
      5,
    );
  assert.ok(snippet.length > 300);
  const steps = [
    search("receipt"),
    [{ name: "gmail_read", args: { messageId: "a5" } }],
    report([ref("a5")]),
  ];
  const heuristic = await run(only("a5"), legacyGmail("a5", snippet), steps);
  assert.equal(heuristic.surfaced, 1);
  assert.equal(heuristic.readable, 0);
  assert.equal(heuristic.scoredByHeuristic, 1);
  const measured = await run(
    only("a5", { bodyChars: 3000 }),
    legacyGmail("a5", snippet),
    steps,
  );
  assert.equal(measured.readable, 0);
  assert.equal(measured.scoredByBodyChars, 1);
  // The current tools read the same HTML-only message as converted text.
  const mail = { a5: { html: true, snippet } };
  const current = await run(only("a5"), fakeGmail(mail, ["a5"]), steps);
  assert.equal(current.readable, 1);
});

test("a short plain body is readable only when bodyChars vouches for it", async () => {
  const mail = { a6: { body: "Your order shipped. ".repeat(7) } };
  const steps = [
    [{ name: "gmail_thread", args: { threadId: "ba6" } }],
    report([ref("a6")]),
  ];
  const heuristic = await run(only("a6"), fakeGmail(mail, []), steps);
  assert.equal(heuristic.readable, 0);
  const measured = await run(
    only("a6", { bodyChars: 140 }),
    fakeGmail(mail, []),
    steps,
  );
  assert.equal(measured.readable, 1);
});

test("with bodyChars, a continuation read adds up but a repeated read does not", async () => {
  const parts = ["p".repeat(600), "q".repeat(600)];
  const steps = [
    [
      { name: "gmail_read", args: { messageId: "a7" } },
      { name: "gmail_read", args: { messageId: "a7" } },
    ],
    report([ref("a7")]),
  ];
  const reader = (texts: string[]) => {
    let n = 0;
    return stubGmail(() => ({
      id: "a7",
      text: texts[n++ % texts.length],
      account: "primary",
    }));
  };
  const t = only("a7", { bodyChars: 2000 });
  assert.equal((await run(t, reader(parts), steps)).readable, 1);
  assert.equal((await run(t, reader([parts[0]!]), steps)).readable, 0);
});

test("with bodyChars, a snippet stand-in from gmail_read counts for nothing", async () => {
  // A short HTML-only email: its snippet alone reaches half of bodyChars.
  const snippet = "Receipt &amp; invoice for &#39;Example&#39; plan ".repeat(6);
  const t = only("a8", { bodyChars: 500 });
  assert.ok(snippet.length >= 250 && snippet.length <= 400);
  const read = [{ name: "gmail_read", args: { messageId: "a8" } }];
  const legacy = await run(t, legacyGmail("a8", snippet), [
    search("receipt"),
    read,
    report([ref("a8")]),
  ]);
  assert.equal(legacy.readable, 0);
  // The current tools convert the HTML in both reads, and say so with fromHtml.
  const mail = { a8: { html: true, snippet } };
  for (const step of [
    read,
    [{ name: "gmail_thread", args: { threadId: "ba8" } }],
  ]) {
    const current = await run(t, fakeGmail(mail, ["a8"]), [
      search("receipt"),
      step,
      report([ref("a8")]),
    ]);
    assert.equal(current.readable, 1);
  }
});

test("a bodyless single read is never a body, and fromHtml is never set on its snippet", async () => {
  // An HTML part that converts to nothing: the tools return the snippet, flagged bodyless.
  const mail = {
    af: { html: true, body: "", snippet: "Your receipt is attached" },
  };
  const gmail = fakeGmail(mail, ["af"]);
  const direct: any = await gmail.call("123", "gmail_read", "af");
  assert.equal(direct.bodyless, true);
  assert.equal(direct.fromHtml, undefined);
  assert.equal(direct.text, "Your receipt is attached");
  // Even with the builder saying the message has plain text, a bodyless text never counts.
  const score = await run(
    only("af", { htmlOnly: false, bodyChars: 20 }),
    fakeGmail(mail, ["af"]),
    [[{ name: "gmail_read", args: { messageId: "af" } }], report([ref("af")])],
  );
  assert.equal(score.readable, 0);
});

test("with bodyChars, a thread's cut of a body read whole later counts once", async () => {
  const body = "r".repeat(1400);
  const gmail = stubGmail((operation) =>
    operation === "gmail_thread"
      ? {
          messages: [{ id: "a9", text: body.slice(0, 1000) }],
          account: "primary",
        }
      : { id: "a9", text: body, account: "primary" },
  );
  // 1,000 + 1,400 would pass half of 3,000; the body itself, 1,400, does not.
  const score = await run(only("a9", { bodyChars: 3000 }), gmail, [
    [
      { name: "gmail_thread", args: { threadId: "ba9" } },
      { name: "gmail_read", args: { messageId: "a9" } },
    ],
    report([ref("a9")]),
  ]);
  assert.equal(score.readable, 0);
});

test("with bodyChars, a message flagged bodyless counts for nothing", async () => {
  const gmail = stubGmail(() => ({
    messages: [{ id: "aa", text: "s".repeat(2000), bodyless: true }],
    account: "primary",
  }));
  const score = await run(only("aa", { bodyChars: 2000 }), gmail, [
    [{ name: "gmail_thread", args: { threadId: "baa" } }],
    report([ref("aa")]),
  ]);
  assert.equal(score.readable, 0);
});

test("htmlOnly false makes a short plain-text email readable that the guess rejects", async () => {
  // The reviewer's probe: 321 characters of plain text, searched, then read as a thread.
  const body =
    "Your order of the monthly plan has shipped and will arrive soon. "
      .repeat(5)
      .slice(0, 321);
  assert.equal(body.length, 321);
  const mail = { ab: { body, snippet: body.slice(0, 200) } };
  const steps = [
    search("order"),
    [{ name: "gmail_thread", args: { threadId: "bab" } }],
    report([ref("ab")]),
  ];
  const told = await run(
    only("ab", { bodyChars: 321, htmlOnly: false }),
    fakeGmail(mail, ["ab"]),
    steps,
  );
  assert.equal(told.readable, 1);
  assert.equal(told.bodyByBuilder, 1);
  // Without htmlOnly the documented guess takes it for its snippet.
  const guessed = await run(
    only("ab", { bodyChars: 321 }),
    fakeGmail(mail, ["ab"]),
    steps,
  );
  assert.equal(guessed.readable, 0);
  assert.equal(guessed.bodyByGuess, 1);
});

test("htmlOnly true makes a long snippet from gmail_read unreadable", async () => {
  // Over 400 characters, the snippet escapes the guess.
  const snippet = "Thank you for your payment for the monthly plan. ".repeat(
    10,
  );
  assert.ok(snippet.length > 400);
  const steps = [
    search("payment"),
    [{ name: "gmail_read", args: { messageId: "ac" } }],
    report([ref("ac")]),
  ];
  const told = await run(
    only("ac", { htmlOnly: true }),
    legacyGmail("ac", snippet),
    steps,
  );
  assert.equal(told.readable, 0);
  const guessed = await run(only("ac"), legacyGmail("ac", snippet), steps);
  assert.equal(guessed.readable, 1);
});

test("a text flagged fromHtml is the body even when htmlOnly is true", async () => {
  const gmail = stubGmail(() => ({
    id: "ad",
    text: "Converted receipt text. ".repeat(20),
    fromHtml: true,
    account: "primary",
  }));
  const score = await run(
    only("ad", { htmlOnly: true, bodyChars: 600 }),
    gmail,
    [[{ name: "gmail_read", args: { messageId: "ad" } }], report([ref("ad")])],
  );
  assert.equal(score.readable, 1);
});

test("a search row's snippet cut inside an entity still matches its stand-in", async () => {
  // Gmail's row snippet is cut at 120 characters, here in the middle of "&amp;".
  const snippet = "a" + "b&amp;".repeat(60);
  assert.equal(snippet.slice(115, 120), "b&amp");
  const score = await run(only("ae"), legacyGmail("ae", snippet), [
    search("receipt"),
    [{ name: "gmail_read", args: { messageId: "ae" } }],
    report([ref("ae")]),
  ]);
  // Without the strip, the cut "&amp" would not match and the stand-in would count.
  assert.equal(score.readable, 0);
});

test("the HTML entities in snippets are decoded before comparison", () => {
  assert.equal(
    normalise("Tom &amp; Jerry&#39;s&nbsp;  &#x2019;plan&quot;  "),
    "Tom & Jerry's ’plan\"",
  );
});

test("malformed task input is refused with its line, field and code, never its value", () => {
  const good = JSON.stringify(task);
  assert.equal(parseTasks(`${good}\n\n`).length, 1);
  assert.throws(() => parseTasks(`${good}\nnot json`), /line 2 is not valid/);
  assert.throws(
    () =>
      parseTasks(
        JSON.stringify({ ...task, expected: [{ account: "primary" }] }),
      ),
    /line 1 is malformed: expected\.0\.messageId: invalid_type/,
  );
  assert.throws(
    () =>
      parseTasks(
        JSON.stringify({ ...task, expected: [ref("a1", "secondary")] }),
      ),
    /expected\.0\.account: custom/,
  );
  assert.throws(
    () =>
      parseTasks(JSON.stringify({ ...task, expected: [ref("a1"), ref("A1")] })),
    /expected\.1\.messageId: custom/,
  );
  assert.throws(
    () => parseTasks(JSON.stringify(only("a1", { bodyChars: 0 }))),
    /expected\.0\.bodyChars: too_small/,
  );
  try {
    parseTasks(
      JSON.stringify({
        ...task,
        kind: "privatekind",
        expected: [ref("privatevalue")],
      }),
    );
    assert.fail("accepted");
  } catch (error) {
    const text = (error as Error).message;
    assert.match(text, /kind: invalid_enum_value/);
    assert.equal(/private/.test(text), false, text);
  }
  assert.throws(() => parseTasks(`${good}\n${good}`), /repeats/);
  assert.throws(() => parseTasks(""), /No tasks/);
  assert.throws(
    () => parseFlags(["--instructions", "file:-"]),
    /retired:email/,
  );
  // The retired agent's arm is replayed from its frozen text, not the registry.
  assert.throws(
    () => parseFlags(["--instructions", "agent:email"]),
    /retired:email/,
  );
  assert.throws(() => parseFlags(["--model", "huge"]), /--model/);
});

test("the summary carries aggregates only, without request text or IDs", async () => {
  const tasks: EvalTask[] = [
    { ...only("a1"), id: "private-one", request: "Private request one" },
    { ...only("a2"), id: "private-two", request: "Private request two" },
    {
      ...only("a3", { bodyChars: 500 }),
      id: "private-three",
      request: "Private request three",
    },
  ];
  const gmail = fakeGmail({}, ["a1", "a2", "a3"]);
  const scores = [
    await run(tasks[0]!, gmail, [
      search("receipt"),
      report([ref("a1"), ref("e9")], "One private answer"),
    ]),
    await run(tasks[1]!, gmail, [new ModelError("private failure", false)]),
    // A validation failure: gmail_search without its query.
    await run(tasks[2]!, gmail, [
      [{ name: "gmail_search", args: { account: "primary" } }],
      "No.",
    ]),
  ];
  const summary = summarise(scores, { instructions: "retired:email" });
  const text = JSON.stringify(summary);
  for (const secret of [
    "private",
    "Private",
    "a1",
    "a2",
    "a3",
    "e9",
    "receipt",
  ])
    assert.equal(text.includes(secret), false, secret);
  assert.equal(summary.tasks, 3);
  assert.equal(summary.found, 1);
  assert.equal(summary.extra, 1);
  assert.equal(summary.foundRate, 0.333);
  assert.deepEqual(summary.toolErrors, { INVALID_INPUT: 1 });
  assert.deepEqual(summary.ended, { reported: 1, error: 1, unreported: 1 });
  assert.equal(summary.scoredByBodyChars, 1);
  assert.equal(summary.scoredByHeuristic, 2);
  assert.deepEqual(summary.searchesPerTask, { median: 0, max: 1 });
});

test("the default arm is a coordinator turn on the main model; retired:email replays the frozen agent", () => {
  assert.deepEqual(
    gmailToolDefinitions().map((t) => t.name),
    ["gmail_accounts", "gmail_search", "gmail_thread", "gmail_read"],
  );
  assert.deepEqual(
    coordinatorTools().map((t) => t.name),
    [
      "gmail_accounts",
      "gmail_search",
      "gmail_thread",
      "gmail_read",
      "skill_read",
    ],
  );
  const arm = resolveArm(parseFlags([]), "test/main");
  assert.equal(arm.arm.instructions, "skill:email-search");
  assert.equal(arm.skill, "core/email-search");
  assert.equal(arm.instructions, instructions);
  assert.deepEqual(
    { tier: arm.tier, model: arm.model },
    { tier: "main", model: "test/main" },
  );
  assert.equal(arm.maxSteps, defaultBudget.models);
  assert.equal(
    arm.arm.version,
    plugins.skills().find((s) => s.key === "core/email-search")!.version,
  );
  const asked = resolveArm(
    parseFlags(["--instructions", "skill:email-search", "--model", "fast"]),
    "test/main",
  );
  assert.deepEqual(
    { tier: asked.tier, model: asked.model },
    resolveAgentModel("fast", "test/main"),
  );
  // The retired email agent's frozen text hashes as the agent:email arm of the Phase 1 runs did
  // (plugins/core/agents/email.md at 4ee82e6), on its own tier, effort and step count.
  const retired = resolveArm(
    parseFlags(["--instructions", "retired:email"]),
    "test/main",
  );
  assert.equal(
    createHash("sha256").update(retired.instructions).digest("hex"),
    "61b719445991cfd260b32bd15ad79622941914207b031464b16bf23d7df33e7c",
  );
  assert.equal(retired.arm.instructionsSha256, "61b719445991cfd2");
  assert.equal(retired.skill, undefined);
  assert.equal(retired.maxSteps, 10);
  assert.equal(retired.effort, "medium");
  assert.deepEqual(
    { tier: retired.tier, model: retired.model },
    resolveAgentModel("fast", "test/main"),
  );
  assert.throws(
    () =>
      resolveArm(parseFlags(["--instructions", "skill:missing"]), "test/main"),
    /No plugin skill/,
  );
});

test("a coordinator turn is assembled by context(), offers the skill through skill_read and counts its reads", async () => {
  const gmail = fakeGmail({}, ["a1"]);
  const { model, seen, offered } = scripted([
    [{ name: "skill_read", args: { key: "core/email-search" } }],
    search("from:store receipt"),
    report([ref("a1")], "One monthly receipt."),
  ]);
  const record = await runTask(task, {
    ...options(gmail, model, 40),
    instructions,
    tools: coordinatorTools(),
    coordinator: { context: await coordinatorContext() },
  });
  const score = scoreTask(task, record);
  assert.equal(score.ended, "reported");
  assert.equal(score.found, 1);
  assert.equal(score.skillReads, 1);
  assert.deepEqual(offered[0], [
    "gmail_accounts",
    "gmail_search",
    "gmail_thread",
    "gmail_read",
    "skill_read",
    "eval_report",
  ]);
  const first = JSON.parse(seen[0]!);
  // Chief's own instructions and configuration open the request, the owner's words follow
  // verbatim, and the state closes it, as context() assembles every coordinator call.
  assert.ok(first[0].content.startsWith(instructions));
  assert.match(first[0].content, /This turn is an evaluation/);
  assert.match(first[0].content, /skill_read core\/email-search/);
  assert.match(first[0].content, /"key":"core\/email-search"/);
  assert.deepEqual(first[1], { role: "user", content: task.request });
  assert.match(first.at(-1).content, /^Current state/);
  // The skill's own text came back from skill_read, with no private version consulted.
  const skill = plugins.skills().find((s) => s.key === "core/email-search")!;
  const read = JSON.parse(
    JSON.parse(seen[1]!).findLast((m: any) => m.role === "tool").content,
  );
  assert.equal(read.result.version.content, skill.content);
  assert.equal(summarise([score], {}).tasksReadingSkill, 1);
});

test("pageSize, messageIds and offset reach GmailTools as src/tools.ts passes them", async () => {
  const seen: [string, string, unknown][] = [];
  const gmail = stubGmail((operation, value, _account, opts) => {
    seen.push([operation, value, opts]);
    return { results: [], messages: [], account: "primary" };
  });
  const score = await run(task, gmail, [
    [
      { name: "gmail_search", args: { query: "receipt", pageSize: 100 } },
      { name: "gmail_read", args: { messageIds: ["a1", "a2"] } },
      { name: "gmail_read", args: { messageId: "a1", offset: 20000 } },
      { name: "gmail_thread", args: { threadId: "ba1" } },
      // Outside the runtime schema: refused before dispatch.
      { name: "gmail_search", args: { query: "receipt", pageSize: 101 } },
    ],
    report([]),
  ]);
  assert.deepEqual(seen, [
    ["gmail_search", "receipt", { pageSize: 100 }],
    ["gmail_read", "", { offset: undefined, messageIds: ["a1", "a2"] }],
    ["gmail_read", "a1", { offset: 20000, messageIds: undefined }],
    ["gmail_thread", "ba1", {}],
  ]);
  assert.deepEqual(score.toolErrors, { INVALID_INPUT: 1 });
});

test("a batch read's messages are bodies; a failed entry's detail is not", async () => {
  const gmail = stubGmail(() => ({
    messages: [
      {
        id: "a1",
        text: "Converted receipt. ".repeat(20),
        truncated: false,
        fromHtml: true,
      },
      { id: "a2", detail: "not retrieved: unavailable" },
      { id: "a3", text: "s".repeat(300), truncated: false, bodyless: true },
    ],
    account: "primary",
  }));
  const score = await run(
    {
      ...task,
      expected: ["a1", "a2", "a3"].map((messageId) => ({
        account: "primary" as const,
        messageId,
        htmlOnly: true,
      })),
    },
    gmail,
    [
      [{ name: "gmail_read", args: { messageIds: ["a1", "a2", "a3"] } }],
      report([]),
    ],
  );
  assert.deepEqual(
    score.messages.map((m) => [m.messageId, m.readable]),
    [
      ["a1", true],
      ["a2", false],
      ["a3", false],
    ],
  );
  assert.equal(score.rateLimitedRows, 0);
});

test("offset continuations are placed by offset: overlaps count once", async () => {
  // Texts at 0-1,000, 500-1,500 and 1,000-2,000 cover 2,000 characters, not 3,000.
  const starts = [0, 500, 1000];
  const overlapping = () => {
    let n = 0;
    return stubGmail(() => {
      const offset = starts[n++ % 3]!;
      return {
        id: "b2",
        text: "x".repeat(1000),
        truncated: true,
        ...(offset ? { offset } : {}),
        nextOffset: offset + 1000,
        account: "primary",
      };
    });
  };
  const three = [
    [0, 1, 2].map(() => ({ name: "gmail_read", args: { messageId: "b2" } })),
    report([ref("b2")]),
  ];
  // Half of 4,000 is 2,000: covered exactly; half of 4,002 is not.
  assert.equal(
    (await run(only("b2", { bodyChars: 4000 }), overlapping(), three)).readable,
    1,
  );
  assert.equal(
    (await run(only("b2", { bodyChars: 4002 }), overlapping(), three)).readable,
    0,
  );
  // Without a start, three equal texts are one text by the prefix rule.
  const loose = stubGmail(() => ({
    id: "b2",
    text: "x".repeat(1000),
    account: "primary",
  }));
  assert.equal(
    (await run(only("b2", { bodyChars: 4000 }), loose, three)).readable,
    0,
  );
});

test("real offset continuations are placed by offset, and trimmed texts too", async () => {
  const body = "Receipt line. ".repeat(3000);
  assert.equal(body.length, 42_000);
  const steps = [
    [{ name: "gmail_read", args: { messageId: "c1" } }],
    [{ name: "gmail_read", args: { messageId: "c1", offset: 20000 } }],
    report([ref("c1")]),
  ];
  // The real tools' results are placed at 0 and 20,000, the second a continuation.
  const record = await runTask(
    only("c1", { bodyChars: 42_000 }),
    options(fakeGmail({ c1: { body } }, []), scripted(steps).model),
  );
  assert.deepEqual(
    [...record.bodies.get("primary:c1")!.values()].map((b) => [
      b.start,
      b.text.length,
    ]),
    [
      [0, 20000],
      [20000, 20000],
    ],
  );
  assert.equal(
    scoreTask(only("c1", { bodyChars: 42_000 }), record).readable,
    1,
  );
  // A trimmed text (the adapter's fit) is placed by its offset like any other.
  const trimmed = stubGmail((_op, _value, _account, opts) => ({
    id: "c2",
    text: "t".repeat(4000),
    truncated: true,
    ...(opts?.offset ? { offset: opts.offset } : {}),
    nextOffset: (opts?.offset ?? 0) + 4000,
    account: "primary",
  }));
  const pair = [
    [{ name: "gmail_read", args: { messageId: "c2" } }],
    [{ name: "gmail_read", args: { messageId: "c2", offset: 4000 } }],
    report([ref("c2")]),
  ];
  assert.equal(
    (await run(only("c2", { bodyChars: 16_000 }), trimmed, pair)).readable,
    1,
  );
  assert.equal(
    (await run(only("c2", { bodyChars: 16_002 }), trimmed, pair)).readable,
    0,
  );
});

test("IDs in omittedMessages count as surfaced ID-only, from a search or a thread", async () => {
  const gmail = stubGmail((operation) =>
    operation === "gmail_search"
      ? {
          results: [{ id: "a1", threadId: "ba1", snippet: "Receipt" }],
          omittedMessages: [{ id: "a2", threadId: "ba2" }],
          account: "primary",
        }
      : {
          messages: [{ id: "a1", text: BODY, truncated: false }],
          omittedMessages: [
            { id: "a3", received: "2026-11-01T09:00:00+08:00" },
          ],
          account: "primary",
        },
  );
  const score = await run(task, gmail, [
    search("receipt"),
    [{ name: "gmail_thread", args: { threadId: "ba1" } }],
    report([]),
  ]);
  assert.equal(score.surfaced, 1);
  assert.equal(score.surfacedIdOnly, 2);
  assert.deepEqual(
    score.messages.map((m) => [m.messageId, m.surfaced, m.surfacedIdOnly]),
    [
      ["a1", true, false],
      ["a2", false, true],
      ["a3", false, true],
      ["a4", false, false],
    ],
  );
});

test("text past the end of the body never counts: an offset read past an 88-character email", async () => {
  // The reviewer's probe. The read at offset 5000 returns no text; even a result that put
  // text there (a hand-made one below) is outside the body and is dropped.
  const body =
    "Your order 1234 has shipped and will arrive on Tuesday. Thank you for shopping.";
  const mail = { bd: { body: body.padEnd(88, ".") } };
  const t = only("bd", { bodyChars: 88, htmlOnly: false });
  const steps = [
    [{ name: "gmail_read", args: { messageId: "bd", offset: 5000 } }],
    report([ref("bd")]),
  ];
  assert.equal((await run(t, fakeGmail(mail, []), steps)).readable, 0);
  const placeholder = stubGmail(() => ({
    id: "bd",
    text: "No text at this offset; the body has 88 characters.",
    truncated: false,
    offset: 5000,
    account: "primary",
  }));
  assert.equal((await run(t, placeholder, steps)).readable, 0);
  // A piece that runs past the end is clipped there: 40 inside of 88 is not half.
  const straddling = stubGmail(() => ({
    id: "bd",
    text: "z".repeat(500),
    truncated: false,
    offset: 48,
    account: "primary",
  }));
  assert.equal((await run(t, straddling, steps)).readable, 0);
  // The same read from the start is the body.
  assert.equal(
    (
      await run(t, fakeGmail(mail, []), [
        [{ name: "gmail_read", args: { messageId: "bd" } }],
        report([ref("bd")]),
      ])
    ).readable,
    1,
  );
});

test("IDs in omittedMessages inside an excerpt count as surfaced ID-only", async () => {
  const gmail = stubGmail(() => ({
    results: [{ id: "a1", threadId: "ba1", snippet: "Receipt" }],
    omittedMessages: [{ id: "a2", threadId: "ba2" }],
    // After the IDs, so the excerpt still holds them.
    padding: "x".repeat(120_000),
    account: "primary",
  }));
  const { model, seen } = scripted([search("receipt"), report([])]);
  const score = scoreTask(task, await runTask(task, options(gmail, model)));
  assert.match(seen[1]!, /excerpt/);
  assert.deepEqual(
    score.messages.map((m) => [m.messageId, m.surfaced, m.surfacedIdOnly]),
    [
      ["a1", true, false],
      ["a2", false, true],
      ["a3", false, false],
      ["a4", false, false],
    ],
  );
});
