import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { HistoryStore } from "../src/history.js";
import { projectObservation } from "../src/observations.js";
import { conversationState } from "../src/conversation-state.js";
import { ensureUser, type Database } from "../src/db.js";
import type { Message } from "../src/model.js";

test("conversation state builds the exchange index from stored rows with observation IDs", async () => {
  const pg = new PGlite();
  const dir = new URL("../db/", import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
    await pg.exec(await readFile(new URL(f, dir), "utf8"));
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
