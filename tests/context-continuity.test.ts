import { test } from "node:test";
import assert from "node:assert/strict";
import {
  context,
  contextHardLimit,
  ContextLimitError,
} from "../src/context.js";
import {
  compactToolGroup,
  completeMessageGroups,
  exchangeIndex,
  turnDigest,
  type IndexRow,
} from "../src/context-continuity.js";
import { runtimeContext } from "../src/runtime.js";
import type { AgentRequest } from "../src/protocol.js";
import type { Message } from "../src/model.js";

const user = (content: string): Message => ({ role: "user", content });
const answer = (content: string): Message => ({ role: "assistant", content });
function toolGroup(name: string, result: unknown, id = name): Message[] {
  return [
    {
      role: "assistant",
      content: null,
      reasoning_details: [{ text: "Internal reasoning ".repeat(1000) }],
      tool_calls: [
        { id, type: "function", function: { name, arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: id, content: JSON.stringify(result) },
  ];
}

/** Real coordinator schemas plus owner memory/state, calibrated to the incident's fixed size. */
function request(
  message: string,
  history: Message[],
  fixedSize = 54264,
): AgentRequest {
  const runtime = runtimeContext(
    {
      canvases: true,
      web: true,
      gmail: true,
      calendar: true,
      preparationSheet: true,
      dailySheet: true,
    },
    null,
  );
  const req: AgentRequest = {
    runId: "fixture",
    capability: "fixture",
    message,
    history,
    memories: [
      { key: "explicit_preferences", value: "Saved preference. ".repeat(120) },
    ],
    runtime,
  };
  const measured = context(req, [user(message)]).fixedSize;
  assert.ok(measured < fixedSize);
  runtime.context += " ".repeat(fixedSize - measured);
  return req;
}

function recentInvitation(): Message[] {
  return [
    user("Add the event from this new invitation. Attachment: image-current"),
    ...toolGroup("media_delegate", {
      observationId: "00000000-0000-4000-8000-000000000001",
      result: {
        extractionSourceId: "00000000-0000-4000-8000-000000000002",
        facts:
          "Mira and Dev's wedding is 2028-04-19 at East Hall. The image has no time.",
      },
    }),
    answer(
      "Mira and Dev's wedding is 19 April 2028 at East Hall. What start and end time should I use?",
    ),
  ];
}

test("54k fixed context preserves the actual invitation question and source when the user supplies its time", () => {
  const history = [
    user("Review 22 saved roles"),
    answer("The earlier role review is paused."),
    user("Another couple's wedding is 3 October 2027"),
    answer("That older invitation starts at 11am."),
    ...recentInvitation(),
  ];
  const before = JSON.stringify(history);
  const message = "Use 8am to 11am";
  const req = request(message, history);
  req.historyOmitted = 469;
  const input = context(req, [...history, user(message)]);
  assert.equal(input.fixedSize, 54264);
  assert.equal(input.overBudget, true);
  assert.equal(input.omitted, 473);
  const text = JSON.stringify(input.messages);
  assert.match(text, /Mira and Dev/);
  assert.match(text, /2028-04-19/);
  assert.match(text, /00000000-0000-4000-8000-000000000002/);
  assert.match(text, /What start and end time should I use/);
  assert.match(text, /Use 8am to 11am/);
  assert.doesNotMatch(
    text,
    /Another couple|Review 22 saved roles|Internal reasoning/,
  );
  assert.deepEqual(
    input.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "assistant", "user", "system"],
  );
  assert.equal(JSON.stringify(history), before);
});

test("dependent retrievals keep earlier results and complete groups instead of forgetting each previous search", () => {
  const history = recentInvitation();
  const message = "Use 8am to 11am";
  const messages = [
    ...history,
    user(message),
    ...toolGroup("conversation_search", {
      observationId: "search-observation",
      result: "current invitation found",
    }),
    ...toolGroup("conversation_read", {
      observationId: "read-observation",
      result: "current invitation original",
    }),
    ...toolGroup("source_read", {
      observationId: "source-observation",
      result: "confirmed venue and date",
    }),
  ];
  const original = JSON.stringify(messages);
  const input = context(request(message, history), messages);
  const tools = input.messages.filter((m) => m.role === "tool");
  assert.equal(tools.length, 4);
  assert.match(JSON.stringify(tools), /search-observation/);
  assert.match(JSON.stringify(tools), /read-observation/);
  assert.match(JSON.stringify(tools), /source-observation/);
  const inTurn = input.messages.slice(
    input.messages.findLastIndex((m) => m.role === "user") + 1,
    -1,
  ) as Message[];
  assert.equal(completeMessageGroups(inTurn).flat().length, inTurn.length);
  assert.equal(JSON.stringify(messages), original);
});

test("long in-turn observations compact with exact read references and keep the newest result intact", () => {
  const history = recentInvitation();
  const message = "Check the saved evidence";
  const groups = Array.from({ length: 8 }, (_, index) =>
    toolGroup(
      "source_read",
      {
        observationId: `observation-${index}`,
        result: {
          sourceId: `source-${index}`,
          content:
            `Exact opening ${index}. ` +
            "Body ".repeat(2000) +
            ` Exact ending ${index}.`,
        },
      },
      `call-${index}`,
    ),
  );
  // Real provider reasoning for the newest tool round remains intact; old reasoning is projected away.
  const latest = toolGroup(
    "source_read",
    { observationId: "newest", result: "Newest exact result" },
    "latest",
  );
  const messages = [...history, user(message), ...groups.flat(), ...latest];
  const original = JSON.stringify(messages);
  const input = context(request(message, history), messages);
  assert.equal(input.compacted, 8);
  assert.ok(
    input.fixedSize +
      input.exchangeSize +
      input.workingSize +
      input.reservedSize <
      contextHardLimit,
  );
  const tools = input.messages.filter((m) => m.role === "tool");
  assert.equal(tools.length, 10);
  for (let index = 0; index < 8; index++) {
    assert.match(
      String(tools[index + 1]!.content),
      new RegExp(`observation-${index}`),
    );
    assert.match(
      String(tools[index + 1]!.content),
      new RegExp(`source-${index}`),
    );
    assert.match(
      String(tools[index + 1]!.content),
      new RegExp(`Exact ending ${index}`),
    );
  }
  assert.deepEqual(input.messages.at(-3), latest[0]);
  assert.deepEqual(input.messages.at(-2), latest[1]);
  assert.equal(JSON.stringify(messages), original);
});

test("an exchange that cannot fit the hard limit fails explicitly rather than dropping its question", () => {
  const history = [
    user("Which date do you mean?"),
    answer("Preserved answer " + "x".repeat(contextHardLimit)),
  ];
  const message = "The later one";
  assert.throws(
    () => context(request(message, history), [...history, user(message)]),
    (error: unknown) =>
      error instanceof ContextLimitError &&
      error.sizes.exchangeSize! > contextHardLimit,
  );
});

test("large previous tool observations can shrink without losing the preceding user request or clarification", () => {
  const history = [
    user("Compare these documents for my meeting"),
    ...Array.from({ length: 8 }, (_, index) =>
      toolGroup(
        "source_read",
        {
          observationId: `previous-${index}`,
          result: "Document passage ".repeat(1000),
        },
        `previous-${index}`,
      ),
    ).flat(),
    answer("The selected meeting is on 21 June 2028. What time should I use?"),
  ];
  const message = "Use 8am to 11am";
  const input = context(request(message, history), [...history, user(message)]);
  assert.equal(input.compacted, 8);
  assert.match(
    JSON.stringify(input.messages),
    /Compare these documents for my meeting/,
  );
  assert.match(JSON.stringify(input.messages), /21 June 2028/);
  assert.equal(input.messages.filter((m) => m.role === "tool").length, 8);
});

test("an oversized earlier call of this turn leaves the context through the digest, not a failure", () => {
  const message = "Continue checking";
  const huge = toolGroup("canvas_create", {
    observationId: "huge-observation",
    result: "saved",
  });
  huge[0]!.tool_calls![0]!.function.arguments = JSON.stringify({
    content: "x".repeat(contextHardLimit),
  });
  const messages = [
    user(message),
    ...huge,
    ...toolGroup("source_read", { result: "last" }),
  ];
  const original = JSON.stringify(messages);
  const input = context(request(message, []), messages);
  assert.equal(input.trimmed, 1);
  assert.ok(input.serializedSize < 130000);
  const text = JSON.stringify(input.messages);
  assert.match(text, /canvas_create.*observationId=huge-observation/);
  assert.doesNotMatch(text, /x{1000}/);
  assert.equal(JSON.stringify(messages), original);
});

test("the serialized text guard accounts for escaping inside fixed system context", () => {
  const req: AgentRequest = {
    runId: "fixture",
    capability: "fixture",
    message: "hello",
    history: [],
    memories: [],
    systemInstructions: "\n".repeat(contextHardLimit / 2),
  };
  assert.throws(
    () => context(req, [user(req.message)]),
    (error: unknown) =>
      error instanceof ContextLimitError &&
      error.sizes.fixedSize! < contextHardLimit &&
      error.sizes.serializedSize! >= contextHardLimit,
  );
});

test("exchange index lists earlier exchanges with read references and excludes the previous one", () => {
  const at = "2026-09-28T06:00:00Z";
  const obs = "11111111-2222-4333-8444-555555555555";
  const rows: IndexRow[] = [
    // A truncated exchange at the window start is skipped.
    { id: "m0", role: "assistant", createdAt: at, content: "orphan reply" },
    {
      id: "m1",
      role: "user",
      createdAt: at,
      content: "any wedding invites?\nplease check",
    },
    {
      id: "m2",
      role: "assistant",
      createdAt: at,
      content: null,
      callNames: ["gmail_search"],
      callIds: ["c1"],
    },
    {
      id: "m3",
      role: "tool",
      createdAt: at,
      content: `{"observationId":"${obs}","result":[]}`,
      toolCallId: "c1",
    },
    {
      id: "m4",
      role: "assistant",
      createdAt: at,
      content: "Two invites: Maya and Priya.",
    },
    {
      id: "m5",
      role: "assistant",
      createdAt: at,
      content: "[Saved answer details: observationId=x.]",
    },
    { id: "m6", role: "user", createdAt: at, content: "thanks" },
    { id: "m7", role: "assistant", createdAt: at, content: "You're welcome." },
  ];
  const index = exchangeIndex(rows);
  const lines = index.split("\n");
  assert.match(
    lines[0]!,
    /conversation_read\(messageId or replyId\).*observation_read\(observationId\)/,
  );
  assert.equal(lines.length, 2);
  assert.match(
    lines[1]!,
    /2 back .*messageId=m1\] you: "any wedding invites\? please check" → "Two invites: Maya and Priya\."/,
  );
  assert.match(lines[1]!, new RegExp(`tools: gmail_search obs=${obs}`));
  assert.doesNotMatch(index, /thanks|orphan|Saved answer/);
  // The allowance keeps the newest exchanges.
  const many: IndexRow[] = Array.from({ length: 60 }, (_, i) => [
    {
      id: `u${i}`,
      role: "user",
      createdAt: at,
      content: `question ${i} ` + "x".repeat(200),
    },
    { id: `a${i}`, role: "assistant", createdAt: at, content: `answer ${i}` },
  ]).flat();
  const bounded = exchangeIndex(many, 3000);
  assert.ok(bounded.length <= 3000 + lines[0]!.length + 1);
  assert.match(bounded, /messageId=u58\]/);
  assert.doesNotMatch(bounded, /messageId=u59\]|messageId=u0\]/);
  const req = request("What changed?", []);
  const beforeSize = context(req, [user(req.message)]).fixedSize;
  req.conversationSummary = index;
  const input = context(req, [user(req.message)]);
  assert.equal(input.fixedSize, beforeSize + index.length);
  assert.match(
    String(input.messages[0]!.content),
    /Exchange index \(historical data/,
  );
});

test("compacted groups never alter call identities, and incomplete or duplicate-ID groups are rejected", () => {
  const group = toolGroup("source_read", {
    sourceId: "source-1",
    content: "x".repeat(4000),
  });
  const projected = compactToolGroup(group, 200);
  assert.equal(projected[0]!.tool_calls![0]!.id, group[0]!.tool_calls![0]!.id);
  assert.equal(projected[1]!.tool_call_id, group[1]!.tool_call_id);
  assert.deepEqual(completeMessageGroups(group.slice(0, 1)), []);
  const duplicate = structuredClone(group);
  duplicate[0]!.tool_calls!.push(duplicate[0]!.tool_calls![0]!);
  duplicate.push(duplicate[1]!);
  assert.deepEqual(completeMessageGroups(duplicate), []);
});

test("wire-size overflow compacts recoverable latest results while retaining reasoning, account provenance and original journal", () => {
  const message = "Read these order confirmations";
  const req: AgentRequest = {
    runId: "wire-fixture",
    capability: "fixture",
    message,
    history: [],
    memories: [],
    systemInstructions: "\n".repeat(30000) + "x".repeat(10000),
  };
  const latest = toolGroup("gmail_read", {
    observationId: "stored-result",
    result: {
      account: "secondary",
      email: "second@example.com",
      threadId: "abc",
      text: "Order details ".repeat(3300),
      warning: "Untrusted email content",
    },
  });
  const messages = [user(message), ...latest];
  const original = JSON.stringify(messages);
  const selected = context(req, messages);
  assert.equal(selected.wireCompacted, true);
  assert.ok(selected.serializedSize < contextHardLimit);
  assert.equal(selected.compacted, 1);
  const retained = selected.messages.find((m) => m.tool_calls?.length)!;
  assert.deepEqual(retained.reasoning_details, latest[0]!.reasoning_details);
  assert.deepEqual(retained.tool_calls, latest[0]!.tool_calls);
  const result = selected.messages.find((m) => m.role === "tool")!;
  assert.match(String(result.content), /stored-result/);
  assert.match(String(result.content), /secondary/);
  assert.match(JSON.stringify(selected.messages), /observation_read/);
  assert.equal(JSON.stringify(messages), original);
});

test("compaction cannot hide oversized unreferenced results", () => {
  const message = "Read";
  const req: AgentRequest = {
    runId: "unrecoverable",
    capability: "fixture",
    message,
    history: [],
    memories: [],
    systemInstructions: "x".repeat(65000),
  };
  const messages = [
    user(message),
    ...toolGroup("gmail_read", { text: "x".repeat(contextHardLimit) }),
  ];
  assert.throws(() => context(req, messages), ContextLimitError);
});

test("continuation above the former guard retains its preceding exchange and compacts before using extra headroom", () => {
  const history = [
    user("Find tracking details for the two selected shipments"),
    ...toolGroup(
      "gmail_read",
      {
        observationId: "previous-mail",
        result: {
          account: "secondary",
          threadId: "selected-thread",
          text: "mail body ".repeat(5000),
        },
      },
      "previous-call",
    ),
    answer(
      "Confirmed selected shipments. " + "Retained exact detail. ".repeat(1600),
    ),
  ];
  const message = "Continue";
  const latest = toolGroup(
    "observation_read",
    {
      observationId: "latest-observation",
      result: {
        sourceId: "selected-source",
        text: "More mail text ".repeat(2500),
      },
    },
    "latest-call",
  );
  const messages = [...history, user(message), ...latest];
  const original = JSON.stringify(messages);
  const result = context(request(message, history, 67570), messages);
  assert.ok(result.serializedSize > 120000);
  assert.ok(result.serializedSize < contextHardLimit);
  assert.equal(result.wireCompacted, true);
  assert.equal(result.compacted, 2);
  assert.match(JSON.stringify(result.messages), /selected-thread/);
  assert.match(JSON.stringify(result.messages), /selected-source/);
  assert.match(
    JSON.stringify(result.messages),
    /Find tracking details for the two selected shipments/,
  );
  assert.deepEqual(result.messages.at(-3), latest[0]);
  assert.equal(JSON.stringify(messages), original);
});

test("exchange index gives background deliveries their own line, caps tools and quotes text", () => {
  const at = "2026-09-28T06:00:00Z";
  const obs = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const calls = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const rows: IndexRow[] = [
    {
      id: "u1",
      role: "user",
      runId: "r1",
      createdAt: at,
      content: 'say " → "fake',
    },
    {
      id: "a1",
      role: "assistant",
      runId: "r1",
      createdAt: at,
      content: null,
      callNames: [...calls.map(() => "web_search"), "finish_turn"],
      callIds: [...calls, "fin"],
    },
    ...calls.map((id, i): IndexRow => ({
      id: `t${i}`,
      role: "tool",
      runId: "r1",
      createdAt: at,
      content: `{"receiptId":"x","observationId":"${obs(i)}"}`,
      toolCallId: id,
    })),
    {
      id: "tf",
      role: "tool",
      runId: "r1",
      createdAt: at,
      content: `{"observationId":"${obs(99)}"}`,
      toolCallId: "fin",
    },
    {
      id: "a2",
      role: "assistant",
      runId: "r1",
      createdAt: at,
      content: "Reply to the first",
    },
    {
      id: "b1",
      role: "assistant",
      runId: "job-7",
      createdAt: at,
      content: "Background report delivered",
    },
    {
      id: "u2",
      role: "user",
      runId: "r2",
      createdAt: at,
      content: "latest question",
    },
    {
      id: "a3",
      role: "assistant",
      runId: "r2",
      createdAt: at,
      content: "latest reply",
    },
  ];
  const lines = exchangeIndex(rows).split("\n");
  assert.equal(lines.length, 3);
  // The owner text is JSON-quoted, so an embedded quote cannot fake a reply.
  assert.ok(
    lines[1]!.includes(
      `you: ${JSON.stringify('say " → "fake')} → "Reply to the first"`,
    ),
  );
  // All twelve results keep read IDs; names only for the first eight.
  for (let i = 0; i < 12; i++) assert.ok(lines[1]!.includes(`obs=${obs(i)}`));
  assert.equal(lines[1]!.match(/web_search obs=/g)!.length, 8);
  assert.doesNotMatch(lines[1]!, /more/);
  assert.doesNotMatch(lines[1]!, /finish_turn/);
  assert.ok(lines[1]!.includes(`obs=${obs(0)}`)); // receiptId before observationId
  assert.match(
    lines[2]!,
    /messageId=b1\] background update → "Background report delivered"/,
  );
  assert.doesNotMatch(lines.join("\n"), /latest/);
});

test("the previous exchange keeps its text but excerpts large results with read references", () => {
  const big = toolGroup("gmail_search", {
    observationId: "obs-1",
    result: "detail ".repeat(1000),
  });
  const history = [
    user("any bank email?"),
    ...big,
    answer("DBS sent a statement."),
    user("and the other one?"),
  ];
  const req = request("and the other one?", history.slice(0, -1));
  const input = context(req, history);
  const text = JSON.stringify(input.messages);
  assert.match(text, /DBS sent a statement/);
  assert.match(text, /earlier tool result excerpts/);
  assert.match(text, /obs-1/);
  assert.ok(input.serializedSize < 120000);
});

test("exchange index keeps reply, saved-answer and every tool read reference", () => {
  const at = "2026-09-28T06:00:00Z";
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const calls = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const rows: IndexRow[] = [
    // A migrated exchange has no run; a later job delivery still gets its own line.
    {
      id: "legacy-u",
      role: "user",
      runId: null,
      createdAt: at,
      content: "old question",
    },
    {
      id: "legacy-a",
      role: "assistant",
      runId: null,
      createdAt: at,
      content: "old answer",
    },
    {
      id: "job-a",
      role: "assistant",
      runId: "job-1",
      createdAt: at,
      content: "Job finished",
    },
    {
      id: "u1",
      role: "user",
      runId: "r1",
      createdAt: at,
      content: "plan my trip",
    },
    {
      id: "a1",
      role: "assistant",
      runId: "r1",
      createdAt: at,
      content: null,
      callNames: calls.map(() => "web_read"),
      callIds: calls,
    },
    ...calls.map((c, i): IndexRow => ({
      id: `t${i}`,
      role: "tool",
      runId: "r1",
      createdAt: at,
      content: `{"observationId":"${id(i)}"}`,
      toolCallId: c,
    })),
    {
      id: "a2",
      role: "assistant",
      runId: "r1",
      createdAt: at,
      content: "Ten stops planned.",
    },
    {
      id: "a3",
      role: "assistant",
      runId: "r1",
      createdAt: at,
      content: `[Saved answer details: observationId=${id(99)}. Use observation_read.]`,
    },
    { id: "u2", role: "user", runId: "r2", createdAt: at, content: "thanks" },
  ];
  const lines = exchangeIndex(rows).split("\n");
  assert.equal(lines.length, 4);
  assert.match(
    lines[1]!,
    /messageId=legacy-u\] you: "old question" → "old answer" · replyId=legacy-a/,
  );
  assert.match(
    lines[2]!,
    /messageId=job-a\] background update → "Job finished"/,
  );
  assert.match(lines[3]!, /→ "Ten stops planned\." · replyId=a2/);
  for (let i = 0; i < 24; i++) assert.ok(lines[3]!.includes(`obs=${id(i)}`));
  assert.ok(!lines[3]!.includes(id(24)));
  assert.match(lines[3]!, /\+6 more/);
  assert.ok(lines[3]!.includes(`saved answer obs=${id(99)}`));
});

test("failed tool calls without IDs never crowd out a stored result's read ID", () => {
  const at = "2026-09-28T06:00:00Z";
  const calls = Array.from({ length: 26 }, (_, i) => `c${i}`);
  const good = "00000000-0000-4000-8000-000000000025";
  const rows: IndexRow[] = [
    { id: "u1", role: "user", runId: "r1", createdAt: at, content: "check" },
    {
      id: "a1",
      role: "assistant",
      runId: "r1",
      createdAt: at,
      content: null,
      callNames: calls.map(() => "gmail_read"),
      callIds: calls,
    },
    ...calls.map((c, i): IndexRow => ({
      id: `t${i}`,
      role: "tool",
      runId: "r1",
      createdAt: at,
      content: i === 25 ? `{"observationId":"${good}"}` : '{"error":"failed"}',
      toolCallId: c,
    })),
    {
      id: "a2",
      role: "assistant",
      runId: "r1",
      createdAt: at,
      content: "Found it.",
    },
    { id: "u2", role: "user", runId: "r2", createdAt: at, content: "thanks" },
  ];
  const line = exchangeIndex(rows).split("\n")[1]!;
  assert.ok(line.includes(`obs=${good}`));
  assert.doesNotMatch(line, /more/);
});

/** A mailbox task shaped like the issue #77 incident: each call returns a projected ~12k result. */
function mailboxTask(calls: number) {
  const history = [
    user("Anything from the courier?"),
    answer("No new courier mail since Monday."),
  ];
  const message = "Find every order confirmation from this month and list them";
  const groups = Array.from({ length: calls }, (_, index) =>
    toolGroup(
      index % 3 ? "gmail_thread" : "gmail_search",
      {
        observationId: `obs-${index}`,
        result: {
          account: "primary",
          threadId: `thread-${index}`,
          excerpt: `Order ${index} confirmed. ` + "mail text ".repeat(1150),
          truncated: true,
        },
      },
      `call-${index}`,
    ),
  );
  groups.forEach((group, index) => {
    group[0]!.reasoning_details = [{ text: "Checking the next thread." }];
    group[0]!.tool_calls![0]!.function.arguments = JSON.stringify({
      threadId: `thread-${index}`,
    });
  });
  const messages = [...history, user(message), ...groups.flat()];
  return { req: request(message, history, 67736), messages, groups };
}

test("a long single-turn task stays bounded as calls grow (issue #77)", () => {
  const sizes: number[] = [];
  for (const calls of [21, 40, 80, 160]) {
    const { req, messages, groups } = mailboxTask(calls);
    const original = JSON.stringify(messages);
    const input = context(req, messages);
    sizes.push(input.serializedSize);
    // The incident failed at 127k characters after 21 calls; growth now stops near the threshold.
    assert.ok(
      input.serializedSize < 135000,
      `${calls}: ${input.serializedSize}`,
    );
    assert.ok(input.trimmed > 0 && input.trimmed % 8 === 0, `${calls}`);
    // Trimming leaves room for escaping, so the newest group is never excerpted.
    assert.equal(input.wireCompacted, false);
    // Every call in context still has exactly its result.
    const tools = input.messages.flatMap((m) =>
      m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [],
    );
    const results = input.messages.flatMap((m) =>
      m.role === "tool" ? [m.tool_call_id] : [],
    );
    assert.deepEqual(results, tools);
    // The newest call is untouched, and the kept calls are the newest ones.
    const latest = groups.at(-1)!;
    assert.deepEqual(input.messages.at(-3), latest[0]);
    assert.deepEqual(input.messages.at(-2), latest[1]);
    assert.equal(tools[0], `call-${input.trimmed}`);
    // The last call to leave is listed with its read reference, and the question stays.
    const text = JSON.stringify(input.messages);
    assert.match(text, new RegExp(`obs-${input.trimmed - 1}\\b`));
    assert.match(text, /Earlier calls in this turn, no longer in context/);
    assert.match(text, /Find every order confirmation from this month/);
    assert.match(text, /No new courier mail since Monday/);
    assert.equal(JSON.stringify(messages), original);
  }
  assert.ok(sizes.at(-1)! - sizes[0]! < 15000, sizes.join(","));
});

test("trimming moves in blocks, so the kept prefix stays stable across several calls", () => {
  const trimmed = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39].map(
    (calls) =>
      context(mailboxTask(calls).req, mailboxTask(calls).messages).trimmed,
  );
  assert.ok(new Set(trimmed).size <= 3, trimmed.join(","));
  for (let i = 1; i < trimmed.length; i++)
    assert.ok(
      [0, 8].includes(trimmed[i]! - trimmed[i - 1]!),
      trimmed.join(","),
    );
});

test("a short task keeps every call and adds no digest", () => {
  const { req, messages } = mailboxTask(4);
  const input = context(req, messages);
  assert.equal(input.trimmed, 0);
  assert.equal(input.messages.filter((m) => m.role === "tool").length, 4);
  assert.doesNotMatch(
    JSON.stringify(input.messages),
    /Earlier calls in this turn/,
  );
});

test("the turn digest lists calls with read IDs, marks failures and keeps the newest within its cap", () => {
  const ok = toolGroup(
    "gmail_search",
    {
      observationId: "obs-a",
      receiptId: "rcpt-a",
      result: { sourceId: "src-a" },
    },
    "a",
  );
  ok[0]!.content = "Searching the primary mailbox first.";
  ok[0]!.tool_calls![0]!.function.arguments = '{"query":"from:shop"}';
  const failed = toolGroup("gmail_read", { error: "not found" }, "b");
  const digest = turnDigest([ok, failed]);
  assert.match(
    digest,
    /\[step 1\] gmail_search\(.*from:shop.*\) → observationId=obs-a receiptId=rcpt-a sourceId=src-a · said "Searching the primary mailbox first\."/,
  );
  assert.match(digest, /\[step 2\] gmail_read\(.*\) · failed/);
  const many = Array.from({ length: 200 }, (_, i) =>
    toolGroup("source_read", { observationId: `o-${i}` }, `c-${i}`),
  );
  const capped = turnDigest(many, 2000);
  assert.ok(capped.length <= 2000);
  assert.match(capped, /o-199\b/);
  assert.doesNotMatch(capped, /o-0\b/);
  assert.match(capped, /\+\d+ earlier calls not listed/);
});

test("owner input steered into a long task stays when its neighbouring calls leave", () => {
  const { req, messages, groups } = mailboxTask(60);
  const steered = user("Also include refunds from the same shops");
  const at = messages.indexOf(groups[4]![0]!);
  const withSteer = [...messages.slice(0, at), steered, ...messages.slice(at)];
  const input = context(req, withSteer);
  assert.ok(input.trimmed >= 8);
  const text = JSON.stringify(input.messages);
  assert.match(text, /Also include refunds from the same shops/);
  assert.doesNotMatch(text, /"call-0"/);
  assert.match(text, /obs-0\b/);
  // The steered message sits after the owner's question and before the calls that remain.
  const roles = input.messages.map((m) => m.role);
  const steerIndex = input.messages.findIndex(
    (m) => m.role === "user" && m.content === steered.content,
  );
  assert.equal(roles[steerIndex + 1], "assistant");
  assert.ok(input.serializedSize < 135000);
});

test("a task at the 100-call run budget keeps a read ID for every call that left", () => {
  const { req, messages, groups } = mailboxTask(100);
  const uuid = (i: number) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const withIds = messages.map((m) =>
    m.role === "tool" && m.content
      ? {
          ...m,
          content: m.content.replace(/"obs-(\d+)"/, (_, i) => `"${uuid(+i)}"`),
        }
      : m,
  );
  const input = context(req, withIds);
  assert.ok(input.trimmed >= 90);
  assert.ok(input.serializedSize < 135000, `${input.serializedSize}`);
  const text = JSON.stringify(input.messages);
  for (let i = 0; i < groups.length; i++)
    assert.ok(text.includes(uuid(i)), `call ${i} lost its read ID`);
  assert.doesNotMatch(text, /earlier calls not listed/);
  assert.match(
    text,
    /s1 gmail_search obs=00000000-0000-4000-8000-000000000000/,
  );
});

test("the digest keeps a failed call's error message", () => {
  const failed = toolGroup(
    "parcel_record",
    {
      error: {
        code: "not_found",
        message: "Unknown parcel id; call parcel_list for ids.",
      },
    },
    "f",
  );
  assert.match(
    turnDigest([failed]),
    /parcel_record\(.*\) · failed "Unknown parcel id; call parcel_list for ids\."/,
  );
});
