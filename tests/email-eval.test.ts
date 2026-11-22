import test from "node:test";
import assert from "node:assert/strict";
import {
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
type Mail = { html?: boolean; body?: string; snippet?: string };
/** A message with a plain-text body, or HTML only (which today's read tools cannot show). */
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
/** Real GmailTools over a fake Gmail: budget, fitting and warnings are the real ones. */
function fakeGmail(
  mail: Record<string, Mail>,
  hits: string[] | ((query: string) => string[]),
) {
  const request = (async (u: unknown) => {
    const url = new URL(String(u));
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "a", expires_in: 3600 });
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: config.email });
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
    return Response.json(message(id, mail[id]));
  }) as typeof fetch;
  return new GmailTools(config, request);
}
/** A stand-in for GmailTools.call, for result shapes the real tools cannot produce. */
function stubGmail(
  answer: (operation: string, value: string, account?: string) => unknown,
): LoopOptions["gmail"] {
  return {
    call: async (_user, operation, value, _page, _run, account) =>
      answer(operation, value, account),
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
  // a1 has a plain-text body, a2 and a3 are HTML only, a4 is never surfaced.
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

test("a search refused by the Gmail request budget is called out", async () => {
  // Nine hits cost ten requests a page, so four pages spend exactly 40 with no partial page.
  const gmail = fakeGmail({}, (q) =>
    Array.from({ length: 9 }, (_, i) => `${q}${i}`),
  );
  const score = await run(task, gmail, [
    search("a"),
    search("b"),
    search("c"),
    search("d"),
    search("e"),
    report([]),
  ]);
  assert.equal(score.budgetExhausted, true);
  assert.deepEqual(score.toolErrors, { VALIDATION_FAILED: 1 });
  assert.equal(score.searches, 5);
  assert.equal(score.ended, "reported");
});

test("a page cut short by the request budget is called out, its bare rows ID-only", async () => {
  // Each page of ten costs 11: the fourth gets metadata for six rows, the last four are bare.
  const gmail = fakeGmail({}, (q) =>
    Array.from({ length: 10 }, (_, i) => `${q}${i}`),
  );
  const score = await run(only("d9"), gmail, [
    search("a"),
    search("b"),
    search("c"),
    search("d"),
    report([]),
  ]);
  assert.equal(score.budgetExhausted, true);
  assert.deepEqual(score.toolErrors, {});
  assert.equal(score.surfaced, 0);
  assert.equal(score.surfacedIdOnly, 1);
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
  const padding = "x".repeat(13_000);
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

test("a long entity-laden snippet returned by gmail_read is not a readable body", async () => {
  const snippet =
    "Receipt &amp; invoice for &#39;Example&#39; &quot;monthly&quot; plan ".repeat(
      5,
    );
  assert.ok(snippet.length > 300);
  const mail = { a5: { html: true, snippet } };
  const steps = [
    search("receipt"),
    [{ name: "gmail_read", args: { messageId: "a5" } }],
    report([ref("a5")]),
  ];
  const heuristic = await run(only("a5"), fakeGmail(mail, ["a5"]), steps);
  assert.equal(heuristic.surfaced, 1);
  assert.equal(heuristic.readable, 0);
  assert.equal(heuristic.scoredByHeuristic, 1);
  const measured = await run(
    only("a5", { bodyChars: 3000 }),
    fakeGmail(mail, ["a5"]),
    steps,
  );
  assert.equal(measured.readable, 0);
  assert.equal(measured.scoredByBodyChars, 1);
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
  const mail = { a8: { html: true, snippet } };
  const t = only("a8", { bodyChars: 500 });
  assert.ok(snippet.length >= 250 && snippet.length <= 400);
  const read = [{ name: "gmail_read", args: { messageId: "a8" } }];
  const seen = await run(t, fakeGmail(mail, ["a8"]), [
    search("receipt"),
    read,
    report([ref("a8")]),
  ]);
  assert.equal(seen.readable, 0);
  // gmail_thread flags the same message bodyless, so the two tools agree.
  const thread = await run(t, fakeGmail(mail, ["a8"]), [
    search("receipt"),
    [{ name: "gmail_thread", args: { threadId: "ba8" } }],
    report([ref("a8")]),
  ]);
  assert.equal(thread.readable, 0);
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
  const mail = { ac: { html: true, snippet } };
  const steps = [
    search("payment"),
    [{ name: "gmail_read", args: { messageId: "ac" } }],
    report([ref("ac")]),
  ];
  const told = await run(
    only("ac", { htmlOnly: true }),
    fakeGmail(mail, ["ac"]),
    steps,
  );
  assert.equal(told.readable, 0);
  const guessed = await run(only("ac"), fakeGmail(mail, ["ac"]), steps);
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
  const mail = { ae: { html: true, snippet } };
  const score = await run(only("ae"), fakeGmail(mail, ["ae"]), [
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
  assert.throws(() => parseFlags(["--instructions", "file:-"]), /agent:/);
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
  const summary = summarise(scores, { instructions: "agent:email" });
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

test("arms take tools from the runtime and resolve the model as agent runs do", () => {
  assert.deepEqual(
    gmailToolDefinitions().map((t) => t.name),
    ["gmail_accounts", "gmail_search", "gmail_thread", "gmail_read"],
  );
  const arm = resolveArm(
    parseFlags(["--instructions", "agent:email"]),
    "test/main",
  );
  const agent = plugins.get("core/email");
  assert.equal(arm.instructions, agent.instructions);
  assert.equal(arm.maxSteps, agent.limits.models);
  assert.deepEqual(
    { tier: arm.tier, model: arm.model },
    resolveAgentModel(agent.model, "test/main"),
  );
  const asked = resolveArm(
    parseFlags(["--instructions", "agent:email", "--model", "standard"]),
    "test/main",
  );
  assert.deepEqual(
    { tier: asked.tier, model: asked.model },
    resolveAgentModel("standard", "test/main"),
  );
  // A registry-pinned host model wins over any tier, as in runAgentType.
  const pinned = resolveArm(
    parseFlags(["--instructions", "agent:email", "--model", "standard"]),
    "test/main",
    undefined,
    {
      get: (id) => ({ ...plugins.get(id), hostModel: "test/pinned" }),
      resolve: (type) => plugins.resolve(type),
      skills: () => plugins.skills(),
    },
  );
  assert.deepEqual(
    { tier: pinned.tier, model: pinned.model },
    { tier: "host", model: "test/pinned" },
  );
  assert.throws(
    () =>
      resolveArm(parseFlags(["--instructions", "skill:missing"]), "test/main"),
    /No plugin skill/,
  );
});
