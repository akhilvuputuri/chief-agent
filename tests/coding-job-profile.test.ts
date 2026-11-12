import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";

// scripts/coding-job-profile.sql is run with psql against production. Here its SQL runs
// against the migrated schema: psql meta-commands are dropped, the variables are filled in
// (quoted as psql's :'name' quotes them),
// and each statement's rows are kept under the section number its \echo heading gives.
async function profileStatements(job: string, prefix: string) {
  const text = await readFile("scripts/coding-job-profile.sql", "utf8");
  const statements: { section: string; sql: string }[] = [];
  let section = "setup";
  let buffer = "";
  for (const raw of text.split("\n")) {
    const heading = /^\\echo '(\d+[a-z]?)\./.exec(raw);
    if (heading) section = heading[1]!;
    const line = raw.replace(/\\gset\s*$/, ";");
    if (/^\s*\\/.test(line) || /^\s*--/.test(line)) continue;
    buffer += `${line}\n`;
    if (/;\s*$/.test(line)) {
      statements.push({
        section,
        sql: buffer
          .replaceAll(":'profile_job'", `'${job}'`)
          .replaceAll(":'job'", `'${prefix.replaceAll("'", "''")}'`),
      });
      buffer = "";
    }
  }
  assert.equal(buffer.trim(), "", "the script ends with a complete statement");
  return statements;
}

const SECRET = "SECRET-7f3a";
const JOB = "9600af57-0000-4000-8000-000000000001";
const OTHER = "9600af58-0000-4000-8000-000000000002";
const PLAN = "22222222-2222-4222-8222-222222222222";
const BUILD = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-11-12T01:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function usage(
  role: string,
  cost: number,
  prompt: number,
  completion: number,
  reasoning: number,
) {
  return {
    kind: "model_usage",
    role,
    purpose: "agent",
    model: "anthropic/claude-opus-5.5",
    provider: "Anthropic",
    usage: {
      cost,
      route: "anthropic-direct",
      prompt_tokens: prompt,
      completion_tokens: completion,
      prompt_tokens_details: {
        cached_tokens: prompt - 100,
        cache_write_tokens: 100,
      },
      completion_tokens_details: { reasoning_tokens: reasoning },
    },
  };
}

function bash(command: string) {
  return {
    id: "t",
    type: "function",
    function: { name: "bash", arguments: JSON.stringify({ command }) },
  };
}

function tool(name: string, args: unknown) {
  return { id: "t", type: "function", function: { name, arguments: args } };
}

test("the coding-job profile reports time, usage and tools per attempt and role without printing contents", async (t) => {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  await pg.query("INSERT INTO users(id) VALUES('owner')");
  for (const id of [JOB, OTHER])
    await pg.query(
      `INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,objective,context,mode,base_sha,settings,state,stage,attempt_id,created_at,updated_at)
       VALUES($1,'owner',$7,'h',gen_random_uuid(),$2,$2,'implement','abc',$3::jsonb,'paused','reviewing',$4,$5,$6)`,
      [
        id,
        SECRET,
        JSON.stringify({
          runtime: "pi",
          effort: "medium",
          model: "anthropic/claude-opus-5.5",
          leaderModel: "anthropic/claude-opus-5.5",
          reviewerModel: "anthropic/claude-opus-5.5",
          limits: { ms: 10800000, models: 1500, tools: 4000 },
          image: "ghcr.io/example/worker@sha256:0123456789abcdef59701d7620ef",
        }),
        BUILD,
        at(-3600),
        at(601),
        `request-${id}`,
      ],
    );
  const event = (key: string, payload: object, seconds: number) =>
    pg.query(
      "INSERT INTO coding_events(job_id,event_key,payload,created_at) VALUES($1,$2,$3::jsonb,$4)",
      [JOB, key, JSON.stringify(payload), at(seconds)],
    );
  let call = 0;
  const request = async (
    attempt: string,
    role: string,
    seconds: number,
    result?: object,
  ) => {
    const id = `00000000-0000-4000-8000-${String(++call).padStart(12, "0")}`;
    await pg.query(
      "INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,state,input,result,created_at) VALUES($1,$2,$3,$4,'h',$5,$6::jsonb,$7::jsonb,$8)",
      [
        id,
        JOB,
        attempt,
        role,
        result ? "complete" : "uncertain",
        JSON.stringify({ messages: [{ role: "user", content: SECRET }] }),
        result ? JSON.stringify(result) : null,
        at(seconds),
      ],
    );
    return id;
  };
  const answer = (tool_calls: object[], reasoning_details?: object[]) => ({
    message: {
      role: "assistant",
      content: SECRET,
      tool_calls,
      ...(reasoning_details ? { reasoning_details } : {}),
    },
  });

  // A planning attempt the evening before: one leader call.
  await event(
    `${PLAN}:pi:p:1`,
    { stage: "planning", summary: "Planning started" },
    -3000,
  );
  await request(
    PLAN,
    "leader",
    -2999,
    answer([
      {
        id: "r",
        type: "function",
        function: { name: "read", arguments: `{"path":"${SECRET}"}` },
      },
    ]),
  );
  await event(`${PLAN}:model:1`, usage("leader", 0.5, 5000, 50, 20), -2990);
  await event(`${PLAN}:finished`, { summary: SECRET }, -2900);

  // The implementation attempt: three coder calls, checks, then a review cut off by a restart.
  await event(
    `${BUILD}:pi:b:1`,
    { stage: "implementing", summary: "Implementation started" },
    0,
  );
  await request(
    BUILD,
    "coder",
    1,
    answer([bash(`cd /work && sed -n 1,5p src/${SECRET}.ts`)]),
  );
  await event(`${BUILD}:model:1`, usage("coder", 0.1, 1000, 100, 80), 11);
  await request(
    BUILD,
    "coder",
    20,
    answer([
      bash(`(cd /work && grep -rn ${SECRET} .)`),
      {
        id: "r",
        type: "function",
        function: { name: "read", arguments: `{"path":"${SECRET}"}` },
      },
    ]),
  );
  await event(`${BUILD}:model:2`, usage("coder", 0.2, 2000, 200, 150), 71);
  const third = await request(
    BUILD,
    "coder",
    80,
    answer(
      [bash(`TOKEN=${SECRET} curl https://example.invalid`)],
      [
        {
          type: "anthropic.thinking",
          format: "anthropic-direct-v1",
          position: 0,
          block: {
            type: "thinking",
            thinking: `${SECRET} summary`,
            signature: "s",
          },
        },
        {
          type: "anthropic.thinking",
          format: "anthropic-direct-v1",
          position: 1,
          block: { type: "thinking", thinking: "", signature: "s" },
        },
      ],
    ),
  );
  for (const elapsedMs of [200000, 210000])
    await event(
      `${BUILD}:model-progress:${elapsedMs}`,
      { kind: "model_progress", role: "coder", callId: third, elapsedMs },
      80 + elapsedMs / 1000,
    );
  await event(`${BUILD}:model:3`, usage("coder", 0.3, 3000, 300, 270), 300);
  await event(
    `${BUILD}:pi:b:2`,
    {
      stage: "implementing",
      summary: "Check passed: kite run check in 100.0 s",
    },
    400,
  );
  await event(
    `${BUILD}:pi:b:3`,
    { stage: "reviewing", summary: "Review started" },
    499,
  );
  await request(BUILD, "reviewer", 500, answer([]));
  await event(`${BUILD}:model:4`, usage("reviewer", 0.05, 500, 50, 45), 530);
  const cut = await request(BUILD, "reviewer", 540);
  await event(
    `${BUILD}:request-rejected:${cut}`,
    {
      kind: "worker_request_rejected",
      phase: "model",
      code: "gateway_restart",
      callId: cut,
    },
    600,
  );
  await event(`${BUILD}:paused`, { summary: SECRET }, 601);

  // The running attempt: no end marker yet, free-text summaries, odd tool arguments and
  // usage values that are not numbers.
  await pg.query(
    "UPDATE coding_jobs SET state='running',stage='implementing',attempt_id=$2 WHERE id=$1",
    [JOB, RUN],
  );
  for (const [n, summary] of [
    "Implementation started",
    `Implementation: ${SECRET} failure`,
    `Requirement check 2: ${SECRET}`,
    `${SECRET} free text`,
    "Requirement check 2: Running review",
    `Check passed: rm -rf ${SECRET} in 1.0 s`,
    "Check failed: kite run check (exit 1) in 3.0 s",
  ].entries())
    await event(
      `${RUN}:pi:r:${n}`,
      { stage: "implementing", summary },
      1000 + n,
    );
  const odd = await request(
    RUN,
    "coder",
    1010,
    answer([
      tool("bash", "not json {"),
      tool("bash", { command: "/usr/bin/git status" }),
      bash("./scripts/acme-private-deploy.sh --go"),
      bash("ab12cd34ef56gh78 run"),
      bash("sk-ant+abc run"),
      bash("cd /x\nsed -n 1p f && ls"),
      tool("bad name!", "{}"),
    ]),
  );
  await event(
    `${RUN}:model-progress:1`,
    { kind: "model_progress", role: "coder", callId: odd, elapsedMs: "soon" },
    1015,
  );
  await event(
    `${RUN}:model:1`,
    {
      kind: "model_usage",
      role: "coder",
      model: "anthropic/claude-opus-5.5",
      usage: {
        cost: "n/a",
        route: "anthropic-direct",
        prompt_tokens: "x",
        completion_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
    1020,
  );

  for (const [prefix, none] of [
    ["9600af5", false],
    ["ffffffff", true],
    ["9600af57' OR true --", true],
  ] as const) {
    const found = (await profileStatements(JOB, prefix)).find((s) =>
      s.sql.includes("profile_found"),
    )!;
    const match = (await pg.query<any>(found.sql)).rows[0];
    assert.equal(match.profile_found, false, prefix);
    assert.equal(match.profile_none, none, prefix);
  }

  const rows: Record<string, any[]> = {};
  for (const { section, sql } of await profileStatements(JOB, "9600af57")) {
    const result = await pg.query<any>(sql);
    (rows[section] ??= []).push(
      ...result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            v === null ? null : String(v),
          ]),
        ),
      ),
    );
  }
  const pick = (section: string, keys: string[]) =>
    rows[section]!.map((row) => keys.map((k) => row[k]));

  assert.equal(rows.setup![0].profile_found, "true");
  assert.equal(rows.setup![0].profile_job, JOB);
  assert.deepEqual(
    pick("1", [
      "job",
      "state",
      "effort",
      "limit_minutes",
      "image_tail",
      "current_attempt",
    ]),
    [["9600af57", "running", "medium", "180", "59701d7620ef", "33333333"]],
  );
  assert.deepEqual(
    pick("2", ["attempt", "wall_min", "ended", "rejected", "model_requests"]),
    [
      ["1 22222222", "1.7", "finished", null, "leader 1"],
      [
        "2 11111111",
        "10.0",
        "paused",
        "gateway_restart x1",
        "coder 3, reviewer 2 (1 not complete)",
      ],
      ["3 33333333", "0.3", "(running)", null, "coder 1"],
    ],
  );
  assert.deepEqual(pick("2b", ["attempt", "what", "detail", "min_to_next"]), [
    ["1 22222222", "planning", "Planning started", "1.7"],
    ["1 22222222", "finished", null, "0.0"],
    ["2 11111111", "implementing", "Implementation started", "6.7"],
    [
      "2 11111111",
      "implementing",
      "Check passed: kite run check in 100.0 s",
      "1.7",
    ],
    ["2 11111111", "reviewing", "Review started", "1.7"],
    ["2 11111111", "rejected", "model gateway_restart", "0.0"],
    ["2 11111111", "paused", null, "0.0"],
    ["3 33333333", "implementing", "Implementation started", "0.0"],
    ["3 33333333", "implementing", "Implementation: (other)", "0.0"],
    ["3 33333333", "implementing", "Requirement check 2: (other)", "0.0"],
    ["3 33333333", "implementing", "(other)", "0.0"],
    [
      "3 33333333",
      "implementing",
      "Requirement check 2: Running review",
      "0.0",
    ],
    ["3 33333333", "implementing", "Check passed: (other)", "0.0"],
    [
      "3 33333333",
      "implementing",
      "Check failed: kite run check (exit 1) in 3.0 s",
      "0.2",
    ],
  ]);
  assert.deepEqual(
    pick("3", [
      "attempt",
      "role",
      "calls",
      "cost_usd",
      "prompt_tokens",
      "cached_tokens",
      "completion_tokens",
      "reasoning_tokens",
      "thinking_pct",
      "routes",
    ]),
    [
      [
        "1 22222222",
        "leader",
        "1",
        "0.50",
        "5000",
        "4900",
        "50",
        "20",
        "40",
        "anthropic-direct",
      ],
      [
        "2 11111111",
        "coder",
        "3",
        "0.60",
        "6000",
        "5700",
        "600",
        "500",
        "83",
        "anthropic-direct",
      ],
      [
        "2 11111111",
        "reviewer",
        "1",
        "0.05",
        "500",
        "400",
        "50",
        "45",
        "90",
        "anthropic-direct",
      ],
      [
        "3 33333333",
        "coder",
        "1",
        "0.00",
        "0",
        "0",
        "10",
        "5",
        "50",
        "anthropic-direct",
      ],
      [
        "all",
        "coder",
        "4",
        "0.60",
        "6000",
        "5700",
        "610",
        "505",
        "83",
        "anthropic-direct",
      ],
      [
        "all",
        "leader",
        "1",
        "0.50",
        "5000",
        "4900",
        "50",
        "20",
        "40",
        "anthropic-direct",
      ],
      [
        "all",
        "reviewer",
        "1",
        "0.05",
        "500",
        "400",
        "50",
        "45",
        "90",
        "anthropic-direct",
      ],
      [
        "all",
        "all",
        "6",
        "1.15",
        "11500",
        "11000",
        "710",
        "570",
        "80",
        "anthropic-direct",
      ],
    ],
  );
  // Coder gaps: 10 s from the first request, then 60 s and 229 s. The reviewer's run starts
  // at its own first request, so the checks between the runs count for neither role.
  assert.deepEqual(
    pick("4", ["attempt", "role", "gap", "calls", "minutes", "max_s"]).filter(
      (r) => r[0] === "2 11111111",
    ),
    [
      ["2 11111111", "coder", "<15 s", "1", "0.2", "10"],
      ["2 11111111", "coder", "1-3 min", "1", "1.0", "60"],
      ["2 11111111", "coder", ">3 min", "1", "3.8", "229"],
      ["2 11111111", "coder", "all", "3", "5.0", "229"],
      ["2 11111111", "reviewer", "15-60 s", "1", "0.5", "30"],
      ["2 11111111", "reviewer", "all", "1", "0.5", "30"],
    ],
  );
  assert.deepEqual(
    pick("4b", [
      "attempt",
      "role",
      "runs",
      "requests",
      "answered",
      "span_min",
      "model_wait_min",
      "between_calls_min",
      "max_wait_s",
      "with_progress",
      "max_progress_s",
    ]).filter((r) => r[0] === "2 11111111"),
    [
      // The reviewer's run spans to its unanswered second request: 40 s, 30 s of it waiting.
      [
        "2 11111111",
        "coder",
        "1",
        "3",
        "3",
        "5.0",
        "4.7",
        "0.3",
        "220",
        "1",
        "210",
      ],
      [
        "2 11111111",
        "reviewer",
        "1",
        "2",
        "1",
        "0.7",
        "0.5",
        "0.2",
        "30",
        "0",
        null,
      ],
    ],
  );
  assert.deepEqual(
    pick("5", ["attempt", "role", "responses", "0", "1", "2", "3+"]),
    [
      ["1 22222222", "leader", "1", "0", "1", "0", "0"],
      ["2 11111111", "coder", "3", "0", "2", "1", "0"],
      ["2 11111111", "reviewer", "1", "1", "0", "0", "0"],
      ["3 33333333", "coder", "1", "0", "0", "0", "1"],
    ],
  );
  assert.deepEqual(pick("5b", ["attempt", "role", "by_name"]), [
    ["1 22222222", "leader", "read 1"],
    ["2 11111111", "coder", "bash 3, read 1"],
    ["3 33333333", "coder", "bash 6, (other) 1"],
  ]);
  // A program is shown without its directory; a path-like script name, a token-like word
  // and anything outside the allowed characters are grouped. A cd prefix ends at a newline.
  assert.deepEqual(pick("5c", ["attempt", "role", "program", "calls"]), [
    ["2 11111111", "coder", "(assignment)", "1"],
    ["2 11111111", "coder", "grep", "1"],
    ["2 11111111", "coder", "sed", "1"],
    ["3 33333333", "coder", "(other)", "3"],
    ["3 33333333", "coder", "(none)", "1"],
    ["3 33333333", "coder", "cd", "1"],
    ["3 33333333", "coder", "git", "1"],
  ]);
  assert.deepEqual(
    pick("6", [
      "attempt",
      "role",
      "responses",
      "with_details",
      "entries",
      "summaries",
      "summary_chars",
    ]),
    [
      ["1 22222222", "leader", "1", "0", "0", "0", "0"],
      [
        "2 11111111",
        "coder",
        "3",
        "1",
        "2",
        "1",
        String(`${SECRET} summary`.length),
      ],
      ["2 11111111", "reviewer", "1", "0", "0", "0", "0"],
      ["3 33333333", "coder", "1", "0", "0", "0", "0"],
    ],
  );
  // Prompts, replies, tool arguments, thinking text, objectives, end-of-attempt summaries and
  // free text in stage summaries never reach the output.
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(SECRET));
  // Read-only: nothing was written.
  assert.equal(
    (await pg.query<any>("SELECT count(*)::int AS n FROM coding_events"))
      .rows[0].n,
    23,
  );
});
