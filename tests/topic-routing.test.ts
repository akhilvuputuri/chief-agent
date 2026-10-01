import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Assistant, topicFirstCall } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { ensureUser, type Database } from "../src/db.js";
import type { ModelAdapter } from "../src/model.js";

const catalogue = JSON.stringify({
  agentCatalogue: [{ type: "email", description: "Email" }],
});

async function database() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  return { pg, db };
}

test("only an ordinary message typed in the Email topic starts with the email agent", () => {
  const call = topicFirstCall(
    "email",
    "any reply from the landlord?",
    false,
    false,
    catalogue,
    { user: "check my inbox", assistant: "Two new messages." },
  )!;
  assert.equal(call.name, "agent_run");
  assert.equal(call.reason, "topic.email");
  const args = JSON.parse(call.arguments);
  assert.equal(args.type, "email");
  assert.equal(args.objective, "any reply from the landlord?");
  assert.match(args.context, /Email|email/);
  assert.match(args.context, /Two new messages/);
  // Everything else takes Chief's ordinary path.
  for (const [topic, message, images, background, context] of [
    [undefined, "hi", false, false, catalogue],
    ["news", "what's this story about?", false, false, catalogue],
    ["markets", "how is TSLA doing?", false, false, catalogue],
    ["email", "x".repeat(2001), false, false, catalogue],
    ["email", "read this screenshot", true, false, catalogue],
    ["email", "continue", false, true, catalogue],
    ["email", "hi", false, false, JSON.stringify({ agentCatalogue: [] })],
    ["email", "hi", false, false, "not json"],
  ] as const)
    assert.equal(
      topicFirstCall(topic, message, images, background, context),
      undefined,
      `${topic}: ${message.slice(0, 20)}`,
    );
});

test("a message in the Email topic skips the coordinator's routing call and keeps one conversation", async () => {
  const { pg, db } = await database();
  const seen: string[] = [];
  let chiefCalls = 0;
  const generate: ModelAdapter["generate"] = async (input) => {
    const system = String(input.messages[0]?.content);
    if (system.includes("You are the email agent")) {
      seen.push("agent");
      // The brief is the owner's own words, with the topic and previous exchange as context.
      assert.match(
        JSON.stringify(input.messages),
        /any reply from the landlord/,
      );
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "r1",
              type: "function",
              function: {
                name: "agent_report",
                arguments: JSON.stringify({
                  status: "complete",
                  summary: "No reply from the landlord yet.",
                  findings: [],
                  refs: [],
                }),
              },
            },
          ],
        },
      };
    }
    chiefCalls++;
    seen.push("chief");
    if (JSON.stringify(input.messages).includes(`"thanks"`))
      return { message: { role: "assistant", content: "You're welcome." } };
    // Chief's first call already sees the email agent's report.
    const last = input.messages.findLast((m) => m.role === "tool");
    assert.match(String(last?.content), /No reply from the landlord yet/);
    assert.match(String(input.messages[0]?.content), /topic/);
    return {
      message: { role: "assistant", content: "No reply from them yet." },
    };
  };
  const assistant = new Assistant(
    db,
    new CustomAgent({ model: "main/model", generate }, {}, (id) => ({
      model: id,
      generate,
    })),
    new JobTools(db, { call: async () => ({}) }),
    { gmail: true },
  );
  try {
    const id = await assistant.recordInput(
      "owner",
      "any reply from the landlord?",
      {
        topic: "email",
      },
    );
    const reply = await assistant.respondDetailed(
      "owner",
      "any reply from the landlord?",
      undefined,
      undefined,
      { id },
    );
    assert.equal(reply.reply, "No reply from them yet.");
    assert.deepEqual(seen, ["agent", "chief"]);
    assert.equal(chiefCalls, 1, "one Chief call: the reply");
    const calls = (
      await db.query(
        "SELECT c.operation,c.state FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.id NOT IN (SELECT run_id FROM events WHERE type='agent.child_started')",
      )
    ).rows;
    assert.deepEqual(calls, [{ operation: "agent_run", state: "success" }]);
    const first = (
      await db.query("SELECT data FROM events WHERE type='route.first_call'")
    ).rows;
    assert.equal(first.length, 1);
    assert.equal(first[0].data.reason, "topic.email");

    // A message in General takes the ordinary path: Chief decides the first step.
    seen.length = 0;
    const general = await assistant.respondDetailed("owner", "thanks");
    assert.equal(general.reply, "You're welcome.");
    assert.deepEqual(seen, ["chief"]);
  } finally {
    await pg.close();
  }
});
