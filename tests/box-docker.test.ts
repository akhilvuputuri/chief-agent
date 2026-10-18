import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerRunner, type TaskOutput } from "../src/boxes/agent.js";

/**
 * The container runner's trust reset against a real Docker daemon. CI sets
 * CHIEF_BOX_DOCKER_IMAGE (an image with node, run as UID 1000) after `npm run build`.
 */
const image = process.env.CHIEF_BOX_DOCKER_IMAGE;
const dist = fileURLToPath(new URL("../dist", import.meta.url));

test(
  "each task runs in a fresh, unprivileged container and leaves nothing for the next",
  { skip: !image && "set CHIEF_BOX_DOCKER_IMAGE to run against Docker" },
  async (t) => {
    assert.ok(
      existsSync(join(dist, "boxes/echo-task.js")),
      "run npm run build first",
    );
    const root = await mkdtemp(join(tmpdir(), "box-docker-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const runner = new DockerRunner(image!, root, {
      extra: [
        "--entrypoint",
        "node",
        "--mount",
        `type=bind,source=${dist},target=/opt/box,readonly`,
      ],
      command: ["/opt/box/boxes/echo-task.js"],
      memory: "1g",
      cpus: "1",
    });
    const run = async (
      id: string,
      payload: Record<string, unknown>,
      messages: string[] = [],
    ) => {
      const outputs: TaskOutput[] = [];
      const running = runner.start({ id, kind: "echo", payload }, (o) => {
        outputs.push(o);
        if (o.type === "question") for (const m of messages) running.send(m);
      });
      const outcome = await running.done;
      await runner.reset(id);
      return { outcome, outputs };
    };

    const hostile = await run("hostile", { hostile: true, text: "x" });
    assert.equal(hostile.outcome.type, "result");
    const inspect = await run("inspect", { inspect: true });
    assert.deepEqual(inspect.outcome.payload.leftovers, []);
    assert.deepEqual(await readdir(root), []);
    const ps = spawnSync(
      "docker",
      ["ps", "-aq", "--filter", "label=chief.box.task"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(ps.stdout.trim(), "");

    const steered = await run("steered", { waitForMessage: true, text: "y" }, [
      "an answer",
    ]);
    assert.deepEqual(steered.outcome.payload.messages, ["an answer"]);

    // Seen from inside a task the runner started: unprivileged, no capabilities, read-only root.
    const probe = await run("probe", { probe: true });
    assert.deepEqual(probe.outcome.payload.probe, {
      uid: 1000,
      capEff: "0000000000000000",
      rootReadOnly: true,
    });
  },
);
