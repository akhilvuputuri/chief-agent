import "dotenv/config";
import { PGlite } from "@electric-sql/pglite";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { OpenRouter, type ModelAdapter, type Message } from "../src/model.js";
import { JobTools } from "../src/tools.js";
import { boundHistory } from "../src/context.js";
import type { Database } from "../src/db.js";
import {
  cases,
  records,
  prompt,
  followup,
  fixtureVersion,
  type CaseName,
} from "./cases.js";
import { grade, graderVersion } from "./grade.js";
const live = process.argv.includes("--live");
const chosen = process.argv.find((a) => a.startsWith("--case="))?.split("=")[1];
if (chosen && !cases.includes(chosen as CaseName))
  throw new Error("Unknown case");
const selected = chosen ? [chosen as CaseName] : [...cases];
if (live && !process.env.OPENROUTER_API_KEY)
  throw new Error("Configure OPENROUTER_API_KEY privately");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
    .length > 0;
const out = new URL(
  `../eval-results/${new Date().toISOString().replace(/[:.]/g, "-")}/`,
  import.meta.url,
);
await mkdir(out, { recursive: true, mode: 0o700 });
// Reproduce the incident's selection pressure independently of stochastic model behavior.
const history: Message[] = [
  {
    role: "user",
    content: "Compare the exact saved collection; do not substitute targets.",
  },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "inventory",
        type: "function",
        function: { name: "job_list", arguments: "{}" },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "inventory",
    content: JSON.stringify(
      records("collection").map(({ description, ...r }) => r),
    ),
  },
];
for (let i = 0; i < 6; i++)
  history.push(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `snapshot-${i}`,
          type: "function",
          function: { name: "work_step", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: `snapshot-${i}`,
      content: JSON.stringify({ bookkeeping: "x".repeat(16000) }),
    },
  );
const bounded = boundHistory(history);
const probe = {
  name: "inventory-survives-bookkeeping",
  pass: bounded.messages.some(
    (m) => m.role === "tool" && m.tool_call_id === "inventory",
  ),
  omitted: bounded.omitted,
};
const summaries: any[] = [];
let charged = 0;
const maxDollars = 2; // Conservative admission accounting; unknown usage is charged at upper bound.
for (const name of live ? selected : []) {
  const pg = new PGlite();
  const trace: any[] = [];
  let calls = 0;
  const started = Date.now();
  try {
    for (const f of [
      "001_initial",
      "002_preparation",
      "003_skills",
      "004_daily",
      "005_work",
      "006_runtime",
    ])
      await pg.exec(
        await readFile(new URL(`../db/${f}.sql`, import.meta.url), "utf8"),
      );
    const db = pg as unknown as Database;
    const owner = "eval-synthetic";
    const fixture = records(name);
    await db.query("INSERT INTO users(id) VALUES($1)", [owner]);
    await db.query(
      "INSERT INTO memories(user_id,key,value) VALUES($1,'background','I have built TypeScript services. No information about customer deployment experience has been supplied.')",
      [owner],
    );
    for (const j of fixture)
      await db.query(
        "INSERT INTO jobs(id,user_id,title,company,url,description) VALUES($1,$2,$3,$4,$5,$6)",
        [j.id, owner, j.title, j.company, j.url, j.description],
      );
    const upstream = new OpenRouter(process.env.OPENROUTER_API_KEY!);
    const adapter: ModelAdapter = {
      model: upstream.model,
      generate: async (input) => {
        // UTF-8 bytes are a deliberately conservative input-token upper estimate.
        const reserve =
          (Buffer.byteLength(
            JSON.stringify(input.messages) +
              JSON.stringify(input.tools) +
              " ".repeat(4096),
          ) *
            2) /
            1e6 +
          (8000 * 10) / 1e6;
        if (calls >= 32 || charged + reserve > maxDollars)
          throw new Error("Evaluation spending/call ceiling reached");
        charged += reserve;
        calls++;
        const t = Date.now();
        const entry: any = {
          input: {
            messages: input.messages,
            tools: input.tools,
            reasoning: input.reasoning,
          },
        };
        trace.push(entry);
        try {
          const result = await upstream.generate(input);
          entry.output = result;
          entry.latencyMs = Date.now() - t;
          const actual = result.usage?.cost;
          if (
            typeof actual === "number" &&
            Number.isFinite(actual) &&
            actual >= 0
          )
            charged += actual - reserve;
          return result;
        } catch {
          entry.error = "Model request failed";
          throw new Error("Evaluation model request failed");
        }
      },
    };
    const web = {
      call: async (operation: string, value: string) => {
        if (operation === "web_search")
          return {
            untrusted: true,
            content: JSON.stringify(
              fixture.map((j) => ({ url: j.url, title: j.title })),
            ),
          };
        const j = fixture.find((j) => j.url === value);
        if (!j) throw new Error("Synthetic source unavailable");
        return {
          untrusted: true,
          content: `${j.company}: ${j.title}. ${j.description}\nRELATED JOBS (not this posting): Fictional Outsider — Voice Lead, reference OUTSIDE-999.`,
        };
      },
    };
    const assistant = new Assistant(
      db,
      new CustomAgent(adapter),
      new JobTools(db, web),
      { web: true },
      { ms: 300000, models: 24, tools: 100 },
    );
    const replies = [await assistant.respond(owner, prompt(name))];
    if (name === "scope-change")
      replies.push(await assistant.respond(owner, followup));
    const expected = name === "scope-change" ? fixture.slice(1) : fixture;
    const score = grade(replies.at(-1)!, expected);
    const runs = (
      await db.query(
        "SELECT state,stop_reason,used_models,used_tools FROM runtime_runs",
      )
    ).rows;
    const dbCalls = (
      await db.query(
        "SELECT operation,arguments,state,result FROM runtime_calls ORDER BY started_at",
      )
    ).rows;
    const result = {
      name,
      score,
      replies,
      runs,
      elapsedMs: Date.now() - started,
      modelCalls: calls,
      toolCalls: dbCalls.length,
      usage: trace.map((t) => t.output?.usage ?? null),
      trace,
      dbCalls,
    };
    await writeFile(
      new URL(`${name}.json`, out),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    summaries.push({
      name,
      score,
      modelCalls: calls,
      toolCalls: dbCalls.length,
      elapsedMs: result.elapsedMs,
    });
    console.log(JSON.stringify(summaries.at(-1)));
  } catch (e) {
    summaries.push({
      name,
      error: e instanceof Error ? e.message : "Evaluation failed",
    });
    await writeFile(
      new URL(`${name}-failed.json`, out),
      JSON.stringify({ trace, error: summaries.at(-1) }, null, 2),
      { mode: 0o600 },
    );
  } finally {
    await pg.close();
  }
}
const fingerprint = createHash("sha256")
  .update(await readFile(new URL("./cases.ts", import.meta.url)))
  .update(await readFile(new URL("./grade.ts", import.meta.url)))
  .digest("hex");
const report = {
  revision,
  dirty,
  fixtureVersion,
  graderVersion,
  fingerprint,
  mode: live ? "live-model-controlled-tools" : "offline-context-probe",
  settings: {
    model: "openai/gpt-5.6-sol",
    reasoning: "medium",
    priceCeilings: { input: 2, output: 10 },
    maxDollars,
  },
  admissionChargedDollars: charged,
  probe,
  summaries,
};
await writeFile(new URL("report.json", out), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
await writeFile(
  new URL("report.md", out),
  `# Companion evaluation\n\nRevision: ${revision}; dirty: ${dirty}. Mode: ${report.mode}.\n\nContext probe: ${probe.pass ? "PASS" : "FAIL"} (${probe.omitted} messages omitted).\n\n${summaries.map((s) => `- ${s.name}: ${s.score?.pass ? "PASS" : "FAIL"}; coverage ${s.score?.coverage ?? "unknown"}; model calls ${s.modelCalls ?? "unknown"}; tools ${s.toolCalls ?? "unknown"}`).join("\n")}\n\nSemantic quality requires manual review. One trial is not a reliability estimate. Spending admission accounting is not a billing statement; missing usage remains unknown.\n`,
);
console.log(JSON.stringify({ report: out.pathname, probe }));
