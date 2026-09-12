import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { contextBudget } from "../src/context.js";
import type { Database } from "../src/db.js";
import type { ModelAdapter } from "../src/model.js";
const call = (name: string, args: unknown) => ({
  message: {
    role: "assistant" as const,
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
test("an over-budget turn keeps its own tool results, records the condition and still answers", async () => {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner')");
  // A message near the 20,000-character turn limit pushes the fixed part past the allowance on its own.
  const message = "Summarise this document: " + "lorem ipsum ".repeat(1655);
  const inputs: any[] = [];
  const model: ModelAdapter = {
    generate: async (input) => {
      inputs.push(input);
      const tools = input.messages.filter((m: any) => m.role === "tool");
      if (!tools.length) return call("job_list", {});
      const last = tools.at(-1)!;
      assert.match(String(last.content), /result/);
      return {
        message: {
          role: "assistant",
          content: `Answered after ${tools.length} tool result(s).`,
        },
      };
    },
  };
  const assistant = new Assistant(
    db,
    new CustomAgent(model),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
  );
  try {
    await assistant.respond("owner", "earlier turn");
    inputs.length = 0;
    const reply = await assistant.respond("owner", message);
    assert.equal(reply, "Answered after 1 tool result(s).");
    assert.equal(inputs.length, 2);
    const second = inputs[1]!.messages.map((m: any) => m.role);
    // Prior history is gone, but the current user message and this turn's tool group are present, in order.
    assert.deepEqual(second, ["system", "user", "assistant", "tool", "system"]);
    assert.equal(inputs[1]!.messages[1].content, message);
    const events = (
      await db.query(
        "SELECT data FROM events WHERE type='context.over_budget' ORDER BY id",
      )
    ).rows as any[];
    assert.equal(events.length, 2);
    assert.ok(events[0].data.fixedSize > contextBudget);
    assert.equal(events[0].data.budget, contextBudget);
    assert.ok(events[1].data.currentTurnSize > 0);
    assert.equal(
      (
        await db.query(
          "SELECT stop_reason FROM runtime_runs ORDER BY started_at DESC LIMIT 1",
        )
      ).rows[0]!.stop_reason,
      "answer",
    );
  } finally {
    await pg.close();
  }
});
