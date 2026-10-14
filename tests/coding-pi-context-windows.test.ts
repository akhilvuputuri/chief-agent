import test from "node:test";
import assert from "node:assert/strict";
import { fixture, settings } from "./helpers/coding-fixture.js";
import { CodingController } from "../src/coding/controller.js";
import { codingSettings } from "../src/coding/schema.js";

const pi = codingSettings.parse({
  ...settings,
  runtime: "pi",
  model: "deepseek/deepseek-v4.1-flash",
  leaderModel: "deepseek/deepseek-v4.1-flash",
  reviewerModel: "google/gemini-4-argon",
  maxOutputTokens: 16000,
});

const controller = (f: Awaited<ReturnType<typeof fixture>>, catalog: any) =>
  new CodingController(
    f.db,
    pi,
    f.provider as any,
    f.publisher as any,
    "c".repeat(64),
    "https://coding.example.com",
    (u) => u === "a",
    () => ({
      generate: async () => ({ message: { role: "assistant", content: "" } }),
    }),
    () => new Date(),
    catalog,
  );
const start = (c: CodingController, run: string, key: string) =>
  c.call("a", run, {
    operation: "coding_start",
    requestKey: key,
    objective: "Synthetic objective",
    context: "Synthetic context",
    mode: "plan",
  }) as Promise<any>;

test("Pi jobs snapshot catalog context windows and send them beside strictly validated settings", async (t) => {
  const f = await fixture(t);
  const c = controller(f, async () => [
    {
      id: "deepseek/deepseek-v4.1-flash",
      inputPrice: 0.02,
      outputPrice: 0.9,
      tools: true,
      contextWindow: 1_048_576,
    },
    {
      id: "google/gemini-4-argon",
      inputPrice: 2,
      outputPrice: 10,
      tools: true,
      contextWindow: 1_048_576,
    },
    {
      id: "unrelated/model",
      inputPrice: 1,
      outputPrice: 1,
      tools: true,
      contextWindow: 9000,
    },
    { id: "openai/gpt-6.1-sol", inputPrice: 2, outputPrice: 10, tools: true },
  ]);
  const job = await start(c, f.run, "windows");
  const stored = (
    await f.db.query("SELECT settings FROM coding_jobs WHERE id=$1", [job.id])
  ).rows[0].settings;
  assert.deepEqual(stored.contextWindows, {
    "deepseek/deepseek-v4.1-flash": 1_048_576,
    "google/gemini-4-argon": 1_048_576,
  });
  const row = (
    await f.db.query("SELECT * FROM coding_jobs WHERE id=$1", [job.id])
  ).rows[0];
  const assignment: any = await c.assignment({
    ...row,
    settings: codingSettings.parse(row.settings),
    attempt_deadline: new Date(Date.now() + 60000),
  });
  assert.equal("contextWindows" in assignment.settings, false);
  assert.deepEqual(assignment.contextWindows, stored.contextWindows);
  // A worker built before this field strictly validates settings and ignores unknown top-level keys.
  const strictBefore = codingSettings
    .innerType()
    .omit({ contextWindows: true })
    .strict();
  assert.doesNotThrow(() => strictBefore.parse(assignment.settings));
});

test("catalog failure or missing metadata leaves Pi jobs without guessed windows", async (t) => {
  const f = await fixture(t);
  const failing = controller(f, async () => {
    throw new Error("catalog unavailable");
  });
  const job = await start(failing, f.run, "no-catalog");
  const row = (
    await f.db.query("SELECT settings FROM coding_jobs WHERE id=$1", [job.id])
  ).rows[0];
  assert.equal(row.settings.contextWindows, undefined);
  const missing = controller(f, async () => [
    {
      id: "google/gemini-4-argon",
      inputPrice: 2,
      outputPrice: 10,
      tools: true,
    },
  ]);
  const other = await start(missing, f.run, "no-metadata");
  const second = (
    await f.db.query("SELECT settings FROM coding_jobs WHERE id=$1", [other.id])
  ).rows[0];
  assert.equal(second.settings.contextWindows, undefined);
});

test("context windows are rejected outside the Pi profile and when out of bounds", () => {
  assert.throws(() =>
    codingSettings.parse({ ...settings, contextWindows: { "a/b": 100000 } }),
  );
  assert.throws(() =>
    codingSettings.parse({ ...pi, contextWindows: { "a/b": 10 } }),
  );
  assert.throws(() =>
    codingSettings.parse({
      ...pi,
      contextWindows: { "a/b": 2000, "c/d": 2000, "e/f": 2000, "g/h": 2000 },
    }),
  );
});
