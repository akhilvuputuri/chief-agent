import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { boundedArray } from "../src/bounded-array.js";
import { checkpoint, outcome } from "../src/coding/schema.js";

// zod 3 validates every element of an over-long array and keeps an issue for each
// (GHSA-mrhx-c7xc-m3w5, journal 196). These tests count element visits and issues, not time.

const counted = () => {
  let seen = 0;
  const item = z
    .object({ name: z.string().max(5) })
    .strict()
    .superRefine(() => {
      seen++;
    });
  return { item, seen: () => seen };
};

test("a valid array parses to what z.array gives, transforms and defaults included", () => {
  const item = z
    .object({ name: z.string().trim(), kind: z.string().default("file") })
    .strict();
  const input = [{ name: " a " }, { name: "b", kind: "dir" }];
  assert.deepEqual(
    boundedArray(item, { min: 1, max: 2 }).parse(input),
    z.array(item).min(1).max(2).parse(input),
  );
  assert.deepEqual(boundedArray(item).parse([]), []);
  assert.deepEqual(boundedArray(item).default([]).parse(undefined), []);
  assert.equal(boundedArray(item).optional().parse(undefined), undefined);
});

test("an array over its maximum is refused before any element is read", () => {
  const { item, seen } = counted();
  const result = boundedArray(item, { max: 3 }).safeParse(
    new Array(100_000).fill(0),
  );
  assert.equal(result.success, false);
  assert.equal(seen(), 0);
  assert.deepEqual(
    result.error!.issues.map((issue) => [issue.code, issue.path]),
    [["too_big", []]],
  );
  // zod's own array reads all of them; this is the behaviour being replaced.
  assert.equal(
    z.array(item).max(3).safeParse(new Array(1000).fill(0)).error!.issues
      .length,
    1001,
  );
});

test("an array under its minimum is refused with one issue", () => {
  const result = boundedArray(z.string(), { min: 1 }).safeParse([]);
  assert.deepEqual(
    result.error!.issues.map((issue) => issue.code),
    ["too_small"],
  );
});

test("the first bad element ends the parse, with its index in the path", () => {
  const { item, seen } = counted();
  const input = [
    { name: "ok" },
    { name: "too long" },
    ...new Array(50_000).fill(0),
  ];
  const result = z.object({ files: boundedArray(item) }).safeParse({
    files: input,
  });
  assert.equal(result.success, false);
  // The object refinement runs for the two objects read; nothing after them is visited.
  assert.equal(seen(), 2);
  assert.deepEqual(
    result.error!.issues.map((issue) => [issue.code, issue.path]),
    [["too_big", ["files", 1, "name"]]],
  );
});

test("a value that is not an array is refused as zod refuses it", () => {
  for (const value of [undefined, null, "x", 3, { length: 2 }]) {
    const mine = boundedArray(z.string()).safeParse(value);
    const zods = z.array(z.string()).safeParse(value);
    assert.equal(mine.success, false);
    assert.deepEqual(
      mine.error!.issues.map(({ code, message, path }) => ({
        code,
        message,
        path,
      })),
      zods.error!.issues.map(({ code, message, path }) => ({
        code,
        message,
        path,
      })),
    );
  }
});

test("worker checkpoints and outcomes refuse oversized arrays with one issue each", () => {
  const zeros = new Array(200_000).fill(0);
  const bodies: [string, z.ZodTypeAny, unknown][] = [
    ["files", checkpoint, { files: zeros }],
    ["delivered", checkpoint, { piState: { version: 1, delivered: zeros } }],
    ["conflicts", checkpoint, { piState: { version: 1, conflicts: zeros } }],
    [
      "runtime memory receipts",
      checkpoint,
      {
        runtimeMemory: {
          scopeHash: "a".repeat(64),
          coder: { receipts: zeros },
        },
      },
    ],
    [
      "checks",
      outcome,
      { kind: "failed", summary: "x", checkpoint: {}, checks: zeros },
    ],
    [
      "options",
      outcome,
      { kind: "failed", summary: "x", checkpoint: {}, options: zeros },
    ],
  ];
  for (const [name, schema, body] of bodies) {
    const result = schema.safeParse(body);
    assert.equal(result.success, false, name);
    assert.equal(result.error!.issues.length, 1, name);
  }
  // Unchanged for real payloads.
  const saved = checkpoint.parse({
    files: [{ path: "a.txt", content: "a", mode: "100644" }],
    piState: {
      version: 1,
      delivered: ["0b0e2a52-6a0b-4d1c-9a3e-0d6b2f6d7c11"],
      conflicts: [{ path: "a.txt", status: "UU", markers: true }],
    },
  });
  assert.equal(saved.files[0].path, "a.txt");
  assert.equal(saved.piState!.delivered.length, 1);
  assert.equal(saved.piState!.conflicts![0].status, "UU");
});

test("no schema a coding worker's request reaches uses zod's own array", () => {
  for (const file of [
    "api.ts",
    "schema.ts",
    "squad-schema.ts",
    "memory-schema.ts",
    "pi-sessions.ts",
  ]) {
    const source = readFileSync(
      new URL(`../src/coding/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /\bz\s*\.\s*array\(|\.array\(\s*$/m, file);
  }
});
