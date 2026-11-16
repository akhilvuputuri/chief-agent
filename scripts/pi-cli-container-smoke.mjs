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
import { TaskStore } from "../coding_runtime_pi/dist/index.js";
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
/** Starts a detached daemon in its own session and records its pid in `file`. */
const daemon = (file) =>
  `node -e 'const {spawn}=require("node:child_process");const fs=require("node:fs");const p=spawn("node",["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});fs.writeFileSync("${file}",String(p.pid));p.unref();'`;
/** Exits 0 only when the daemon recorded in `file` no longer exists. */
const check = (file) =>
  `node -e 'const fs=require("node:fs");const pid=Number(fs.readFileSync("${file}","utf8"));try{process.kill(pid,0);process.exit(1);}catch(e){if(e.code!=="ESRCH")process.exit(2);}'`;
const task = {
  version: 1,
  id: randomUUID(),
  role: "coder",
  status: "ready",
  workspace: "/fixture/work",
  base: git("rev-parse", "HEAD").toString().trim(),
  summary: "Ready",
  events: [],
};
await new TaskStore(join(root, "tasks"), key).save(task);
/** Server-sent events as the Anthropic Messages API streams one response. */
const event = (type, data) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function messagesStream(tools) {
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
  // Every tool call of one assistant message, as one response: Pi runs them at once.
  tools.forEach((tool, index) => {
    out += event("content_block_start", {
      index,
      content_block: {
        type: "tool_use",
        id: tool.id,
        name: tool.name,
        input: {},
      },
    });
    out += event("content_block_delta", {
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(tool.arguments),
      },
    });
    out += event("content_block_stop", { index });
  });
  if (!tools.length) {
    out += event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    });
    out += event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "Done." },
    });
    out += event("content_block_stop", { index: 0 });
  }
  out += event("message_delta", {
    delta: {
      stop_reason: tools.length ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 50 },
  });
  return out + event("message_stop", {});
}
let calls = 0;
/** The tool result Pi sent back for one call, from the next request's messages. */
const resultFor = (messages, id) =>
  messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === "tool_result" && b.tool_use_id === id);
const server = createServer(async (req, res) => {
  // Pi's own Anthropic client: the Messages route, with the configured key as its API key.
  assert.equal(req.url, "/v1/messages?beta=true");
  assert.equal(req.headers["x-api-key"], "synthetic-api-key");
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  assert.equal(request.model, "claude-opus-5-5");
  const current = calls++;
  /** The text of the result Pi sent back for a call of the previous turn. */
  const result = (index) => {
    const found = resultFor(
      request.messages,
      `toolu_synthetic_${current - 1}_${index}`,
    );
    assert(
      found,
      `The result of call ${index} of turn ${current - 1} is missing`,
    );
    return {
      error: found.is_error === true,
      text: JSON.stringify(found.content),
    };
  };
  const bash = (command) => ({ name: "bash", arguments: { command } });
  // The check runs as the session's own command after the daemon's command returned: the
  // guard must already have reaped the daemon, so the check exits 0 (no error result).
  if (current === 2) {
    const checked = result(0);
    assert.equal(checked.error, false, checked.text);
  }
  // Two commands in one message (journal 197): each returns its own output and exit code.
  if (current === 3) {
    const [first, second] = [result(0), result(1)];
    assert.equal(first.error, true, first.text);
    assert.match(first.text, /first/);
    assert.match(first.text, /Command exited with code 3/);
    assert.equal(second.error, false, second.text);
    assert.match(second.text, /second/);
    assert.doesNotMatch(second.text, /first/);
  }
  // Three at once, a slow one among them, one of them leaving a daemon.
  if (current === 4) {
    const [slow, left, third] = [result(0), result(1), result(2)];
    assert.equal(slow.error, false, slow.text);
    assert.match(slow.text, /slow/);
    assert.equal(left.error, false, left.text);
    assert.equal(third.error, false, third.text);
    assert.match(third.text, /third/);
  }
  // The daemon left while the slow command ran is gone now that no command runs.
  if (current === 5) {
    const checked = result(0);
    assert.equal(checked.error, false, checked.text);
  }
  const turns = [
    [bash(daemon("daemon.pid"))],
    [bash(check("daemon.pid"))],
    [bash("sleep 1; echo first; exit 3"), bash("echo second")],
    [bash("sleep 2; echo slow"), bash(daemon("left.pid")), bash("echo third")],
    [bash(check("left.pid"))],
    [
      {
        name: "report",
        arguments: {
          kind: "done",
          summary: "Synthetic command complete",
          detail: "The session's own checks verified daemon cleanup.",
        },
      },
    ],
  ];
  const tools = (turns[current] ?? []).map((tool, index) => ({
    ...tool,
    id: `toolu_synthetic_${current}_${index}`,
  }));
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(messagesStream(tools));
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
    "Verify guarded standalone execution",
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
  assert.equal(completed.report.kind, "done");
  assert.equal(completed.report.version, 1);
  // A valid report ends the run through Pi's early termination: no extra model call.
  assert.equal(calls, 6);
  console.log(
    "Actual standalone guarded CLI: detached processes reaped once no command runs; commands at once each returned their own result; zero external model calls.",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
