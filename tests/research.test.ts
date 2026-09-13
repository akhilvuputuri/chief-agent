import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { ensureUser, type Database } from "../src/db.js";
import { type ModelAdapter } from "../src/model.js";
import { spending, Spending } from "../src/spending.js";
import { Execution, recoverRuntime } from "../src/execution.js";
import { scrubTrace } from "../src/trace-scrub.js";
const text = (content: string) => ({
  message: { role: "assistant" as const, content },
});
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
const assignment = {
  objective: "Find the product's supported platform",
  context: "",
  jobIds: [],
  urls: ["https://example.com/product"],
};
const report = (sourceId: string) => ({
  targets: [
    {
      targetId: assignment.urls[0],
      status: "complete",
      summary: "Linux is supported.",
      evidence: [{ sourceId, quote: "Supports Linux" }],
    },
  ],
});
function child(input: Parameters<ModelAdapter["generate"]>[0]) {
  return String(input.messages[0]?.content).includes(
    "read-only research specialist",
  );
}
function observation(input: Parameters<ModelAdapter["generate"]>[0]) {
  return JSON.parse(
    String(input.messages.findLast((m) => m.role === "tool")?.content),
  );
}
async function fixture(model: ModelAdapter, models = 40) {
  const pg = new PGlite();
  for (const file of [
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
      await readFile(new URL(`../db/${file}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  const assistant = new Assistant(
    db,
    new CustomAgent(model),
    new JobTools(db, {
      call: async () => ({
        content: "Supports Linux. " + "Detailed source text. ".repeat(1000),
      }),
    }),
    { web: true },
    { ms: 900000, models, tools: 100 },
  );
  return { pg, db, assistant };
}
test("research isolates context, returns sourced targets and correlates traces/cost without duplicate charges", async () => {
  let parentCalls = 0,
    childCalls = 0;
  const f = await fixture({
    model: "test-model",
    generate: async (input) => {
      const ledger = spending.getStore()!,
        charge = await ledger.begin("mock", 0.02);
      await ledger.settle(charge, { cost: 0.01 });
      if (child(input)) {
        childCalls++;
        assert(!JSON.stringify(input.messages).includes("PRIVATE PROFILE"));
        assert.deepEqual(input.tools.map((t) => t.name).sort(), [
          "finish_turn",
          "research_report",
          "skill_read",
          "source_read",
          "web_read",
          "web_search",
        ]);
        if (childCalls === 1)
          return call("web_read", { url: assignment.urls[0] });
        return call(
          "research_report",
          report(observation(input).result.sourceId),
        );
      }
      if (++parentCalls === 1) return call("research_delegate", assignment);
      const o = observation(input).result;
      assert.equal(o.status, "reported");
      assert.equal(o.targets[0].status, "complete");
      assert(!JSON.stringify(input.messages).includes("Detailed source text."));
      assert.equal(Number((await ledger.summary()).reported_usd), 0.04);
      return text("The source says Linux is supported.");
    },
  });
  try {
    await ensureUser(f.db, "owner");
    await f.db.query(
      "INSERT INTO memories(user_id,key,value) VALUES('owner','profile','PRIVATE PROFILE')",
    );
    assert.equal(
      await f.assistant.respond("owner", "Research the supported platform"),
      "The source says Linux is supported.",
    );
    const links = (
      await f.db.query(
        "SELECT * FROM events WHERE type='research.child_started'",
      )
    ).rows;
    assert.equal(links.length, 1);
    const parentId = links[0].data.parentRunId,
      childId = links[0].run_id;
    const runs = (
      await f.db.query("SELECT * FROM runtime_runs ORDER BY started_at")
    ).rows;
    assert.equal(runs[0].used_models, 4);
    assert.equal(runs[1].used_models, 2);
    assert.equal(runs[1].task_id, null);
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='research.model_input' AND run_id=$1",
          [childId],
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='tool.linked'",
        )
      ).rows[0].n,
      3,
    );
    assert.equal(
      Number(
        (await new Spending(f.db, "owner", parentId).summary()).reported_usd,
      ),
      0.04,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM provider_charges")).rows[0]
        .n,
      4,
    );
  } finally {
    await f.pg.close();
  }
});
test("simple requests remain direct and another owner's saved target cannot be delegated", async () => {
  let n = 0;
  const foreign = randomUUID();
  const f = await fixture({
    generate: async (input) => {
      assert(!child(input));
      if (++n === 1) return text("Hello");
      if (n === 2)
        return call("research_delegate", {
          ...assignment,
          urls: [],
          jobIds: [foreign],
        });
      assert.equal(observation(input).error.code, "VALIDATION_FAILED");
      return text("That saved target is unavailable.");
    },
  });
  try {
    await ensureUser(f.db, "other");
    await f.db.query(
      "INSERT INTO jobs(id,user_id,title,company) VALUES($1,'other','Engineer','Example')",
      [foreign],
    );
    assert.equal(await f.assistant.respond("owner", "Hello"), "Hello");
    await f.assistant.respond("owner", "Research a role");
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='research.child_started'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await f.pg.close();
  }
});
test("specialist rejects writes, recursive delegation, unassigned targets and invented source quotes then repairs", async () => {
  let p = 0,
    c = 0,
    source = "";
  const f = await fixture({
    generate: async (input) => {
      if (!child(input))
        return ++p === 1
          ? call("research_delegate", assignment)
          : text("Research received.");
      c++;
      if (c === 1) return call("memory_set", { key: "bad", value: "bad" });
      if (c === 2) {
        assert(observation(input).error);
        return call("research_delegate", assignment);
      }
      if (c === 3) {
        assert(observation(input).error);
        return call("web_read", { url: assignment.urls[0] });
      }
      if (c === 4) {
        source = observation(input).result.sourceId;
        return call("research_report", {
          targets: [{ ...report(source).targets[0], targetId: "invented" }],
        });
      }
      if (c === 5) {
        assert.equal(observation(input).error.code, "VALIDATION_FAILED");
        return call("research_report", {
          targets: [
            {
              ...report(source).targets[0],
              evidence: [
                { sourceId: source, quote: "Supports imaginary platform" },
              ],
            },
          ],
        });
      }
      assert.equal(observation(input).error.code, "VALIDATION_FAILED");
      return call("research_report", report(source));
    },
  });
  try {
    await f.assistant.respond("owner", "Research it");
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM memories")).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM runtime_calls WHERE state='uncertain'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='research.child_started'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});
test("child model calls consume the parent's allocation and incomplete results are persisted", async () => {
  let count = 0;
  const f = await fixture(
    {
      generate: async (input) => {
        count++;
        return child(input)
          ? call("web_read", { url: assignment.urls[0] })
          : call("research_delegate", assignment);
      },
    },
    2,
  );
  try {
    await f.assistant.respond("owner", "Research it");
    assert.equal(count, 2);
    const result = (
      await f.db.query(
        "SELECT result FROM runtime_calls WHERE operation='research_delegate'",
      )
    ).rows[0].result;
    assert.equal(result.status, "incomplete");
    assert.equal(result.stopReason, "budget_exhausted");
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM runtime_runs WHERE stop_reason='budget_exhausted'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await f.pg.close();
  }
});
test("cancelling the parent aborts the in-flight child and prevents tool dispatch", async () => {
  let announce!: () => void;
  const started = new Promise<void>((r) => (announce = r));
  const f = await fixture({
    generate: async (input) => {
      if (!child(input)) return call("research_delegate", assignment);
      announce();
      return await new Promise((_, reject) =>
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    },
  });
  try {
    const pending = f.assistant.respond("owner", "Research it");
    await started;
    await f.assistant.cancel("owner");
    await pending;
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM runtime_calls WHERE operation='web_read'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM runtime_runs WHERE stop_reason='cancelled'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await f.pg.close();
  }
});
test("restart does not replay delegated reads; trace scrubbing preserves non-secret content", async () => {
  const f = await fixture({ generate: async () => text("unused") });
  try {
    await ensureUser(f.db, "owner");
    const controller = new AbortController();
    const root = new Execution(f.db, "owner", randomUUID(), controller.signal);
    await root.start();
    await root.beginCall("call", "research_delegate", assignment);
    const sub = new Execution(
      f.db,
      "owner",
      randomUUID(),
      controller.signal,
      undefined,
      root,
    );
    await sub.start();
    await sub.beginCall("read", "web_read", { url: assignment.urls[0] });
    await recoverRuntime(f.db);
    assert(
      (await f.db.query("SELECT state FROM runtime_calls")).rows.every(
        (r) => r.state === "interrupted",
      ),
    );
    assert(
      (await f.db.query("SELECT state FROM runtime_runs")).rows.every(
        (r) => r.state === "stopped",
      ),
    );
    assert.deepEqual(
      scrubTrace({ api_key: "secret", text: "Bearer abcdef", normal: "Linux" }),
      {
        api_key: "[REDACTED_CREDENTIAL]",
        text: "Bearer [REDACTED_CREDENTIAL]",
        normal: "Linux",
      },
    );
  } finally {
    await f.pg.close();
  }
});
