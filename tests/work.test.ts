import { recoverRuntime } from "../src/execution.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { JobTools } from "../src/tools.js";
import { WorkTools, renderWork } from "../src/work.js";
import { WorkWorker } from "../src/work-worker.js";
import { runtimeContext } from "../src/runtime.js";
import { Assistant } from "../src/agent.js";

async function fixture() {
  const pg = new PGlite();
  for (const f of [
    "001_initial.sql",
    "002_preparation.sql",
    "003_skills.sql",
    "005_work.sql",
  ])
    await pg.exec(
      await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
    );
  await pg.exec(
    await readFile(new URL("../db/003_skills.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(new URL("../db/006_runtime.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(new URL("../db/008_costs.sql", import.meta.url), "utf8"),
  );
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  await ensureUser(db, "other");
  const tools = new JobTools(db, { call: async () => ({}) }, undefined, {
    sync: async () => {
      throw new Error("upstream private-token");
    },
  });
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,$2,$3)",
    [run, "owner", "Compare options and export results"],
  );
  const call = (
    operation: string,
    args: Record<string, unknown> = {},
    r = run,
    u = "owner",
  ) => tools.execute(u, r, { operation, ...args }, true) as Promise<any>;
  const work = new WorkTools(db);
  return { pg, db, run, call, work, tools };
}

test("cross-domain provenance: mismatched product/location, fabricated quote, and another owner cannot prove research", async () => {
  const f = await fixture();
  try {
    const start = await f.call("work_start", {
      objective: "Compare tools and travel options",
      steps: [
        {
          key: "product",
          title: "Check the requested product version",
          verification: "evidence",
        },
        {
          key: "travel",
          title: "Check Singapore availability",
          verification: "evidence",
        },
      ],
    });
    const id = start.result.task.id,
      source = randomUUID();
    await f.db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,$2,$3,$4)",
      [
        source,
        "owner",
        "https://example.com/version-1",
        "Version 1 is available in London.",
      ],
    );
    await assert.rejects(
      () =>
        f.call("work_evidence", {
          id,
          sourceId: source,
          claim: "Singapore",
          sourceQuote: "Available in Singapore",
          applicability: "matched",
          reason: "Requested location",
        }),
      /Quote/,
    );
    await assert.rejects(
      () =>
        f.call("work_evidence", {
          id,
          sourceId: source,
          claim: "Empty proof",
          sourceQuote: "   ",
          applicability: "matched",
          reason: "Should reject",
        }),
      /Quote/,
    );
    for (const applicability of ["mismatch", "unverified"]) {
      const ev = await f.call("work_evidence", {
        id,
        sourceId: source,
        claim: "Availability",
        sourceQuote: "available in London",
        applicability,
        reason: "Wrong location or version",
      });
      await assert.rejects(
        () =>
          f.call("work_step", {
            id,
            key: "travel",
            status: "done",
            result: "All checked",
            proofs: [ev.result.id],
          }),
        /Matched source/,
      );
    }
    const other = randomUUID();
    await f.db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,$2,$3,$4)",
      [other, "other", "https://example.com", "Private evidence"],
    );
    await assert.rejects(
      () =>
        f.call("work_evidence", {
          id,
          sourceId: other,
          claim: "Private",
          sourceQuote: "Private evidence",
          applicability: "matched",
          reason: "proof",
        }),
      /Source not found/,
    );
    assert.deepEqual((await f.work.snapshot("owner"))?.counts, {
      total: 2,
      done: 0,
      blocked: 0,
      pending: 2,
    });
  } finally {
    await f.pg.close();
  }
});

test("writes and exports have distinct receipts; failed export cannot complete the task", async () => {
  const f = await fixture();
  try {
    const { result: s } = await f.call("work_start", {
      objective: "Save preference and export",
      steps: [
        {
          key: "save",
          title: "Save preference",
          verification: "action",
          expectedOperation: "memory_set",
        },
        {
          key: "export",
          title: "Export to Sheet",
          verification: "action",
          expectedOperation: "sheet_sync",
        },
      ],
    });
    const id = s.task.id;
    const saved = await f.call("memory_set", {
      key: "preference",
      value: "Concise replies",
    });
    await f.call("work_step", {
      id,
      key: "save",
      status: "done",
      result: "Preference saved",
      proofs: [saved.receiptId],
    });
    await assert.rejects(
      () =>
        f.call("work_step", {
          id,
          key: "export",
          status: "done",
          result: "Exported",
          proofs: [saved.receiptId],
        }),
      /Successful action/,
    );
    await assert.rejects(() => f.call("sheet_sync"));
    const failed = (
      await f.db.query(
        "SELECT * FROM tool_receipts WHERE operation='sheet_sync'",
      )
    ).rows[0];
    assert.equal(failed.status, "failed");
    assert.equal(
      JSON.stringify(failed.details).includes("private-token"),
      false,
    );
    await assert.rejects(
      () =>
        f.call("work_step", {
          id,
          key: "export",
          status: "done",
          result: "Exported",
          proofs: [failed.id],
        }),
      /Successful action/,
    );
    const snapshot = await f.work.snapshot("owner");
    assert.equal(snapshot?.counts.done, 1);
    assert.match(renderWork(snapshot), /Incomplete: 1\/2/);
  } finally {
    await f.pg.close();
  }
});

test("scope revision invalidates completion, keeps receipts, and rejects stale and background scope changes", async () => {
  const f = await fixture();
  try {
    const steps = [
      {
        key: "one",
        title: "Save preference",
        verification: "action",
        expectedOperation: "memory_set",
      },
      { key: "two", title: "Synthesize", verification: "analysis" },
    ];
    const { result: s } = await f.call("work_start", {
      objective: "Initial scope",
      steps,
    });
    const id = s.task.id;
    const saved = await f.call("memory_set", {
      key: "preference",
      value: "Concise",
    });
    await f.call("work_step", {
      id,
      key: "one",
      status: "done",
      result: "Saved",
      proofs: [saved.receiptId],
    });
    const next = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id,revision) VALUES($1,$2,$3,$4,1)",
      [next, "owner", "Include all options", id],
    );
    const revised = await f.call(
      "work_revise",
      {
        id,
        objective: "Expanded scope",
        steps: [
          ...steps,
          {
            key: "three",
            title: "Additional option",
            verification: "evidence",
          },
        ],
      },
      next,
    );
    assert.equal(revised.result.counts.done, 0);
    assert.equal(revised.result.counts.total, 3);
    assert.equal(revised.result.task.revision, 2);
    assert.equal(revised.result.receipts.length, 1);
    await assert.rejects(
      () =>
        f.call("work_step", {
          id,
          key: "one",
          status: "done",
          result: "Stale",
          proofs: [saved.receiptId],
        }),
      /scope changed/,
    );
    await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
      next,
    ]);
    await assert.rejects(
      () =>
        f.call("work_revise", { id, objective: "Self-expanded", steps }, next),
      /user follow-up/,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM work_revisions")).rows.length,
      2,
    );
  } finally {
    await f.pg.close();
  }
});

test("worker is bounded, resumes persisted queued work, and does not replay stale execution", async () => {
  const f = await fixture();
  try {
    const { result: s } = await f.call("work_start", {
      objective: "Long research",
      steps: [{ key: "a", title: "Research", verification: "evidence" }],
    });
    await f.call("work_yield", { id: s.task.id });
    let calls = 0;
    let messages = 0;
    const worker = new WorkWorker(
      f.db,
      async () => {
        calls++;
        await f.db.query(
          "UPDATE work_tasks SET used_models=used_models+1,budget_models=3",
        );
        return "Incomplete";
      },
      async () => {
        messages++;
      },
    );
    for (let i = 0; i < 4; i++) {
      await f.db.query("UPDATE work_tasks SET next_run=now()");
      await worker.tick();
    }
    assert.equal(calls, 3);
    assert.equal(messages, 3);
    assert.equal((await f.work.current("owner")).status, "paused");
    await f.db.query(
      "UPDATE work_tasks SET status='running',updated_at=now()-interval '6 minutes'",
    );
    await recoverRuntime(f.db);
    await worker.tick();
    assert.equal(calls, 3);
    assert.equal((await f.work.current("owner")).status, "paused");
    await f.call("work_cancel", { id: s.task.id });
    await worker.tick();
    assert.equal(calls, 3);
  } finally {
    await f.pg.close();
  }
});

test("tracked responses retain model-written prose while status uses recorded evidence", async () => {
  const f = await fixture();
  try {
    let assistant: Assistant;
    assistant = new Assistant(
      f.db,
      {
        run: async (req) => {
          await assistant.call(req.capability, {
            operation: "work_start",
            objective: "Research every option",
            steps: [
              {
                key: "research",
                title: "Check sources",
                verification: "evidence",
              },
            ],
          });
          return {
            reply: "I started the research; the sources still need checking.",
            history: [],
            interrupted: true,
          };
        },
      },
      f.tools,
    );
    const response = await assistant.respond("owner", "Research every option");
    assert.equal(
      response,
      "I started the research; the sources still need checking.",
    );
    assert.match(
      renderWork(await f.work.snapshot("owner")),
      /Incomplete: 0\/1/,
    );
    assert.equal((await f.work.current("owner")).status, "queued");
    assert.doesNotMatch(response, /background passes/);
    assert.equal(assistant.capabilities.size, 0);
  } finally {
    await f.pg.close();
  }
});

test("capability schema exposes configured operations and structured work arguments", () => {
  const off = runtimeContext({}, null);
  assert.ok(
    !off.tools.some((t) => t.name === "gmail_read" || t.name === "sheet_sync"),
  );
  const start = off.tools.find((t) => t.name === "work_start")!;
  assert.equal((start.parameters.properties as any).steps.type, "array");
  assert.ok(
    runtimeContext({ gmail: true, preparationSheet: true }, null).tools.some(
      (t) => t.name === "sheet_sync",
    ),
  );
});

test("cancellation revokes an in-flight turn including attempts to start replacement work", async () => {
  const f = await fixture();
  try {
    let assistant: Assistant;
    assistant = new Assistant(
      f.db,
      {
        run: async (req) => {
          const started: any = await assistant.call(req.capability, {
            operation: "work_start",
            objective: "Original task",
            steps: [{ key: "a", title: "Research", verification: "evidence" }],
          });
          await f.db.query(
            "UPDATE work_tasks SET status='cancelled' WHERE id=$1",
            [started.result.task.id],
          );
          await assert.rejects(
            () =>
              assistant.call(req.capability, {
                operation: "work_start",
                objective: "Revive task",
                steps: [
                  { key: "a", title: "Research", verification: "evidence" },
                ],
              }),
            /scope changed/,
          );
          await assert.rejects(
            () =>
              assistant.call(req.capability, {
                operation: "memory_set",
                key: "ignored",
                value: "should not write",
              }),
            /scope changed/,
          );
          return { reply: "Cancelled", history: [] };
        },
      },
      f.tools,
    );
    await assistant.respond("owner", "Research");
    assert.equal((await f.db.query("SELECT * FROM work_tasks")).rows.length, 1);
    assert.equal((await f.db.query("SELECT * FROM memories")).rows.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("runtime owns continuation across exhausted passes and stops at the budget without work_yield", async () => {
  const f = await fixture();
  try {
    let assistant: Assistant;
    let calls = 0;
    assistant = new Assistant(
      f.db,
      {
        run: async (req) => {
          calls++;
          await req.execution!.consume("models");
          if (calls === 1)
            await assistant.call(req.capability, {
              operation: "work_start",
              objective: "Research several targets",
              steps: [
                {
                  key: "a",
                  title: "Research target",
                  verification: "evidence",
                },
              ],
            });
          await req.execution!.attach();
          await f.db.query("UPDATE work_tasks SET budget_models=4");
          return { reply: "Partial work", history: [], interrupted: true };
        },
      },
      f.tools,
    );
    await assistant.respond(
      "owner",
      "Research several targets and continue automatically",
    );
    const worker = new WorkWorker(
      f.db,
      (u, id) => assistant.resume(u, id),
      async () => {},
    );
    for (let i = 0; i < 4; i++) {
      await f.db.query("UPDATE work_tasks SET next_run=now()");
      await worker.tick();
    }
    assert.equal(calls, 4); // original turn + three bounded continuation passes
    const task = await f.work.current("owner");
    assert.equal(task.status, "paused");
    assert.equal(task.passes, 3);
  } finally {
    await f.pg.close();
  }
});

test("a user-input blocker pauses instead of scheduling speculative continuation", async () => {
  const f = await fixture();
  try {
    let assistant: Assistant;
    assistant = new Assistant(
      f.db,
      {
        run: async (req) => {
          const { result: s }: any = await assistant.call(req.capability, {
            operation: "work_start",
            objective: "Research target",
            steps: [
              {
                key: "a",
                title: "Confirm target identity",
                verification: "evidence",
              },
            ],
          });
          await assistant.call(req.capability, {
            operation: "work_step",
            id: s.task.id,
            key: "a",
            status: "blocked",
            result: "Which product version do you mean?",
          });
          return { reply: "Need your input", history: [], interrupted: false };
        },
      },
      f.tools,
    );
    const reply = await assistant.respond("owner", "Research this product");
    assert.equal((await f.work.current("owner")).status, "paused");
    assert.equal(reply, "Need your input");
    assert.doesNotMatch(reply, /Continuing/);
  } finally {
    await f.pg.close();
  }
});

test("one blocked target does not stop unrelated pending targets", async () => {
  const f = await fixture();
  try {
    let assistant: Assistant;
    assistant = new Assistant(
      f.db,
      {
        run: async (req) => {
          const { result: s }: any = await assistant.call(req.capability, {
            operation: "work_start",
            objective: "Compare two products",
            steps: [
              {
                key: "a",
                title: "Unavailable product A",
                verification: "evidence",
              },
              {
                key: "b",
                title: "Independent product B",
                verification: "evidence",
              },
            ],
          });
          await assistant.call(req.capability, {
            operation: "work_step",
            id: s.task.id,
            key: "a",
            status: "blocked",
            result: "No applicable public source for product A",
          });
          return { reply: "Partial", history: [], interrupted: true };
        },
      },
      f.tools,
    );
    await assistant.respond("owner", "Compare two products");
    assert.equal((await f.work.current("owner")).status, "queued");
  } finally {
    await f.pg.close();
  }
});

test("a successful read can prove a retrieval step without claiming a write", async () => {
  const f = await fixture();
  try {
    const task = await f.call("work_start", {
      objective: "Load saved records",
      steps: [
        {
          key: "load",
          title: "Load records",
          verification: "action",
          expectedOperation: "job_list",
        },
      ],
    });
    const listed = await f.call("job_list");
    const result = await f.call("work_step", {
      id: task.result.task.id,
      key: "load",
      status: "done",
      result: "Records loaded",
      proofs: [listed.receiptId],
    });
    assert.equal(result.result.counts.done, 1);
  } finally {
    await f.pg.close();
  }
});
