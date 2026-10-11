import { createRequire } from "node:module";
const acceptanceGuard = createRequire(import.meta.url)(
  "/opt/pi-runtime/process-boundary.node",
);
if (!acceptanceGuard.lockdown()) throw Error("Native guard unavailable");
const bootstrap = JSON.parse(await readFile("/dev/stdin", "utf8"));
test("paid full Pi report workflow on a multi-file options fixture", async (t) => {
  const f = await fixture(t),
    root = await mkdtemp(join(tmpdir(), "pi-report-paid-")),
    source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(
    join(source, "src/options.js"),
    "export function resolveOptions(base, overrides={}) { return {...base,...overrides}; }\n",
  );
  await writeFile(
    join(source, "src/format.js"),
    "export const describe = c => `${c.model}/${c.reviewerModel}/${c.effort}`;\n",
  );
  const assertions = `import assert from 'node:assert/strict';import {resolveOptions} from './src/options.js';import {describe} from './src/format.js';
 const base={model:'coder-a',reviewerModel:'reviewer-a',effort:'high',limits:{models:40,tools:100}}; const before=JSON.stringify(base);
 const a=resolveOptions(base,{model:'coder-b',limits:{tools:200}});assert.deepEqual(a,{model:'coder-b',reviewerModel:'reviewer-a',effort:'high',limits:{models:40,tools:200}});assert.equal(describe(a),'coder-b/reviewer-a/high');
 assert.deepEqual(resolveOptions(base),base);assert.deepEqual(resolveOptions(base,{effort:'low'}).limits,base.limits);
 for(const invalid of [{model:''},{reviewerModel:2},{effort:'ultra'},{unknown:1},{limits:{bad:2}},{limits:{models:0}},{limits:{tools:1.5}},{limits:{tools:Infinity}},{limits:null},null])assert.throws(()=>resolveOptions(base,invalid));
 a.limits.models=999;assert.equal(JSON.stringify(base),before);const ov={limits:{models:55}};const c=resolveOptions(base,ov);c.limits.models=99;assert.equal(ov.limits.models,55);assert.equal(JSON.stringify(base),before);
 `;
  await writeFile(join(source, "test.mjs"), assertions);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "pi-report-options-fixture",
      version: "1.0.0",
      type: "module",
      scripts: {
        check: "node test.mjs",
        build: "node --check src/options.js",
        "format:check": "node --check src/format.js",
      },
    }),
  );
  await writeFile(
    join(source, "package-lock.json"),
    JSON.stringify({
      name: "pi-report-options-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "pi-report-options-fixture", version: "1.0.0" } },
    }),
  );
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const commit = git("rev-parse", "HEAD").toString().trim();
  const objective =
    "Fix resolveOptions in src/options.js. Preserve the API and src/format.js. Merge model, reviewerModel and effort overrides with defaults; merge nested limits per field. Accept effort low/medium/high, nonempty string model IDs, and positive finite integer model/tool limits. Reject unknown top-level/nested keys, malformed values and null overrides or limits. Return independent objects without mutating or retaining mutable references to base or overrides. Modify only src/options.js. All existing npm check/build/format checks must genuinely pass; do not change tests or scripts. This is an isolated, explicitly authorized acceptance fixture. First inspect and plan; the fixture caller will confirm the exact returned plan before implementation. The reviewer independently checks the completed candidate.";
  const started = await f.start("pi-report-paid", "plan");
  const profile = {
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
    model: bootstrap.model,
    leaderModel: bootstrap.model,
    reviewerModel: bootstrap.reviewer,
    maxOutputTokens: 16000,
    limits: { ms: 2400000, models: 400, tools: 1000 },
  };
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3,objective=$4,context=$5 WHERE id=$1",
    [
      started.id,
      JSON.stringify(profile),
      commit,
      objective,
      "Preserve every requirement and use actual source/check evidence. This fixture permits its stated implementation only after exact fixture confirmation.",
    ],
  );
  f.setGeneration(async (model, input) => {
    const response = await fetch(bootstrap.proxy + "/generate", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + bootstrap.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: input.messages,
        tools: input.tools,
      }),
      signal: input.signal,
    });
    if (!response.ok)
      throw Error("Acceptance model proxy failed: " + response.status);
    return response.json();
  });
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const run = async () => {
    const job = await f.row(started.id);
    await runPiWorker(
      new NativePiWorkerClient(
        origin,
        job.id,
        f.c.token(job.id, job.attempt_id),
        new AbortController().signal,
      ),
      acceptanceGuard.cleanup,
      new AbortController().signal,
      {
        prepareRepository: async (directory, assignment) => {
          execFileSync("git", ["clone", "--no-hardlinks", source, directory], {
            stdio: "pipe",
          });
          execFileSync(
            "git",
            ["-C", directory, "checkout", "--detach", assignment.baseSha],
            { stdio: "pipe" },
          );
        },
      },
    );
  };
  await f.c.tick();
  await run();
  let job = await f.row(started.id);
  console.log(
    JSON.stringify({
      phase: "plan",
      state: job.state,
      calls: f.modelCalls(),
      planCharacters: job.checkpoint.plan.length,
      reportVersion: job.checkpoint.piState?.reportDocument?.version,
      summary: job.state === "paused" ? job.summary : undefined,
    }),
  );
  assert.equal(job.state, "plan_ready");
  const completePlan = job.checkpoint.plan;
  assert(completePlan.length > 0);
  assert.equal(job.checkpoint.piState.reportDocument.detail, completePlan);
  await f.c.tick();
  await f.c.tick();
  let approval = "",
    messageId = 0,
    sequence = 0;
  for (let i = 0; i < 100 && !approval; i++)
    await f.c.deliver(async (_u, _target, text, id) => {
      const message_id = ++sequence;
      if (id) {
        assert(text.includes(completePlan));
        approval = id;
        messageId = message_id;
      }
      return { message_id };
    });
  assert(approval);
  await assert.rejects(
    f.c.requirements.confirm("b", approval, true, "b", messageId),
  );
  await f.c.requirements.confirm("a", approval, true, "a", messageId);
  await f.c.tick();
  await run();
  job = await f.row(started.id);
  console.log(
    JSON.stringify({
      phase: "build-review",
      state: job.state,
      calls: f.modelCalls(),
      summary: job.state === "paused" ? job.summary : undefined,
      checks: job.result?.checks?.map((c: any) => ({
        command: c.command,
        exitCode: c.exitCode,
      })),
      verdict: job.result?.review?.verdict,
    }),
  );
  assert.equal(job.state, "publishing");
  assert.equal(job.checkpoint.plan, completePlan);
  assert.equal(job.result.review.verdict, "APPROVE");
  assert(job.result.checks.every((c: any) => c.exitCode === 0));
  assert.equal(job.checkpoint.files.length, 1);
  assert.equal(job.checkpoint.files[0].path, "src/options.js");
  const verify = join(root, "verify");
  await mkdir(verify);
  execFileSync("git", ["clone", "--no-hardlinks", source, verify], {
    stdio: "pipe",
  });
  await writeFile(
    join(verify, "src/options.js"),
    job.checkpoint.files[0].content,
  );
  execFileSync(process.execPath, ["test.mjs"], { cwd: verify, stdio: "pipe" });
  await f.c.tick();
  await f.c.tick();
  assert.equal((await f.row(job.id)).state, "pr_ready");
  assert.equal(f.publishes(), 1);
  console.log(
    JSON.stringify({
      acceptance: true,
      model: bootstrap.model,
      reviewer: bootstrap.reviewer,
      calls: f.modelCalls(),
      fullRequirementsPreserved: true,
      externalAssertionsPassed: true,
      publication: "fixture draft publisher",
      realOwnerWrites: 0,
    }),
  );
});
