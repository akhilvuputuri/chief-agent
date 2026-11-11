import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import ranFiles from "./test-ran-files.mjs";
import {
  allTestFiles,
  assignShards,
  isolationMode,
  parseShard,
  rerunPlan,
  undecidedFiles,
} from "./test-shard.mjs";
import {
  assertComplete,
  testTitles,
  weightsFromLog,
} from "./update-test-weights.mjs";

test("every test file lands in exactly one shard, including unrecorded ones", () => {
  const files = allTestFiles();
  const weights = JSON.parse(readFileSync("tests/test-weights.json", "utf8"));
  const shards = assignShards(
    [...files, "tests/brand-new.test.ts"],
    weights,
    6,
  );
  assert.equal(shards.length, 6);
  assert.deepEqual(
    shards.flat().sort(),
    [...files, "tests/brand-new.test.ts"].sort(),
  );
});

test("shards are deterministic and balanced by recorded time", () => {
  const weights = {
    "a.ts": 100,
    "b.ts": 60,
    "c.ts": 40,
    "d.ts": 30,
    "e.ts": 30,
    "f.ts": 20,
  };
  const files = Object.keys(weights);
  const shards = assignShards(files, weights, 2);
  assert.deepEqual(shards, assignShards([...files].reverse(), weights, 2));
  const totals = shards.map((s) => s.reduce((n, f) => n + weights[f], 0));
  assert.ok(Math.abs(totals[0] - totals[1]) <= 20, String(totals));
});

test("the recorded times give shards far closer than an even file split", () => {
  const files = allTestFiles();
  const weights = JSON.parse(readFileSync("tests/test-weights.json", "utf8"));
  const totals = assignShards(files, weights, 6).map((s) =>
    s.reduce((n, f) => n + (weights[f] ?? 0), 0),
  );
  assert.ok(Math.max(...totals) - Math.min(...totals) < 15, String(totals));
});

test("a malformed shard is refused", () => {
  assert.deepEqual(parseShard("2/6"), { index: 2, count: 6 });
  for (const bad of ["0/6", "7/6", "2", "a/b"])
    assert.throws(() => parseShard(bad));
});

test("weights credit each duration to the file declaring that title", () => {
  const owners = testTitles({
    "tests/a.test.ts": `test("first", () => {});\ntest("it's shared", () => {});`,
    "tests/b.test.ts": `test(\n  "second \\"quoted\\"",\n  () => {},\n);\ntest("it's shared", () => {});`,
  });
  const row = (shard, text) =>
    `tests ${shard}/6\tstep\t2026-10-31T09:06:38.1Z ${text}`;
  const log = [
    row(1, "ok 1 - first"),
    row(1, "  ---"),
    row(1, "  duration_ms: 1500"),
    row(2, 'ok 1 - second "quoted"'),
    row(2, "  duration_ms: 2000"),
    row(2, "ok 2 - it's shared"),
    row(2, "  duration_ms: 9000"),
    row(1, "not ok 2 - first"),
    row(1, "  duration_ms: 500"),
    "format and types\tstep\t2026-10-31T09:06:38.1Z ok 1 - first",
  ].join("\n");
  assert.deepEqual(weightsFromLog(log, owners), {
    "tests/a.test.ts": 2,
    "tests/b.test.ts": 2,
  });
});

test("weights credit templated titles, and a literal title beats a template", () => {
  const owners = testTitles({
    "tests/loop.test.ts":
      "test(`preserves ${size}-character reports`, () => {});",
    "tests/exact.test.ts": 'test("preserves 8-character reports", () => {});',
  });
  const row = (text) => `tests 1/6\tstep\t2026-10-31T09:06:38.1Z ${text}`;
  const log = [
    row("ok 1 - preserves 16000-character reports"),
    row("  duration_ms: 3000"),
    row("ok 2 - preserves 8-character reports"),
    row("  duration_ms: 1000"),
    row("ok 3 - preserves nothing"),
    row("  duration_ms: 9000"),
  ].join("\n");
  assert.deepEqual(weightsFromLog(log, owners), {
    "tests/exact.test.ts": 1,
    "tests/loop.test.ts": 3,
  });
});

test("a log is refused unless every shard reached its summary", () => {
  const row = (shard, text) =>
    `tests ${shard}/2\tstep\t2026-10-31T09:06:38.1Z ${text}`;
  const finished = (shard) =>
    [row(shard, "ok 1 - a"), row(shard, "# tests 1")].join("\n");
  assert.doesNotThrow(() =>
    assertComplete([finished(1), finished(2)].join("\n")),
  );
  // Cut off inside the second shard, the way a truncated log looks.
  assert.throws(
    () => assertComplete([finished(1), row(2, "ok 1 - a")].join("\n")),
    /Only 1 of 2/,
  );
  // A whole shard missing, and a log with no shards at all.
  assert.throws(() => assertComplete(finished(1)), /Only 1 of 2/);
  assert.throws(() => assertComplete("format\tstep\tnothing"), /Only 0/);
});

test("a serial run shares one process, and parallel files keep their own", () => {
  assert.equal(isolationMode({}), "shared");
  assert.equal(isolationMode({ TEST_CONCURRENCY: "1" }), "shared");
  assert.equal(isolationMode({ TEST_CONCURRENCY: "4" }), "process");
  assert.equal(isolationMode({ TEST_ISOLATION: "process" }), "process");
  assert.throws(() => isolationMode({ TEST_ISOLATION: "none" }), /Invalid/);
  assert.throws(
    () => isolationMode({ TEST_ISOLATION: "shared", TEST_CONCURRENCY: "4" }),
    /one file at a time/,
  );
});

test("files that failed or never reported are left undecided", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];
  const report = [
    "ran /repo/tests/a.test.ts",
    "ran /repo/tests/b.test.ts",
    "failed /repo/tests/b.test.ts",
    // A test declared in a helper reports the helper's path, which names no test file.
    "ran /repo/tests/helpers/shared.ts",
    "",
  ].join("\n");
  assert.deepEqual(undecidedFiles(files, report, "/repo"), [
    "tests/b.test.ts",
    "tests/c.test.ts",
  ]);
  // No report at all, as after a crash: nothing is decided.
  assert.deepEqual(undecidedFiles(files, "", "/repo"), files);
  assert.deepEqual(
    undecidedFiles(
      files,
      files.map((f) => `ran /repo/${f}`).join("\n"),
      "/repo",
    ),
    [],
  );
});

test("the reporter names each file once when it runs and once when it fails", async () => {
  const events = [
    { type: "test:start", data: { file: "/r/a.test.ts" } },
    { type: "test:pass", data: { file: "/r/a.test.ts" } },
    { type: "test:pass", data: { file: "/r/a.test.ts" } },
    { type: "test:fail", data: { file: "/r/b.test.ts" } },
    { type: "test:fail", data: { file: "/r/b.test.ts" } },
    { type: "test:pass", data: {} },
  ];
  let written = "";
  for await (const line of ranFiles(events)) written += line;
  assert.equal(
    written,
    "ran /r/a.test.ts\nran /r/b.test.ts\nfailed /r/b.test.ts\ncomplete\n",
  );
});

test("a shared run decides nothing it cannot vouch for", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "chief-shared-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const write = (name, body) =>
    writeFileSync(
      join(dir, "tests", `${name}.test.ts`),
      `import test from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`,
    );
  const script = resolve("scripts/test-shard.mjs");
  // Whatever this test run was started with must not reach the runs below, least of all
  // the marker that tells node it is already inside a test run.
  const {
    TEST_SHARD,
    TEST_CONCURRENCY,
    TEST_ISOLATION,
    NODE_TEST_CONTEXT,
    ...inherited
  } = process.env;
  const run = (env = {}) => {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...inherited,
        ...env,
        PATH: `${resolve("node_modules/.bin")}:${process.env.PATH}`,
      },
    });
    return { code: result.status, output: result.stdout + result.stderr };
  };

  const remove = (...names) =>
    names.forEach((name) => rmSync(join(dir, "tests", `${name}.test.ts`)));

  write("a", `globalThis.leaked = true; test("a", () => {});`);
  let result = run();
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /one process each/);

  // Fails only beside a. It passes alone, but that leaves the failed run unexplained, so
  // a runs alone too before the run may pass.
  write("b", `test("b", () => assert.equal(globalThis.leaked, undefined));`);
  result = run();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /1 test file\(s\) failed or did not report/);
  assert.match(result.output, /Running the other 1 file\(s\) one process each/);

  // A real failure fails at once, from the failed files alone.
  write("d", `test("d", () => assert.equal(1, 2));`);
  result = run();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /2 test file\(s\) failed or did not report/);
  assert.doesNotMatch(result.output, /Running the other/);

  // A file that ends the process early cannot hide the files after it.
  write("c", `test("c", () => process.exit(0));`);
  result = run();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /tests\/d\.test\.ts/);

  // One process per file never takes the shared path.
  result = run({ TEST_ISOLATION: "process" });
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, /shared process/);
  remove("c", "d");

  // Node fails this run without naming x: its timer throws after its test ended. b is the
  // only named failure and passes alone, which must not pass the run.
  write(
    "x",
    `test("x", () => { setTimeout(() => { throw new Error("late"); }, 50); });
     test("x waits", () => new Promise((done) => setTimeout(done, 200)));`,
  );
  result = run();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Running the other 2 file\(s\) one process each/);
  remove("b", "x");

  // Another file's leftover timer ends the process with code 0 while m is midway: m has
  // reported a test, and its failing one never ran.
  remove("a");
  write("l", `test("l", () => { setTimeout(() => process.exit(0), 250); });`);
  write(
    "m",
    `test("m1", () => {});
     test("m2", () => new Promise((done) => setTimeout(done, 600)));
     test("m3", () => assert.equal(1, 2));`,
  );
  result = run();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /stopped before finishing/);
  remove("l", "m");
  write("a", `globalThis.leaked = true; test("a", () => {});`);

  // A crash after a file's first test: that file has reported, and must still not count.
  write(
    "k",
    `test("k1", () => {});
     test("k2", async () => {
       await new Promise((done) => setTimeout(done, 300));
       process.kill(process.pid, "SIGKILL");
     });`,
  );
  result = run();
  // tsx reports its child's death as a failed exit, not a signal, so this arrives as a
  // failure that names no file. Either way every file runs alone.
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Running every file one process each/);
  assert.match(result.output, /not ok \d+ - tests\/k\.test\.ts/);
});

test("only a clean shared run is believed", () => {
  const files = ["a", "b", "c"];
  const plan = (undecided, code, crashed = false, complete = true) =>
    rerunPlan({ files, undecided, code, crashed, complete });
  assert.deepEqual(plan([], 0), { first: [], thenIfPassed: [] });
  // Clean exit, but a file never reported: only that file is in doubt.
  assert.deepEqual(plan(["c"], 0), { first: ["c"], thenIfPassed: [] });
  // Named failures run first; if they pass alone, the others must run too.
  assert.deepEqual(plan(["b"], 1), { first: ["b"], thenIfPassed: ["a", "c"] });
  // A failure nothing accounts for, and a crash: every file runs alone.
  assert.deepEqual(plan([], 1), { first: files, thenIfPassed: [] });
  assert.deepEqual(plan(["b"], 1, true), { first: files, thenIfPassed: [] });
  assert.deepEqual(plan([], 0, true), { first: files, thenIfPassed: [] });
  // Exit code 0 from a run that never finished proves nothing.
  assert.deepEqual(plan([], 0, false, false), {
    first: files,
    thenIfPassed: [],
  });
});
