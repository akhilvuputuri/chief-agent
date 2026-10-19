import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateArgs, steerArgs } from "../src/boxes/probe-args.js";

test("probe delegate turns flags into the echo payload and keeps the rest as text", () => {
  assert.deepEqual(delegateArgs(["box", "k1", "hello", "there"]), {
    boxId: "box",
    requestKey: "k1",
    payload: { text: "hello there" },
  });
  assert.deepEqual(
    delegateArgs(["box", "k2", "--wait", "--probe", "say", "--hostile"]),
    {
      boxId: "box",
      requestKey: "k2",
      payload: { waitForMessage: true, probe: true, text: "say --hostile" },
    },
  );
  assert.deepEqual(delegateArgs(["box", "k3", "--hostile"]).payload, {
    hostile: true,
  });
  assert.throws(() => delegateArgs(["box", "k4", "--sudo"]), /Unknown flag/);
  // A lone "--" is not an end-of-flags marker; text cannot start with "--".
  assert.throws(
    () => delegateArgs(["box", "k5", "--", "text"]),
    /Unknown flag/,
  );
  assert.throws(() => delegateArgs(["box"]), /delegate/);
});

test("probe steer needs a box, task, request key and text", () => {
  assert.deepEqual(steerArgs(["box", "task", "k", "use", "this"]), {
    boxId: "box",
    taskId: "task",
    requestKey: "k",
    text: "use this",
  });
  assert.throws(() => steerArgs(["box", "task", "k"]), /steer/);
  assert.throws(() => steerArgs(["box", "", "k", "text"]), /steer/);
});
