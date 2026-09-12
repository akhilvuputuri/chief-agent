import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import type { Database } from "../src/db.js";
import type { ModelAdapter } from "../src/model.js";
import { validateAlignment, runAlignment } from "../src/alignment.js";
import { Execution, recoverRuntime } from "../src/execution.js";
const answer = (content: string) => ({
  message: { role: "assistant" as const, content },
});
const call = (name: string, args: any) => ({
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
const obs = (input: any) =>
  JSON.parse(input.messages.findLast((m: any) => m.role === "tool").content)
    .result;
const request = (input: any) =>
  JSON.parse(input.messages.find((m: any) => m.role === "user").content);
async function fixture(model: ModelAdapter) {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  const tools = new JobTools(db, {
    call: async () => ({
      content:
        "Build systems. Singapore, senior engineer. Interview guidance is not confirmed for this role.",
    }),
  });
  const assistant = new Assistant(db, new CustomAgent(model), tools, {
    web: true,
  });
  return { pg, db, assistant };
}
async function addJobs(db: Database, n: number, user = "owner") {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    ids.push(id);
    await db.query(
      "INSERT INTO jobs(id,user_id,title,company,url,description) VALUES($1,$2,$3,'Example',$4,'Build systems.')",
      [id, user, "Engineer " + i, "https://example.com/sg/" + id],
    );
  }
  return ids;
}
function report(target: any, sourceId: string) {
  return {
    targetId: target.targetId,
    status: "complete",
    summary: "Relevant systems work; experience details remain unknown.",
    identity: {
      match: "matched",
      location: "Singapore",
      level: "senior",
      note: "Posting was read; applicability remains an assessment.",
      evidence: [
        { kind: "web", refId: sourceId, quote: "Singapore, senior engineer" },
      ],
    },
    requirements: [
      {
        id: "systems",
        requirement: "Build systems",
        kind: "essential",
        evidence: [
          {
            kind: "job_snapshot",
            refId: target.targetId,
            quote: "Build systems.",
          },
        ],
        fit: {
          status: "unknown",
          explanation: "No established systems example supplied.",
          memoryEvidence: [],
        },
      },
    ],
    interviews: {
      status: "uncertain",
      searchSummary: "Specific interview stages have not been established.",
      findings: [],
    },
    preparation: [
      {
        id: "evidence",
        requirementIds: ["systems"],
        interviewIds: [],
        priority: "minimum",
        action: "Identify an existing systems example before assigning study.",
        why: "Determine whether this is a gap or undocumented experience.",
        doneWhen: "A concrete example is established or the gap confirmed.",
        effortEstimate: null,
      },
    ],
    unknowns: ["What systems work has the user done?"],
  };
}
function specialistResponder() {
  const state = new Map<string, { index: number; sources: string[] }>();
  return (input: any) => {
    const s = state.get(input.sessionId) ?? { index: 0, sources: [] };
    state.set(input.sessionId, s);
    const data = request(input);
    if (input.messages.filter((m: any) => m.role === "tool").length === 0)
      return call("web_search", {
        query: "Example Singapore engineer interview process",
      });
    if (
      input.messages.findLast((m: any) => m.role === "assistant")
        ?.tool_calls?.[0]?.function.name === "web_read"
    )
      s.sources.push(obs(input).sourceId);
    if (s.index < data.targets.length)
      return call("web_read", { url: data.targets[s.index++].url });
    return call("job_alignment_report", {
      targets: data.targets.map((t: any, i: number) =>
        report(t, s.sources[i]!),
      ),
    });
  };
}
test("all saved roles keep a frozen target set across batches and restarts; reports survive lost parent aggregation", async () => {
  let parent = 0,
    scopeId = "",
    ids: string[] = [];
  const child = specialistResponder();
  const f = await fixture({
    generate: async (input) => {
      if (
        input.messages[0]?.content?.includes(
          "job-alignment research specialist",
        )
      )
        return child(input);
      if (parent++ === 0)
        return call("job_alignment_start", {
          objective: "Assess all my roles and minimum preparation",
          allSaved: true,
          jobIds: [],
          memoryKeys: [],
        });
      const result = obs(input);
      scopeId = result.scopeId;
      assert.equal(result.counts.total, 5);
      assert.equal(result.counts.reported, 2);
      return answer("Two assessed, three pending in the saved scope.");
    },
  });
  try {
    ids = await addJobs(f.db, 5);
    await addJobs(f.db, 1, "other");
    await f.assistant.respond("owner", "Assess all my saved roles");
    await addJobs(f.db, 1); // Created after the snapshot: must not join it on resume.
    await f.db.query("DELETE FROM events WHERE type='job_alignment.reported'"); // Simulate losing only parent aggregation.
    await recoverRuntime(f.db);
    const nextChild = specialistResponder();
    let n = 0;
    const resumed = new Assistant(
      f.db,
      new CustomAgent({
        generate: async (input) => {
          if (
            input.messages[0]?.content?.includes(
              "job-alignment research specialist",
            )
          )
            return nextChild(input);
          if (n++ === 0) return call("job_alignment_resume", { scopeId });
          const r = obs(input);
          assert.equal(r.counts.total, 5);
          if (r.counts.pending)
            return call("job_alignment_resume", { scopeId });
          assert.equal(r.counts.reported, 5);
          assert.equal(r.counts.complete, 5);
          return answer(
            "All five assessed; shared preparation can use the existing-work example, with each role reference retained.",
          );
        },
      }),
      new JobTools(f.db, {
        call: async () => ({
          content: "Build systems. Singapore, senior engineer.",
        }),
      }),
      { web: true },
    );
    await resumed.respond("owner", "Continue that scope");
    const assignments = (
      await f.db.query(
        "SELECT data FROM events WHERE type='research.child_started' ORDER BY id",
      )
    ).rows;
    const targets = assignments.flatMap((r) =>
      r.data.assignment.targets.map((t: any) => t.targetId),
    );
    assert.deepEqual(new Set(targets), new Set(ids));
    assert.equal(targets.length, 5);
    assert(
      assignments.every(
        (r) => r.data.profile.skillVersion === "repo:job-alignment:1",
      ),
    );
    const run = randomUUID(),
      ex = new Execution(f.db, "other", run, new AbortController().signal);
    await ex.start();
    await assert.rejects(
      () =>
        runAlignment(
          {
            execution: ex,
            signal: ex.signal,
            executeResearch: async () => ({}),
          } as any,
          { operation: "job_alignment_read", scopeId, jobId: null, offset: 0 },
          async () => {
            throw Error("must not run");
          },
        ),
      /scope unavailable/,
    );
  } finally {
    await f.pg.close();
  }
});
test("selected roles are preserved; foreign IDs are denied before scope creation", async () => {
  let ids: string[] = [],
    n = 0;
  const child = specialistResponder();
  const f = await fixture({
    generate: async (input) => {
      if (
        input.messages[0]?.content?.includes(
          "job-alignment research specialist",
        )
      )
        return child(input);
      if (n++ === 0)
        return call("job_alignment_start", {
          objective: "Selected roles",
          allSaved: false,
          jobIds: [ids[2], ids[0]],
          memoryKeys: [],
        });
      const r = obs(input);
      assert.equal(r.counts.total, 2);
      assert.deepEqual(
        r.roles.map((x: any) => x.jobId),
        [ids[2], ids[0]],
      );
      return answer("Selected roles assessed.");
    },
  });
  try {
    ids = await addJobs(f.db, 3);
    const foreign = (await addJobs(f.db, 1, "other"))[0];
    await f.assistant.respond("owner", "Assess X and Y");
    const ex = new Execution(
      f.db,
      "owner",
      randomUUID(),
      new AbortController().signal,
    );
    await ex.start();
    await assert.rejects(
      () =>
        runAlignment(
          {
            execution: ex,
            signal: ex.signal,
            executeResearch: async () => ({}),
          } as any,
          {
            operation: "job_alignment_start",
            objective: "invalid",
            allSaved: false,
            jobIds: [ids[0], foreign],
            memoryKeys: [],
          },
          async () => {
            throw Error("must not run");
          },
        ),
      /unavailable for this owner/,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='job_alignment.scope'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.pg.close();
  }
});
test("fit and interview claims reject unsupported upgrades, foreign evidence and unlinked preparation", async () => {
  const f = await fixture({ generate: async () => answer("unused") });
  try {
    const id = (await addJobs(f.db, 1))[0]!,
      run = randomUUID(),
      source = randomUUID();
    const ex = new Execution(f.db, "owner", run, new AbortController().signal);
    await ex.start();
    await f.db.query(
      "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,'owner','https://example.com/hiring','Singapore, senior engineer. US software engineer interview: coding then design.')",
      [source],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'read','web_read','{}',false,'success',$3)",
      [randomUUID(), run, JSON.stringify({ result: { sourceId: source } })],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'search','web_search','{}',false,'success','{}')",
      [randomUUID(), run],
    );
    const job = (await f.db.query("SELECT * FROM jobs WHERE id=$1", [id]))
      .rows[0];
    const scope = {
      memories: [{ key: "work", value: "I build systems in production." }],
    } as any;
    const req = { execution: ex } as any;
    const base = () => report({ targetId: id }, source);
    const validate = (r: any) =>
      validateAlignment(
        req,
        scope,
        [job],
        { operation: "job_alignment_report", targets: [r] },
        run,
      );
    await validate(base());
    let r: any = base();
    r.requirements[0].fit.status = "confirmed_gap";
    await assert.rejects(() => validate(r), /missing experience stays unknown/);
    r = base();
    r.requirements[0].fit.memoryEvidence = [
      { key: "work", quote: "I have no systems experience" },
    ];
    await assert.rejects(() => validate(r), /background quotation/);
    const finding = {
      id: "us",
      claim: "Coding then design",
      scope: "exact_role",
      roleMatch: "matched",
      locationMatch: "mismatch",
      levelMatch: "unknown",
      sourceType: "candidate_report",
      date: "2025",
      confidence: "medium",
      caveat: "US report, not Singapore.",
      evidence: [
        {
          kind: "web",
          refId: source,
          quote: "US software engineer interview: coding then design.",
        },
      ],
    };
    r = base();
    r.interviews = {
      status: "supported",
      searchSummary: "Found a US account",
      findings: [finding],
    };
    await assert.rejects(() => validate(r), /cannot verify an exact-role/);
    r.interviews.findings[0].scope = "other_role_or_location";
    await assert.rejects(
      () => validate(r),
      /supported process needs exact-role/,
    );
    r.interviews.status = "uncertain";
    await validate(r);
    r.preparation[0].requirementIds = [];
    r.preparation[0].interviewIds = ["us"];
    await assert.rejects(() => validate(r), /cannot justify minimum/);
    r = base();
    r.interviews.status = "not_found";
    await f.db.query("DELETE FROM runtime_calls WHERE operation='web_search'");
    await assert.rejects(
      () => validate(r),
      /recorded interview search attempt/,
    );
    r = base();
    r.requirements[0].evidence[0].refId = randomUUID();
    await assert.rejects(() => validate(r), /this exact role description/);
    r = base();
    r.identity.evidence[0].quote = "Invented identity";
    await assert.rejects(
      () => validate(r),
      /must quote an owner-scoped source/,
    );
    r = base();
    r.targetId = randomUUID();
    await assert.rejects(() => validate(r), /assigned target set/);
  } finally {
    await f.pg.close();
  }
});
test("full frozen input and skill version remain auditable; missing evidence stays partial", async () => {
  let id = "",
    step = 0;
  const f = await fixture({
    generate: async (input) => {
      if (
        input.messages[0]?.content?.includes(
          "job-alignment research specialist",
        )
      ) {
        const t = request(input).targets[0];
        if (step++ === 0)
          return call("job_alignment_input", {
            kind: "job",
            id: t.targetId,
            offset: 0,
          });
        assert(obs(input).content.includes("FULL_DESCRIPTION_TAIL"));
        return call("job_alignment_report", {
          targets: [
            {
              ...report(t, randomUUID()),
              status: "partial",
              identity: {
                match: "saved_only",
                location: "Unknown",
                level: "Unknown",
                note: "Original posting inaccessible.",
                evidence: [],
              },
              interviews: {
                status: "uncertain",
                searchSummary:
                  "Access blocked; cannot establish interview process.",
                findings: [],
              },
            },
          ],
        });
      }
      if (!input.messages.some((m) => m.role === "tool"))
        return call("job_alignment_start", {
          objective: "Understand this role",
          allSaved: false,
          jobIds: [id],
          memoryKeys: ["work"],
        });
      assert.equal(obs(input).counts.partial, 1);
      return answer(
        "Saved description assessed; current posting and interview process remain unverified.",
      );
    },
  });
  try {
    id = (await addJobs(f.db, 1))[0]!;
    await f.db.query("UPDATE jobs SET description=$2 WHERE id=$1", [
      id,
      "Build systems. " + ".".repeat(2200) + "FULL_DESCRIPTION_TAIL",
    ]);
    await f.db.query(
      "INSERT INTO memories(user_id,key,value) VALUES('owner','work','Established background')",
    );
    await f.assistant.respond("owner", "Analyze the selected role");
    const snapshot = (
      await f.db.query(
        "SELECT data FROM events WHERE type='job_alignment.scope'",
      )
    ).rows[0].data;
    assert.equal(snapshot.memories[0].value, "Established background");
    assert(snapshot.skill.sha256.length === 64);
    const events = (
      await f.db.query(
        "SELECT data FROM events WHERE type='research.model_input'",
      )
    ).rows;
    assert(events.length === 2);
    assert(
      events[1].data.messages.some(
        (m: any) =>
          m.role === "tool" && m.content.includes("FULL_DESCRIPTION_TAIL"),
      ),
    );
  } finally {
    await f.pg.close();
  }
});
