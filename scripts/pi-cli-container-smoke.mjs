// Exercise the actual standalone guarded CLI entry, with synthetic Anthropic Messages traffic.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskStore, planHash } from "../coding_runtime_pi/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "pi-cli-container-"));
const work = join(root, "work");
await mkdir(work);
const git = (...args) =>
  execFileSync("git", ["-C", work, ...args], { stdio: "pipe" });
git("init", "-q");
git("config", "user.name", "Synthetic");
git("config", "user.email", "synthetic@example.invalid");
await writeFile(join(work, "README.md"), "Synthetic isolation fixture.\n");
git("add", ".");
git("commit", "-qm", "Fixture");
const key = "synthetic-private-state-key-32-characters";
const command =
  'node -e \'const {spawn}=require("node:child_process");const fs=require("node:fs");const p=spawn("node",["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});fs.writeFileSync("daemon.pid",String(p.pid));p.unref();\'';
const check =
  'node -e \'const fs=require("node:fs");const pid=Number(fs.readFileSync("daemon.pid","utf8"));try{process.kill(pid,0);process.exit(1);}catch(e){if(e.code!=="ESRCH")process.exit(2);}\'';
const task = {
  version: 1,
  id: randomUUID(),
  revision: 1,
  intent: "build",
  status: "ready",
  workspace: "/fixture/work",
  base: git("rev-parse", "HEAD").toString().trim(),
  objective: "Verify guarded standalone execution",
  instructions: "Synthetic fixture only.",
  ownerInstructions: "Synthetic fixture only.",
  limits: { ms: 30000, models: 10, tools: 10 },
  used: { models: 0, tools: 0, ms: 0 },
  checkCommands: [check],
  summary: "Ready",
  checks: [],
  events: [],
};
task.plan = {
  revision: 1,
  text: "Start a synthetic detached process; verify it is reaped before checks.",
  hash: planHash(
    task,
    "Start a synthetic detached process; verify it is reaped before checks.",
  ),
};
task.approved = { revision: 1, hash: task.plan.hash };
await new TaskStore(join(root, "tasks"), key).save(task);
/** Server-sent events as the Anthropic Messages API streams one response. */
const event = (type, data) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function messagesStream(tool) {
  let out = event("message_start", {
    message: {
      id: `msg_synthetic_${calls}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  });
  if (tool) {
    out += event("content_block_start", {
      index: 0,
      content_block: {
        type: "tool_use",
        id: `toolu_synthetic_${calls}`,
        name: tool.name,
        input: {},
      },
    });
    out += event("content_block_delta", {
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(tool.arguments),
      },
    });
  } else {
    out += event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    });
    out += event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "Done." },
    });
  }
  out += event("content_block_stop", { index: 0 });
  out += event("message_delta", {
    delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 50 },
  });
  return out + event("message_stop", {});
}
let calls = 0;
const server = createServer(async (req, res) => {
  // Pi's own Anthropic client: the Messages route, with the configured key as its API key.
  assert.equal(req.url, "/v1/messages?beta=true");
  assert.equal(req.headers["x-api-key"], "synthetic-api-key");
  let body = "";
  for await (const chunk of req) body += chunk;
  assert.equal(JSON.parse(body).model, "claude-opus-5-5");
  const current = calls++;
  const tool =
    current === 0
      ? { name: "bash", arguments: { command } }
      : current === 1
        ? {
            name: "report",
            arguments: {
              kind: "done",
              summary: "Synthetic command complete",
              detail: "The configured actual check verifies daemon cleanup.",
            },
          }
        : undefined;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(messagesStream(tool));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const port = server.address().port;
  const args = [
    "run",
    "--rm",
    "--network=host",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--mount",
    `type=bind,source=${root},target=/fixture`,
    "--env",
    "PI_RUNTIME_API_KEY=synthetic-api-key",
    "--env",
    `PI_RUNTIME_STATE_KEY=${key}`,
    "pi-runtime-standalone:test",
    "run",
    task.id,
    "--state",
    "/fixture",
    "--local-execution",
    // A model from Pi's catalogue; the fake above speaks Anthropic's protocol.
    "--model",
    "claude-opus-5-5",
    "--base-url",
    `http://127.0.0.1:${port}`,
  ];
  const result = await promisify(execFile)("docker", args, {
    timeout: 60000,
    maxBuffer: 1_000_000,
  });
  const completed = JSON.parse(result.stdout);
  assert.equal(completed.status, "completed", completed.summary);
  assert.equal(completed.checks[0].exitCode, 0);
  assert.equal(completed.report.kind, "done");
  assert.equal(completed.report.version, 1);
  // A settled valid report completes without an extra model continuation.
  assert.equal(calls, 2);
  console.log(
    "Actual standalone guarded CLI: detached process reaped before real check; zero external model calls.",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
