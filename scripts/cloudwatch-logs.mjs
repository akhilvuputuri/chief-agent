#!/usr/bin/env node
// Bounded, read-only CloudWatch Logs Insights reader for Chief's sanitized
// operational logs. Usable from a local checkout or a cloud coding task that has
// the log-reader identity in its private secret store (AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY, or AWS_PROFILE). It never reads the server, database
// or SSH. The window and row limits are cost/convenience controls; IAM is the
// access boundary. Do not run it in GitHub Actions: this repository is public.
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { pathToFileURL } from "node:url";

export const REGION = "ap-southeast-1";
export const GROUPS = {
  runtime: "/chief/prod/runtime",
  host: "/chief/prod/host",
};
const HOUR = 3600;
export const MAX_WINDOW_S = 24 * HOUR;
export const MAX_ROWS = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const EVENT = /^[a-z][a-z0-9_.]{0,79}$/;

const common =
  "fields @timestamp, ts, level, event, runId, parentRunId, childRunId, taskId, callId, operation, state, stopReason, errorCode, errorCategory, httpStatus, latencyMs, model, release";

export const QUERIES = {
  errors: {
    group: "runtime",
    help: "warn/error lines, newest first",
    query: () =>
      `${common} | filter level = "error" or level = "warn" | sort @timestamp desc`,
  },
  run: {
    group: "runtime",
    help: "timeline for --run ID (also matches parent/child runs, input and task IDs)",
    needsRun: true,
    query: (id) =>
      `${common}, inputId, ref | filter runId = "${id}" or parentRunId = "${id}" or childRunId = "${id}" or inputId = "${id}" or taskId = "${id}" | sort @timestamp asc`,
  },
  event: {
    group: "runtime",
    help: "lines for one --event NAME, newest first",
    needsEvent: true,
    query: (_id, event) =>
      `${common} | filter event = "${event}" | sort @timestamp desc`,
  },
  tools: {
    group: "runtime",
    help: "tool outcomes by operation/state with latency",
    query: () =>
      `filter event = "tool.finished" | stats count(*) as calls, avg(latencyMs) as avgMs, max(latencyMs) as maxMs by operation, state, errorCode | sort calls desc`,
  },
  models: {
    group: "runtime",
    help: "model calls, latency, tokens and reported cost",
    query: () =>
      `filter event in ["model.completed", "model.failed"] | stats count(*) as calls, avg(latencyMs) as avgMs, sum(inputTokens) as inputTokens, sum(cachedTokens) as cachedTokens, sum(outputTokens) as outputTokens, sum(costUsd) as reportedUsd by event, model, provider`,
  },
  schedules: {
    group: "runtime",
    help: "routine, reminder/briefing and background work passes",
    query: () =>
      `${common}, ref | filter event like /^(routine|daily|work)\\./ or event like /tick_failed$/ | sort @timestamp desc`,
  },
  releases: {
    group: "runtime",
    help: "which release SHAs logged, first and last seen",
    query: () =>
      `stats count(*) as lines, min(@timestamp) as first, max(@timestamp) as last by release | sort last desc`,
  },
  heartbeat: {
    group: "runtime",
    help: "gateway start/stop/heartbeat lines",
    query: () =>
      `fields @timestamp, ts, event, release, uptimeS, rssMb | filter event like /^gateway\\./ | sort @timestamp desc`,
  },
  host: {
    group: "host",
    help: "host health records (disk, memory, services, backup, exporter)",
    query: () =>
      `fields @timestamp, ts, release, diskUsedPct, memAvailableMb, swapUsedMb, load1, services.gateway.state, services.gateway.health, services.postgres.health, backupResult, exporter, caddy | sort @timestamp desc`,
  },
};

/** Parses 30m, 2h, 1d, an ISO timestamp or "now" into epoch seconds. */
export function parseTime(value, now) {
  if (value === "now") return now;
  const relative = /^(\d{1,4})([mhd])$/.exec(value);
  if (relative)
    return (
      now -
      Number(relative[1]) *
        { m: 60, h: HOUR, d: 24 * HOUR }[
          /** @type {"m"|"h"|"d"} */ (relative[2])
        ]
    );
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value))
    throw new Error(`Unrecognized time ${value}; use 30m, 2h, 1d, now or ISO`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid time ${value}`);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error("ISO times need an explicit zone, e.g. Z or +08:00");
  return Math.floor(ms / 1000);
}

export function parseArgs(argv, now = Math.floor(Date.now() / 1000)) {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "help") return { help: true };
  const spec = QUERIES[name];
  if (!spec) throw new Error(`Unknown query ${name}`);
  const options = { since: "1h", until: "now", limit: "100" };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!["--since", "--until", "--limit", "--run", "--event"].includes(key))
      throw new Error(`Unknown option ${key}`);
    if (value === undefined) throw new Error(`${key} needs a value`);
    options[key.slice(2)] = value;
  }
  const start = parseTime(options.since, now);
  const end = parseTime(options.until, now);
  if (end <= start) throw new Error("--until must be after --since");
  if (end - start > MAX_WINDOW_S)
    throw new Error("Window exceeds 24 hours; query daily windows instead");
  const limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS)
    throw new Error(`--limit must be 1..${MAX_ROWS}`);
  if (spec.needsRun && !(options.run && ID.test(options.run)))
    throw new Error("--run needs an ID (letters, digits, _ . : -)");
  if (spec.needsEvent && !(options.event && EVENT.test(options.event)))
    throw new Error("--event needs an event name such as tool.finished");
  return {
    name,
    group: GROUPS[spec.group],
    start,
    end,
    limit,
    query: spec.query(options.run, options.event),
  };
}

/** Removes ARNs and account IDs from an AWS error message and bounds it. */
export const redact = (message) =>
  String(message ?? "")
    .replace(/arn:aws[a-z-]*:[^\s"',]+/g, "<arn>")
    .replace(/\b\d{12}\b/g, "<account>")
    .slice(0, 300);

const format = (epoch, offset) =>
  new Date((epoch + offset) * 1000).toISOString().replace(".000Z", "");

async function main() {
  let request;
  try {
    request = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (request.help) {
    console.log(
      "Usage: npm run logs:cloudwatch -- <query> [--since 1h] [--until now] [--limit 100] [--run ID] [--event NAME]\n",
    );
    for (const [name, spec] of Object.entries(QUERIES))
      console.log(`  ${name.padEnd(10)} ${spec.help}`);
    console.log(
      "\nTimes: 30m, 2h, 1d, now, or ISO with zone. Max window 24h, max 500 rows. Missing lines are not proof of success.",
    );
    return;
  }
  // Finite end to end: per-request timeouts plus a hard process deadline.
  setTimeout(() => {
    console.error("CloudWatch query did not finish in 75s");
    process.exit(1);
  }, 75_000).unref();
  const client = new CloudWatchLogsClient({
    region: REGION,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 15_000,
      throwOnRequestTimeout: true,
    },
  });
  console.error(
    `${request.name} on ${request.group}: ${format(request.start, 0)}Z → ${format(request.end, 0)}Z (SGT ${format(request.start, 8 * HOUR)} → ${format(request.end, 8 * HOUR)}), limit ${request.limit}`,
  );
  const deadline = Date.now() + 60_000;
  try {
    const { queryId } = await client.send(
      new StartQueryCommand({
        logGroupName: request.group,
        startTime: request.start,
        endTime: request.end,
        queryString: request.query,
        limit: request.limit,
      }),
    );
    for (;;) {
      const result = await client.send(new GetQueryResultsCommand({ queryId }));
      if (result.status === "Complete") {
        for (const row of result.results ?? [])
          console.log(
            JSON.stringify(
              Object.fromEntries(
                row
                  .filter((f) => f.field !== "@ptr")
                  .map((f) => [f.field, f.value]),
              ),
            ),
          );
        const stats = result.statistics ?? {};
        console.error(
          `${(result.results ?? []).length} rows; scanned ${Math.round((stats.bytesScanned ?? 0) / 1024)} KiB, matched ${stats.recordsMatched ?? 0}`,
        );
        return;
      }
      if (["Failed", "Cancelled", "Timeout", "Unknown"].includes(result.status))
        throw new Error(`Query ${result.status}`);
      if (Date.now() > deadline) throw new Error("Query did not finish in 60s");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    // AWS error names/codes only; no credential material is printed.
    // AWS error name/status and a message with ARNs and account IDs removed;
    // output may be pasted into a public PR.
    const message = redact(error.message);
    console.error(
      `CloudWatch query failed: ${error.name ?? "Error"}${error.$metadata?.httpStatusCode ? ` (HTTP ${error.$metadata.httpStatusCode})` : ""}: ${message}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
