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
import { runAgentType, latestObservations } from "../src/agents.js";
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
    model: "anthropic/claude-opus-5.5",
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
      id: "anthropic/claude-opus-5.5",
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
      ["anthropic/claude-opus-5.5", "high"],
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
test("a delegated agent's refused write blocks the coordinator from delegating again in that turn", async () => {
  // Devin, PR 249: a child's WRITE_BLOCKED did not reach the coordinator, which could re-delegate the same write.
  const { pg, db } = await database();
  const job = randomUUID();
  let coordinatorCalls = 0,
    agentCalls = 0;
  const behaviour = async (input: Parameters<ModelAdapter["generate"]>[0]) => {
    if (system(input).includes("You are the jobs agent")) {
      agentCalls++;
      if (agentCalls === 1) return call("job_delete", { id: job });
      if (agentCalls === 2) {
        assert.equal(lastTool(input).error.code, "WRITE_BLOCKED");
        return call("agent_report", {
          status: "blocked",
          summary: "The delete was refused: an earlier write needs inspection.",
          findings: [],
          refs: [],
        });
      }
      return text("done");
    }
    coordinatorCalls++;
    if (coordinatorCalls === 1)
      return call("agent_run", {
        type: "jobs",
        objective: "Delete the Acme role",
        context: `Role id ${job}`,
      });
    if (coordinatorCalls === 2) {
      assert.equal(lastTool(input).result.writesBlocked, true);
      return call("agent_run", {
        type: "jobs",
        objective: "Try deleting the Acme role again",
        context: `Role id ${job}`,
      });
    }
    if (coordinatorCalls === 3) {
      assert.equal(lastTool(input).error.code, "WRITE_BLOCKED");
    }
    return text("A write is waiting on inspection, so I could not delete it.");
  };
  const main: ModelAdapter = { model: "main/model", generate: behaviour };
  const assistant = new Assistant(
    db,
    new CustomAgent(main, {}, (id) => ({ model: id, generate: behaviour })),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
  );
  try {
    await db.query(
      "INSERT INTO jobs(id,user_id,title,company) VALUES($1,'owner','Engineer','Acme')",
      [job],
    );
    const earlier = randomUUID();
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,state,stop_reason) VALUES($1,'owner','stopped','failed')",
      [earlier],
    );
    await db.query(
      `INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result)
       VALUES($1,$2,'c','memory_set','{}',true,'uncertain','{"error":{"code":"TOOL_FAILED"}}')`,
      [randomUUID(), earlier],
    );
    const response = await assistant.respondDetailed(
      "owner",
      "please delete the acme role",
    );
    assert.match(response.reply, /waiting on inspection/);
    assert.equal(agentCalls, 2);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM events WHERE type='agent.child_started'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM jobs")).rows[0].n,
      1,
    );
  } finally {
    await pg.close();
  }
});
test("if the child's write-block lookup fails, the coordinator treats the child as blocked", async () => {
  // Devin, PR 249: a failed lookup returned "not blocked" and permitted repeat delegations.
  const { pg, db } = await database();
  const original = Execution.prototype.writesBlockedIn;
  Execution.prototype.writesBlockedIn = async () => {
    throw new Error("lookup failed");
  };
  let coordinatorCalls = 0;
  const behaviour = async (input: Parameters<ModelAdapter["generate"]>[0]) => {
    if (system(input).includes("You are the jobs agent"))
      return call("agent_report", {
        status: "complete",
        summary: "Nothing to do.",
        findings: [],
        refs: [],
      });
    coordinatorCalls++;
    if (coordinatorCalls === 1)
      return call("agent_run", { type: "jobs", objective: "List roles" });
    if (coordinatorCalls === 2) {
      assert.equal(lastTool(input).result.writesBlocked, true);
      return call("agent_run", { type: "jobs", objective: "List roles again" });
    }
    if (coordinatorCalls === 3)
      assert.equal(lastTool(input).error.code, "WRITE_BLOCKED");
    return text("Done.");
  };
  const main: ModelAdapter = { model: "main/model", generate: behaviour };
  const assistant = new Assistant(
    db,
    new CustomAgent(main, {}, (id) => ({ model: id, generate: behaviour })),
    new JobTools(db, { call: async () => ({}) }),
    { web: true },
  );
  try {
    assert.equal(await assistant.respond("owner", "list my roles"), "Done.");
    assert.equal(coordinatorCalls, 3);
  } finally {
    Execution.prototype.writesBlockedIn = original;
    await pg.close();
  }
});

/** A web page whose numbers and typography models routinely copy imperfectly. */
const LIBRARY_PAGE =
  "Library record 1234567 (branch 042).\n  “Open   daily, 9am – 5pm.”\nThe branch is closed on public holidays and for stocktake in March.";

/** Runs the core web agent once under a coordinator; returns its agent_run result. */
async function runWebAgent(
  child: (
    n: number,
    input: Parameters<ModelAdapter["generate"]>[0],
  ) => ReturnType<typeof call> | ReturnType<typeof text>,
) {
  const { pg, db } = await database();
  let coordinator = 0,
    childCalls = 0,
    result: any;
  const errors: unknown[] = [];
  const main: ModelAdapter = {
    model: "main/model",
    generate: async (input) => {
      try {
        if (system(input).includes("You are the web lookup agent"))
          return child(++childCalls, input);
        if (++coordinator === 1)
          return call("agent_run", {
            type: "web",
            objective: "When is the branch open?",
          });
        result = lastTool(input).result;
        return text("Relayed.");
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  };
  const assistant = new Assistant(
    db,
    new CustomAgent(main),
    new JobTools(db, {
      call: async (operation: string) =>
        operation === "web_search"
          ? {
              results: [{ url: "https://example.com/library" }],
              // A short number that appears only as a key, never as a value.
              byRecord: { "5550001": "branch hours" },
            }
          : { content: LIBRARY_PAGE },
    }),
    { web: true },
  );
  try {
    await assistant.respondDetailed("owner", "when is the branch open?");
    assert.deepEqual(errors, []);
    return { result, childCalls, db, close: () => pg.close() };
  } catch (error) {
    await pg.close();
    throw error;
  }
}

test("a short numeric ref the agent saw and typographic or elided quotes pass; invented ones are named so one retry fixes them", async () => {
  let source = "";
  const run = await runWebAgent((n, input) => {
    if (n === 1)
      return call("web_read", { url: "https://example.com/library" });
    if (n === 2) {
      source = lastTool(input).result.sourceId;
      return call("agent_report", {
        status: "complete",
        summary: "Open daily 9am to 5pm.",
        findings: [
          // Straight quotes, a hyphen and single spaces for the page's curly quotes,
          // en dash and repeated spaces.
          {
            text: "Hours",
            sourceId: source,
            quote: '"Open daily, 9am - 5pm."',
          },
          {
            text: "Closures",
            sourceId: source,
            quote: "Open daily ... closed on public holidays",
          },
          {
            text: "Sundays",
            sourceId: source,
            quote: "Open on Sundays until midnight",
          },
        ],
        refs: ["1234567", "7654321", "123456", "12"],
      });
    }
    if (n === 3) {
      const error = lastTool(input).error;
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.equal(error.retryable, true);
      // Every failing item is named, with how to fix it; the passing ones are not.
      assert.match(error.message, /not recorded/);
      assert.match(
        error.message,
        /finding 3: .*"Open on Sundays until midnight" is not in source/,
      );
      assert.doesNotMatch(error.message, /finding [12]:/);
      assert.match(error.message, /refs must be IDs.*"7654321"/);
      // A prefix of a longer number is not the number the agent saw.
      assert.match(error.message, /"123456"/);
      assert.match(error.message, /"12" \(too short/);
      assert.doesNotMatch(error.message, /"1234567"/);
      return call("agent_report", {
        status: "complete",
        summary: "Open daily 9am to 5pm.",
        findings: [
          {
            text: "Hours",
            sourceId: source,
            quote: '"Open daily, 9am - 5pm."',
          },
          {
            text: "Closures",
            sourceId: source,
            quote: "Open daily … closed on public holidays",
          },
        ],
        refs: ["1234567", "042"],
      });
    }
    throw new Error("unexpected child call " + n);
  });
  try {
    assert.equal(run.childCalls, 3);
    assert.equal(run.result.status, "complete");
    assert.deepEqual(run.result.refs, ["1234567", "042"]);
    // What the coordinator receives is the page's own words.
    assert.equal(run.result.findings[0].quote, "“Open daily, 9am – 5pm.”");
    // The elided quote spans few words, so the coordinator gets them all.
    assert.equal(
      run.result.findings[1].quote,
      "Open daily, 9am – 5pm.” The branch is closed on public holidays",
    );
    assert.equal(run.result.findings[0].unsupported, undefined);
  } finally {
    await run.close();
  }
});

test("a web agent whose report was rejected and then ran out of calls returns the checked part as partial", async () => {
  let source = "";
  const run = await runWebAgent((n, input) => {
    if (n === 1)
      return call("web_read", { url: "https://example.com/library" });
    if (n === 2) {
      source = lastTool(input).result.sourceId;
      return call("agent_report", {
        status: "complete",
        summary: "Open daily 9am to 5pm, and Sundays until midnight.",
        findings: [
          { text: "Hours", sourceId: source, quote: "Open daily, 9am – 5pm." },
          {
            text: "Sundays",
            sourceId: source,
            quote: "Sundays until midnight",
          },
        ],
        refs: ["1234567", "9999999"],
      });
    }
    const notices = input.messages
      .map((m) => String(m.content))
      .filter((c) => c.startsWith("[Host notice]"));
    const last = String(notices.at(-1));
    if (n < 5) assert.equal(notices.length, 0);
    if (n === 5) assert.match(last, /one model call left after this one/);
    if (n === 6) {
      // The last call offers only the report tool, and says so.
      assert.deepEqual(
        input.tools.map((t) => t.name),
        ["agent_report"],
      );
      assert.match(last, /last model call/);
    }
    // The agent keeps searching instead of fixing its report.
    return call("web_search", { query: "branch hours " + n });
  });
  try {
    assert.equal(run.childCalls, 6);
    assert.equal(run.result.stopReason, "budget_exhausted");
    assert.equal(run.result.status, "partial");
    assert.match(run.result.partialReason, /failed host checks/);
    // Every failing item is listed, compactly.
    assert.match(run.result.partialReason, /finding 2 quote; refs "9999999"/);
    assert.equal(run.result.findings[0].quote, "Open daily, 9am – 5pm.");
    // The unverified quote is not passed on as a quote.
    assert.equal(run.result.findings[1].quote, undefined);
    assert.equal(run.result.findings[1].sourceId, undefined);
    // The kept text is marked as having lost its support.
    assert.deepEqual(run.result.findings[1].unsupported, ["quote"]);
    assert.equal(run.result.findings[0].unsupported, undefined);
    // The search asked for on the last call was refused, not run.
    const refused = (
      await run.db.query(
        "SELECT state,result FROM runtime_calls WHERE operation='web_search' ORDER BY started_at",
      )
    ).rows;
    assert.deepEqual(
      refused.map((r) => r.state),
      ["success", "success", "success", "failed"],
    );
    assert.match(
      refused[3].result.error.message,
      /last model call, so only agent_report runs/,
    );
    assert.deepEqual(run.result.refs, ["1234567"]);
    assert.equal(
      (
        await run.db.query(
          "SELECT count(*)::int n FROM events WHERE type='agent.budget_notice'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    await run.close();
  }
});

test("a web agent that never reports before its allocation ends returns its completed calls, not a report", async () => {
  const run = await runWebAgent(() =>
    call("web_read", { url: "https://example.com/library" }),
  );
  try {
    assert.equal(run.result.stopReason, "budget_exhausted");
    assert.equal(run.result.status, "incomplete");
    assert.deepEqual(run.result.findings, []);
    assert.match(run.result.summary, /used its allocation before it reported/);
    // The sixth read, asked for on the last call, was refused rather than run.
    assert.equal(run.result.observations.length, 5);
    assert(
      run.result.observations.every(
        (o: { operation: string }) => o.operation === "web_read",
      ),
    );
  } finally {
    await run.close();
  }
});

test("a short ref that appears only as a JSON key in a tool result is refused", async () => {
  const run = await runWebAgent((n, input) => {
    if (n === 1) return call("web_search", { query: "branch hours" });
    if (n === 2)
      return call("agent_report", {
        status: "complete",
        summary: "Found the branch record.",
        findings: [],
        refs: ["5550001"],
      });
    if (n === 3) {
      assert.match(lastTool(input).error.message, /not found: "5550001"/);
      return call("agent_report", {
        status: "partial",
        summary: "Found search results only.",
        findings: [],
        refs: [],
      });
    }
    throw new Error("unexpected child call " + n);
  });
  try {
    assert.equal(run.childCalls, 3);
    assert.equal(run.result.status, "partial");
  } finally {
    await run.close();
  }
});

test("a child short of time gets one final notice, runs only its report, and reports", async () => {
  // Each of the first two model calls takes 35 s of a 90 s allocation; later ones take 1 s.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const run = await runWebAgent((n, input) => {
      offset += n <= 2 ? 35000 : 1000;
      const finals = input.messages.filter((m) =>
        String(m.content).startsWith("[Host notice] This is your last"),
      );
      if (n <= 2) {
        assert.equal(finals.length, 0);
        return call("web_read", { url: "https://example.com/library" });
      }
      // From the third call on, less than 20 s remain on every call, but the notice is given once.
      assert.equal(finals.length, 1);
      assert.deepEqual(
        input.tools.map((t) => t.name),
        ["agent_report"],
      );
      if (n === 3)
        return call("web_read", { url: "https://example.com/library" });
      assert.match(lastTool(input).error.message, /only agent_report runs/);
      return call("agent_report", {
        status: "partial",
        summary: "Open daily 9am to 5pm.",
        findings: [],
        refs: ["1234567"],
      });
    });
    try {
      assert.equal(run.childCalls, 4);
      assert.equal(run.result.status, "partial");
      assert.deepEqual(run.result.refs, ["1234567"]);
      assert.equal(
        (
          await run.db.query(
            "SELECT count(*)::int n FROM events WHERE type='agent.budget_notice' AND (data->>'final')::boolean",
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await run.close();
    }
  } finally {
    Date.now = realNow;
  }
});

/** One model step asking for several tool calls. */
const calls = (...items: [string, unknown][]) => ({
  message: {
    role: "assistant" as const,
    content: null,
    tool_calls: items.map(([name, args]) => ({
      id: randomUUID(),
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    })),
  },
});

test("a lookup refused on the last call does not take the tool unit its report needs", async () => {
  const run = await runWebAgent((n, input) => {
    // The web agent may make 12 tool calls; the first step uses 11 of them.
    if (n === 1)
      return calls(
        ...Array.from(
          { length: 11 },
          (_, i) =>
            ["web_search", { query: "branch hours " + i }] as [string, unknown],
        ),
      );
    // One tool unit is left, so this is the last call.
    assert.deepEqual(
      input.tools.map((t) => t.name),
      ["agent_report"],
    );
    return calls(
      ["web_search", { query: "one more" }],
      [
        "agent_report",
        {
          status: "partial",
          summary: "Search results only.",
          findings: [],
          refs: [],
        },
      ],
    );
  });
  try {
    assert.equal(run.childCalls, 2);
    assert.equal(run.result.stopReason, "answer");
    assert.equal(run.result.status, "partial");
    assert.equal(run.result.summary, "Search results only.");
    const refused = (
      await run.db.query(
        "SELECT result FROM runtime_calls WHERE operation='web_search' AND state='failed'",
      )
    ).rows;
    assert.equal(refused.length, 1);
    assert.match(
      refused[0].result.error.message,
      /^Not dispatched: .*only agent_report runs/,
    );
  } finally {
    await run.close();
  }
});

test("an incomplete agent's observations are its latest twelve calls, in call order", async () => {
  // Devin on PR 313: the earliest twelve were returned, hiding an agent's latest work.
  const run = await runWebAgent(() =>
    call("web_read", { url: "https://example.com/library" }),
  );
  try {
    const childRun = run.result.childRunId;
    for (let i = 0; i < 10; i++)
      await run.db.query(
        "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,started_at) VALUES(gen_random_uuid(),$1,$2,'web_search','{}',false,'success',now()+make_interval(secs=>$3))",
        [childRun, `later-${i}`, i + 1],
      );
    const latest = await latestObservations(run.db, childRun);
    assert.equal(latest.length, 12);
    const ids = (
      await run.db.query(
        "SELECT id FROM runtime_calls WHERE run_id=$1 AND state='success' AND operation NOT IN ('agent_report','skill_read') ORDER BY started_at,id",
        [childRun],
      )
    ).rows.map((r) => r.id);
    assert.equal(ids.length, 15);
    assert.deepEqual(
      latest.map((o) => o.observationId),
      ids.slice(-12),
    );
  } finally {
    await run.close();
  }
});
