// Context recall eval: replays synthetic conversations through Chief's real
// history and context pipeline, then asks each probe as the next message.
//   --mode context  (default, free): capture the first model call's input and
//                   record which evidence strings the model can see.
//   --mode answer   (paid): let the configured model answer with the real
//                   runtime, including conversation_search/observation_read.
// Writes one JSON line per probe to --out (default stdout). Fixtures are
// synthetic; see evals/context/README.md. No secrets are printed.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../../src/agent.js";
import { CustomAgent } from "../../src/custom-agent.js";
import { JobTools } from "../../src/tools.js";
import { HistoryStore } from "../../src/history.js";
import { projectObservation } from "../../src/observations.js";
import { ensureUser, type Database } from "../../src/db.js";
import { setOpsSink } from "../../src/ops-log.js";
import {
  OpenRouter,
  type Message,
  type ModelAdapter,
  type ModelMessage,
  type ToolDefinition,
} from "../../src/model.js";

const OWNER = "eval-owner";
// Operational log lines would interleave with the JSONL output.
setOpsSink(() => {});
const root = new URL("../../", import.meta.url);
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const mode = args.get("mode") ?? "context";
if (!["context", "answer"].includes(mode))
  throw new Error("--mode context|answer");
const only = args.get("probe");
const fixtureDir = args.get("fixtures")
  ? new URL(`file://${args.get("fixtures")!.replace(/\/?$/, "/")}`)
  : new URL("fixtures/", import.meta.url);

interface Call {
  operation: string;
  args?: Record<string, unknown>;
  result: unknown;
}
interface Turn {
  user: string;
  calls?: Call[];
  reply: string;
}
interface Probe {
  id: string;
  after: number;
  message: string;
  slice: string;
  evidence: string[];
  accept: string[];
  reject?: string[];
}
interface Fixture {
  id: string;
  turns: Turn[];
  probes: Probe[];
}

// Deterministic neutral filler for {"$fill": n}; never contains evidence.
const NEUTRAL = [
  "This section repeats routine account information without new details.",
  "Standard footer text follows with unsubscribe and privacy links.",
  "The message continues with general background that does not change any plan.",
  "Formatting and quoted earlier text are included below for reference.",
  "No action is required for the items listed in this part of the message.",
  "Additional boilerplate from the sender's template appears here.",
];
function fill(n: number, seed: number) {
  let out = "";
  let i = seed;
  while (out.length < n) {
    out += NEUTRAL[i % NEUTRAL.length] + " ";
    i = (i * 7 + 3) % 9973;
  }
  return out.slice(0, n);
}
function expand(value: unknown, seed = { n: 1 }): unknown {
  if (Array.isArray(value)) return value.map((v) => expand(v, seed));
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.$fill === "number")
      return fill(o.$fill, seed.n++);
    return Object.fromEntries(
      Object.entries(o).map(([k, v]) => [k, expand(v, seed)]),
    );
  }
  return value;
}

// Owner memories comparable in size to production (about 2.5k characters).
const MEMORIES: [string, string][] = [
  [
    "preferred_reply_style",
    "Short, direct answers; bullet points only when listing several items.",
  ],
  ["timezone", "Asia/Singapore. Use 24-hour times only if asked."],
  [
    "job_search_focus",
    "Backend and platform engineering roles in Singapore or remote APAC; prefers TypeScript and Go; avoids ad-tech. ".repeat(
      3,
    ),
  ],
  [
    "work_history_summary",
    "Six years of backend work: payments APIs, event pipelines and internal tooling at two mid-size companies. ".repeat(
      4,
    ),
  ],
  [
    "salary_expectation",
    "Target base in the upper band for senior backend roles; open to equity.",
  ],
  [
    "interview_prep_notes",
    "Practising system design (queues, idempotency, rate limiting) and behavioural stories. ".repeat(
      4,
    ),
  ],
];

async function database() {
  const pg = new PGlite();
  const files = readdirSync(new URL("db/", root))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files)
    await pg.exec(readFileSync(new URL("db/" + f, root), "utf8"));
  return pg;
}

/** Store the turns the way a completed run would: journaled calls, projected results, history rows. */
async function load(db: Database, turns: Turn[]) {
  await ensureUser(db, OWNER);
  for (const [key, value] of MEMORIES)
    await db.query(
      "INSERT INTO memories(user_id,key,value) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [OWNER, key, value],
    );
  const history = new HistoryStore(db);
  let count = 0;
  const seed = { n: 1 };
  for (const turn of turns) {
    const run = randomUUID();
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,state,stop_reason) VALUES($1,$2,'stopped','completed')",
      [run, OWNER],
    );
    const messages: Message[] = [{ role: "user", content: turn.user }];
    if (turn.calls?.length) {
      const ids = turn.calls.map(() => "call_" + randomUUID().slice(0, 8));
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: turn.calls.map((c, i) => ({
          id: ids[i]!,
          type: "function",
          function: {
            name: c.operation,
            arguments: JSON.stringify(c.args ?? {}),
          },
        })),
      });
      for (const [i, c] of turn.calls.entries()) {
        const observation = randomUUID();
        const result = expand(c.result, seed);
        await db.query(
          "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result,finished_at) VALUES($1,$2,$3,$4,$5,false,'success',$6,now())",
          [
            observation,
            run,
            ids[i],
            c.operation,
            JSON.stringify(c.args ?? {}),
            JSON.stringify({ result }),
          ],
        );
        messages.push({
          role: "tool",
          tool_call_id: ids[i]!,
          content: JSON.stringify(
            projectObservation(c.operation, { result }, observation),
          ),
        });
      }
    }
    messages.push({ role: "assistant", content: turn.reply });
    await history.append(OWNER, null, count, messages, run);
    count += messages.length;
  }
}

function visibleText(messages: ModelMessage[]) {
  return messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content ?? ""),
    )
    .join("\n");
}

async function runProbe(fixture: Fixture, probe: Probe) {
  const pg = await database();
  const db = pg as unknown as Database;
  try {
    await load(db, fixture.turns.slice(0, probe.after));
    let first:
      { messages: ModelMessage[]; tools: ToolDefinition[] } | undefined;
    const calls: string[] = [];
    const real =
      mode === "answer"
        ? new OpenRouter(
            process.env.OPENROUTER_API_KEY ?? "",
            args.get("model") ?? process.env.AGENT_MODEL ?? "openai/gpt-6-sol",
          )
        : undefined;
    const model: ModelAdapter = {
      generate: async (input) => {
        first ??= { messages: input.messages, tools: input.tools };
        if (!real)
          return {
            message: { role: "assistant", content: "(context captured)" },
          };
        const out = await real.generate(input);
        for (const c of out.message.tool_calls ?? [])
          calls.push(c.function.name);
        return out;
      },
    };
    const assistant = new Assistant(
      db,
      new CustomAgent(model),
      new JobTools(db, { call: async () => ({ results: [] }) }),
      // Integrations are off: the eval measures recall from the conversation, not re-fetching.
      {
        web: true,
        gmail: false,
        calendar: false,
        parcels: false,
        library: false,
        libraryAccount: false,
        preparationSheet: false,
        dailySheet: false,
        stocks: false,
        canvases: false,
      },
      { ms: 180000, models: 8, tools: 12 },
    );
    const start = Date.now();
    const delivery = await assistant.respondDetailed(OWNER, probe.message);
    const latencyMs = Date.now() - start;
    const text = first ? visibleText(first.messages) : "";
    const selected = (
      await db.query(
        "SELECT data FROM events WHERE run_id=$1 AND type='context.selected' ORDER BY id LIMIT 1",
        [delivery.runId],
      )
    ).rows[0]?.data;
    const cost = (
      await db.query(
        "SELECT COALESCE(sum(actual_usd),0)::float AS usd FROM provider_charges WHERE run_id=$1",
        [delivery.runId],
      )
    ).rows[0]?.usd;
    return {
      fixture: fixture.id,
      probe: probe.id,
      slice: probe.slice,
      mode,
      turnsLoaded: probe.after,
      evidence: Object.fromEntries(
        probe.evidence.map((e) => [e, text.includes(e) ? "context" : "absent"]),
      ),
      sizes: {
        fixed: selected?.fixedSize ?? null,
        serialized: selected?.serializedSize ?? null,
        omitted: selected?.omitted ?? null,
        exchange: selected?.exchangeSize ?? null,
        tools: first ? JSON.stringify(first.tools).length : null,
        messageChars: text.length,
      },
      accept: probe.accept,
      reject: probe.reject ?? [],
      reply: mode === "answer" ? delivery.reply : null,
      toolCalls: calls,
      costUsd: cost ?? 0,
      latencyMs,
    };
  } finally {
    await pg.close();
  }
}

if (mode === "answer" && !process.env.OPENROUTER_API_KEY)
  throw new Error("answer mode needs OPENROUTER_API_KEY in the environment");
const fixtures: Fixture[] = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, fixtureDir), "utf8")));
const rows: string[] = [];
for (const fixture of fixtures)
  for (const probe of fixture.probes) {
    if (only && probe.id !== only) continue;
    const row = await runProbe(fixture, probe);
    rows.push(JSON.stringify(row));
    process.stderr.write(
      `${probe.id} ${Object.values(row.evidence).join(",")}\n`,
    );
  }
const out = args.get("out");
if (out) writeFileSync(out, rows.join("\n") + "\n");
else process.stdout.write(rows.join("\n") + "\n");
