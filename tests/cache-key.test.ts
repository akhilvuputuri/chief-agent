import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import type { Database } from "../src/db.js";

test("an owner's messages share one provider cache key while runs keep their own session", async () => {
  const pg = new PGlite();
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "008_costs",
    "012_message_storage",
    "013_conversation_control",
    "014_checkpoint_steering",
  ])
    await pg.exec(
      await readFile(new URL("../db/" + f + ".sql", import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  const seen: Array<{ sessionId?: string; cacheKey?: string }> = [];
  const assistant = new Assistant(
    db,
    new CustomAgent({
      generate: async (input) => {
        seen.push({ sessionId: input.sessionId, cacheKey: input.cacheKey });
        return { message: { role: "assistant", content: "ok" } };
      },
    }),
    new JobTools(db, { call: async () => ({ content: "" }) }),
    { web: true },
    { ms: 900000, models: 40, tools: 100 },
  );
  try {
    await assistant.respond("owner", "hello");
    await assistant.respond("owner", "again");
    await assistant.respond("someone-else", "hi");
    const [a, b, c] = seen;
    assert.match(a!.cacheKey!, /^chief-[0-9a-f]{16}$/);
    assert.equal(a!.cacheKey, b!.cacheKey);
    assert.notEqual(a!.sessionId, b!.sessionId);
    assert.notEqual(a!.cacheKey, c!.cacheKey);
    // The key is derived: the raw owner id is never sent. It is a pseudonym, not anonymous.
    assert.ok(!a!.cacheKey!.includes("owner"));
  } finally {
    await pg.close();
  }
});
