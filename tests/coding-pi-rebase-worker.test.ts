import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type Scenario = {
  /** What main changes after the candidate was reviewed. */
  moveMain: (
    write: (path: string, text: string) => Promise<void>,
  ) => Promise<void>;
  /** The scripted coder; any call fails a scenario that expects none. */
  coder?: (input: any, call: number) => any;
  /** Breaks the carried change's identity, so it cannot be carried. */
  tamper?: boolean;
  /** The job was created on an earlier worker image that the boxes still accept. */
  olderImage?: string;
};

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
  const write = (path: string, text: string) =>
    writeFile(join(source, path), text);
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await write(".gitignore", "node_modules/\n");
  await write("sum.js", sumFile(subtract));
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
  await f.c.tick();
  const running = await f.row(started.id);
  const assignment = await f.c.assignment(running);
  await runPiWorker(
    new NativePiWorkerClient(
      origin,
      running.id,
      f.c.token(running.id, running.attempt_id),
      new AbortController().signal,
    ),
    () => {},
    new AbortController().signal,
    {
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
    },
  );
  const finished = await f.row(started.id);
  /** Publishes the approved candidate and runs the automation to the Merge card. */
  const toMergeCard = async () => {
    (f.publisher as any).publish = async () => ({ url, head, tree });
    await f.c.tick();
    await f.c.tick();
    assert.equal((await f.row(started.id)).state, "pr_ready");
    await auto.tick();
    await auto.tick();
    return (
      await f.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND event_key LIKE 'merge-approval:2:%'",
        [started.id],
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
