import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { fixture, settings, startCard } from "./helpers/coding-fixture.js";
import { codingSettings } from "../src/coding/schema.js";
import { artifactHash } from "../src/coding/github.js";
import { inboxMessage } from "../src/coding/pi-worker.js";
import { reportDocument } from "@chief-agent/pi-runtime/report";
import {
  messagesStream,
  toolUse,
  type FakeBlock,
} from "../coding_runtime_pi/tests/anthropic-sse.js";

const SCRIPT = "scripts/coding-job-profile.sql";

type Row = Record<string, string>;

/**
 * Runs scripts/coding-job-profile.sql as psql would, against the test database: \set, \pset
 * and \x are display settings and ignored; \if/\elif/\else/\endif, \gset, \echo and \quit are
 * followed; :'name' is quoted as psql quotes it. Returns the printed text and each section's
 * rows under the number its \echo heading gives.
 */
async function profile(
  db: { query: (sql: string, params?: unknown[]) => Promise<any> },
  job?: string,
) {
  const text = await readFile(SCRIPT, "utf8");
  const vars: Record<string, string> = job === undefined ? {} : { job };
  const printed: string[] = [];
  const sections: Record<string, Row[]> = {};
  let section = "";
  const branches: { active: boolean; taken: boolean }[] = [];
  const active = () => branches.every((b) => b.active);
  const truth = (expression: string) => {
    const value = expression
      .trim()
      .replace(/^:\{\?(\w+)\}$/, (_, n) => (n in vars ? "true" : "false"))
      .replace(/^:(\w+)$/, (_, n) => vars[n] ?? "")
      .toLowerCase();
    if (["t", "true", "on", "1", "yes"].includes(value)) return true;
    if (["f", "false", "off", "0", "no"].includes(value)) return false;
    throw new Error(`Not a boolean for \\if: ${expression}`);
  };
  const quote = (name: string) => {
    assert(name in vars, `variable ${name} is set`);
    return `'${vars[name]!.replaceAll("'", "''")}'`;
  };
  const show = (v: unknown) =>
    v === null || v === undefined
      ? "-"
      : v instanceof Date
        ? v.toISOString()
        : String(v);
  let buffer = "";
  try {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!buffer && line.startsWith("\\")) {
        const [command, ...rest] = line.split(/\s+/);
        const argument = rest.join(" ");
        if (command === "\\if") {
          const on = active() && truth(argument);
          branches.push({ active: on, taken: on });
          continue;
        }
        if (command === "\\elif") {
          const b = branches.at(-1)!;
          const parent = branches.slice(0, -1).every((x) => x.active);
          b.active = parent && !b.taken && truth(argument);
          b.taken ||= b.active;
          continue;
        }
        if (command === "\\else") {
          const b = branches.at(-1)!;
          const parent = branches.slice(0, -1).every((x) => x.active);
          b.active = parent && !b.taken;
          b.taken = true;
          continue;
        }
        if (command === "\\endif") {
          branches.pop();
          continue;
        }
        if (!active()) continue;
        if (command === "\\echo") {
          const message = argument.startsWith("'")
            ? argument.slice(1, -1).replaceAll("''", "'")
            : argument;
          printed.push(message);
          const heading = /^(\d+[a-z]?)\./.exec(message);
          if (heading) section = heading[1]!;
          continue;
        }
        if (command === "\\quit") break;
        if (["\\set", "\\pset", "\\x"].includes(command!)) continue;
        throw new Error(`Unexpected psql command ${command}`);
      }
      if (/^--/.test(line) || (!buffer && !line)) continue;
      buffer += `${raw}\n`;
      const gset = /\\gset\s*$/.test(line);
      if (!gset && !/;\s*$/.test(line)) continue;
      const sql = buffer
        .replace(/\\gset\s*$/, "")
        .replace(/:'(\w+)'/g, (_, n) => quote(n));
      buffer = "";
      if (!active()) continue;
      const result = await db.query(sql);
      const rows = (result.rows ?? []).map((r: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, show(v)])),
      ) as Row[];
      if (gset) {
        assert.equal(rows.length, 1, "\\gset needs exactly one row");
        for (const [k, v] of Object.entries(rows[0]!))
          vars[k] = v === "true" ? "t" : v === "false" ? "f" : v;
        continue;
      }
      if (!result.fields?.length) continue;
      sections[section] = rows;
      for (const r of rows)
        printed.push(
          Object.entries(r)
            .map(([k, v]) => `${k}=${v}`)
            .join(" | "),
        );
    }
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
  assert.equal(buffer.trim(), "", "the script ends with a complete statement");
  return { text: printed.join("\n"), sections };
}

const MARKER = "PLANTED-7f3a-PRIVATE";
const PRICES = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
// Scripted times, far before the real clock: every row the real code writes during a step is
// stamped with the step's time, so durations are exact.
const T0 = Date.parse("2020-03-02T08:00:00Z");
const CUT = "2021-01-01T00:00:00Z";
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const minutes = (seconds: number) => (Math.round(seconds / 6) / 10).toFixed(1);

type Usage = {
  input: number;
  read: number;
  write: number;
  write1h?: number;
  output: number;
  thinking?: number;
};

/** Anthropic's stream for one turn, with the cache write split by lifetime and thinking tokens. */
function anthropicTurn(content: FakeBlock[], u: Usage) {
  const raw = messagesStream({
    content,
    usage: {
      input_tokens: u.input,
      output_tokens: u.output,
      cache_read_input_tokens: u.read,
      cache_creation_input_tokens: u.write,
    },
  });
  const events = raw
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const [name, data] = chunk.split("\n");
      const event = JSON.parse(data!.slice("data: ".length));
      if (event.type === "message_start")
        event.message.usage.cache_creation = {
          ephemeral_5m_input_tokens: u.write - (u.write1h ?? 0),
          ephemeral_1h_input_tokens: u.write1h ?? 0,
        };
      if (event.type === "message_delta" && u.thinking !== undefined)
        event.usage.output_tokens_details = { thinking_tokens: u.thinking };
      return `${name}\ndata: ${JSON.stringify(event)}\n\n`;
    });
  return new Response(events.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A request as Pi's Anthropic client builds it, with private text in every message kind. */
function request(model: string, extra: unknown[] = [], maxTokens = 32000) {
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: [{ type: "text", text: `Pi system prompt; request: ${MARKER}` }],
    thinking: {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
    output_config: { effort: "high" },
    tools: [
      {
        name: "bash",
        description: "Run a command",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ],
    messages: [
      { role: "user", content: `Start the work. ${MARKER}` },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "c2lnLTE=" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: `cat ${MARKER}.ts` },
          },
        ],
      },
      { role: "system", content: [], output_config: { effort: "medium" } },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: MARKER },
        ],
      },
      ...extra,
      { role: "system", content: [], output_config: { effort: "medium" } },
    ],
  };
}

const bash = (id: string, command: string) => toolUse(id, "bash", { command });
const thinking: FakeBlock = {
  type: "thinking",
  thinking: `Private reasoning ${MARKER}`,
  signature: "c2lnLTI=",
};

/** Cost as the host prices it (src/anthropic.ts anthropicUsage), for the expected figures. */
const cost = (u: Usage) =>
  (u.input * PRICES.input +
    u.read * PRICES.cacheRead +
    (u.write - (u.write1h ?? 0)) * PRICES.cacheWrite +
    (u.write1h ?? 0) * PRICES.input * 2 +
    u.output * PRICES.output) /
  1e6;

/**
 * A synthetic job on the one-session loop, built through the host's own code wherever it
 * exists on this branch: coding_start and the owner's Start, the tick, every model call through
 * piMessages (Anthropic streams recorded by the host), an owner follow-up through coding_reply,
 * checkpoints, the publication commit, finish and the PR. The box rows, the box-lifetime
 * continuation (stage D3, journal 193, not merged here) and the CI inbox item with its
 * feedback round are written with the statements and shapes those stages use.
 */
async function syntheticJob(t: TestContext) {
  const piSettings = codingSettings.parse({
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
    effort: "medium",
    maxOutputTokens: 32000,
    reviewerMaxOutputTokens: 16000,
  });
  const f = await fixture(t, { settings: piSettings });
  const db = f.db;
  const stamp = async (seconds: number) => {
    for (const table of [
      "coding_events",
      "coding_model_calls",
      "coding_revisions",
      "coding_jobs",
    ])
      await db.query(
        `UPDATE ${table} SET created_at=$1 WHERE created_at > $2`,
        [at(seconds), CUT],
      );
  };
  const card = await startCard(f, "profile", `Fix the bug. ${MARKER}`);
  const jobId = card.jobId;
  await stamp(0);
  await f.c.requirements.confirm("a", card.approvalId, "a", card.messageId);
  await stamp(600);
  const box = async (seconds: number, runningMs: number) => {
    const job = await f.row(jobId);
    await db.query(
      `INSERT INTO boxes(id,user_id,request_key,profile,provider,environment,subject,image,state,credential_hash,running_ms,absolute_deadline,created_at)
       VALUES($1,'a',$2,'coding','docker','test',$3,'image','terminated','hash',$4,$5,$6)`,
      [
        randomUUID(),
        `coding:${job.attempt_id}`,
        `coding:${jobId}`,
        runningMs,
        at(seconds + 14400),
        at(seconds),
      ],
    );
  };
  await f.c.tick();
  await stamp(660);
  await box(660, 1_140_000);

  const usages: { role: string; purpose: string; u: Usage }[] = [];
  const recorded = async () =>
    (
      await db.query(
        "SELECT count(*)::int AS n FROM coding_events WHERE job_id=$1 AND payload->>'kind'='model_usage'",
        [jobId],
      )
    ).rows[0].n;
  const call = async (
    role: "coder" | "reviewer",
    seconds: number,
    took: number,
    content: FakeBlock[],
    u: Usage,
    options: {
      purpose?: "agent" | "compaction" | "cache_warm";
      candidate?: string;
      extra?: unknown[];
      maxTokens?: number;
    } = {},
  ) => {
    const purpose = options.purpose ?? "agent";
    const before = await recorded();
    f.setMessages(async () => anthropicTurn(content, u));
    const reply = await f.c.piMessages(
      await f.row(jobId),
      role,
      // The fixture's Anthropic route gives each role's model its own catalogue id.
      request(
        role === "coder" ? "claude-opus-5-5" : "claude-sonnet-5-5",
        options.extra,
        options.maxTokens,
      ),
      {
        purpose,
        ...(options.candidate ? { candidate: options.candidate } : {}),
        signal: new AbortController().signal,
      },
    );
    assert.equal(reply.status, 200, String(reply.body));
    await new Response(reply.body as ReadableStream).text();
    for (let i = 0; i < 400 && (await recorded()) === before; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await recorded(), before + 1, "the call's usage was recorded");
    await db.query(
      "UPDATE coding_model_calls SET created_at=$1 WHERE created_at > $2",
      [at(seconds), CUT],
    );
    await db.query(
      "UPDATE coding_events SET created_at=$1 WHERE created_at > $2",
      [at(seconds + took), CUT],
    );
    usages.push({ role, purpose, u });
  };

  // Coder run 1, attempt 1: three tools in parallel, then a test run, a cache-warming replay,
  // an owner message, an edit and a write in parallel, Pi's compaction and the report.
  await call(
    "coder",
    700,
    60,
    [
      thinking,
      toolUse("t1", "read", { path: `${MARKER}.ts` }),
      toolUse("t2", "grep", { pattern: MARKER }),
      bash("t3", `cat src/${MARKER}.ts`),
    ],
    {
      input: 1000,
      read: 0,
      write: 6000,
      write1h: 2000,
      output: 400,
      thinking: 150,
    },
  );
  await call(
    "coder",
    800,
    30,
    [bash("t4", `cd /work && CI=1 kite run check -- ${MARKER}`)],
    { input: 200, read: 6000, write: 500, output: 100, thinking: 40 },
  );
  await call(
    "coder",
    1100,
    1,
    [{ type: "text", text: "" }],
    {
      input: 10,
      read: 6700,
      write: 0,
      output: 1,
    },
    { purpose: "cache_warm", maxTokens: 1 },
  );
  const replied: any = await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: jobId,
    baseRevision: (await f.row(jobId)).revision,
    requestKey: "owner-1",
    message: `Also handle the empty case. ${MARKER}`,
  });
  assert.equal(replied.state, "provisioning");
  await stamp(1150);
  const ownerItem = (
    await db.query(
      "SELECT id,payload FROM coding_events WHERE job_id=$1 AND event_key='inbox:reply:owner-1'",
      [jobId],
    )
  ).rows[0];
  assert.equal(ownerItem.payload.source, "owner");
  await call(
    "coder",
    1200,
    60,
    [
      { type: "text", text: `Editing now ${MARKER}` },
      toolUse("t5", "edit", {
        path: "sum.js",
        edits: [{ oldText: MARKER, newText: MARKER }],
      }),
      toolUse("t6", "write", { path: "new.js", content: MARKER }),
    ],
    { input: 300, read: 6700, write: 800, output: 600, thinking: 200 },
    {
      // Pi's steering delivers the owner's message as the newest user message.
      extra: [
        {
          role: "user",
          content: inboxMessage({
            id: ownerItem.id,
            source: "owner",
            text: ownerItem.payload.text,
          }),
        },
      ],
    },
  );
  await call(
    "coder",
    1300,
    60,
    [{ type: "text", text: `Summary of the session ${MARKER}` }],
    { input: 500, read: 7300, write: 0, output: 900 },
    { purpose: "compaction" },
  );
  await call(
    "coder",
    1400,
    30,
    [
      toolUse("t7", "report", {
        kind: "done",
        summary: MARKER,
        detail: MARKER,
      }),
    ],
    { input: 2000, read: 0, write: 0, output: 150, thinking: 50 },
  );
  const checkpoint1 = {
    plan: "",
    patch: "p1",
    summary: "s1",
    files: [{ path: "sum.js", content: "v1\n" }],
    piState: { version: 1, phase: "build", delivered: [ownerItem.id] },
  };
  await f.c.save(await f.row(jobId), checkpoint1);
  await stamp(1440);
  const first = artifactHash(checkpoint1 as any);

  // Review round 1: three tools in parallel, then findings.
  await call(
    "reviewer",
    1500,
    60,
    [
      bash("r1", "git diff base candidate"),
      bash("r2", `npm test -- ${MARKER}`),
      toolUse("r3", "read", { path: MARKER }),
    ],
    {
      input: 3000,
      read: 0,
      write: 4000,
      write1h: 4000,
      output: 500,
      thinking: 300,
    },
    { candidate: first },
  );
  await call(
    "reviewer",
    1600,
    60,
    [
      toolUse("r4", "report", {
        kind: "review",
        verdict: "REQUEST_CHANGES",
        summary: MARKER,
        detail: MARKER,
      }),
    ],
    { input: 100, read: 7000, write: 200, output: 700, thinking: 400 },
    { candidate: first },
  );

  // The box reaches its lifetime and the job continues in a new box (journal 193's
  // CodingController.stopped with cause lifetime, then continueAfterLifetime).
  const one = await f.row(jobId);
  await db.query(
    `WITH changed AS (UPDATE coding_jobs SET state='paused',stage='paused',summary=$3,cleanup='none',model_busy=false,updated_at=now() WHERE id=$1 AND attempt_id=$2 RETURNING id)
     INSERT INTO coding_events(job_id,event_key,payload,delivery) SELECT id,$4,jsonb_build_object('summary',$3::text,'cause','lifetime'),'suppressed' FROM changed`,
    [
      one.id,
      one.attempt_id,
      "The coding box reached its time limit",
      `${one.attempt_id}:paused`,
    ],
  );
  await stamp(1700);
  await db.query(
    `WITH changed AS (
      UPDATE coding_jobs SET revision=revision+1,state='queued',stage='queued',question='',result=NULL,attempt_id=NULL,sandbox_id=NULL,heartbeat_at=NULL,attempt_deadline=NULL,model_busy=false,publication_started=false,lease=NULL,lease_until=NULL,summary='Continuing in a new coding box',updated_at=now()
      WHERE id=$1 AND revision=$2 AND attempt_id=$3 AND state='paused' RETURNING id,revision,mode
    ), revised AS (
      INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) SELECT id,revision,$4,'The coding box reached its lifetime; continued in a new box',mode FROM changed RETURNING job_id
    ) INSERT INTO coding_events(job_id,event_key,payload) SELECT job_id,$4,jsonb_build_object('summary','The coding box reached its time limit; the job continues in a new box.') FROM revised`,
    [one.id, one.revision, one.attempt_id, `continue-box:${one.attempt_id}`],
  );
  await stamp(1800);
  await f.c.tick();
  await stamp(1860);
  await box(1860, 600_000);
  assert.notEqual((await f.row(jobId)).attempt_id, one.attempt_id);

  // Coder run 2, attempt 2, then review round 2 approves.
  await call(
    "coder",
    1900,
    30,
    [toolUse("t8", "edit", { path: "sum.js", edits: [] })],
    { input: 2500, read: 0, write: 0, output: 300, thinking: 100 },
  );
  await call(
    "coder",
    2000,
    30,
    [toolUse("t9", "report", { kind: "done", summary: MARKER, detail: "" })],
    { input: 100, read: 2500, write: 100, output: 80, thinking: 20 },
  );
  const checkpoint2 = {
    ...checkpoint1,
    patch: "p2",
    files: [{ path: "sum.js", content: "v2\n" }],
  };
  await f.c.save(await f.row(jobId), checkpoint2);
  await stamp(2040);
  const second = artifactHash(checkpoint2 as any);
  await call(
    "reviewer",
    2100,
    60,
    [bash("r5", "git diff reviewed candidate")],
    { input: 400, read: 7300, write: 300, output: 200, thinking: 120 },
    { candidate: second },
  );
  await call(
    "reviewer",
    2200,
    60,
    [
      toolUse("r6", "report", {
        kind: "review",
        verdict: "APPROVE",
        summary: "Fine",
        detail: "Fine.",
      }),
    ],
    { input: 50, read: 8000, write: 50, output: 100, thinking: 60 },
    { candidate: second },
  );
  const approved = {
    ...checkpoint2,
    piState: {
      version: 1,
      phase: "review",
      delivered: [ownerItem.id],
      reportDocument: reportDocument({
        kind: "review",
        summary: "Fine",
        detail: "Fine.",
        verdict: "APPROVE",
      }),
    },
  };
  await f.c.save(await f.row(jobId), approved);
  await stamp(2270);
  const candidate = {
    kind: "candidate",
    summary: "Done",
    question: "",
    checkpoint: approved,
    review: {
      verdict: "APPROVE",
      findings: "Fine.",
      model: piSettings.reviewerModel,
      patchHash: second,
    },
  };
  assert.deepEqual(
    await f.c.approvePublication(await f.row(jobId), candidate),
    { accepted: true },
  );
  await stamp(2280);
  await f.c.finish(await f.row(jobId), candidate);
  await stamp(2290);
  for (let i = 0; i < 5 && !(await f.row(jobId)).pr_url; i++) await f.c.tick();
  assert.equal((await f.row(jobId)).state, "pr_ready");
  await stamp(2300);

  // CI fails on the PR: the automation's inbox item and feedback round (src/coding/automation.ts).
  const pr = await f.row(jobId);
  await db.query(
    `INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'inbox:gh:ci:run-7',$2::jsonb,'suppressed')`,
    [
      jobId,
      JSON.stringify({ kind: "inbox", seq: 0, source: "ci", text: MARKER }),
    ],
  );
  await db.query(
    "INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) VALUES($1,$2,$3,$4,'implement')",
    [jobId, pr.revision + 1, `mr-feedback:${"e".repeat(64)}`, MARKER],
  );
  await stamp(2400);
  return { f, db, jobId, usages, first, second };
}

const row = (rows: Row[] | undefined, match: Record<string, string>) => {
  const found = (rows ?? []).find((r) =>
    Object.entries(match).every(([k, v]) => r[k] === v),
  );
  assert(
    found,
    `a row matching ${JSON.stringify(match)} in ${JSON.stringify(rows)}`,
  );
  return found;
};

test("the coding-job profile reports a one-session job's time, cost, loop, tools and context without printing contents", async (t) => {
  const { db, jobId, usages, first, second } = await syntheticJob(t);
  const { text, sections } = await profile(db, jobId.slice(0, 8));
  // Nothing private is printed: no message, thinking, tool argument, owner message, report or
  // revision text.
  assert(!text.includes(MARKER), text);
  assert(!text.includes("Private reasoning"));
  assert(!text.includes("empty case"));

  // 1. Summary.
  const [s] = sections["1"]!;
  assert.equal(s!.job, jobId.slice(0, 8));
  assert.equal(s!.state, "pr_ready");
  assert.equal(s!.start_at_min, "10.0");
  assert.equal(s!.waiting_before_start_min, "10.0");
  // The box lifetime was continued by the host, so it is not owner time.
  assert.equal(s!.waiting_at_asks_and_pauses_min, "0.0");
  assert.equal(s!.ended, "false");
  assert.equal(s!.last_activity_min, "40.0");
  assert.equal(s!.machine_min, "29.0");
  assert.equal(s!.machine_since_owner_min, "29.0");
  assert.equal(s!.boxes, "2");
  assert.equal(s!.attempts, "2");
  assert.equal(s!.coder_runs, "2");
  assert.equal(s!.review_rounds, "2");
  assert.equal(s!.findings_reports, "1");
  assert.equal(s!.approvals, "1");
  assert.equal(s!.rebases, "0");
  assert.equal(s!.pr_feedback_rounds, "1");
  assert.equal(s!.has_pr, "true");
  assert.equal(s!.pr_number, "1");

  // 1b. Owner waits.
  assert.deepEqual(sections["1b"], [
    {
      wait: "before Start",
      from_min: "0.0",
      to_min: "10.0",
      minutes: "10.0",
      resumed_by: "owner",
    },
    {
      wait: "box lifetime",
      from_min: minutes(1700),
      to_min: "30.0",
      minutes: minutes(100),
      resumed_by: "automatic",
    },
  ]);

  // 1c. Attempts and why each ended.
  const [a1, a2] = sections["1c"]!;
  assert.match(a1!.attempt!, /^1 [0-9a-f]{8}$/);
  assert.deepEqual(
    { ...a1, attempt: undefined },
    {
      attempt: undefined,
      box: "terminated",
      start_min: "11.0",
      wall_min: minutes(1700 - 660),
      machine_min: "19.0",
      coder_calls: "6",
      reviewer_calls: "2",
      ended: "box lifetime, continued",
    },
  );
  assert.deepEqual(
    { ...a2, attempt: undefined },
    {
      attempt: undefined,
      box: "terminated",
      start_min: "31.0",
      wall_min: minutes(2300 - 1860),
      machine_min: "10.0",
      coder_calls: "2",
      reviewer_calls: "2",
      ended: "done (PR opened)",
    },
  );

  // 2. Cost and tokens by role and purpose; the total is the sum of the rows.
  const expected = (filter: (x: (typeof usages)[number]) => boolean) => {
    const xs = usages.filter(filter);
    const sum = (k: (u: Usage) => number) => xs.reduce((n, x) => n + k(x.u), 0);
    const output = sum((u) => u.output);
    const withThinking = xs.filter((x) => x.u.thinking !== undefined);
    const thinkingTokens = withThinking.reduce((n, x) => n + x.u.thinking!, 0);
    const thinkingOutput = withThinking.reduce((n, x) => n + x.u.output, 0);
    return {
      calls: String(xs.length),
      incomplete: "0",
      input: String(sum((u) => u.input)),
      cache_read: String(sum((u) => u.read)),
      cache_write: String(sum((u) => u.write)),
      write_1h: String(sum((u) => u.write1h ?? 0)),
      output: String(output),
      thinking: withThinking.length ? String(thinkingTokens) : "-",
      thinking_pct: withThinking.length
        ? (Math.round((1000 * thinkingTokens) / thinkingOutput) / 10).toFixed(1)
        : "-",
      cost_usd: (Math.round(sum(cost) * 1e4) / 1e4).toFixed(4),
      thinking_dropped: "0",
    };
  };
  const cut = (r: Row) => {
    const { role: _r, purpose: _p, ...rest } = r;
    return rest;
  };
  for (const [role, purpose] of [
    ["coder", "agent"],
    ["coder", "cache_warm"],
    ["coder", "compaction"],
    ["reviewer", "agent"],
  ] as const)
    assert.deepEqual(
      cut(row(sections["2"], { role, purpose })),
      expected((x) => x.role === role && x.purpose === purpose),
      `${role} ${purpose}`,
    );
  assert.deepEqual(
    cut(row(sections["2"], { role: "total" })),
    expected(() => true),
  );
  assert.equal(sections["2"]!.length, 5);
  // Spot-check one row by hand: the first coder call's 1-hour write costs twice the input price.
  assert.equal(
    row(sections["2"], { role: "coder", purpose: "agent" }).write_1h,
    "2000",
  );
  assert.equal(
    row(sections["2"], { role: "coder", purpose: "agent" }).thinking_pct,
    "34.4",
  );

  // 3. The loop in order.
  const runCost = (seconds: number[]) =>
    (
      Math.round(
        usages
          .filter((_, i) => seconds.includes(i))
          .reduce((n, x) => n + cost(x.u), 0) * 1e4,
      ) / 1e4
    ).toFixed(4);
  assert.deepEqual(sections["3"], [
    {
      run: "coder run 1",
      attempt: "1",
      start_min: minutes(700),
      minutes: minutes(1430 - 700),
      agent_calls: "4",
      cache_warm: "1",
      compaction: "1",
      unfinished: "0",
      cost_usd: runCost([0, 1, 2, 3, 4, 5]),
      report: "done",
      candidate: "-",
    },
    {
      run: "review round 1",
      attempt: "1",
      start_min: "25.0",
      minutes: minutes(160),
      agent_calls: "2",
      cache_warm: "0",
      compaction: "0",
      unfinished: "0",
      cost_usd: runCost([6, 7]),
      report: "REQUEST_CHANGES",
      candidate: first.slice(0, 12),
    },
    {
      run: "coder run 2",
      attempt: "2",
      start_min: minutes(1900),
      minutes: minutes(130),
      agent_calls: "2",
      cache_warm: "0",
      compaction: "0",
      unfinished: "0",
      cost_usd: runCost([8, 9]),
      report: "done",
      candidate: "-",
    },
    {
      run: "review round 2",
      attempt: "2",
      start_min: "35.0",
      minutes: minutes(160),
      agent_calls: "2",
      cache_warm: "0",
      compaction: "0",
      unfinished: "0",
      cost_usd: runCost([10, 11]),
      report: "APPROVE",
      candidate: second.slice(0, 12),
    },
  ]);

  // 3b. Milestones.
  assert.deepEqual(
    sections["3b"]!.map((r) => [r.at_min, r.attempt, r.what, r.detail]),
    [
      ["0.0", "-", "coding_start", "-"],
      ["10.0", "-", "Start", "-"],
      [minutes(1700), "1", "paused", "lifetime"],
      ["30.0", "-", "continued in a new box", "-"],
      ["38.0", "2", "publication committed", second.slice(0, 12)],
      [minutes(2290), "2", "finished", "candidate"],
      [minutes(2300), "2", "PR opened", "#1"],
      ["40.0", "-", "PR feedback round", "-"],
    ],
  );

  // 3c. Inbox items: the owner's message reached the coder at its next call; CI's is waiting.
  assert.deepEqual(sections["3c"], [
    {
      source: "owner",
      at_min: minutes(1150),
      held: "false",
      delivered: "true",
      first_seen_min: "20.0",
      seen_by: "coder",
    },
    {
      source: "ci",
      at_min: "40.0",
      held: "false",
      delivered: "false",
      first_seen_min: "-",
      seen_by: "-",
    },
  ]);

  // 4. Tool calls per turn, including parallel calls.
  assert.deepEqual(sections["4"], [
    {
      role: "coder",
      turns: "6",
      no_tool: "0",
      one: "4",
      two: "1",
      three_or_more: "1",
      tool_calls: "9",
      most_in_one_turn: "3",
    },
    {
      role: "reviewer",
      turns: "4",
      no_tool: "0",
      one: "3",
      two: "0",
      three_or_more: "1",
      tool_calls: "6",
      most_in_one_turn: "3",
    },
  ]);
  assert.deepEqual(
    sections["4b"]!.map((r) => `${r.role} ${r.tool} ${r.calls}`),
    [
      "coder bash 2",
      "coder edit 2",
      "coder report 2",
      "coder grep 1",
      "coder read 1",
      "coder write 1",
      "reviewer bash 3",
      "reviewer report 2",
      "reviewer read 1",
    ],
  );
  assert.deepEqual(
    sections["4c"]!.map((r) => `${r.role} ${r.class} ${r.calls}`),
    [
      "coder read 1",
      "coder tests or build 1",
      "reviewer git 2",
      "reviewer tests or build 1",
    ],
  );
  assert.deepEqual(sections["4d"], [
    {
      role: "coder",
      agent_calls: "6",
      calls_before_first_edit: "2",
      min_to_first_edit: minutes(500),
      largest_context: "7800",
      largest_at_min: "20.0",
    },
    {
      role: "reviewer",
      agent_calls: "4",
      calls_before_first_edit: "-",
      min_to_first_edit: "-",
      largest_context: "8100",
      largest_at_min: minutes(2200),
    },
  ]);

  // 5. Context over the runs and Pi's compaction.
  assert.deepEqual(
    sections["5"]!.map((r) => [
      r.role,
      r.run,
      r.agent_calls,
      r.first,
      r.median,
      r.max,
      r.last,
      r.compactions,
    ]),
    [
      ["coder", "1", "4", "7000", "6700", "7800", "2000", "1"],
      ["coder", "2", "2", "2500", "2500", "2700", "2700", "0"],
      ["coder", "all", "6", "7000", "2700", "7800", "2700", "1"],
      ["reviewer", "1", "2", "7000", "7000", "7300", "7300", "0"],
      ["reviewer", "2", "2", "8000", "8000", "8100", "8100", "0"],
      ["reviewer", "all", "4", "7000", "7300", "8100", "8100", "0"],
    ],
  );
  assert.deepEqual(sections["5b"], [
    {
      role: "coder",
      at_min: minutes(1300),
      state: "complete",
      summarised_context: "7800",
      next_context: "2000",
    },
  ]);
});

test("the profile stops with one line for an old-loop job, a prefix that matches nothing, or no prefix", async (t) => {
  const f = await fixture(t);
  const started = await f.start("old");
  await f.c.tick();
  const job = await f.row(started.id);
  // An old-loop Pi job: an OpenAI-shaped call record without the request's shape.
  await f.db.query(
    'UPDATE coding_jobs SET settings=settings || \'{"runtime":"pi"}\'::jsonb WHERE id=$1',
    [job.id],
  );
  await f.db.query(
    "INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,state,input,result) VALUES($1,$2,$3,'coder','h','complete',$4::jsonb,$5::jsonb)",
    [
      randomUUID(),
      job.id,
      job.attempt_id,
      JSON.stringify({ messages: [{ role: "user", content: MARKER }] }),
      JSON.stringify({
        message: { role: "assistant", content: MARKER, tool_calls: [] },
      }),
    ],
  );
  const old = await profile(f.db, job.id.slice(0, 8));
  assert.match(old.text, /^This job was recorded by the old coding loop/);
  assert.equal(old.text.split("\n").length, 1);
  assert.deepEqual(old.sections, {});
  // A legacy-runtime job is old too.
  await f.db.query("DELETE FROM coding_model_calls WHERE job_id=$1", [job.id]);
  await f.db.query(
    "UPDATE coding_jobs SET settings=settings - 'runtime' WHERE id=$1",
    [job.id],
  );
  assert.match(
    (await profile(f.db, job.id)).text,
    /^This job was recorded by the old coding loop/,
  );
  assert.equal(
    (await profile(f.db, "ffffffff")).text,
    "No coding job matches that id prefix.",
  );
  // A quote cannot leave the prefix's string literal.
  assert.equal(
    (await profile(f.db, "a'; SELECT 1; --")).text,
    "No coding job matches that id prefix.",
  );
  assert.match((await profile(f.db)).text, /^Usage: psql -v job=/);
});

test("the profile script writes nothing and runs no dynamic SQL", async () => {
  const text = await readFile(SCRIPT, "utf8");
  // psql commands: only display settings, conditionals, \gset, \echo and \quit.
  for (const line of text.split("\n")) {
    const command = /^\s*(\\[a-z!?]+)/.exec(line)?.[1];
    if (command)
      assert(
        [
          "\\set",
          "\\pset",
          "\\if",
          "\\elif",
          "\\else",
          "\\endif",
          "\\echo",
          "\\quit",
          "\\x",
        ].includes(command),
        `psql command ${command}`,
      );
    assert(
      !/\\(g|gx|gexec|o|copy|!|i|ir|w|lo_)\b/.test(
        line.replace(/\\gset\s*$/, ""),
      ),
      line,
    );
  }
  const sql = text
    .split("\n")
    .filter((l) => !/^\s*(--|\\)/.test(l))
    .join("\n")
    .replace(/\\gset/g, ";")
    // String literals hold names such as 'write' and 'edit'; only code is checked.
    .replace(/'(?:[^']|'')*'/g, "''");
  assert.match(text, /^BEGIN READ ONLY;$/m);
  assert.match(text, /^SET LOCAL statement_timeout = '60s';$/m);
  assert.match(text, /^SET LOCAL lock_timeout = '2s';$/m);
  assert.match(text.trimEnd(), /ROLLBACK;$/);
  for (const word of [
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "TRUNCATE",
    "CREATE",
    "ALTER",
    "DROP",
    "GRANT",
    "REVOKE",
    "COPY",
    "CALL",
    "DO",
    "EXECUTE",
    "PREPARE",
    "LOCK",
    "VACUUM",
    "ANALYZE",
    "REFRESH",
    "CLUSTER",
    "REINDEX",
    "COMMENT",
    "NOTIFY",
    "LISTEN",
    "COMMIT",
    "SAVEPOINT",
    "nextval",
    "setval",
    "set_config",
    "pg_advisory_lock",
    "pg_advisory_xact_lock",
    "dblink",
    "lo_import",
    "lo_export",
    "pg_read_file",
    "pg_sleep",
    "format",
    "query_to_xml",
  ])
    assert(
      !new RegExp(`\\b${word}\\b`, "i").test(sql),
      `the script contains ${word}`,
    );
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    assert.match(
      statement,
      /^(SELECT\s|WITH\s|BEGIN READ ONLY$|SET LOCAL (statement|lock)_timeout = ''$|ROLLBACK$)/,
      statement,
    );
  // Every statement that reads a job's tables names the one job.
  const statements = text
    .split("\n")
    .filter((l) => !/^\s*(--|\\(?!gset))/.test(l))
    .join("\n")
    .split(/;\s*$|\\gset\s*$/m);
  for (const statement of statements)
    if (
      /\b(coding_events|coding_model_calls|coding_revisions|coding_jobs|boxes)\b/.test(
        statement,
      )
    )
      assert.match(statement, /:'(profile_job|job)'/, statement);
});
