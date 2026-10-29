import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedPGlite } from "./helpers/pglite.js";
import { randomUUID } from "node:crypto";
import { HistoryStore } from "../src/history.js";
import { projectObservation } from "../src/observations.js";
import { conversationState } from "../src/conversation-state.js";
import { ensureUser, type Database } from "../src/db.js";
import type { Message } from "../src/model.js";

test("conversation state builds the exchange index from stored rows with observation IDs", async () => {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  try {
    await ensureUser(db, "owner");
    const history = new HistoryStore(db);
    let count = 0;
    const run = async (messages: Message[]) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'owner','stopped')",
        [id],
      );
      await history.append("owner", null, count, messages, id);
      count += messages.length;
      return id;
    };
    const observation = randomUUID();
    await run([
      { role: "user", content: "any wedding invites?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "gmail_search", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: JSON.stringify(
          projectObservation(
            "gmail_search",
            { receiptId: "r-1", result: ["invite"] },
            observation,
          ),
        ),
      },
      { role: "assistant", content: "Two invites." },
    ]);
    // A background job's delivery is appended by a different run.
    await run([
      { role: "assistant", content: "Your laptop comparison is ready." },
    ]);
    await run([
      { role: "user", content: "thanks" },
      { role: "assistant", content: "Welcome." },
    ]);
    const { summary } = await conversationState(db, "owner");
    const lines = summary.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[1]!, /you: "any wedding invites\?" → "Two invites\."/);
    assert.ok(lines[1]!.includes(`gmail_search obs=${observation}`));
    assert.match(
      lines[2]!,
      /background update → "Your laptop comparison is ready\."/,
    );
    assert.doesNotMatch(summary, /thanks|Welcome/);
  } finally {
    await pg.close();
  }
});

test("the latest answer for feedback skips the saved-details pointer; the prompt's reply does not", async () => {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  try {
    await ensureUser(db, "owner");
    const history = new HistoryStore(db);
    const id = randomUUID();
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'owner','stopped')",
      [id],
    );
    await history.append(
      "owner",
      null,
      0,
      [
        { role: "user", content: "rain later?" },
        { role: "assistant", content: "No rain expected; 31°C." },
        { role: "assistant", content: "[Saved answer details: sources]" },
      ],
      id,
    );
    await db.query(
      "INSERT INTO conversation_contexts(user_id,run_id) VALUES('owner',$1)",
      [id],
    );
    const state = await conversationState(db, "owner");
    assert.equal(
      state.lastExchangeHere?.reply,
      "[Saved answer details: sources]",
    );
    assert.equal(state.lastAnswerHere, "No rain expected; 31°C.");
  } finally {
    await pg.close();
  }
});
