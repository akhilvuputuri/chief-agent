import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Database } from "../src/db.js";
import { resolvePreparationChain } from "../src/preparation-chain.js";
import { PreparationTools } from "../src/preparation.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  const jobId = randomUUID(),
    foreignJobId = randomUUID(),
    scopeId = randomUUID();
  const childRunId = randomUUID(),
    otherRunId = randomUUID(),
    reportCallId = randomUUID();
  const sourceId = randomUUID(),
    readCallId = randomUUID();
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  await db.query(
    "INSERT INTO jobs(id,user_id,title,company,url,description) VALUES($1,'owner','Engineer','Example','https://example.com/role','Build systems and evaluate data.'),($2,'other','Engineer','Other',NULL,'Other role')",
    [jobId, foreignJobId],
  );
  await db.query(
    "INSERT INTO memories(user_id,key,value) VALUES('owner','experience','I built a data pipeline.')",
  );
  await db.query(
    "INSERT INTO runtime_runs(id,user_id) VALUES($1,'owner'),($2,'owner')",
    [childRunId, otherRunId],
  );
  const scope: any = {
    version: 1,
    scopeId,
    objective: "Assess the selected role",
    targets: [
      {
        id: jobId,
        title: "Engineer",
        company: "Example",
        url: "https://example.com/role",
        description:
          "Build systems and evaluate data. UNREFERENCED DESCRIPTION MUST NOT BE COPIED.",
        updated_at: "2026-09-13T10:00:00.000Z",
      },
    ],
    memories: [
      {
        key: "experience",
        value:
          "I built a data pipeline. UNREFERENCED MEMORY MUST NOT BE COPIED.",
        updated_at: "2026-09-12T10:00:00.000Z",
      },
    ],
    skill: {
      version: "repo:1",
      content: "Use exact sources and preserve unknowns",
      sha256: hash("Use exact sources and preserve unknowns"),
    },
    createdAt: "2026-09-13T11:00:00.000Z",
  };
  const target: any = {
    targetId: jobId,
    status: "complete",
    summary:
      "A supported report with a concrete clarification and established background.",
    identity: {
      match: "matched",
      location: "Singapore",
      level: "senior",
      note: "Exact posting was read",
      evidence: [
        { kind: "web", refId: sourceId, quote: "Singapore senior Engineer" },
      ],
    },
    requirements: [
      {
        id: "systems",
        requirement: "Build systems",
        kind: "essential",
        evidence: [
          { kind: "job_snapshot", refId: jobId, quote: "Build systems" },
        ],
        fit: {
          status: "unknown",
          explanation: "Systems experience needs clarification",
          memoryEvidence: [],
          question: "Which systems have you built?",
        },
      },
      {
        id: "data",
        requirement: "Evaluate data",
        kind: "essential",
        evidence: [{ kind: "web", refId: sourceId, quote: "Evaluate data" }],
        fit: {
          status: "transferable",
          explanation: "The prior pipeline is adjacent experience",
          memoryEvidence: [
            { key: "experience", quote: "I built a data pipeline." },
          ],
        },
      },
    ],
    interviews: {
      status: "supported",
      searchSummary: "Official role guidance read",
      findings: [
        {
          id: "interview",
          claim: "Discuss a design",
          scope: "exact_role",
          roleMatch: "matched",
          locationMatch: "matched",
          levelMatch: "matched",
          sourceType: "official",
          date: "2026-09-12",
          confidence: "high",
          caveat: "Recorded guidance, not a guaranteed question",
          evidence: [
            { kind: "web", refId: sourceId, quote: "Discuss a design" },
          ],
        },
      ],
    },
    preparation: [
      {
        id: "explain",
        requirementIds: ["systems", "data"],
        interviewIds: ["interview"],
        priority: "minimum",
        action:
          "Identify an existing systems example and explain the data work",
        why: "Resolve the unknown before assigning extra study",
        doneWhen: "The user provides a concrete example or confirms the gap",
        effortEstimate: "About 30 minutes, estimated",
      },
    ],
    unknowns: ["Systems experience"],
  };
  await db.query(
    "INSERT INTO events(run_id,user_id,type,data) VALUES($1,'owner','job_alignment.scope',$2)",
    [randomUUID(), JSON.stringify(scope)],
  );
  await db.query(
    "INSERT INTO events(run_id,user_id,type,data) VALUES($1,'owner','research.child_started',$2)",
    [
      childRunId,
      JSON.stringify({
        profile: { scopeId },
        assignment: { targets: [{ targetId: jobId }] },
      }),
    ],
  );
  await db.query(
    "INSERT INTO research_sources(id,user_id,url,content,retrieved_at) VALUES($1,'owner','https://example.com/official','Singapore senior Engineer. Evaluate data. Discuss a design. UNREFERENCED SOURCE.','2026-09-13T10:30:00Z')",
    [sourceId],
  );
  await db.query(
    "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'read','web_read','{}',false,'success',$3)",
    [readCallId, childRunId, JSON.stringify({ result: { sourceId } })],
  );
  await db.query(
    "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'report','job_alignment_report','{}',false,'success',$3)",
    [
      reportCallId,
      childRunId,
      JSON.stringify({ recorded: true, targets: [target] }),
    ],
  );
  const setTarget = (value: any) =>
    db.query("UPDATE runtime_calls SET result=$2 WHERE id=$1", [
      reportCallId,
      JSON.stringify({ recorded: true, targets: [value] }),
    ]);
  const setScope = (value: any) =>
    db.query(
      "UPDATE events SET data=$2 WHERE type='job_alignment.scope' AND data->>'scopeId'=$1",
      [scopeId, JSON.stringify(value)],
    );
  const link = { scopeId, jobId, preparationId: "explain" };
  return {
    pg,
    db,
    link,
    scope,
    target,
    sourceId,
    childRunId,
    otherRunId,
    foreignJobId,
    reportCallId,
    readCallId,
    setTarget,
    setScope,
    resolve: () => resolvePreparationChain(db, "owner", [link]),
  };
}

test("preparation provenance freezes role and background evidence and enriches exact citations", async () => {
  const f = await fixture();
  try {
    const before = await f.resolve();
    await f.db.query(
      "UPDATE jobs SET title='Changed title',company='Changed company',url='https://changed.example',description='Changed description',updated_at=now() WHERE id=$1",
      [f.link.jobId],
    );
    await f.db.query(
      "UPDATE memories SET value='Changed memory',updated_at=now() WHERE user_id='owner'",
    );
    const after = await f.resolve();
    assert.deepEqual(after, before);
    const chain = after[0]!;
    assert.equal(chain.capturedAt, f.scope.createdAt);
    assert.equal(chain.childRunId, f.childRunId);
    assert.deepEqual(chain.skill, {
      version: "repo:1",
      sha256: f.scope.skill.sha256,
    });
    assert.equal(chain.job.title, "Engineer");
    assert.equal(
      chain.job.descriptionHash,
      hash(f.scope.targets[0].description),
    );
    assert.equal(chain.job.updatedAt, f.scope.targets[0].updated_at);
    assert.equal(
      chain.requirements[0]!.fit.question,
      "Which systems have you built?",
    );
    assert.deepEqual(chain.requirements[1]!.fit.memoryEvidence, [
      {
        key: "experience",
        quote: "I built a data pipeline.",
        updatedAt: f.scope.memories[0].updated_at,
      },
    ]);
    const web = chain.requirements[1]!.evidence[0]!;
    assert.equal(web.kind, "web");
    if (web.kind === "web") {
      assert.equal(web.url, "https://example.com/official");
      assert.match(web.retrievedAt, /^2026-09-13 10:30:00/);
    }
    assert.equal(
      chain.interviews[0]!.caveat,
      f.target.interviews.findings[0].caveat,
    );
    assert.equal(chain.action, f.target.preparation[0].action);
    assert.equal(chain.doneWhen, f.target.preparation[0].doneWhen);
    assert(!JSON.stringify(chain).includes("UNREFERENCED"));
  } finally {
    await f.pg.close();
  }
});

test("preparation provenance refuses cross-owner scopes, jobs and child reports", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => resolvePreparationChain(f.db, "other", [f.link]),
      /scope must uniquely belong/,
    );
    const altered = structuredClone(f.scope);
    altered.targets[0].id = f.foreignJobId;
    await f.setScope(altered);
    await assert.rejects(
      () =>
        resolvePreparationChain(f.db, "owner", [
          { ...f.link, jobId: f.foreignJobId },
        ]),
      /job unavailable for this owner/,
    );
    await f.setScope(f.scope);
    await f.db.query("UPDATE runtime_runs SET user_id='other' WHERE id=$1", [
      f.childRunId,
    ]);
    await assert.rejects(f.resolve, /uniquely matching successful/);
  } finally {
    await f.pg.close();
  }
});

test("only a successful report from this scope can resolve, and ambiguous reports fail closed", async () => {
  const f = await fixture();
  try {
    await f.db.query("UPDATE runtime_calls SET state='failed' WHERE id=$1", [
      f.reportCallId,
    ]);
    await assert.rejects(f.resolve, /uniquely matching successful/);
    await f.db.query("UPDATE runtime_calls SET state='success' WHERE id=$1", [
      f.reportCallId,
    ]);
    await f.db.query(
      "UPDATE events SET data=jsonb_set(data,'{profile,scopeId}',to_jsonb($1::text)) WHERE type='research.child_started'",
      [randomUUID()],
    );
    await assert.rejects(f.resolve, /uniquely matching successful/);
    await f.db.query(
      "UPDATE events SET data=jsonb_set(data,'{profile,scopeId}',to_jsonb($1::text)) WHERE type='research.child_started'",
      [f.link.scopeId],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) SELECT $1,run_id,'second-report',operation,arguments,is_write,state,result FROM runtime_calls WHERE id=$2",
      [randomUUID(), f.reportCallId],
    );
    await assert.rejects(f.resolve, /uniquely matching successful/);
  } finally {
    await f.pg.close();
  }
});

test("preparation references must be unique, bounded and resolve real requirement and interview IDs", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => resolvePreparationChain(f.db, "owner", [f.link, f.link]),
      /duplicate preparation references/,
    );
    await assert.rejects(() => resolvePreparationChain(f.db, "owner", []));
    await assert.rejects(() =>
      resolvePreparationChain(
        f.db,
        "owner",
        Array.from({ length: 17 }, (_, i) => ({
          ...f.link,
          preparationId: String(i),
        })),
      ),
    );
    await assert.rejects(
      () =>
        resolvePreparationChain(f.db, "owner", [
          { ...f.link, preparationId: "missing" },
        ]),
      /preparation ID/,
    );
    for (const [field, value, pattern] of [
      ["requirementIds", [], /at least one role requirement/],
      ["requirementIds", ["missing"], /linked requirement/],
      [
        "requirementIds",
        ["systems", "systems"],
        /duplicate linked requirement IDs/,
      ],
      ["interviewIds", ["missing"], /linked interview/],
      [
        "interviewIds",
        ["interview", "interview"],
        /duplicate linked interview IDs/,
      ],
    ] as const) {
      const target = structuredClone(f.target);
      target.preparation[0][field] = value;
      await f.setTarget(target);
      await assert.rejects(f.resolve, pattern);
    }
    const target = structuredClone(f.target);
    target.requirements.push(target.requirements[0]);
    await f.setTarget(target);
    await assert.rejects(f.resolve, /duplicate requirement IDs/);
  } finally {
    await f.pg.close();
  }
});

test("unknown experience requires a stored clarification question, while non-unknown fits need frozen quotes", async () => {
  const f = await fixture();
  try {
    for (const question of [undefined, "   "]) {
      const target = structuredClone(f.target);
      target.requirements[0].fit.question = question;
      await f.setTarget(target);
      await assert.rejects(f.resolve, /explicit report clarification question/);
    }
    for (const memoryEvidence of [
      [],
      [{ key: "missing", quote: "I built a data pipeline." }],
      [{ key: "experience", quote: "I operated every production system" }],
    ]) {
      const target = structuredClone(f.target);
      target.requirements[1].fit.memoryEvidence = memoryEvidence;
      await f.setTarget(target);
      await assert.rejects(
        f.resolve,
        /frozen background evidence|selected frozen memory/,
      );
    }
  } finally {
    await f.pg.close();
  }
});

test("source citations require exact frozen or owner-scoped text and a successful read by this child", async () => {
  const f = await fixture();
  try {
    for (const evidence of [
      [],
      [{ kind: "job_snapshot", refId: f.foreignJobId, quote: "Build systems" }],
      [
        {
          kind: "job_snapshot",
          refId: f.link.jobId,
          quote: "Invented requirement",
        },
      ],
      [{ kind: "web", refId: f.sourceId, quote: "Invented web requirement" }],
    ]) {
      const target = structuredClone(f.target);
      target.requirements[0].evidence = evidence;
      await f.setTarget(target);
      await assert.rejects(
        f.resolve,
        /source quotation|snapshot quote|web quotation/,
      );
    }
    await f.setTarget(f.target);
    await f.db.query(
      "UPDATE research_sources SET user_id='other' WHERE id=$1",
      [f.sourceId],
    );
    await assert.rejects(
      f.resolve,
      /belong to this owner and be read by this child/,
    );
    await f.db.query(
      "UPDATE research_sources SET user_id='owner' WHERE id=$1",
      [f.sourceId],
    );
    await f.db.query("UPDATE runtime_calls SET run_id=$2 WHERE id=$1", [
      f.readCallId,
      f.otherRunId,
    ]);
    await assert.rejects(f.resolve, /be read by this child/);
    await f.db.query(
      "UPDATE runtime_calls SET run_id=$2,state='failed' WHERE id=$1",
      [f.readCallId, f.childRunId],
    );
    await assert.rejects(f.resolve, /be read by this child/);
    await f.db.query(
      "UPDATE runtime_calls SET state='success',operation='source_read',result=$2 WHERE id=$1",
      [f.readCallId, JSON.stringify({ sourceId: f.sourceId })],
    );
    assert.equal((await f.resolve())[0]!.requirements.length, 2);
  } finally {
    await f.pg.close();
  }
});

test("saved-only identity stays qualified; mismatched identity and inapplicable exact-role findings are rejected", async () => {
  const f = await fixture();
  try {
    for (const match of ["unverified", "mismatch"]) {
      const target = structuredClone(f.target);
      target.identity.match = match;
      await f.setTarget(target);
      await assert.rejects(f.resolve, /mismatched or unverified/);
    }
    const target = structuredClone(f.target);
    target.identity.match = "saved_only";
    target.identity.evidence = [];
    target.status = "partial";
    await f.setTarget(target);
    assert.equal((await f.resolve())[0]!.identity.match, "saved_only");
    target.interviews.findings[0].locationMatch = "mismatch";
    await f.setTarget(target);
    await assert.rejects(f.resolve, /match role, location and level/);
  } finally {
    await f.pg.close();
  }
});

test("preparation tools merge shared-role provenance without resetting progress and page a stable owner-scoped snapshot", async () => {
  const f = await fixture();
  try {
    const tools = new PreparationTools(f.db);
    const jobId = randomUUID();
    await f.db.query(
      "INSERT INTO jobs(id,user_id,title,company,url,description) VALUES($1,'owner','Data Engineer','Second',NULL,'Build systems and evaluate data.')",
      [jobId],
    );
    const secondScope = structuredClone(f.scope);
    secondScope.targets.push({
      ...secondScope.targets[0],
      id: jobId,
      company: "Second",
      title: "Data Engineer",
    });
    await f.setScope(secondScope);
    const secondTarget = structuredClone(f.target);
    secondTarget.targetId = jobId;
    secondTarget.requirements[0].evidence[0].refId = jobId;
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'report-second-role','job_alignment_report','{}',false,'success',$3)",
      [
        randomUUID(),
        f.childRunId,
        JSON.stringify({ recorded: true, targets: [secondTarget] }),
      ],
    );
    const secondLink = { ...f.link, jobId };
    const action = {
      operation: "prep_task_save" as const,
      topic: "Shared Systems",
      exercise: "Explain the existing example. " + '\"\\'.repeat(1200),
      completionCriteria:
        "Provide the missing experience and explain its limits",
      priority: "high" as const,
    };
    const first: any = await tools.call("owner", {
      ...action,
      links: [f.link],
      status: "doing",
    });
    assert.equal(first.link_count, 1);
    const second: any = await tools.call("owner", {
      ...action,
      links: [secondLink],
    });
    assert.equal(second.id, first.id);
    assert.equal(second.status, "doing");
    assert.equal(second.link_count, 2);
    const repeated: any = await tools.call("owner", {
      ...action,
      links: [f.link],
    });
    assert.equal(repeated.link_count, 2);
    await assert.rejects(
      () =>
        tools.call("owner", {
          ...action,
          links: [f.link, { ...secondLink, preparationId: "missing" }],
          status: "done",
        }),
      /preparation ID/,
    );
    assert.equal(
      (
        await f.db.query("SELECT status FROM preparation_tasks WHERE id=$1", [
          first.id,
        ])
      ).rows[0].status,
      "doing",
    );

    const listed: any = await tools.call("owner", {
      operation: "prep_list",
      id: jobId,
    });
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].links.length, 2);
    assert.equal(listed.tasks[0].evidence_chain, undefined);
    assert.equal(
      (
        (await tools.call("other", {
          operation: "prep_list",
          id: jobId,
        })) as any
      ).tasks.length,
      0,
    );
    await assert.rejects(
      () =>
        tools.call("other", {
          operation: "prep_task_read",
          id: first.id,
          offset: 0,
        }),
      /not found/,
    );
    const initial: any = await tools.call("owner", {
      operation: "prep_task_read",
      id: first.id,
      offset: 0,
    });
    assert(initial.nextOffset > 0);
    assert(initial.content.length <= 6000);
    assert(JSON.stringify(initial.content).length <= 6500);
    await assert.rejects(
      () =>
        tools.call("owner", {
          operation: "prep_task_read",
          id: first.id,
          offset: initial.nextOffset,
        }),
      /version missing/,
    );
    let content = initial.content,
      nextOffset = initial.nextOffset;
    while (nextOffset !== null) {
      const page: any = await tools.call("owner", {
        operation: "prep_task_read",
        id: first.id,
        offset: nextOffset,
        version: initial.version,
      });
      assert(page.content.length <= 6000);
      assert(JSON.stringify(page.content).length <= 6500);
      content += page.content;
      nextOffset = page.nextOffset;
    }
    const snapshot = JSON.parse(content);
    assert.equal(snapshot.evidence_chain.length, 2);
    assert.deepEqual(
      new Set(snapshot.evidence_chain.map((c: any) => c.jobId)),
      new Set([f.link.jobId, jobId]),
    );
    assert.equal(snapshot.evidence_chain[0].requirements.length, 2);
    const progressed: any = await tools.call("owner", {
      ...action,
      status: "done",
    });
    assert.equal(progressed.link_count, 2);
    assert.equal(progressed.status, "done");
    await assert.rejects(
      () =>
        tools.call("owner", {
          operation: "prep_task_read",
          id: first.id,
          offset: initial.nextOffset,
          version: initial.version,
        }),
      /task changed/,
    );
  } finally {
    await f.pg.close();
  }
});

test("new or legacy unlinked preparation cannot fabricate provenance through a task update", async () => {
  const f = await fixture();
  try {
    const tools = new PreparationTools(f.db);
    const action = {
      operation: "prep_task_save" as const,
      topic: "Legacy",
      exercise: "Study a topic",
      completionCriteria: "Explain it",
      priority: "medium" as const,
    };
    await assert.rejects(
      () => tools.call("owner", action),
      /require links to saved alignment actions/,
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM preparation_tasks"))
        .rows[0].n,
      0,
    );
    const id = randomUUID();
    await f.db.query(
      "INSERT INTO preparation_tasks(id,user_id,topic,exercise,completion_criteria,priority) VALUES($1,'owner','legacy','Old exercise','Old criterion','medium')",
      [id],
    );
    await assert.rejects(
      () => tools.call("owner", { ...action, status: "done" }),
      /require links to saved alignment actions/,
    );
    const legacy = (
      await f.db.query("SELECT * FROM preparation_tasks WHERE id=$1", [id])
    ).rows[0];
    assert.deepEqual(legacy.evidence_chain, []);
    assert.equal(legacy.status, "todo");
    assert.equal(legacy.exercise, "Old exercise");
    const read: any = await tools.call("owner", {
      operation: "prep_task_read",
      id,
      offset: 0,
    });
    assert.match(read.notice, /legacy provenance is unavailable/);
  } finally {
    await f.pg.close();
  }
});

test("runtime can correct rejected preparation inputs without an uncertain-write pause", async () => {
  const { Assistant } = await import("../src/agent.js");
  const { CustomAgent } = await import("../src/custom-agent.js");
  const { JobTools } = await import("../src/tools.js");
  const f = await fixture();
  const args = {
    topic: "runtime chain",
    exercise: "Describe the existing work",
    completionCriteria: "Provide an example or confirm the gap",
    priority: "high",
  };
  let calls = 0;
  const invoke = (data: unknown) => ({
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: "function" as const,
          function: { name: "prep_task_save", arguments: JSON.stringify(data) },
        },
      ],
    },
  });
  try {
    const assistant = new Assistant(
      f.db,
      new CustomAgent({
        generate: async (input) => {
          const turn = calls++;
          if (turn === 0) return invoke(args);
          const observation = JSON.parse(
            input.messages.findLast((m) => m.role === "tool")!.content!,
          );
          if (turn < 3) {
            assert.equal(observation.error.code, "VALIDATION_FAILED");
            assert.match(
              observation.error.message,
              turn === 1 ? /require links/ : /Preparation provenance:/,
            );
            return invoke({
              ...args,
              links: [
                {
                  ...f.link,
                  preparationId:
                    turn === 1 ? "nonexistent" : f.link.preparationId,
                },
              ],
            });
          }
          assert.equal(observation.result.link_count, 1);
          return {
            message: {
              role: "assistant" as const,
              content: "Saved the preparation evidence.",
            },
          };
        },
      }),
      new JobTools(f.db, {
        call: async () => {
          throw Error("No research expected");
        },
      }),
    );
    assert.match(
      await assistant.respond(
        "owner",
        "Save the preparation with its evidence.",
      ),
      /Saved the preparation evidence/,
    );
    assert.equal(calls, 4);
    const writes = (
      await f.db.query(
        "SELECT state FROM runtime_calls WHERE operation='prep_task_save' ORDER BY started_at,id",
      )
    ).rows;
    assert.deepEqual(
      writes.map((r) => r.state),
      ["failed", "failed", "success"],
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM preparation_tasks"))
        .rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});

test("ambiguous preparation database acknowledgement still pauses as an uncertain write", async () => {
  const { Assistant } = await import("../src/agent.js");
  const { CustomAgent } = await import("../src/custom-agent.js");
  const { JobTools } = await import("../src/tools.js");
  const f = await fixture();
  let calls = 0;
  const db: Database = {
    query: async (sql, values) => {
      const result = await f.db.query(sql, values);
      if (sql.startsWith("INSERT INTO preparation_tasks"))
        throw new Error("Simulated lost database acknowledgement");
      return result;
    },
  };
  try {
    const assistant = new Assistant(
      db,
      new CustomAgent({
        generate: async () => {
          calls++;
          assert.equal(calls, 1, "must not blindly dispatch another write");
          return {
            message: {
              role: "assistant" as const,
              content: null,
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function" as const,
                  function: {
                    name: "prep_task_save",
                    arguments: JSON.stringify({
                      topic: "uncertain chain",
                      exercise: "Explain the work",
                      completionCriteria: "Show evidence",
                      priority: "high",
                      links: [f.link],
                    }),
                  },
                },
              ],
            },
          };
        },
      }),
      new JobTools(db, {
        call: async () => {
          throw Error("No research expected");
        },
      }),
    );
    await assistant.respond("owner", "Save preparation.");
    assert.equal(calls, 1);
    assert.equal(
      (
        await f.db.query(
          "SELECT state FROM runtime_calls WHERE operation='prep_task_save'",
        )
      ).rows[0].state,
      "uncertain",
    );
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM preparation_tasks"))
        .rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});
