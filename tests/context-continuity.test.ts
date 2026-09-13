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
  extractiveConversationSummary,
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
    answer("Preserved answer " + "x".repeat(70000)),
  ];
  const message = "The later one";
  assert.throws(
    () => context(request(message, history), [...history, user(message)]),
    (error: unknown) =>
      error instanceof ContextLimitError && error.sizes.exchangeSize! > 70000,
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

test("an uncompactable current working set fails explicitly and leaves its original messages unchanged", () => {
  const message = "Continue checking";
  const huge = toolGroup("canvas_create", { result: "saved" });
  huge[0]!.tool_calls![0]!.function.arguments = JSON.stringify({
    content: "x".repeat(70000),
  });
  const messages = [
    user(message),
    ...huge,
    ...toolGroup("source_read", { result: "last" }),
  ];
  const original = JSON.stringify(messages);
  assert.throws(
    () => context(request(message, []), messages),
    ContextLimitError,
  );
  assert.equal(JSON.stringify(messages), original);
});

test("the serialized text guard accounts for escaping inside fixed system context", () => {
  const req: AgentRequest = {
    runId: "fixture",
    capability: "fixture",
    message: "hello",
    history: [],
    memories: [],
    systemInstructions: "\n".repeat(60000),
  };
  assert.throws(
    () => context(req, [user(req.message)]),
    (error: unknown) =>
      error instanceof ContextLimitError &&
      error.sizes.fixedSize! < contextHardLimit &&
      error.sizes.serializedSize! >= contextHardLimit,
  );
});

test("extractive archive stays bounded, keeps original IDs and exact excerpts, and is historical data", () => {
  const originals = Array.from({ length: 20 }, (_, index) => ({
    id: `message-${index}`,
    ordinal: index,
    message: answer(`Original statement ${index}: ` + "text ".repeat(500)),
  }));
  const before = JSON.stringify(originals);
  const summary = extractiveConversationSummary(originals, 7000);
  assert.ok(summary.length <= 7000);
  const parsed = JSON.parse(summary);
  assert.ok(parsed.omittedEntries > 0);
  assert.match(parsed.notice, /Historical source text/);
  assert.equal(parsed.entries.at(-1).messageId, "message-19");
  for (const entry of parsed.entries) {
    const source = originals[entry.ordinal]!.message.content!;
    for (const excerpt of entry.excerpts)
      assert.equal(
        source.slice(excerpt.offset, excerpt.offset + excerpt.text.length),
        excerpt.text,
      );
  }
  const req = request("What changed?", []);
  const beforeSize = context(req, [user(req.message)]).fixedSize;
  req.conversationSummary = summary;
  const input = context(req, [user(req.message)]);
  assert.equal(input.fixedSize, beforeSize + summary.length);
  assert.match(
    String(input.messages[0]!.content),
    /Conversation archive \(historical data\)/,
  );
  assert.equal(JSON.stringify(originals), before);
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
