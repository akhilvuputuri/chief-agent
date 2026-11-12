import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Workspace as PiWorkspace,
  localExecutor,
} from "@chief-agent/pi-runtime";
import { fixture, settings } from "./helpers/coding-fixture.js";
import { reviewDocumentReader } from "./helpers/pi-review-documents.js";
import { runPiWorker, NativePiWorkerClient } from "../src/coding/pi-worker.js";
import { requirementScope } from "../src/coding/requirements.js";
import { CodingAutomation } from "../src/coding/automation.js";
import { artifactHash } from "../src/coding/github.js";
import { outcome } from "../src/coding/schema.js";
import type { PrInspection } from "../src/coding/merge-policy.js";
import { codingApi } from "../src/coding/api.js";
import { server } from "../src/server.js";

/*
 * Journal 174: when main moves before the owner merges, the reviewed change is carried
 * onto current main with git's three-way merge instead of being implemented again. These
 * run the real host, worker and git against a synthetic repository; models are scripted.
 */

const head = "b".repeat(40),
  tree = "c".repeat(40),
  url = "https://github.com/example/repo/pull/7";
const plan =
  "Change sum.js subtraction to addition; keep the exported API; run the checks.";
const approvedFindings =
  "Earlier approving review: the addition is correct and the API is unchanged.";
const sumFile = (sum: string, name = "sum") =>
  `// Synthetic sum module.\n${sum}\n// One.\n// Two.\n// Three.\n// Four.\nexport const name = "${name}";\n`;
const subtract = "export const sum = (a, b) => a - b;";
const add = "export const sum = (a, b) => a + b;";
const notes = Array.from(
  { length: 40 },
  (_, i) => `Synthetic note ${i} about the addition.\n`,
).join("");

type Write = ((path: string, text: string) => Promise<void>) & {
  remove: (path: string) => Promise<void>;
};
type Scenario = {
  /** What main changes after the candidate was reviewed. */
  moveMain: (write: Write) => Promise<void>;
  /** The scripted coder; any call fails a scenario that expects none. */
  coder?: (input: any, call: number) => any;
  /** Breaks the carried change's identity, so it cannot be carried. */
  tamper?: boolean;
  /** The job was created on an earlier worker image that the boxes still accept. */
  olderImage?: string;
  /** Extra files on the old base, and extra changes in the reviewed candidate. */
  baseFiles?: Record<string, string>;
  candidateFiles?: Record<string, string>;
  /** The first attempt stops (as a lost box would) once the clean carry is saved. */
  interruptAfterCarry?: boolean;
};

/** Reads the next required task document this session has not been given yet. */
function readRequired(input: any) {
  const text = input.messages
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
  const delivered = new Set(
    input.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => {
        try {
          return JSON.parse(m.content).id;
        } catch {
          return undefined;
        }
      }),
  );
  for (const match of text.matchAll(
    /^([a-z][a-z0-9_-]*): [^\n]*; \d+ characters; SHA-256 [a-f0-9]{64}; 1 pages(; optional reference)?/gm,
  ))
    if (!match[2] && !delivered.has(match[1]))
      return reply(`read-${match[1]}-${randomUUID()}`, "read_document", {
        id: match[1],
        page: 0,
      });
  return undefined;
}

const reply = (id: string, name: string, args: unknown) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
const delivered = (input: any, id: string) =>
  input.messages
    .filter((m: any) => m.role === "tool")
    .map((m: any) => {
      try {
        return JSON.parse(m.content);
      } catch {
        return null;
      }
    })
    .filter((m: any) => m?.id === id)
    .map((m: any) => m.text)
    .join("");

async function rebased(t: TestContext, scenario: Scenario) {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "pi-rebase-"));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  const write: Write = Object.assign(
    async (path: string, text: string) => {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), text);
    },
    { remove: (path: string) => rm(join(source, path)) },
  );
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await write(".gitignore", "node_modules/\n");
  await write("sum.js", sumFile(subtract));
  for (const [path, text] of Object.entries(scenario.baseFiles ?? {}))
    await write(path, text);
  await write(
    "test.mjs",
    "import assert from 'node:assert/strict';\nimport { sum } from './sum.js';\nassert.equal(sum(2, 3), 5);\n",
  );
  await write(
    "package.json",
    JSON.stringify({
      name: "synthetic-pi-workspace",
      version: "1.0.0",
      type: "module",
      scripts: {
        check: "node test.mjs",
        build: "node --check sum.js",
        "format:check": "node --check test.mjs",
      },
    }),
  );
  await write(
    "package-lock.json",
    JSON.stringify({
      name: "synthetic-pi-workspace",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "synthetic-pi-workspace", version: "1.0.0" } },
    }),
  );
  git("add", ".");
  git("commit", "-qm", "Base");
  const oldBase = git("rev-parse", "HEAD");
  // The reviewed candidate, snapshotted on the old base exactly as the worker does.
  const work = join(root, "candidate");
  execFileSync("git", ["clone", "-q", "--no-hardlinks", source, work]);
  await writeFile(join(work, "sum.js"), sumFile(add));
  // Most of a real change is untouched by main; the review should not read it again.
  await writeFile(join(work, "notes.md"), notes);
  for (const [path, text] of Object.entries(scenario.candidateFiles ?? {}))
    await writeFile(join(work, path), text);
  const snap = await (
    await new PiWorkspace(work).initialize()
  ).snapshot(
    localExecutor(work, join(root, "home")),
    new AbortController().signal,
    oldBase,
  );
  await scenario.moveMain(write);
  git("add", ".");
  git("commit", "-qm", "Main moves");
  const newBase = git("rev-parse", "HEAD");

  const started = await f.start("pi-rebase", "plan");
  const cp = {
    plan,
    patch: snap.patch,
    summary: "Addition fixed",
    files: snap.files,
    piState: { version: 1, toolsUsed: 4, reviewRound: 1 },
  };
  const result = outcome.parse({
    kind: "candidate",
    summary: "Addition fixed",
    checkpoint: cp,
    checks: [
      "kite ci",
      "kite run check",
      "kite run build",
      "kite run format:check",
    ].map((command) => ({ command, exitCode: 0, output: "passed" })),
    review: {
      verdict: "APPROVE",
      findings: approvedFindings,
      model: settings.reviewerModel,
      patchHash: artifactHash(cp as any),
    },
  });
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3,mode='implement',state='pr_ready',stage='pr_ready',checkpoint=$4::jsonb,result=$5::jsonb,attempt_id=$6,cleanup='complete',pr_url=$7,head_sha=$8,attempt_deadline=$9 WHERE id=$1",
    [
      started.id,
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
        prWorkflow: "owner_merge",
        ...(scenario.olderImage ? { image: scenario.olderImage } : {}),
      }),
      oldBase,
      JSON.stringify(cp),
      JSON.stringify(result),
      randomUUID(),
      url,
      head,
      new Date(Date.now() + 600000),
    ],
  );
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'owner-approved',$2::jsonb,'suppressed')",
    [
      started.id,
      JSON.stringify({
        decision: "approved",
        approvedScope: requirementScope(await f.row(started.id)),
      }),
    ],
  );

  // The automation sees main move and rebases the job.
  let inspection: PrInspection = {
    head,
    tree,
    base: oldBase,
    main: oldBase,
    merged: false,
    closed: false,
    draft: false,
    mergeable: true,
    checks: "passed",
    feedback: [],
    unresolvedThreads: 0,
  };
  const auto = new CodingAutomation(
    f.db,
    {
      outcome: async () => inspection,
      inspect: async () => inspection,
      ready: async () => {},
      attest: async () => {},
      merge: async () => {
        throw new Error("The test never merges");
      },
      release: async () => "pending" as const,
    },
    () => true,
    async () => true,
    () => new Date(),
    // New jobs use the fixture's image.
    () => ({ runtime: "pi", image: settings.image }),
  );
  await auto.start(await f.row(started.id), tree);
  inspection = { ...inspection, main: newBase, base: newBase };
  await auto.tick();
  const queued = await f.row(started.id);
  assert.equal(queued.state, "queued");
  assert.equal(queued.revision, 2);
  assert.equal(queued.base_sha, newBase);
  // The checkpoint still starts empty, so an older worker implements the plan again.
  assert.deepEqual(queued.checkpoint.files, []);
  if (scenario.tamper)
    await f.db.query(
      "UPDATE coding_events SET payload=jsonb_set(payload,'{hash}',to_jsonb($2::text)) WHERE job_id=$1 AND event_key='rebase-change:2'",
      [started.id, "0".repeat(64)],
    );

  const calls = { coder: 0, reviewer: 0 };
  const coderInputs: any[] = [];
  const reviewInputs: any[] = [];
  const readEvidence = reviewDocumentReader();
  f.setGeneration((selected, input) => {
    if (selected === settings.reviewerModel) {
      calls.reviewer++;
      reviewInputs.push(input);
      const evidence = readEvidence(input, "review");
      if (evidence) return evidence;
      return reply(`review-${calls.reviewer}`, "report", {
        kind: "review",
        summary: "Reviewed",
        detail: "The carried change is correct on the new base.",
        verdict: "APPROVE",
      });
    }
    calls.coder++;
    coderInputs.push(input);
    assert(scenario.coder, "No implementation call is expected");
    return scenario.coder(input, calls.coder);
  });
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  /** Provisions the queued attempt and runs the real worker on it. */
  const runWorker = async (interrupt = false) => {
    await f.c.tick();
    const running = await f.row(started.id);
    const assignment: any = await f.c.assignment(running);
    const client = new NativePiWorkerClient(
      origin,
      running.id,
      f.c.token(running.id, running.attempt_id),
      new AbortController().signal,
    );
    if (interrupt) {
      const request = client.request.bind(client);
      client.request = async (path: string, body?: any) => {
        if (path === "progress" && body?.key?.startsWith("pi:carried:"))
          throw new Error("Synthetic lost box");
        return request(path, body);
      };
    }
    await runPiWorker(client, () => {}, new AbortController().signal, {
      prepareRepository: async (directory: string, a: any) => {
        execFileSync("git", [
          "clone",
          "-q",
          "--no-hardlinks",
          source,
          directory,
        ]);
        execFileSync("git", [
          "-C",
          directory,
          "checkout",
          "-q",
          "--detach",
          a.baseSha,
        ]);
      },
    }).catch((error) => {
      if (!interrupt) throw error;
    });
    return assignment;
  };
  /** The attempt stopped; the owner resumes it, which starts a new revision. */
  const resume = async () => {
    await f.db.query(
      "UPDATE coding_jobs SET state='paused',stage='paused',cleanup='complete',lease=NULL,lease_until=NULL WHERE id=$1",
      [started.id],
    );
    const job = await f.row(started.id);
    await f.c.call("a", f.run, {
      operation: "coding_resume",
      id: started.id,
      baseRevision: job.revision,
      requestKey: `resume-${job.revision}`,
      confirmStale: true,
    });
    assert.equal((await f.row(started.id)).revision, job.revision + 1);
    return runWorker();
  };
  const assignment = await runWorker(scenario.interruptAfterCarry);
  const finished = await f.row(started.id);
  /** Publishes the approved candidate and runs the automation to the Merge card. */
  const toMergeCard = async () => {
    (f.publisher as any).publish = async () => ({ url, head, tree });
    await f.c.tick();
    await f.c.tick();
    assert.equal((await f.row(started.id)).state, "pr_ready");
    await auto.tick();
    await auto.tick();
    const { revision } = await f.row(started.id);
    return (
      await f.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key LIKE $2",
        [started.id, `merge-approval:${revision}:%`],
      )
    ).rows.map((r: any) => r.payload);
  };
  const progress = (
    await f.db.query(
      "SELECT payload->>'summary' AS summary FROM coding_events WHERE job_id=$1 AND event_key LIKE '%:pi:carried:%'",
      [started.id],
    )
  ).rows.map((r: any) => r.summary);
  return {
    f,
    queued,
    id: started.id,
    oldBase,
    newBase,
    assignment,
    calls,
    coderInputs,
    reviewInputs,
    finished,
    progress,
    toMergeCard,
    resume,
    approvedHash: artifactHash(cp as any),
  };
}

test("a clean rebase carries the reviewed change with no implementation call, re-runs checks and a delta review, then offers the Merge card", async (t) => {
  const r = await rebased(t, {
    moveMain: (write) => write("sum.js", sumFile(subtract, "sum-module")),
  });
  // The host sent the reviewed change from the old base.
  assert.equal(r.assignment.rebase.from, r.oldBase);
  assert.equal(r.assignment.rebase.hash, r.approvedHash);
  assert.equal(r.assignment.rebase.findings, approvedFindings);
  assert.equal(r.calls.coder, 0);
  assert(r.calls.reviewer > 0);
  assert.equal(r.finished.state, "publishing");
  assert.equal(r.finished.used_models, r.calls.reviewer);
  const result = r.finished.result;
  assert.equal(result.review.verdict, "APPROVE");
  // The real checks ran again on the merged tree.
  assert.deepEqual(
    result.checks.map((c: any) => [c.command, c.exitCode]),
    [
      ["kite ci", 0],
      ["kite run check", 0],
      ["kite run build", 0],
      ["kite run format:check", 0],
    ],
  );
  // Both the reviewed change and main's change are in the candidate.
  assert.deepEqual(
    result.checkpoint.files.map((f: any) => [f.path, f.content]),
    [
      ["notes.md", notes],
      ["sum.js", sumFile(add, "sum-module")],
    ],
  );
  assert.match(
    result.summary,
    /^Carried onto current main [a-f0-9]{12} by git's three-way merge, with no model edits\. Addition fixed$/,
  );
  // The review read what changed since the approved candidate, not the whole change.
  const review = r.reviewInputs.at(-1);
  const system = review.messages.find((m: any) => m.role === "system").content;
  assert(system.includes("after a rebase"));
  assert(
    system.includes(
      `approved candidate ${r.approvedHash} on base ${r.oldBase}`,
    ),
  );
  assert.match(system, /candidate_diff: [^\n]*; optional reference/);
  assert.equal(delivered(review, "candidate_diff"), "");
  const delta = delivered(review, "review_delta");
  assert.match(
    delta,
    /Files main changed from [a-f0-9]{40} to [a-f0-9]{40} \(git diff --stat\):\n sum\.js \| 2/,
  );
  assert.match(
    delta,
    /-export const name = "sum";\n\+export const name = "sum-module";/,
  );
  assert(!delta.includes("notes.md"));
  assert(
    !/^[-+]export const sum/m.test(delta),
    "the unchanged reviewed lines are not reviewed again",
  );
  assert.equal(delivered(review, "previous_findings"), approvedFindings);
  assert.deepEqual(r.progress, [
    "Main moved; the reviewed change applied cleanly to current main, so only the checks and a review run again",
  ]);
  const cards = await r.toMergeCard();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].merge.revision, 2);
  assert.equal(cards[0].merge.head, head);
});

test("a conflicting rebase goes to a coder repair session with the conflicts and the reviewed change, not a fresh implementation", async (t) => {
  const resolved = sumFile(`${add} // main`);
  const r = await rebased(t, {
    moveMain: (write) => write("sum.js", sumFile(`${subtract} // main`)),
    coder: (input, call) => {
      if (call === 1)
        return reply("coder-1", "read_document", {
          id: "rebase_conflicts",
          page: 0,
        });
      if (call === 2) return reply("coder-2", "read", { path: "sum.js" });
      if (call === 3) {
        // git left its markers in the workspace for the coder to resolve.
        const read = input.messages
          .filter((m: any) => m.role === "tool")
          .at(-1);
        assert.match(
          String(read.content),
          /<<<<<<< [\s\S]*=======[\s\S]*>>>>>>> /,
        );
        return reply("coder-3", "write", { path: "sum.js", content: resolved });
      }
      return reply("coder-4", "report", {
        kind: "done",
        summary: "Conflict resolved",
        detail: "Kept main's comment and the approved addition.",
      });
    },
  });
  assert.equal(r.calls.coder, 4);
  const first = JSON.stringify(r.coderInputs[0].messages);
  assert.match(
    first,
    /The approved change is already implemented in this workspace/,
  );
  assert.match(first, /Do not implement the change again from scratch/);
  assert.match(first, /carried_change: [^"]*optional reference/);
  const conflicts = delivered(r.coderInputs[1], "rebase_conflicts");
  assert.match(
    conflicts,
    /These files conflict and contain git's conflict markers:\n- sum\.js\n/,
  );
  assert(conflicts.includes(`Main moved from ${r.oldBase} to ${r.newBase}`));
  assert.equal(r.finished.state, "publishing");
  assert.equal(r.finished.result.review.verdict, "APPROVE");
  assert.deepEqual(
    r.finished.result.checkpoint.files.map((f: any) => [f.path, f.content]),
    [
      ["notes.md", notes],
      ["sum.js", resolved],
    ],
  );
  // The review still reads only how the change was combined with main.
  const review = r.reviewInputs.at(-1);
  const system = review.messages.find((m: any) => m.role === "system").content;
  assert(system.includes("after a rebase"));
  assert.match(
    delivered(review, "review_delta"),
    /-export const sum = \(a, b\) => a \+ b;\n\+export const sum = \(a, b\) => a \+ b; \/\/ main/,
  );
  assert.equal((await r.toMergeCard()).length, 1);
});

test("checks that fail after a clean rebase go to a coder repair with the failures, then review", async (t) => {
  const repaired = sumFile(
    "export const sum = (...n) => n.reduce((x, y) => x + y, 0);",
  );
  const r = await rebased(t, {
    // Main now expects any number of arguments; the carried two-argument sum fails it.
    moveMain: (write) =>
      write(
        "test.mjs",
        "import assert from 'node:assert/strict';\nimport { sum } from './sum.js';\nassert.equal(sum(2, 3), 5);\nassert.equal(sum(2, 3, 4), 9);\n",
      ),
    coder: (_input, call) => {
      if (call === 1)
        return reply("coder-1", "read_document", {
          id: "check_failures",
          page: 0,
        });
      if (call === 2)
        return reply("coder-2", "write", { path: "sum.js", content: repaired });
      return reply("coder-3", "report", {
        kind: "done",
        summary: "Adapted to main's variadic sum",
        detail: "Sum accepts any number of arguments.",
      });
    },
  });
  assert.equal(r.calls.coder, 3);
  const first = JSON.stringify(r.coderInputs[0].messages);
  assert.match(
    first,
    /The host ran the configured checks on your candidate and some failed/,
  );
  assert.match(
    first,
    /These checks ran after git carried the reviewed change onto current main without conflicts/,
  );
  assert.match(
    delivered(r.coderInputs[1], "check_failures"),
    /\$ kite run check \(exit [1-9]/,
  );
  assert.equal(r.finished.state, "publishing");
  assert.equal(r.finished.result.review.verdict, "APPROVE");
  assert(r.finished.result.checks.every((c: any) => c.exitCode === 0));
  assert.deepEqual(
    r.finished.result.checkpoint.files.map((f: any) => [f.path, f.content]),
    [
      ["notes.md", notes],
      ["sum.js", repaired],
    ],
  );
  const system = r.reviewInputs
    .at(-1)
    .messages.find((m: any) => m.role === "system").content;
  assert(system.includes("after a rebase"));
});

test("a carried change that cannot be applied falls back to implementing the approved plan on current main", async (t) => {
  const r = await rebased(t, {
    moveMain: (write) => write("sum.js", sumFile(subtract, "sum-module")),
    tamper: true,
    coder: (input, call) => {
      const text = JSON.stringify(input.messages);
      assert(!text.includes("rebase_conflicts"));
      assert(!text.includes("already implemented in this workspace"));
      if (call === 1)
        return reply("coder-1", "edit", {
          path: "sum.js",
          edits: [{ oldText: "a - b", newText: "a + b" }],
        });
      return reply("coder-2", "report", {
        kind: "done",
        summary: "Addition fixed",
        detail: "Implemented the approved plan.",
      });
    },
  });
  assert.equal(r.calls.coder, 2);
  assert.deepEqual(r.progress, [
    "Main moved and the reviewed change could not be carried onto it, so the approved plan is implemented on current main",
  ]);
  assert.equal(r.finished.state, "publishing");
  // Nothing was carried, so the review is a full one.
  const review = r.reviewInputs.at(-1);
  const system = review.messages.find((m: any) => m.role === "system").content;
  assert(!system.includes("after a rebase"));
  assert(delivered(review, "candidate_diff").includes("sum.js"));
});

test("a rebase moves a job on an older worker image to the image new jobs use, and the carried change still applies", async (t) => {
  // Found on production job 9600af57: main had moved to Kite 0.2.0 while the job's image had 0.1.3.
  const older = `ghcr.io/example/worker@sha256:${"e".repeat(64)}`;
  const r = await rebased(t, {
    moveMain: (write) => write("sum.js", sumFile(subtract, "sum-module")),
    olderImage: older,
  });
  assert.equal(r.queued.settings.image, settings.image);
  // Only the image changed: models, limits and the owner-merge workflow are kept.
  assert.deepEqual(
    { ...r.queued.settings, image: older },
    {
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
      prWorkflow: "owner_merge",
      image: older,
    },
  );
  const change = (
    await r.f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='rebase-change:2'",
      [r.id],
    )
  ).rows[0].payload;
  assert.deepEqual(change.image, { from: older, to: settings.image });
  const revision = (
    await r.f.db.query(
      "SELECT message FROM coding_revisions WHERE job_id=$1 AND revision=2",
      [r.id],
    )
  ).rows[0].message;
  assert.match(revision, /; worker image e{12} → a{12}$/);
  const notice = (
    await r.f.db.query(
      "SELECT payload->>'summary' AS summary FROM coding_events WHERE job_id=$1 AND event_key LIKE 'rebase:%'",
      [r.id],
    )
  ).rows[0].summary;
  assert.match(notice, /also moves to the worker image new jobs use/);
  // The assignment the worker received carried the change, which still applied cleanly.
  assert.equal(r.assignment.settings.image, settings.image);
  assert.equal(r.assignment.rebase.hash, r.approvedHash);
  assert.equal(r.calls.coder, 0);
  assert.equal(r.finished.state, "publishing");
  assert.equal(r.finished.result.review.verdict, "APPROVE");
  assert.equal((await r.toMergeCard()).length, 1);
});

test("a rebase on the current image records no image change", async (t) => {
  const r = await rebased(t, {
    moveMain: (write) => write("sum.js", sumFile(subtract, "sum-module")),
  });
  assert.equal(r.queued.settings.image, settings.image);
  const change = (
    await r.f.db.query(
      "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key='rebase-change:2'",
      [r.id],
    )
  ).rows[0].payload;
  assert.equal("image" in change, false);
});

const systemOf = (input: any) =>
  input.messages.find((m: any) => m.role === "system").content as string;

test("a change git cannot apply leaves the workspace at the base and the approved plan is implemented again", async (t) => {
  const r = await rebased(t, {
    // Main moved the module, so the reviewed change to sum.js has nothing to apply to.
    moveMain: async (write) => {
      await write("lib/sum.js", sumFile(subtract));
      await write(
        "test.mjs",
        "import assert from 'node:assert/strict';\nimport { sum } from './lib/sum.js';\nassert.equal(sum(2, 3), 5);\n",
      );
      await write.remove("sum.js");
      await write(
        "package.json",
        JSON.stringify({
          name: "synthetic-pi-workspace",
          version: "1.0.0",
          type: "module",
          scripts: {
            check: "node test.mjs",
            build: "node --check lib/sum.js",
            "format:check": "node --check test.mjs",
          },
        }),
      );
    },
    coder: (input, call) => {
      const text = JSON.stringify(input.messages);
      assert(!text.includes("already implemented in this workspace"));
      if (call === 1) return reply("coder-1", "read", { path: "notes.md" });
      if (call === 2) {
        // Nothing of the reviewed change was left behind, not even its new file.
        const read = input.messages
          .filter((m: any) => m.role === "tool")
          .at(-1);
        assert(!String(read.content).includes("Synthetic note 0"));
        return reply("coder-2", "edit", {
          path: "lib/sum.js",
          edits: [{ oldText: "a - b", newText: "a + b" }],
        });
      }
      return reply("coder-3", "report", {
        kind: "done",
        summary: "Addition fixed in lib/sum.js",
        detail: "Implemented the approved plan on current main.",
      });
    },
  });
  assert.deepEqual(r.progress, [
    "Main moved and the reviewed change could not be carried onto it, so the approved plan is implemented on current main",
  ]);
  assert.equal(r.finished.state, "publishing");
  assert.deepEqual(
    r.finished.result.checkpoint.files.map((f: any) => f.path),
    ["lib/sum.js"],
  );
  assert.deepEqual(r.finished.result.checkpoint.piState.carry, {
    kind: "reimplemented",
  });
  assert(!systemOf(r.reviewInputs.at(-1)).includes("after a rebase"));
});

test("main that already contains the reviewed change leaves nothing to merge and makes no model call", async (t) => {
  const r = await rebased(t, {
    moveMain: async (write) => {
      await write("sum.js", sumFile(add));
      await write("notes.md", notes);
    },
  });
  assert.equal(r.calls.coder + r.calls.reviewer, 0);
  assert.equal(r.finished.state, "paused");
  assert.match(
    r.finished.result.summary,
    /^Main already contains the reviewed change/,
  );
});

test("a clean carry interrupted before its checks resumes after the owner's resume as checks and a delta review, with no implementation call", async (t) => {
  const r = await rebased(t, {
    moveMain: (write) => write("sum.js", sumFile(subtract, "sum-module")),
    interruptAfterCarry: true,
  });
  const stopped = await r.f.row(r.id);
  assert.equal(stopped.checkpoint.piState.phase, "build");
  assert.deepEqual(stopped.checkpoint.piState.carry, { kind: "clean" });
  assert.equal(r.calls.reviewer, 0);
  // coding_resume starts revision 3; the carry still applies to it.
  const assignment = await r.resume();
  assert.equal(assignment.revision, 3);
  assert.equal(assignment.rebase.hash, r.approvedHash);
  const after = await r.f.row(r.id);
  assert.equal(r.calls.coder, 0);
  assert.equal(after.state, "publishing");
  assert(after.result.checks.every((c: any) => c.exitCode === 0));
  assert.equal(after.result.checks.length, 4);
  const system = systemOf(r.reviewInputs.at(-1));
  assert(system.includes("after a rebase"));
  assert(system.includes("It applied without conflicts."));
  assert.equal((await r.toMergeCard()).length, 1);
});

test("a conflict session that stopped resumes with the conflicts named, and the review knows they were resolved", async (t) => {
  const resolved = sumFile(`${add} // main`);
  let failFirst = true;
  const r = await rebased(t, {
    moveMain: (write) => write("sum.js", sumFile(`${subtract} // main`)),
    coder: (input, call) => {
      if (failFirst) {
        failFirst = false;
        throw new Error("Synthetic interrupted generation");
      }
      const read = readRequired(input);
      if (read) return read;
      const tools = input.messages.filter((m: any) => m.role === "tool");
      if (!tools.some((m: any) => String(m.content).includes("<<<<<<<")))
        return reply(`coder-${call}`, "read", { path: "sum.js" });
      if (!tools.some((m: any) => String(m.content).includes("Successfully")))
        return reply(`coder-${call}`, "write", {
          path: "sum.js",
          content: resolved,
        });
      return reply(`coder-${call}`, "report", {
        kind: "done",
        summary: "Conflict resolved",
        detail: "Kept main's comment and the approved addition.",
      });
    },
  });
  assert.equal(r.finished.state, "paused");
  assert.deepEqual(r.finished.checkpoint.piState.carry, {
    kind: "conflict",
    conflicts: ["sum.js"],
    unmarked: [],
  });
  const assignment = await r.resume();
  assert.equal(assignment.rebase.hash, r.approvedHash);
  const resumed = JSON.stringify(r.coderInputs[1].messages);
  assert.match(resumed, /these files had conflict markers: sum\.js/);
  assert.match(resumed, /Do not implement the change again from scratch/);
  const after = await r.f.row(r.id);
  assert.equal(after.state, "publishing");
  assert.deepEqual(
    after.result.checkpoint.files.map((f: any) => [f.path, f.content]),
    [
      ["notes.md", notes],
      ["sum.js", resolved],
    ],
  );
  const system = systemOf(r.reviewInputs.at(-1));
  assert(system.includes("The merge conflicted in 1 file(s)"));
  assert(system.includes("sum.js"));
});

test("conflict markers left in a file the checks never read fail like a check and go back to the coder", async (t) => {
  const readme = (line: string) => `# Synthetic\n\n${line}\n`;
  const r = await rebased(t, {
    baseFiles: { "README.md": readme("Intro.") },
    candidateFiles: { "README.md": readme("Intro, with addition.") },
    moveMain: (write) => write("README.md", readme("Intro, from main.")),
    coder: (input, call) => {
      const read = readRequired(input);
      if (read) return read;
      const text = JSON.stringify(input.messages);
      if (!text.includes("check_failures"))
        // The first session claims it is done and leaves the markers.
        return reply(`coder-${call}`, "report", {
          kind: "done",
          summary: "Done",
          detail: "Claims the conflict is resolved.",
        });
      const tools = input.messages.filter((m: any) => m.role === "tool");
      if (!tools.some((m: any) => String(m.content).includes("Successfully")))
        return reply(`coder-${call}`, "write", {
          path: "README.md",
          content: readme("Intro, from main, with addition."),
        });
      return reply(`coder-${call}`, "report", {
        kind: "done",
        summary: "Markers removed",
        detail: "Combined both intro lines.",
      });
    },
  });
  const repair = r.coderInputs.find((input) =>
    JSON.stringify(input.messages).includes("check_failures"),
  );
  assert(repair);
  const failures = delivered(
    r.coderInputs.findLast((input) => delivered(input, "check_failures")),
    "check_failures",
  );
  assert.match(failures, /\$ conflict marker scan \(exit 1\)/);
  assert.match(failures, /README\.md: <<<<<<< /);
  assert.equal(r.finished.state, "publishing");
  assert(r.finished.result.checks.every((c: any) => c.exitCode === 0));
  assert.equal(
    r.finished.result.checkpoint.files.find((f: any) => f.path === "README.md")
      .content,
    readme("Intro, from main, with addition."),
  );
});

test("when main's change touches none of the change's files, the delta review reads main's complete diff", async (t) => {
  const r = await rebased(t, {
    moveMain: (write) => write("other.md", "Main's unrelated change.\n"),
  });
  assert.equal(r.calls.coder, 0);
  assert.equal(r.finished.state, "publishing");
  const review = r.reviewInputs.at(-1);
  assert(systemOf(review).includes("after a rebase"));
  const delta = delivered(review, "review_delta");
  assert.match(
    delta,
    /Every file this change touches is byte-identical to the approved candidate\. Main's complete diff/,
  );
  assert.match(delta, /\+Main's unrelated change\./);
});

test("a conflict git cannot mark, such as a file main made binary, is named as unmarked and not as holding markers", async (t) => {
  const r = await rebased(t, {
    baseFiles: { "data.txt": "line one\nline two\n" },
    candidateFiles: { "data.txt": "line one\nline two changed\n" },
    moveMain: (write) => write("data.txt", "bin\0ary\n"),
    coder: (input, call) => {
      const read = readRequired(input);
      if (read) return read;
      const tools = input.messages.filter((m: any) => m.role === "tool");
      if (!tools.some((m: any) => String(m.content).includes("Successfully")))
        return reply(`coder-${call}`, "write", {
          path: "data.txt",
          content: "line one\nline two changed\n",
        });
      return reply(`coder-${call}`, "report", {
        kind: "done",
        summary: "Kept the reviewed text file",
        detail: "Replaced main's binary data with the approved text.",
      });
    },
  });
  const conflicts = delivered(r.coderInputs[1], "rebase_conflicts");
  assert.doesNotMatch(conflicts, /contain git's conflict markers/);
  assert.match(
    conflicts,
    /These files conflict, but git could not mark them \(binary files, for example\), so they contain no markers\.[^\n]*\n- data\.txt\n/,
  );
  const first = JSON.stringify(r.coderInputs[0].messages);
  assert.doesNotMatch(first, /remove every conflict marker/);
  assert.equal(r.finished.state, "publishing");
  assert.deepEqual(r.finished.result.checkpoint.piState.carry, {
    kind: "conflict",
    conflicts: [],
    unmarked: ["data.txt"],
  });
  const system = systemOf(r.reviewInputs.at(-1));
  assert(system.includes("The merge conflicted in 1 file(s)"));
  assert(system.includes("data.txt"));
});
