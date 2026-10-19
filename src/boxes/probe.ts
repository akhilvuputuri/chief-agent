/**
 * Operator probe for boxed sub-agents (docs/boxes.md, phase 3). Runs inside the gateway
 * container against the production database, as the configured owner. It only writes box
 * requests; the running gateway's reconciler launches, serves and ends the boxes.
 *
 *   node dist/boxes/probe.js spawn <profile> <request-key>
 *   node dist/boxes/probe.js delegate <box-id> <request-key> <text>
 *   node dist/boxes/probe.js status <box-id>
 *   node dist/boxes/probe.js timings <box-id>
 *   node dist/boxes/probe.js close <box-id>
 */
import { connect } from "../db.js";
import { BoxController } from "./controller.js";
import { boxSettings, loadBoxesFile } from "./config.js";
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
    case "delegate":
      result = await boxes.delegate(owner, args[0]!, {
        requestKey: args[1]!,
        kind: "echo",
        payload: { text: args.slice(2).join(" ") },
      });
      break;
    case "status":
      result = await boxes.status(owner, args[0]!);
      break;
    case "timings":
      result = await timings(args[0]!);
      break;
    case "close":
      result = await boxes.close(owner, args[0]!);
      break;
    default:
      throw new Error("Commands: spawn, delegate, status, timings, close");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await db.end();
}
