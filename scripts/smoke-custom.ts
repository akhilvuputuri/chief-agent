import "dotenv/config";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { OpenRouter } from "../src/model.js";
import { JobTools } from "../src/tools.js";
import type { Database } from "../src/db.js";
import assert from "node:assert/strict";
if (!process.env.OPENROUTER_API_KEY)
  throw new Error("Set OPENROUTER_API_KEY privately");
const pg = new PGlite();
try {
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "008_costs",
  ])
    await pg.exec(
      await readFile(new URL("../db/" + f + ".sql", import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  const agent = new Assistant(
    db,
    new CustomAgent(new OpenRouter(process.env.OPENROUTER_API_KEY)),
    new JobTools(db, {
      call: async () => {
        throw new Error("Web disabled in smoke test");
      },
    }),
    {},
    { ms: 120000, models: 6, tools: 8 },
  );
  const reply = await agent.respond(
    "synthetic-smoke",
    "Please remember my explicitly stated preference: concise replies. Save it using memory_set, then check memory_list and confirm briefly.",
  );
  const memories = (await db.query("SELECT key,value FROM memories")).rows;
  assert.ok(memories.length > 0);
  const operations = (
    await db.query(
      "SELECT operation,state FROM runtime_calls ORDER BY started_at",
    )
  ).rows;
  assert.ok(
    operations.some(
      (x) => x.operation === "memory_set" && x.state === "success",
    ),
  );
  assert.ok(
    operations.some(
      (x) => x.operation === "memory_list" && x.state === "success",
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      reply,
      operations,
      runs: (
        await db.query(
          "SELECT model,stop_reason,used_models,used_tools FROM runtime_runs",
        )
      ).rows,
      usage: (
        await db.query("SELECT data FROM events WHERE type='model.completed'")
      ).rows,
    }),
  );
} finally {
  await pg.close();
}
