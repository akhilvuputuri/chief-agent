import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { ensureUser, type Database } from "../src/db.js";
import type { ModelAdapter } from "../src/model.js";
import { runtimeContext } from "../src/runtime.js";
import { runAgentType } from "../src/agents.js";
import { Execution } from "../src/execution.js";
import { PluginRegistry, readBundle, contentHash } from "../src/plugins.js";
import { resolveAgentModel, readModelPolicy } from "../src/model-policy.js";

const everything = {
  canvases: true,
  web: true,
  gmail: true,
  calendar: true,
  preparationSheet: true,
  dailySheet: true,
  library: true,
  libraryAccount: true,
  parcels: true,
  stocks: true,
  news: true,
};
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
const text = (content: string) => ({
  message: { role: "assistant" as const, content },
});
const lastTool = (input: Parameters<ModelAdapter["generate"]>[0]) =>
  JSON.parse(
    String(input.messages.findLast((m) => m.role === "tool")?.content),
  );
const system = (input: Parameters<ModelAdapter["generate"]>[0]) =>
  String(input.messages[0]?.content);

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

test("the coordinator is offered agent_run and a catalogue instead of domain tools", () => {
  const direct = runtimeContext(everything, null);
  const chief = runtimeContext(everything, null, undefined, undefined, true);
  const names = (r: { tools: { name: string }[] }) =>
    new Set(r.tools.map((t) => t.name));
  for (const op of [
    "gmail_search",
    "parcel_list",
    "calendar_draft",
    "watchlist_add",
    "news_status",
    "item_save",
    "web_search",
  ]) {
    assert(names(direct).has(op), op);
    assert(!names(chief).has(op), op);
  }
  for (const op of [
    "agent_run",
    "conversation_search",
    "observation_read",
    "work_start",
    "canvas_create",
    "job_alignment_start",
  ])
    assert(names(chief).has(op), op);
  // Agents still get every enabled definition.
  assert(chief.allTools!.some((t) => t.name === "gmail_search"));
  assert(
    JSON.stringify(chief.tools).length <
      JSON.stringify(direct.tools).length / 1.8,
  );
  const catalogue = JSON.parse(chief.context).agentCatalogue;
  assert.deepEqual(catalogue.map((a: { type: string }) => a.type).sort(), [
    "calendar",
    "daily",
    "email",
    "jobs",
    "library",
    "media",
    "news",
    "parcels",
    "research",
    "stocks",
    "web",
  ]);
  // A disconnected domain keeps nothing stranded: its agent leaves the catalogue.
  const noGmail = runtimeContext(
    { ...everything, gmail: false, parcels: false },
    null,
    undefined,
    undefined,
    true,
  );
  const types = JSON.parse(noGmail.context).agentCatalogue.map(
    (a: { type: string }) => a.type,
  );
  assert(!types.includes("email") && !types.includes("parcels"));
});

test("model tiers map to reviewed model IDs and fall back to the main model without a policy", () => {
  const policy = readModelPolicy();
  assert.equal(policy.agents?.default, "fast");
  assert.deepEqual(resolveAgentModel(undefined, "main/model", policy), {
    tier: "fast",
    model: "google/gemini-3.8-flash",
  });
  assert.deepEqual(resolveAgentModel("standard", "main/model", policy), {
    tier: "standard",
    model: "openai/gpt-6.1-sol",
  });
  assert.throws(
    () => resolveAgentModel("strong", "main/model", policy),
    /tier "strong" is not configured/,
  );
  assert.deepEqual(
    resolveAgentModel("strong", "main/model", {
      schemaVersion: 1,
      main: null,
    }),
    { tier: "strong", model: "main/model" },
  );
});

test("a domain agent runs on its tier and effort, writes under its own run, and its approval reaches the coordinator", async () => {
  const { pg, db } = await database();
  const job = randomUUID();
  const used: { model: string; effort: string; who: string }[] = [];
  let coordinatorCalls = 0,
    agentCalls = 0;
  const behaviour = async (
    model: string,
    input: Parameters<ModelAdapter["generate"]>[0],
  ) => {
    const agent = system(input).includes("You are the jobs agent");
    used.push({
      model,
      effort: input.reasoning,
      who: agent ? "agent" : "chief",
    });
    if (agent) {
      agentCalls++;
      assert.match(String(input.messages[1]?.content), /Delete the Acme role/);
      assert.deepEqual(input.tools.map((t) => t.name).sort(), [
        "agent_report",
        "finish_turn",
        "job_analyze",
        "job_delete",
        "job_list",
        "job_save",
        "job_update",
        "source_read",
        "web_read",
      ]);
      if (agentCalls === 1) return call("gmail_search", { query: "acme" });
      if (agentCalls === 2) {
        // Tools outside the agent's definition are not even offered to it.
        assert.equal(lastTool(input).error.code, "NOT_FOUND_OR_UNAVAILABLE");
        return call("agent_run", { type: "email", objective: "nested" });
      }
      if (agentCalls === 3) {
        assert(lastTool(input).error);
        return call("job_delete", { id: job });
      }
      if (agentCalls === 4)
        return call("agent_report", {
          status: "complete",
          summary: "Deletion of the Acme role is waiting for approval.",
          findings: [],
          refs: ["11111111-1111-4111-8111-111111111111"],
        });
      if (agentCalls === 5) {
        assert.match(lastTool(input).error.message, /refs must be IDs/);
        return call("agent_report", {
          status: "complete",
          summary: "Deletion of the Acme role is waiting for approval.",
          findings: [
            { text: "Acme Engineer role", observationId: randomUUID() },
          ],
          refs: [job],
        });
      }
      if (agentCalls === 6) {
        assert.match(lastTool(input).error.message, /own calls/);
        return call("agent_report", {
          status: "complete",
          summary: "Deletion of the Acme role is waiting for approval.",
          findings: [],
          refs: [job],
        });
      }
      return text("done");
    }
    if (++coordinatorCalls === 1)
      return call("agent_run", {
        type: "jobs",
        objective: "Delete the Acme role",
        context: `Role id ${job}`,
        model: "standard",
        effort: "high",
      });
    const result = lastTool(input).result;
    assert.equal(result.status, "complete");
    assert.deepEqual(result.refs, [job]);
    assert.equal(result.approvals[0].operation, "job_delete");
    assert.deepEqual(result.model, {
      tier: "standard",
      id: "openai/gpt-6.1-sol",
    });
    assert.equal(result.effort, "high");
    return text("Deleting the Acme role needs your approval.");
  };
  const errors: unknown[] = [];
  const traced = async (
    model: string,
    input: Parameters<ModelAdapter["generate"]>[0],
  ) => {
    try {
      return await behaviour(model, input);
    } catch (error) {
      errors.push(error);
      throw error;
    }
  };
  const main: ModelAdapter = {
    model: "main/model",
    generate: (input) => traced("main/model", input),
  };
  const assistant = new Assistant(
    db,
    new CustomAgent(main, {}, (id) => ({
      model: id,
      generate: (input) => traced(id, input),
    })),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
  );
  try {
    await db.query(
      "INSERT INTO jobs(id,user_id,title,company) VALUES($1,'owner','Engineer','Acme')",
      [job],
    );
    const response = await assistant.respondDetailed(
      "owner",
      "please delete the acme role",
    );
    assert.deepEqual(errors, []);
    assert.match(response.reply, /needs your approval/);
    assert.match(String(response.notices), /Approval required/);
    assert.equal(
      (
        await db.query(
          "SELECT stop_reason FROM runtime_runs r WHERE NOT EXISTS(SELECT 1 FROM events e WHERE e.run_id=r.id AND e.type='agent.child_started')",
        )
      ).rows[0].stop_reason,
      "awaiting_approval",
    );
    // The approval belongs to the agent's run, which the host linked to Chief's run.
    const approval = (
      await db.query(
        "SELECT a.run_id,e.data->>'parentRunId' AS parent FROM approvals a JOIN events e ON e.run_id=a.run_id AND e.type='agent.child_started'",
      )
    ).rows[0];
    assert(approval.parent);
    assert.notEqual(approval.run_id, approval.parent);
    assert.deepEqual(
      used.filter((u) => u.who === "agent").map((u) => [u.model, u.effort])[0],
      ["openai/gpt-6.1-sol", "high"],
    );
    assert(
      used
        .filter((u) => u.who === "chief")
        .every((u) => u.model === "main/model"),
    );
    // Nothing was deleted: the delete waits for the owner.
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM jobs")).rows[0].n,
      1,
    );
    const started = (
      await db.query("SELECT data FROM events WHERE type='agent.child_started'")
    ).rows[0].data;
    assert.equal(started.agentId, "core/jobs");
    assert.equal(started.model.tier, "standard");
  } finally {
    await pg.close();
  }
});

test("the host refuses an agent call outside the tools it recorded for that child", async () => {
  const { pg, db } = await database();
  const job = randomUUID();
  let agentCalls = 0,
    childRun = "";
  let refusal = "";
  const assistant = new Assistant(
    db,
    new CustomAgent({
      generate: async (input) => {
        if (system(input).includes("You are the jobs agent")) {
          agentCalls++;
          if (agentCalls === 1) return call("job_list", {});
          return call("agent_report", {
            status: "complete",
            summary: "Listed roles.",
            findings: [],
            refs: [job],
          });
        }
        if (!childRun)
          return call("agent_run", { type: "jobs", objective: "List roles" });
        return text("Listed.");
      },
    }),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
  );
  try {
    await db.query(
      "INSERT INTO jobs(id,user_id,title,company) VALUES($1,'owner','Engineer','Acme')",
      [job],
    );
    // Capture the executeAgent the host builds for this turn and try it with a foreign tool.
    const original = (assistant as any).agent.run.bind(
      (assistant as any).agent,
    );
    (assistant as any).agent.run = async (req: any) => {
      if (req.executeAgent && !req.specialist) {
        const execute = req.executeAgent;
        req.executeAgent = async (run: string, input: any) => {
          childRun = run;
          try {
            await execute(run, { operation: "gmail_search", query: "x" });
          } catch (error) {
            refusal = String(error);
          }
          return execute(run, input);
        };
      }
      return original(req);
    };
    await assistant.respond("owner", "list my roles");
    assert(childRun);
    assert.match(refusal, /unavailable to this agent/);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM runtime_calls WHERE operation='gmail_search'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await pg.close();
  }
});

test("a new plugin agent is usable through agent_run from registry configuration alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "agents-test-"));
  const { pg, db } = await database();
  try {
    const dir = join(root, "notes");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        format: "companion.plugin/v1",
        id: "notes",
        version: "1.0.0",
        description: "Summarises the owner's saved roles.",
        agents: [
          {
            id: "summariser",
            description: "Summarise saved notes.",
            instructions: "agents/summariser.md",
            contract: "findings/v1",
            tools: ["job_list"],
            skills: [],
            limits: { ms: 30000, models: 3, tools: 3 },
            model: "fast",
            effort: "low",
          },
        ],
        skills: [],
      }),
    );
    writeFileSync(
      join(dir, "agents/summariser.md"),
      "You are the notes summariser. List notes and summarise them.",
    );
    const hash = contentHash(readBundle(dir));
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        format: "companion.plugin-registry/v1",
        researchAgent: null,
        aliases: { notes: "notes/summariser" },
        enabled: [
          {
            path: "notes",
            sha256: hash,
            agents: ["summariser"],
            allowTools: ["job_list"],
          },
        ],
      }),
    );
    const registry = new PluginRegistry(root);
    const catalogue = registry.agentCatalogue(new Set(["job_list"]));
    assert.deepEqual(
      catalogue.map((a) => a.type),
      ["notes"],
    );
    await db.query(
      "INSERT INTO jobs(id,user_id,title,company) VALUES(gen_random_uuid(),'owner','Milk buyer','Acme')",
    );
    const signal = new AbortController().signal,
      runId = randomUUID();
    const execution = new Execution(db, "owner", runId, signal);
    await execution.start();
    await db.query(
      "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'owner','x',false)",
      [runId],
    );
    const tools = new JobTools(db, { call: async () => ({}) });
    let calls = 0;
    const result: any = await runAgentType(
      {
        runId,
        capability: "",
        execution,
        signal,
        history: [],
        memories: [],
        message: "Summarise my notes",
        runtime: runtimeContext({ web: true }, null),
        executeAgent: (run, input) => tools.execute("owner", run, input as any),
      },
      { operation: "agent_run", type: "notes", objective: "Summarise notes" },
      (req) =>
        new CustomAgent({
          generate: async (input) => {
            assert.equal(input.reasoning, "low");
            if (++calls === 1) return call("job_list", {});
            assert.match(JSON.stringify(lastTool(input)), /Milk buyer/);
            return call("agent_report", {
              status: "complete",
              summary: "One role: milk buyer at Acme.",
              findings: [{ text: "Milk buyer at Acme" }],
              refs: [],
            });
          },
        }).run(req),
      "main/model",
      registry,
    );
    assert.equal(result.agentId, "notes/summariser");
    assert.equal(result.status, "complete");
    assert.equal(result.summary, "One role: milk buyer at Acme.");
    // No grant can give an agent a coordinator tool such as memory_set.
    const manifest = JSON.parse(
      await readFile(join(dir, "plugin.json"), "utf8"),
    );
    manifest.agents[0].tools = ["job_list", "memory_set"];
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        format: "companion.plugin-registry/v1",
        researchAgent: null,
        enabled: [
          {
            path: "notes",
            sha256: contentHash(readBundle(dir)),
            agents: ["summariser"],
            allowTools: ["job_list", "memory_set"],
          },
        ],
      }),
    );
    assert.throws(
      () => new PluginRegistry(root),
      /no agent can have: memory_set/,
    );
  } finally {
    await pg.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent inherits its parent's lane, so a background job's agent cannot change routines", async () => {
  const { pg, db } = await database();
  try {
    const tools = new JobTools(db, { call: async () => ({}) });
    const attempt = async (background: boolean | null) => {
      const signal = new AbortController().signal,
        runId = randomUUID();
      const execution = new Execution(db, "owner", runId, signal);
      await execution.start();
      if (background !== null)
        await db.query(
          "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'owner','x',$2)",
          [runId, background],
        );
      let refusal = "";
      let calls = 0;
      await runAgentType(
        {
          runId,
          capability: "",
          execution,
          signal,
          history: [],
          memories: [],
          message: "set up a routine",
          runtime: runtimeContext(everything, null, undefined, undefined, true),
          executeAgent: (run, input) =>
            tools.execute("owner", run, input as any),
        },
        {
          operation: "agent_run",
          type: "daily",
          objective: "Create a daily 8am news routine",
        },
        (req) =>
          new CustomAgent({
            generate: async (input) => {
              if (++calls === 1)
                return call("routine_create", {
                  name: "News",
                  instruction: "Summarise the news",
                  schedule: "every day at 8am",
                });
              refusal = JSON.stringify(lastTool(input));
              return call("agent_report", {
                status: "blocked",
                summary: "Could not create the routine.",
                findings: [],
                refs: [],
              });
            },
          }).run(req),
        "main/model",
      );
      return refusal;
    };
    assert.match(
      await attempt(true),
      /Only a foreground user request may change routines/,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM work_turns WHERE background AND request='Create a daily 8am news routine'",
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(attempt(null), /coordinator's turn is not recorded/);
  } finally {
    await pg.close();
  }
});

test("a brief naming more targets than a contract allows is refused, never silently cut", async () => {
  const { pg, db } = await database();
  try {
    const signal = new AbortController().signal,
      runId = randomUUID();
    const execution = new Execution(db, "owner", runId, signal);
    await execution.start();
    const links = Array.from(
      { length: 7 },
      (_, i) => `https://example.com/page-${i}`,
    ).join(" ");
    let childStarted = false;
    await assert.rejects(
      runAgentType(
        {
          runId,
          capability: "",
          execution,
          signal,
          history: [],
          memories: [],
          message: "research these",
          runtime: runtimeContext({ web: true }, null),
          executeResearch: async () => ({}),
        },
        {
          operation: "agent_run",
          type: "research",
          objective: "Compare these pages",
          context: links,
        },
        async () => {
          childStarted = true;
          throw new Error("unexpected child");
        },
        "main/model",
      ),
      /at most six|too_big|at most 6/i,
    );
    assert.equal(childStarted, false);
  } finally {
    await pg.close();
  }
});
