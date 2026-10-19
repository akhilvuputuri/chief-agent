import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import type { ModelAdapter, ToolDefinition } from "../src/model.js";
import { JobTools } from "../src/tools.js";
import { runtimeContext } from "../src/runtime.js";
import { action } from "../src/protocol.js";
import {
  CORE_OPERATIONS,
  DOMAIN_GUIDANCE,
  domainOf,
  selectDomains,
  TOOL_DOMAINS,
  type ToolDomain,
} from "../src/tool-domains.js";
import { instructions } from "../src/context.js";
import type { Database } from "../src/db.js";

const allOn = {
  web: true,
  gmail: true,
  calendar: true,
  preparationSheet: true,
  dailySheet: true,
  canvases: true,
  library: true,
  libraryAccount: true,
  parcels: true,
  stocks: true,
};

test("every operation is core or belongs to a loadable domain", () => {
  for (const option of action.options) {
    const op = option.shape.operation.value;
    assert.ok(
      CORE_OPERATIONS.has(op) || domainOf(op),
      `${op} has no tool domain`,
    );
  }
  for (const core of CORE_OPERATIONS) assert.equal(domainOf(core), undefined);
});

test("initial domains come from message cues, task binding, approvals and recent use", () => {
  const pick = (message: string, extra = {}) =>
    [...selectDomains({ message, ...extra })].sort();
  assert.deepEqual(pick("hello, how are you?"), []);
  assert.deepEqual(pick("any new email from the bank?"), ["gmail"]);
  assert.deepEqual(pick("what's on tomorrow?"), ["calendar"]);
  assert.deepEqual(
    pick("Look at this\n\n[Attached image: a.png attachmentId=x]"),
    ["media"],
  );
  assert.deepEqual(pick("prep me for the interview at the company"), ["jobs"]);
  assert.deepEqual(pick("ok", { taskBound: true }), ["work"]);
  assert.deepEqual(pick("yes", { pendingCalendarApproval: true }), [
    "calendar",
  ]);
  assert.deepEqual(
    pick("and the other one?", {
      recentOperations: ["gmail_search", "web_search"],
    }),
    ["gmail"],
  );
  // No false match inside words.
  assert.deepEqual(pick("remailing and scheduling-ish"), []);
});

test("domain-limited runtime offers the core plus selected domains and lists the rest", () => {
  const full = runtimeContext(allOn, null);
  const limited = runtimeContext(
    allOn,
    null,
    undefined,
    selectDomains({ message: "any new email?" }),
  );
  const names = limited.tools.map((t) => t.name);
  assert.ok(names.includes("gmail_search"));
  assert.ok(names.includes("tools_load"));
  assert.ok(!names.includes("job_list"));
  assert.ok(!names.includes("canvas_create"));
  for (const name of names)
    assert.ok(CORE_OPERATIONS.has(name) || domainOf(name) === "gmail", name);
  assert.equal(limited.allTools!.length, full.tools.length);
  const domains = JSON.parse(limited.context).toolDomains;
  assert.deepEqual(domains.loaded, ["gmail"]);
  assert.ok(domains.loadable.jobs && domains.loadable.canvas);
  assert.equal("gmail" in domains.loadable, false);
  assert.ok(
    JSON.stringify(limited.tools).length <
      JSON.stringify(full.tools).length / 2,
  );
  // Unavailable integrations are neither offered nor loadable.
  const noGmail = JSON.parse(
    runtimeContext({ web: true, delegation: false }, null, undefined, new Set())
      .context,
  ).toolDomains;
  assert.equal("gmail" in noGmail.loadable, false);
  assert.ok(TOOL_DOMAINS.includes("gmail"));
});

async function fixture(model: ModelAdapter) {
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
  const assistant = new Assistant(
    db,
    new CustomAgent(model),
    new JobTools(db, { call: async () => ({ content: "public source" }) }),
    { web: true, delegation: false },
    { ms: 900000, models: 40, tools: 100 },
  );
  return { pg, db, assistant };
}
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
const names = (tools: ToolDefinition[]) => tools.map((t) => t.name);

test("tools_load offers a domain's tools on the next model call and is recorded", async () => {
  const seen: string[][] = [];
  const states: string[] = [];
  const f = await fixture({
    generate: async (input) => {
      seen.push(names(input.tools));
      states.push(String(input.messages.at(-1)?.content));
      if (seen.length === 1) return call("tools_load", { domains: ["jobs"] });
      if (seen.length === 2) return call("job_list", {});
      return text("You have no saved roles.");
    },
  });
  try {
    assert.equal(
      await f.assistant.respond("owner", "hello there"),
      "You have no saved roles.",
    );
    assert.ok(!seen[0]!.includes("job_list"));
    assert.ok(seen[0]!.includes("tools_load"));
    assert.ok(seen[1]!.includes("job_list"));
    // The loaded domain's guidance arrives with its tools, at the end of the request.
    assert.doesNotMatch(states[0]!, /job-alignment skill/);
    assert.match(states[1]!, /job-alignment skill/);
    const events = (
      await f.db.query(
        "SELECT type,data FROM events WHERE type IN ('tools.selected','tools.loaded') ORDER BY id",
      )
    ).rows;
    assert.deepEqual(
      events.map((e) => e.type),
      ["tools.selected", "tools.loaded"],
    );
    assert.deepEqual(events[1].data.domains, ["jobs"]);
    const calls = (
      await f.db.query(
        "SELECT operation,state,is_write FROM runtime_calls ORDER BY started_at",
      )
    ).rows;
    assert.deepEqual(
      calls.map((c) => [c.operation, c.state, c.is_write]),
      [
        ["tools_load", "success", false],
        ["job_list", "success", false],
      ],
    );
  } finally {
    await f.pg.close();
  }
});

test("calling a known tool whose domain is not loaded loads it and dispatches once", async () => {
  const seen: string[][] = [];
  const f = await fixture({
    generate: async (input) => {
      seen.push(names(input.tools));
      if (seen.length === 1) return call("job_list", {});
      return text("None saved.");
    },
  });
  try {
    await f.assistant.respond("owner", "hi");
    assert.ok(!seen[0]!.includes("job_list"));
    assert.ok(seen[1]!.includes("job_list"));
    const calls = (
      await f.db.query("SELECT operation,state FROM runtime_calls")
    ).rows;
    assert.deepEqual(calls, [{ operation: "job_list", state: "success" }]);
  } finally {
    await f.pg.close();
  }
});

test("a disabled integration stays unavailable even when requested", async () => {
  let n = 0;
  const f = await fixture({
    generate: async () => {
      n++;
      if (n === 1) return call("gmail_search", { query: "from:bank" });
      if (n === 2) return call("tools_load", { domains: ["gmail"] });
      return text("Gmail is not connected.");
    },
  });
  try {
    await f.assistant.respond("owner", "check my email");
    const calls = (
      await f.db.query(
        "SELECT operation,state,result FROM runtime_calls ORDER BY started_at",
      )
    ).rows;
    assert.equal(calls[0].operation, "gmail_search");
    assert.equal(calls[0].state, "failed");
    // Loading an unavailable domain reports it instead of pretending it loaded.
    assert.equal(calls[1].operation, "tools_load");
    assert.equal(calls[1].state, "success");
    const loaded = calls[1].result;
    assert.deepEqual(loaded.unavailable, ["gmail"]);
    assert.equal(loaded.loaded.includes("gmail"), false);
  } finally {
    await f.pg.close();
  }
});

test("a plain message sends well under half of the full tool schemas", async () => {
  let first: ToolDefinition[] = [];
  const f = await fixture({
    generate: async (input) => {
      if (!first.length) first = input.tools;
      return text("Hi!");
    },
  });
  try {
    await f.assistant.respond("owner", "hello");
    const full = runtimeContext({ web: true, delegation: false }, null).tools;
    assert.ok(
      JSON.stringify(first).length < JSON.stringify(full).length / 2,
      `${JSON.stringify(first).length} vs ${JSON.stringify(full).length}`,
    );
  } finally {
    await f.pg.close();
  }
});

test("common phrasings reach their domains", () => {
  const pick = (message: string) => [...selectDomains({ message })];
  for (const [message, domain] of [
    ["Did Sarah reply to me?", "gmail"],
    ["Check my messages from the bank", "gmail"],
    ["What's on at 3pm?", "calendar"],
    ["When is my dentist?", "calendar"],
    ["Add lunch with Tom on the 5th at 1pm", "calendar"],
    ["Did DHL deliver?", "parcels"],
  ] as const)
    assert.ok(pick(message).includes(domain), `${message} -> ${domain}`);
});

test("loading a domain appends its tools after the existing ones", () => {
  const domains = selectDomains({ message: "any new email?" });
  const before = runtimeContext(allOn, null, undefined, domains).tools.map(
    (t) => t.name,
  );
  domains.add("jobs");
  const after = runtimeContext(allOn, null, undefined, domains).tools.map(
    (t) => t.name,
  );
  assert.deepEqual(after.slice(0, before.length), before);
  assert.ok(after.slice(before.length).every((n) => domainOf(n) === "jobs"));
});

test("coding tools form their own domain, so ordinary work turns do not carry them", () => {
  assert.equal(domainOf("coding_start"), "coding");
  assert.equal(domainOf("work_start"), "work");
  // coding_status stays in the core so status answers never need a load.
  assert.equal(domainOf("coding_status"), undefined);
  const pick = (message: string) => [...selectDomains({ message })].sort();
  assert.deepEqual(pick("do this in the background step by step"), ["work"]);
  assert.deepEqual(pick("open a pull request for that bug fix"), ["coding"]);
  const enabled = { ...allOn, coding: true };
  const work = runtimeContext(enabled, null, undefined, new Set(["work"]));
  assert.ok(!work.tools.some((t) => t.name === "coding_start"));
  assert.ok(work.tools.some((t) => t.name === "work_start"));
  const coding = runtimeContext(enabled, null, undefined, new Set(["coding"]));
  assert.ok(coding.tools.some((t) => t.name === "coding_start"));
});

test("domain guidance travels with its offered domain instead of the fixed instructions", () => {
  assert.doesNotMatch(instructions, /When canvas tools are available/);
  assert.doesNotMatch(instructions, /job-alignment skill/);
  assert.doesNotMatch(instructions, /Work in small batches/);
  const guidance = (domains: string[]) =>
    JSON.parse(
      runtimeContext(allOn, null, undefined, new Set(domains as ToolDomain[]))
        .context,
    ).domainGuidance;
  assert.equal(guidance([]), undefined);
  assert.deepEqual(Object.keys(guidance(["canvas"])), ["canvas"]);
  assert.match(guidance(["canvas"]).canvas, /When canvas tools are available/);
  assert.deepEqual(Object.keys(guidance(["jobs", "work"])).sort(), [
    "jobs",
    "work",
  ]);
  for (const [domain, text] of Object.entries(DOMAIN_GUIDANCE))
    assert.ok(TOOL_DOMAINS.includes(domain as ToolDomain) && text, domain);
});

test("a waiting coding job keeps coding tools offered; conversational words no longer load them", () => {
  const pick = (message: string, extra = {}) =>
    [...selectDomains({ message, ...extra })].sort();
  assert.deepEqual(pick("merge it", { pendingCoding: true }), ["coding"]);
  assert.deepEqual(pick("merge it"), []);
  assert.deepEqual(pick("open a PR for this"), ["coding"]);
  // Background steps say "Continue the existing task"; that is work, not coding.
  assert.deepEqual(pick("Continue the existing task", { taskBound: true }), [
    "work",
  ]);
  for (const message of ["update my resume", "I have a promo code"])
    assert.ok(!pick(message).includes("coding"), message);
});
