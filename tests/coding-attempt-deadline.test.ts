import { test } from "node:test";
import assert from "node:assert/strict";
import { TWO_HOUR_BOX_IMAGES } from "../src/coding/controller.js";
import { fixture, settings } from "./helpers/coding-fixture.js";

// The controller's configuration (the fixture's settings) gives 15 minutes; each job below
// carries its own snapshot, which is what the provisioning deadline must follow.
const twoHourImage = `ghcr.io/akhilvuputuri/chief-agent-coding@sha256:${TWO_HOUR_BOX_IMAGES[0]}`;
const cases = [
  {
    name: "a Pi job's own limit",
    job: { runtime: "pi", limits: { ...settings.limits, ms: 7_200_000 } },
    activeMs: 7_200_000,
  },
  {
    name: "a Pi job above the three-hour ceiling",
    job: { runtime: "pi", limits: { ...settings.limits, ms: 14_400_000 } },
    activeMs: 10_800_000,
  },
  {
    name: "a Pi job on an image with a two-hour box task deadline",
    job: {
      runtime: "pi",
      image: twoHourImage,
      limits: { ...settings.limits, ms: 7_200_000 },
    },
    activeMs: 6_000_000,
  },
  {
    name: "a Python job, which has no Pi ceiling",
    job: {
      runtime: "python",
      squad: true,
      limits: { ...settings.limits, ms: 14_400_000 },
    },
    activeMs: 14_400_000,
  },
];
for (const { name, job: changed, activeMs } of cases)
  test(`the provisioning deadline follows ${name}, not the current configuration`, async (t) => {
    const f = await fixture(t),
      started = await f.start(`deadline-${activeMs}`, "plan");
    const snapshot = {
      ...settings,
      squad: false,
      autoMerge: false,
      ...changed,
    };
    await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
      started.id,
      JSON.stringify(snapshot),
    ]);
    await f.c.tick();
    const claimed = await f.row(started.id);
    assert.equal(claimed.state, "provisioning");
    // The five-minute startup margin, on the job's own active time.
    assert.equal(
      new Date(claimed.attempt_deadline).getTime() -
        new Date(claimed.heartbeat_at).getTime(),
      activeMs + 300_000,
    );
    // The box is asked for the same window.
    assert.equal(
      f.sandboxRequests()[0].timeoutMinutes,
      Math.ceil(activeMs / 60_000) + 5,
    );
    await f.c.heartbeat(claimed);
    const live = await f.row(started.id);
    assert.equal(
      new Date(live.attempt_deadline).getTime() -
        new Date(live.heartbeat_at).getTime(),
      activeMs,
    );
  });

test("a provisioning job is not timed out at the configuration's window when its own limit is longer", async (t) => {
  const f = await fixture(t),
    started = await f.start("deadline-before-heartbeat", "plan");
  // A cold box: no heartbeat-loss pause while this test waits for the deadline.
  f.startupGrace(60 * 60_000);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
      limits: { ...settings.limits, ms: 1_800_000 },
    }),
  ]);
  await f.c.tick();
  const claimed = await f.row(started.id);
  // Past the configuration's 20-minute window, inside the job's 35 minutes.
  f.advance(25 * 60_000);
  await f.c.tick();
  assert.equal((await f.row(started.id)).state, "provisioning");
  f.advance(11 * 60_000);
  await f.c.tick();
  const expired = await f.row(started.id);
  assert.equal(expired.attempt_id, claimed.attempt_id);
  assert.equal(expired.state, "paused");
  assert.match(expired.summary, /time ran out/);
});
