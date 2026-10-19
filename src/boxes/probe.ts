/**
 * Operator probe for boxed sub-agents (docs/boxes.md, phase 3). Runs inside the gateway
 * container against the production database, as the configured owner. Apart from `orphan`
 * it only writes box requests; the running gateway's reconciler launches, serves and ends
 * the boxes.
 *
 *   node dist/boxes/probe.js spawn <profile> <request-key>
 *   node dist/boxes/probe.js delegate <box-id> <request-key> [--wait] [--hostile] [--inspect] [--probe] <text>
 *   node dist/boxes/probe.js steer <box-id> <task-id> <request-key> <text>
 *   node dist/boxes/probe.js status <box-id>
 *   node dist/boxes/probe.js timings <box-id>
 *   node dist/boxes/probe.js close <box-id>
 *   node dist/boxes/probe.js orphan <profile>
 */
import { randomBytes, randomUUID } from "node:crypto";
import { connect } from "../db.js";
import { BoxController } from "./controller.js";
import { boxSettings, loadBoxesFile } from "./config.js";
import { delegateArgs, steerArgs } from "./probe-args.js";
import type { BoxProvider } from "./provider.js";

const env = process.env;
const owner = (env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",")[0];
const [command, ...args] = process.argv.slice(2);
if (!owner || !env.DATABASE_URL || !env.BOX_AUTH_KEY || !env.BOX_AWS_ACCOUNT_ID)
  throw new Error(
    "Run inside the gateway container (DATABASE_URL, BOX_AUTH_KEY, BOX_AWS_ACCOUNT_ID, TELEGRAM_ALLOWED_USER_IDS)",
  );
const file = loadBoxesFile(new URL("../../config/boxes.json", import.meta.url));
const settings = boxSettings(file, env.BOX_AWS_ACCOUNT_ID);
// The probe never reconciles, so it needs no provider; the gateway's controller does that.
const inert = new Proxy({} as BoxProvider, {
  get: () => {
    throw new Error("The probe does not call providers");
  },
});
const db = connect(env.DATABASE_URL);
const boxes = new BoxController(
  db,
  settings.config,
  Object.fromEntries(
    Object.values(settings.config.profiles).map((p) => [p.provider, inert]),
  ),
  env.BOX_AUTH_KEY,
  env.CODING_PUBLIC_ORIGIN ?? "",
  undefined,
  {},
  // Steering from the probe is the operator acting for the owner from a shell that can
  // already write box messages. Chief's own controller still refuses all steering: no
  // owner-input check is wired there yet.
  async (_user, run, inputId) =>
    run === "probe" && inputId.startsWith("probe:"),
);

async function timings(id: string) {
  const box = (
    await db.query(
      "SELECT state,reason,epoch,launch_started_at,running_ms,created_at FROM boxes WHERE id=$1 AND user_id=$2",
      [id, owner],
    )
  ).rows[0];
  if (!box) throw new Error("Box not found");
  // Each epoch's first event is the box's first report after a hello (boot or warm start).
  const epochs = (
    await db.query(
      "SELECT epoch,min(created_at) AS first FROM box_events WHERE box_id=$1 GROUP BY epoch ORDER BY epoch",
      [id],
    )
  ).rows;
  const launched = box.launch_started_at && new Date(box.launch_started_at);
  return {
    state: box.state,
    reason: box.reason,
    epoch: box.epoch,
    runningMs: Number(box.running_ms),
    launchToFirstReportMs:
      launched && epochs[0]
        ? new Date(epochs[0].first).getTime() - launched.getTime()
        : null,
    epochs: epochs.map((e) => ({ epoch: e.epoch, firstReport: e.first })),
  };
}

/**
 * Launches one instance from the profile's own template for a box the database has never
 * heard of, then stops it as soon as it runs, long before its agent could say hello (a
 * cold boot takes minutes). A refused hello would power the instance off by itself; a
 * stopped one can only be ended by an API call, so its termination proves the gateway's
 * sweep. Its bootstrap secret is random in any case.
 */
async function orphan(profile: string) {
  if (settings.config.profiles[profile]?.provider !== "ec2")
    throw new Error(`${profile} is not an EC2 profile`);
  const { Ec2BoxProvider } = await import("./ec2-provider.js");
  const { EC2Client } = await import("@aws-sdk/client-ec2");
  const provider = new Ec2BoxProvider(
    new EC2Client({ region: file.region, maxAttempts: 1 }),
    file.environment,
    settings.ec2,
  );
  const boxId = randomUUID();
  const providerId = await provider.launch({
    boxId,
    clientToken: boxId,
    profile,
    image: settings.config.profiles[profile]!.image,
    environment: file.environment,
    bootstrap: {
      origin: env.CODING_PUBLIC_ORIGIN ?? "",
      boxId,
      secret: randomBytes(32).toString("hex"),
    },
  });
  const launchedAt = new Date().toISOString();
  const until = async (state: string) => {
    for (let i = 0; i < 60; i++) {
      const now = await provider.describe(providerId);
      if (now === state) return;
      if (now === "terminated" || now === "missing")
        throw new Error(`Orphan ${providerId} is ${now} before ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`Orphan ${providerId} did not reach ${state}`);
  };
  await until("running");
  await provider.stop(providerId);
  await until("stopped");
  return {
    boxId,
    providerId,
    launchedAt,
    stoppedAt: new Date().toISOString(),
  };
}

try {
  let result: unknown;
  switch (command) {
    case "spawn":
      result = await boxes.spawn(owner, {
        profile: args[0]!,
        requestKey: args[1]!,
        subject: `probe:${args[1]}`,
      });
      break;
    case "delegate": {
      const a = delegateArgs(args);
      result = await boxes.delegate(owner, a.boxId, {
        requestKey: a.requestKey,
        kind: "echo",
        payload: a.payload,
      });
      break;
    }
    case "steer": {
      const a = steerArgs(args);
      result = await boxes.send(owner, "probe", a.boxId, {
        requestKey: a.requestKey,
        taskId: a.taskId,
        text: a.text,
        ownerInputId: `probe:${a.requestKey}`,
      });
      break;
    }
    case "status":
      result = await boxes.status(owner, args[0]!);
      break;
    case "timings":
      result = await timings(args[0]!);
      break;
    case "close":
      result = await boxes.close(owner, args[0]!);
      break;
    case "orphan":
      result = await orphan(args[0]!);
      break;
    default:
      throw new Error(
        "Commands: spawn, delegate, steer, status, timings, close, orphan",
      );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await db.end();
}
