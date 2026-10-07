import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { destination, workDestination, threadId, slowReply } = await import(
  pathToFileURL(process.argv[2])
);
const [id, group] = process.argv.slice(3);
if (group === "regression") {
  assert.deepEqual(destination({ kind: "news" }), {
    kind: "topic",
    topic: "news",
  });
  assert.deepEqual(destination({ kind: "markets" }), {
    kind: "topic",
    topic: "markets",
  });
  assert.deepEqual(destination({ kind: "unprompted", threadId: 50 }), {
    kind: "general",
  });
  assert.deepEqual(destination({ kind: "foreground", threadId: 50 }), {
    kind: "thread",
    threadId: 50,
  });
  for (const value of [
    0,
    1,
    -2,
    1.5,
    NaN,
    Infinity,
    "3",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(threadId(value), undefined);
  assert.equal(
    slowReply(
      { threadId: 42, receivedAt: "2026-01-01T00:00:00Z" },
      Date.parse("2026-01-01T00:02:00Z"),
    ),
    true,
  );
} else if (id === "chief-routing-owner") {
  for (const value of [2, 42, Number.MAX_SAFE_INTEGER])
    assert.deepEqual(destination({ kind: "owner_work", threadId: value }), {
      kind: "thread",
      threadId: value,
    });
  for (const value of [undefined, 1, -2, 1.5])
    assert.deepEqual(destination({ kind: "owner_work", threadId: value }), {
      kind: "general",
    });
} else {
  assert.deepEqual(
    workDestination({ destination: { kind: "topic", topic: "updates" } }),
    { kind: "general" },
  );
  for (const topic of ["news", "markets", "coding"])
    assert.deepEqual(
      workDestination({ destination: { kind: "topic", topic } }),
      { kind: "topic", topic },
    );
  assert.deepEqual(
    workDestination({
      sourceLabel: "Scheduled",
      destination: { kind: "thread", threadId: 42 },
    }),
    { kind: "general" },
  );
  assert.deepEqual(
    workDestination({ destination: { kind: "thread", threadId: 42 } }),
    { kind: "thread", threadId: 42 },
  );
}

// Reaching every assertion is required; candidate exit(0) is not success.
process.exitCode = 42;
