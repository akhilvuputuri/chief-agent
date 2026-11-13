import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  base,
  fixture,
  settings,
  startCard,
} from "./helpers/coding-fixture.js";
import { BOX_SAVE_MS, codingSettings } from "../src/coding/schema.js";
import { CodingAutomation } from "../src/coding/automation.js";
import type { PrInspection } from "../src/coding/merge-policy.js";
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
 * Runs scripts/coding-job-profile.sql as psql would, against the test database: \pset and \x
 * are display settings and ignored; \set, \if/\elif/\else/\endif, \gset, \echo and \quit are
 * followed; :'name' is quoted as psql quotes it. With ON_ERROR_ROLLBACK on and ON_ERROR_STOP off
 * a failed statement is rolled back to a savepoint set before it, its error is printed and the
 * run goes on, setting ERROR as psql does. Returns the printed text and each section's rows
 * under the number its \echo heading gives. `fail` makes the statement of that section fail
 * in the database, to show what a timed-out section leaves; `fail: "calls"` fails the
 * statement that reads the model calls.
 */
async function profile(
  db: { query: (sql: string, params?: unknown[]) => Promise<any> },
  job?: string,
  fail?: string,
) {
  const text = await readFile(SCRIPT, "utf8");
  const vars: Record<string, string> = job === undefined ? {} : { job };
  vars.ERROR = "false";
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
        if (command === "\\set") {
          const [name, ...value] = rest;
          vars[name!] = value.join(" ").replace(/^'(.*)'$/, "$1");
          continue;
        }
        if (["\\pset", "\\x"].includes(command!)) continue;
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
      // psql sets no savepoint around a statement that ends the transaction.
      const rollback =
        vars.ON_ERROR_ROLLBACK === "on" && !/^\s*(ROLLBACK|COMMIT)\b/.test(sql);
      let result: any;
      try {
        if (rollback) await db.query("SAVEPOINT psql_statement");
        const failing =
          fail === "calls"
            ? gset && sql.includes("AS profile_calls")
            : !gset && section === fail;
        result = await db.query(failing ? "SELECT 1/0 AS failed" : sql);
        if (rollback) await db.query("RELEASE SAVEPOINT psql_statement");
        vars.ERROR = "false";
      } catch (error) {
        if (!rollback || vars.ON_ERROR_STOP !== "off") throw error;
        await db.query("ROLLBACK TO SAVEPOINT psql_statement");
        vars.ERROR = "true";
        printed.push(`ERROR:  ${(error as Error).message}`);
        continue;
      }
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

const HOUR = 3_600_000;

/**
 * A synthetic job on the one-session loop, built through the host's own code: coding_start
 * and the owner's Start, the tick and heartbeat, every model call through piMessages
 * (Anthropic streams recorded by the host), an owner follow-up through coding_reply,
 * checkpoints, the box reaching its lifetime (finish with the host's lifetime cause and the
 * continuation in a new box), the publication commit, finish and the PR, and the PR's own
 * automation: an hour waiting for CI, a clean and a conflicting rebase onto main, and a CI
 * failure with a review comment as a feedback round. The test writes only what a box and
 * GitHub would supply: the boxes controller's rows (the fixture has no boxes), the worker's
 * checkpoints and model requests, and the PR readings.
 */
async function syntheticJob(t: TestContext) {
  const piSettings = codingSettings.parse({
    ...settings,
    limits: undefined,
    runtime: "pi",
    squad: false,
    autoMerge: false,
    prWorkflow: "owner_merge",
    effort: "medium",
    maxOutputTokens: 32000,
    reviewerMaxOutputTokens: 16000,
  });
  const f = await fixture(t, { settings: piSettings });
  const db = f.db;
  // GitHub's publisher also returns the PR's tree, which starts the PR's automation; the
  // controller builds its automation exactly as when its publisher has one.
  const tree = "c".repeat(40);
  const publish = f.publisher.publish;
  (f.publisher as any).publish = async () => ({ ...(await publish()), tree });
  let inspection: PrInspection = {
    head: "b".repeat(40),
    tree,
    base,
    main: base,
    merged: false,
    closed: false,
    draft: true,
    mergeable: true,
    checks: "pending",
    feedback: [],
    unresolvedThreads: 0,
  };
  const reading = (i: Partial<PrInspection>) =>
    (inspection = { ...inspection, ...i });
  const controller = f.c as any;
  controller.automation = new CodingAutomation(
    db,
    {
      outcome: async () => inspection,
      inspect: async () => inspection,
      ready: async () => reading({ draft: false }),
      attest: async () => {},
      merge: async () => ({ sha: "d".repeat(40) }),
      release: async () => "pending",
    } as any,
    () => true,
    (job) => controller.hasReviewerProof(job),
    controller.clock,
    (job) => f.c.requirements.approved(job),
    (job) => f.c.machineSpent(job),
  );
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
  const job = () => f.row(jobId);
  await stamp(0);
  await f.c.requirements.confirm("a", card.approvalId, "a", card.messageId);
  await stamp(600);
  /** A new attempt: the tick provisions it and the worker's first heartbeat arrives. */
  const attempt = async (seconds: number, runningMs: number) => {
    const before = (await job()).attempt_id;
    for (let i = 0; i < 6; i++) {
      const now = await job();
      if (now.attempt_id && now.attempt_id !== before) break;
      await f.c.tick();
    }
    const now = await job();
    assert(now.attempt_id && now.attempt_id !== before, "a new attempt");
    await f.c.heartbeat(now);
    await stamp(seconds);
    // What the boxes controller records for the attempt's box (src/boxes/controller.ts).
    await db.query(
      `INSERT INTO boxes(id,user_id,request_key,profile,provider,environment,subject,image,state,credential_hash,running_ms,absolute_deadline,created_at)
       VALUES($1,'a',$2,'coding','ec2','test',$3,'image','terminated','hash',$4,$5,$6)`,
      [
        randomUUID(),
        `coding:${now.attempt_id}`,
        `coding:${jobId}`,
        runningMs,
        at(seconds + 14400),
        at(seconds),
      ],
    );
  };
  const usages: { run: string; role: string; purpose: string; u: Usage }[] = [];
  const recorded = async () =>
    (
      await db.query(
        "SELECT count(*)::int AS n FROM coding_events WHERE job_id=$1 AND payload->>'kind'='model_usage'",
        [jobId],
      )
    ).rows[0].n;
  const call = async (
    run: string,
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
    const role = run.startsWith("coder") ? "coder" : "reviewer";
    const purpose = options.purpose ?? "agent";
    const before = await recorded();
    f.setMessages(async () => anthropicTurn(content, u));
    const reply = await f.c.piMessages(
      await job(),
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
    usages.push({ run, role, purpose, u });
  };
  const save = async (checkpoint: unknown, seconds: number) => {
    await f.c.save(await job(), checkpoint);
    await stamp(seconds);
  };
  const report = (input: Record<string, unknown>) =>
    toolUse(`report-${randomUUID()}`, "report", input);
  const approve = (run: string, seconds: number, hash: string) =>
    call(
      run,
      seconds,
      60,
      [
        report({
          kind: "review",
          verdict: "APPROVE",
          summary: "Fine",
          detail: "Fine.",
        }),
      ],
      { input: 50, read: 8000, write: 50, output: 100, thinking: 60 },
      { candidate: hash },
    );
  /** The worker's approved checkpoint, the publication commit, finish and the PR. */
  const publishApproved = async (cp: any, hash: string, seconds: number) => {
    const approved = {
      ...cp,
      piState: {
        ...cp.piState,
        phase: "review",
        reportDocument: reportDocument({
          kind: "review",
          summary: "Fine",
          detail: "Fine.",
          verdict: "APPROVE",
        }),
      },
    };
    await save(approved, seconds);
    const candidate = {
      kind: "candidate",
      summary: "Done",
      question: "",
      checkpoint: approved,
      review: {
        verdict: "APPROVE",
        findings: "Fine.",
        model: piSettings.reviewerModel,
        patchHash: hash,
      },
    };
    assert.deepEqual(await f.c.approvePublication(await job(), candidate), {
      accepted: true,
    });
    await stamp(seconds + 10);
    await f.c.finish(await job(), candidate);
    await stamp(seconds + 20);
    // Published, and the box cleaned up, before the PR's automation reads it.
    const settled = async () => {
      const now = await job();
      return now.state === "pr_ready" && now.cleanup !== "pending";
    };
    for (let i = 0; i < 6 && !(await settled()); i++) await f.c.tick();
    assert(await settled(), "published with its box cleaned up");
    await stamp(seconds + 30);
  };
  const inboxItem = async (like: string) =>
    (
      await db.query(
        "SELECT id,event_key,payload FROM coding_events WHERE job_id=$1 AND event_key LIKE $2 ORDER BY created_at DESC LIMIT 1",
        [jobId, like],
      )
    ).rows[0];

  await attempt(660, 19 * 60_000);
  // Coder run 1, attempt 1: three tools in parallel, then a test run, a cache-warming replay,
  // an owner message, an edit and a write in parallel, Pi's compaction and the report.
  await call(
    "coder run 1",
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
    "coder run 1",
    800,
    30,
    [bash("t4", `cd /work && CI=1 kite run check -- ${MARKER}`)],
    { input: 200, read: 6000, write: 500, output: 100, thinking: 40 },
  );
  await call(
    "coder run 1",
    1100,
    1,
    [{ type: "text", text: "" }],
    { input: 10, read: 6700, write: 0, output: 1 },
    { purpose: "cache_warm", maxTokens: 1 },
  );
  const replied: any = await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: jobId,
    baseRevision: (await job()).revision,
    requestKey: "owner-1",
    message: `Also handle the empty case. ${MARKER}`,
  });
  assert.equal(replied.state, "running");
  await stamp(1150);
  const owner = await inboxItem("inbox:reply:owner-1");
  assert.equal(owner.payload.source, "owner");
  await call(
    "coder run 1",
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
            id: owner.id,
            source: "owner",
            text: owner.payload.text,
          }),
        },
      ],
    },
  );
  await call(
    "coder run 1",
    1300,
    60,
    [{ type: "text", text: `Summary of the session ${MARKER}` }],
    { input: 500, read: 7300, write: 0, output: 900 },
    { purpose: "compaction" },
  );
  await call(
    "coder run 1",
    1400,
    30,
    [report({ kind: "done", summary: MARKER, detail: MARKER })],
    { input: 2000, read: 0, write: 0, output: 150, thinking: 50 },
  );
  const checkpoint1 = {
    plan: "",
    patch: "p1",
    summary: "s1",
    files: [{ path: "sum.js", content: "v1\n" }],
    piState: { version: 1, phase: "build", base, delivered: [owner.id] },
  };
  await save(checkpoint1, 1440);
  const first = artifactHash(checkpoint1 as any);

  // Review round 1: three tools in parallel, then findings.
  await call(
    "review round 1",
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
  // The box reaches its lifetime in the middle of review round 1: the worker stops a save
  // margin before the host's deadline and finishes paused; the host records the cause and
  // continues in a new box (journal 193), where the same round goes on.
  const one = await job();
  f.advance(3 * HOUR - BOX_SAVE_MS + 1000);
  assert.deepEqual(
    await f.c.finish(one, {
      kind: "paused",
      summary: "The coding box reached its time limit",
      question: "",
      checkpoint: one.checkpoint,
    }),
    { accepted: true },
  );
  await stamp(1540);
  await attempt(1560, 10 * 60_000);
  assert.equal(
    (
      await db.query(
        "SELECT payload->>'cause' AS cause FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [jobId, `${one.attempt_id}:finished`],
      )
    ).rows[0].cause,
    "lifetime",
  );

  await call(
    "review round 1",
    1600,
    60,
    [
      report({
        kind: "review",
        verdict: "REQUEST_CHANGES",
        summary: MARKER,
        detail: MARKER,
      }),
    ],
    { input: 100, read: 7000, write: 200, output: 700, thinking: 400 },
    { candidate: first },
  );

  // Coder run 2, still attempt 2, then review round 2 approves and the PR opens.
  await call(
    "coder run 2",
    1900,
    30,
    [toolUse("t8", "edit", { path: "sum.js", edits: [] })],
    { input: 2500, read: 0, write: 0, output: 300, thinking: 100 },
  );
  await call(
    "coder run 2",
    2000,
    30,
    [report({ kind: "done", summary: MARKER, detail: "" })],
    { input: 100, read: 2500, write: 100, output: 80, thinking: 20 },
  );
  const checkpoint2 = {
    ...checkpoint1,
    patch: "p2",
    files: [{ path: "sum.js", content: "v2\n" }],
  };
  await save(checkpoint2, 2040);
  const second = artifactHash(checkpoint2 as any);
  await call(
    "review round 2",
    2100,
    60,
    [bash("r5", "git diff reviewed candidate")],
    { input: 400, read: 7300, write: 300, output: 200, thinking: 120 },
    { candidate: second },
  );
  await approve("review round 2", 2200, second);
  await publishApproved(checkpoint2, second, 2270);

  // The PR waits an hour for CI: the owner hears once.
  await f.c.automationTick();
  await f.c.automationTick();
  await stamp(2310);
  f.advance(HOUR + 1000);
  await f.c.automationTick();
  await stamp(2400);
  assert(await inboxItem("ci-wait:%"), "the CI-wait notice");

  // Main moves and the PR conflicts: the job goes back to a box to be rebased. Git rebases it
  // cleanly there, so it goes straight to review.
  const moved1 = "e".repeat(40);
  reading({ checks: "passed", draft: false, main: moved1, mergeable: false });
  await f.c.automationTick();
  await stamp(2500);
  const rebase1 = await inboxItem("inbox:rebase:%");
  assert.equal(rebase1.payload.onto, moved1);
  await attempt(2560, 5 * 60_000);
  const rebased = {
    ...checkpoint2,
    piState: {
      version: 1,
      phase: "build",
      base: moved1,
      delivered: [owner.id, rebase1.id],
      next: { step: "review", hash: second },
    },
  };
  await save(rebased, 2580);
  await approve("review round 3", 2600, second);
  await publishApproved(rebased, second, 2650);

  // Main moves again; this time git leaves conflicts and the coder resolves them.
  const moved2 = "f".repeat(40);
  reading({ main: moved2, mergeable: false });
  await f.c.automationTick();
  await stamp(2700);
  const rebase2 = await inboxItem("inbox:rebase:%");
  assert.equal(rebase2.payload.onto, moved2);
  await attempt(2760, 6 * 60_000);
  await save(
    {
      ...checkpoint2,
      files: [{ path: "sum.js", content: "<<<<<<< conflict\n" }],
      piState: {
        version: 1,
        phase: "build",
        base: moved2,
        delivered: [owner.id, rebase1.id],
        conflicts: [{ path: "sum.js", status: "UU", markers: true }],
      },
    },
    2780,
  );
  await call(
    "coder run 3",
    2800,
    30,
    [toolUse("t10", "edit", { path: "sum.js", edits: [] })],
    { input: 3000, read: 0, write: 0, output: 200, thinking: 90 },
    {
      extra: [
        {
          role: "user",
          content: inboxMessage({
            id: rebase2.id,
            source: "rebase",
            text: `Main moved and the pull request conflicted with it: sum.js ${MARKER}`,
          }),
        },
      ],
    },
  );
  await call(
    "coder run 3",
    2850,
    20,
    [report({ kind: "done", summary: MARKER, detail: "" })],
    { input: 100, read: 3000, write: 50, output: 60, thinking: 10 },
  );
  const checkpoint3 = {
    plan: "",
    patch: "p3",
    summary: "s3",
    files: [{ path: "sum.js", content: "v3\n" }],
    piState: {
      version: 1,
      phase: "build",
      base: moved2,
      delivered: [owner.id, rebase1.id, rebase2.id],
    },
  };
  await save(checkpoint3, 2880);
  const third = artifactHash(checkpoint3 as any);
  await approve("review round 4", 2900, third);
  await publishApproved(checkpoint3, third, 2950);

  // CI fails and a trusted reviewer comments: one feedback round with two inbox items.
  reading({
    checks: "failed",
    mergeable: true,
    feedback: [
      { id: "ci:1:1:9", text: `{"job":"test","log":"${MARKER}"}` },
      { id: "devin-1", text: `Devin: ${MARKER}` },
    ],
  });
  await f.c.automationTick();
  assert.equal((await job()).state, "queued");
  await stamp(3000);
  return { db, jobId, usages, first, second, third, moved1, moved2 };
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

test("the coding-job profile reports a one-session job's time, cost, loop, rebases, tools and context without printing contents", async (t) => {
  const { db, jobId, usages, first, second, third, moved1, moved2 } =
    await syntheticJob(t);
  const { text, sections } = await profile(db, jobId.slice(0, 8));
  if (process.env.SHOW_PROFILE) console.log(text);
  // Nothing private is printed: no message, thinking, tool argument, owner message, report,
  // CI log, review comment or revision text.
  assert(!text.includes(MARKER), text);
  assert(!text.includes("Private reasoning"));
  assert(!text.includes("empty case"));
  // What is approximate is said before the figures.
  assert.match(
    text,
    /^\nApproximate \(what the host does not record exactly\)/,
  );

  // 1. Summary.
  const [s] = sections["1"]!;
  assert.deepEqual(
    {
      job: s!.job,
      state: s!.state,
      start_at_min: s!.start_at_min,
      ended: s!.ended,
      last_activity_min: s!.last_activity_min,
      waiting_before_start_min: s!.waiting_before_start_min,
      waiting_at_asks_and_pauses_min: s!.waiting_at_asks_and_pauses_min,
      machine_min: s!.machine_min,
      machine_since_owner_min: s!.machine_since_owner_min,
      machine_left_of_eight_hours_min: s!.machine_left_of_eight_hours_min,
      eight_hour_pauses: s!.eight_hour_pauses,
      boxes: s!.boxes,
      attempts: s!.attempts,
      coder_runs: s!.coder_runs,
      review_rounds: s!.review_rounds,
      findings_reports: s!.findings_reports,
      approvals: s!.approvals,
      rebases: s!.rebases,
      conflicting_rebases: s!.conflicting_rebases,
      pr_feedback_rounds: s!.pr_feedback_rounds,
      has_pr: s!.has_pr,
      pr_number: s!.pr_number,
    },
    {
      job: jobId.slice(0, 8),
      state: "queued",
      start_at_min: "10.0",
      ended: "false",
      last_activity_min: "50.0",
      waiting_before_start_min: "10.0",
      // The box lifetime was continued by the host, so it is not owner time.
      waiting_at_asks_and_pauses_min: "0.0",
      machine_min: "40.0",
      // No owner revision after Start: every box counts toward the eight hours.
      machine_since_owner_min: "40.0",
      machine_left_of_eight_hours_min: "440.0",
      eight_hour_pauses: "0",
      boxes: "4",
      attempts: "4",
      coder_runs: "3",
      review_rounds: "4",
      findings_reports: "1",
      approvals: "3",
      rebases: "2",
      conflicting_rebases: "1",
      pr_feedback_rounds: "1",
      has_pr: "true",
      pr_number: "1",
    },
  );

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
      from_min: minutes(1540),
      to_min: "26.0",
      minutes: minutes(20),
      resumed_by: "automatic",
    },
  ]);

  // 1c. Attempts and the recorded reason each ended.
  assert.deepEqual(
    sections["1c"]!.map((r) => [
      r.attempt!.split(" ")[0],
      r.start_min,
      r.machine_min,
      r.coder_calls,
      r.reviewer_calls,
      r.ended,
    ]),
    [
      ["1", "11.0", "19.0", "6", "1", "box lifetime, continued"],
      ["2", "26.0", "10.0", "2", "3", "done (PR opened)"],
      ["3", minutes(2560), "5.0", "0", "1", "done (PR opened)"],
      ["4", "46.0", "6.0", "2", "1", "done (PR opened)"],
    ],
  );

  // 2. Cost and tokens by role and purpose; the total is the sum of the rows.
  const expected = (filter: (x: (typeof usages)[number]) => boolean) => {
    const xs = usages.filter(filter);
    const sum = (k: (u: Usage) => number) => xs.reduce((n, x) => n + k(x.u), 0);
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
      output: String(sum((u) => u.output)),
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
  assert.equal(
    row(sections["2"], { role: "coder", purpose: "agent" }).write_1h,
    "2000",
  );

  // 3. The loop in order, each run's cost from its own calls.
  const runCost = (run: string) =>
    (
      Math.round(
        usages.filter((x) => x.run === run).reduce((n, x) => n + cost(x.u), 0) *
          1e4,
      ) / 1e4
    ).toFixed(4);
  const runs = sections["3"]!;
  assert.deepEqual(
    runs.map((r) => [
      r.run,
      r.attempt,
      r.start_min,
      r.minutes,
      r.agent_calls,
      r.cache_warm,
      r.compaction,
      r.report,
      r.candidate,
    ]),
    [
      [
        "coder run 1",
        "1",
        minutes(700),
        minutes(730),
        "4",
        "1",
        "1",
        "done",
        "-",
      ],
      [
        "review round 1",
        "1-2",
        "25.0",
        minutes(160),
        "2",
        "0",
        "0",
        "REQUEST_CHANGES",
        first.slice(0, 12),
      ],
      [
        "coder run 2",
        "2",
        minutes(1900),
        minutes(130),
        "2",
        "0",
        "0",
        "done",
        "-",
      ],
      [
        "review round 2",
        "2",
        "35.0",
        minutes(160),
        "2",
        "0",
        "0",
        "APPROVE",
        second.slice(0, 12),
      ],
      [
        "review round 3",
        "3",
        minutes(2600),
        "1.0",
        "1",
        "0",
        "0",
        "APPROVE",
        second.slice(0, 12),
      ],
      [
        "coder run 3",
        "4",
        minutes(2800),
        minutes(70),
        "2",
        "0",
        "0",
        "done",
        "-",
      ],
      [
        "review round 4",
        "4",
        minutes(2900),
        "1.0",
        "1",
        "0",
        "0",
        "APPROVE",
        third.slice(0, 12),
      ],
    ],
  );
  for (const r of runs) assert.equal(r.cost_usd, runCost(r.run!), r.run);

  // 3b. Milestones.
  assert.deepEqual(
    sections["3b"]!.map((r) => [r.at_min, r.attempt, r.what, r.detail]),
    [
      ["0.0", "-", "coding_start", "-"],
      ["10.0", "-", "Start", "-"],
      [minutes(1540), "1", "finished", "lifetime"],
      ["26.0", "-", "continued in a new box", "-"],
      ["38.0", "2", "publication committed", second.slice(0, 12)],
      [minutes(2290), "2", "finished", "candidate"],
      [minutes(2300), "2", "PR opened", "#1"],
      ["40.0", "-", "an hour waiting for CI or review", "-"],
      [minutes(2500), "-", "rebase onto main", `onto ${moved1.slice(0, 12)}`],
      [minutes(2660), "3", "publication committed", second.slice(0, 12)],
      [minutes(2670), "3", "finished", "candidate"],
      [minutes(2680), "3", "PR opened", "#1"],
      ["45.0", "-", "rebase onto main", `onto ${moved2.slice(0, 12)}`],
      [minutes(2960), "4", "publication committed", third.slice(0, 12)],
      [minutes(2970), "4", "finished", "candidate"],
      [minutes(2980), "4", "PR opened", "#1"],
      ["50.0", "-", "PR feedback round", "-"],
    ],
  );

  // 3c. Inbox items: the owner's message reached the coder at its next call; a clean rebase
  // never reaches the coder, a conflicting one does; the feedback round's items wait.
  assert.deepEqual(
    sections["3c"]!.map((r) => [
      r.source,
      r.at_min,
      r.held,
      r.delivered,
      r.first_seen_min,
      r.seen_by,
    ]),
    [
      ["owner", minutes(1150), "false", "true", "20.0", "coder"],
      ["rebase", minutes(2500), "false", "true", "-", "-"],
      ["rebase", "45.0", "false", "true", minutes(2800), "coder"],
      ["ci", "50.0", "false", "false", "-", "-"],
      ["review", "50.0", "false", "false", "-", "-"],
    ],
  );

  // 3d. Rebases and the review round that followed each.
  assert.deepEqual(sections["3d"], [
    {
      at_min: minutes(2500),
      onto: moved1.slice(0, 12),
      kind: "clean",
      coder_told_min: "-",
      review_round: "3",
      review_start_min: minutes(2600),
      verdict: "APPROVE",
    },
    {
      at_min: "45.0",
      onto: moved2.slice(0, 12),
      kind: "conflicting",
      coder_told_min: minutes(2800),
      review_round: "4",
      review_start_min: minutes(2900),
      verdict: "APPROVE",
    },
  ]);

  // 4. Tool calls per turn, including parallel calls.
  assert.deepEqual(sections["4"], [
    {
      role: "coder",
      turns: "8",
      no_tool: "0",
      one: "6",
      two: "1",
      three_or_more: "1",
      tool_calls: "11",
      most_in_one_turn: "3",
    },
    {
      role: "reviewer",
      turns: "6",
      no_tool: "0",
      one: "5",
      two: "0",
      three_or_more: "1",
      tool_calls: "8",
      most_in_one_turn: "3",
    },
  ]);
  assert.deepEqual(
    sections["4b"]!.map((r) => `${r.role} ${r.tool} ${r.calls}`),
    [
      "coder edit 3",
      "coder report 3",
      "coder bash 2",
      "coder grep 1",
      "coder read 1",
      "coder write 1",
      "reviewer report 4",
      "reviewer bash 3",
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
      agent_calls: "8",
      calls_before_first_edit: "2",
      min_to_first_edit: minutes(500),
      largest_context: "7800",
      largest_at_min: "20.0",
    },
    {
      role: "reviewer",
      agent_calls: "6",
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
      ["coder", "3", "2", "3000", "3000", "3150", "3150", "0"],
      ["coder", "all", "8", "7000", "3000", "7800", "3150", "1"],
      ["reviewer", "1", "2", "7000", "7000", "7300", "7300", "0"],
      ["reviewer", "2", "2", "8000", "8000", "8100", "8100", "0"],
      ["reviewer", "3", "1", "8100", "8100", "8100", "8100", "0"],
      ["reviewer", "4", "1", "8100", "8100", "8100", "8100", "0"],
      ["reviewer", "all", "6", "7000", "8000", "8100", "8100", "0"],
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

/** A started Pi job in its first box after the worker's first heartbeat (as coding-backstop.test.ts). */
async function running(t: TestContext) {
  const f = await fixture(t);
  const job = await f.start(`ends-${randomUUID()}`);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify({
      ...settings,
      limits: undefined,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }),
  ]);
  await f.c.tick();
  await f.c.heartbeat(await f.row(job.id));
  return { f, id: job.id as string, row: () => f.row(job.id) };
}
const emptyWork = {
  plan: "",
  patch: "",
  summary: "",
  files: [],
  piState: { version: 1, base, delivered: [] },
};

test("the attempt list shows the end cause the host records: eight hours, crash and retry, ask and nothing to change", async (t) => {
  const ended = async (j: Awaited<ReturnType<typeof running>>) => {
    const { text, sections } = await profile(j.f.db, j.id);
    return { text, sections, ends: sections["1c"]!.map((r) => r.ended) };
  };

  // Eight hours of machine time: the lifetime pause is held for the owner with one notice.
  const eight = await running(t);
  await eight.f.db.query(
    `INSERT INTO boxes(id,user_id,request_key,profile,provider,environment,subject,image,credential_hash,absolute_deadline,running_ms)
     VALUES($1,'a',$2,'coding','ec2','test',$3,'image','hash',now()+interval '1 day',$4)`,
    [
      randomUUID(),
      `coding:${(await eight.row()).attempt_id}`,
      `coding:${eight.id}`,
      8 * HOUR,
    ],
  );
  eight.f.advance(3 * HOUR - 1000);
  await eight.f.c.finish(await eight.row(), {
    kind: "paused",
    summary: "The coding box reached its time limit",
    checkpoint: emptyWork,
  });
  for (let i = 0; i < 4; i++) await eight.f.c.tick();
  const held = await ended(eight);
  assert.deepEqual(held.ends, ["eight-hour pause"]);
  assert.equal(held.sections["1"]![0]!.eight_hour_pauses, "1");
  assert.equal(held.sections["1"]![0]!.machine_left_of_eight_hours_min, "0.0");
  assert.deepEqual(
    held.sections["1b"]!.map((r) => [r.wait, r.resumed_by]),
    [
      ["before Start", "(still waiting)"],
      ["eight-hour pause", "(still waiting)"],
    ],
  );

  // A box that stops without a reason is a crash, retried once automatically.
  const crash = await running(t);
  const crashed = (await crash.row()).attempt_id;
  await crash.f.provider.terminate(`fixture:${crashed}`);
  await crash.f.c.tick();
  await crash.f.c.tick();
  await crash.f.db.query(
    "UPDATE coding_jobs SET updated_at=now()-interval '5 minutes' WHERE id=$1",
    [crash.id],
  );
  await crash.f.c.autoRetryOnce();
  assert.equal((await crash.row()).state, "queued");
  const retried = await ended(crash);
  assert.deepEqual(retried.ends, ["crash, retried once"]);
  assert.deepEqual(
    retried.sections["1b"]!.map((r) => [r.wait, r.resumed_by]).slice(1),
    [["crash", "automatic"]],
  );

  // A question to the owner.
  const ask = await running(t);
  await ask.f.c.finish(await ask.row(), {
    kind: "awaiting_input",
    summary: "Needs a decision",
    question: `Which way? ${MARKER}`,
    options: ["Keep it", "Change it"],
    askedBy: "coder",
    checkpoint: emptyWork,
  });
  const asked = await ended(ask);
  assert.deepEqual(asked.ends, ["ask"]);
  assert(!asked.text.includes(MARKER));
  assert.deepEqual(
    asked.sections["1b"]!.map((r) => [r.wait, r.resumed_by]).slice(1),
    [["ask", "(still waiting)"]],
  );

  // Nothing to change: the host records the outcome's kind on the job.
  const none = await running(t);
  await none.f.c.finish(await none.row(), {
    kind: "no_change",
    summary: `The code already does this. ${MARKER}`,
    checkpoint: emptyWork,
  });
  assert.equal((await none.row()).stage, "no_change");
  const nothing = await ended(none);
  assert.deepEqual(nothing.ends, ["no change"]);
  assert(!nothing.text.includes(MARKER));
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
  // An old call with no stored response is caught by its request having no shape.
  await f.db.query(
    "UPDATE coding_model_calls SET result=NULL,state='uncertain' WHERE job_id=$1",
    [job.id],
  );
  const unanswered = await profile(f.db, job.id.slice(0, 8));
  assert.match(
    unanswered.text,
    /^This job was recorded by the old coding loop/,
  );
  assert.equal(unanswered.text.split("\n").length, 1);
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

test("a prefix that matches several jobs stops with one line", async (t) => {
  const f = await fixture(t);
  const started = await f.start("several");
  const twin = `${started.id.slice(0, 8)}-0000-4000-8000-000000000099`;
  await f.db.query(
    "INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,objective,context,mode,base_sha,settings,state,stage) SELECT $2,user_id,'twin',request_hash,origin_run,objective,context,mode,base_sha,settings,state,stage FROM coding_jobs WHERE id=$1",
    [started.id, twin],
  );
  const { text, sections } = await profile(f.db, started.id.slice(0, 8));
  assert.equal(
    text,
    "Several coding jobs match that id prefix; give a longer one.",
  );
  assert.deepEqual(sections, {});
});

test("a section that fails, as on the statement timeout, prints its error and the others still print; a free-text model id is not printed", async (t) => {
  const j = await running(t);
  await j.f.db.query(
    "UPDATE coding_jobs SET settings=settings || jsonb_build_object('model',$2::text) WHERE id=$1",
    [j.id, `a model; ${MARKER}`],
  );
  const { text, sections } = await profile(j.f.db, j.id, "3");
  assert.match(text, /^ERROR: {2}division by zero$/m);
  assert.equal(sections["3"], undefined);
  // Sections before and after the failed one are printed.
  assert.equal(sections["1"]![0]!.coder_model, "(other)");
  assert.equal(sections["1"]![0]!.reviewer_model, settings.reviewerModel);
  assert(sections["1c"] !== undefined);
  assert(sections["3b"]!.length > 0, "coding_start and its milestones");
  assert(sections["4"] !== undefined && sections["5"] !== undefined);
  assert(!text.includes(MARKER));
  const script = await readFile(SCRIPT, "utf8");
  // psql's own settings that make this so, after the job is found.
  assert(
    script.indexOf("\\set ON_ERROR_ROLLBACK on") >
      script.indexOf("\\if :profile_old"),
  );
  assert(
    script.indexOf("\\set ON_ERROR_STOP off") >
      script.indexOf("\\if :profile_old"),
  );
});

test("when the model calls cannot be read, no figure that needs them is printed, and the rest is", async (t) => {
  const { db, jobId } = await syntheticJob(t);
  const { text, sections } = await profile(db, jobId.slice(0, 8), "calls");
  assert.match(text, /^ERROR: {2}division by zero$/m);
  assert.match(
    text,
    /The model calls could not be read \(see the error above\)/,
  );
  // Sections built only from the calls say so and print no rows.
  for (const n of ["3", "3d", "4", "4b", "4c", "4d", "5", "5b"]) {
    assert.equal(sections[n], undefined, n);
    assert.match(
      text,
      new RegExp(
        `^${n}\\. not available: the model calls could not be read$`,
        "m",
      ),
    );
  }
  // Mixed sections keep what the events, revisions and boxes give, with the call columns empty.
  const [s] = sections["1"]!;
  for (const k of [
    "last_activity_min",
    "coder_runs",
    "review_rounds",
    "findings_reports",
    "approvals",
    "conflicting_rebases",
  ])
    assert.equal(s![k], "-", k);
  assert.equal(s!.start_at_min, "10.0");
  assert.equal(s!.machine_min, "40.0");
  assert.equal(s!.rebases, "2");
  // Attempts, their numbers and start times come from box and event rows, as when read.
  assert.equal(s!.attempts, "4");
  assert.match(
    text,
    /^Attempts, their numbers and start times come from box and event rows only/m,
  );
  assert.deepEqual(
    sections["1c"]!.map((r) => [
      r.attempt!.split(" ")[0],
      r.start_min,
      r.wall_min,
    ]),
    [
      ["1", "11.0", "-"],
      ["2", "26.0", "-"],
      ["3", minutes(2560), "-"],
      ["4", "46.0", "-"],
    ],
  );
  assert.deepEqual(
    sections["3b"]!.filter((r) => r.attempt !== "-").map((r) => r.attempt),
    ["1", "2", "2", "2", "3", "3", "3", "4", "4", "4"],
  );
  assert.deepEqual(
    sections["1c"]!.map((r) => [r.coder_calls, r.reviewer_calls, r.ended]),
    [
      ["-", "-", "box lifetime, continued"],
      ["-", "-", "done (PR opened)"],
      ["-", "-", "done (PR opened)"],
      ["-", "-", "done (PR opened)"],
    ],
  );
  for (const r of sections["2"]!) assert.equal(r.write_1h, "-");
  assert.equal(row(sections["2"], { role: "total" }).calls, "16");
  for (const r of sections["3c"]!) {
    assert.equal(r.first_seen_min, "-");
    assert.equal(r.seen_by, "-");
  }
  assert(sections["3b"]!.length > 0);
  assert(!text.includes(MARKER));
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
