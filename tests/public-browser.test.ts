import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, event } from "../src/db.js";
import {
  BROWSER_AGENT,
  commandArgs,
  publicBrowserCommand,
} from "../src/public-browser/commands.js";
import {
  chromiumArgs,
  parseResult,
  PublicBrowserBusy,
  PublicBrowserCleanupFailure,
  PublicBrowserEngine,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  sessionEnvironment,
} from "../src/public-browser/engine.js";
import { PublicBrowser } from "../src/public-browser/client.js";
import { contentHash, PluginRegistry, readBundle } from "../src/plugins.js";
import { plugins } from "../src/plugin-registry.js";
import { runtimeContext } from "../src/runtime.js";
import { readOperations } from "../src/execution.js";
import { projectObservation } from "../src/observations.js";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import type { ModelAdapter } from "../src/model.js";

const a = randomUUID(),
  b = randomUUID();
const parse = (c: unknown) => publicBrowserCommand.parse(c);

function engine(
  overrides: {
    kill?: (pid: number) => void;
    alive?: (pid: number) => boolean;
    urls?: unknown[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pb-test-"));
  const calls: string[][] = [],
    launches: { args: string[]; env: Record<string, string> }[] = [],
    killed: number[] = [];
  let clock = 1000;
  const instance = new PublicBrowserEngine(
    "http://proxy:3002",
    async (args) => {
      calls.push(args);
      if (args.includes("get") && args.includes("url"))
        return JSON.stringify({
          success: true,
          data: { url: overrides.urls?.shift() ?? "https://example.com/" },
        });
      return JSON.stringify({
        success: true,
        data: { lifecycle: { launched: true }, ok: 1, result: "page text" },
      });
    },
    (args, env) => {
      launches.push({ args, env });
      const profile = args
        .find((x) => x.startsWith("--user-data-dir="))!
        .split("=")[1]!;
      mkdirSync(profile, { recursive: true });
      writeFileSync(
        join(profile, "DevToolsActivePort"),
        "45555\n/devtools/x\n",
      );
      return { pid: 4242, exitCode: null };
    },
    overrides.kill ?? ((pid) => void killed.push(pid)),
    () => clock,
    root,
    overrides.alive ?? (() => false),
  );
  return {
    instance,
    root,
    calls,
    launches,
    killed,
    advance: (ms: number) => void (clock += ms),
  };
}

test("only public HTTPS URLs can be opened", () => {
  assert.ok(parse({ kind: "open", url: "https://example.com/a" }));
  for (const url of [
    "http://example.com",
    "https://127.0.0.1/",
    "https://localhost/",
    "https://gateway.internal/",
    "file:///etc/passwd",
    "https://user:pw@example.com/",
    "https://example.com:8443/",
  ])
    assert.throws(() => parse({ kind: "open", url }), undefined, url);
});

test("no command reaches cookies, state, downloads, files or the proxy-bypassing read", () => {
  for (const kind of [
    "cookies",
    "state",
    "auth",
    "upload",
    "download",
    "screenshot",
    "connect",
  ])
    assert.throws(() => parse({ kind }), undefined, kind);
  assert.throws(() => parse({ kind: "click", ref: "--proxy" }));
  assert.throws(() => parse({ kind: "press", key: "--args" }));
  assert.deepEqual(commandArgs(parse({ kind: "read" })).slice(0, 2), [
    "eval",
    "-b",
  ]);
  assert.ok(!commandArgs(parse({ kind: "read" })).includes("read"));
});

test("model text can never be read as a command-line flag", () => {
  for (const text of ["--session", "--args=x", "-b", "--"])
    assert.throws(
      () => parse({ kind: "fill", ref: "e1", text }),
      undefined,
      text,
    );
  assert.deepEqual(
    commandArgs(parse({ kind: "fill", ref: "e1", text: "a -b" })),
    ["fill", "@e1", "a -b"],
  );
  assert.ok(parse({ kind: "fill", ref: "e1", text: "" }));
  const evaluate = commandArgs(parse({ kind: "eval", js: "--cdp 1" }));
  assert.equal(evaluate[1], "-b");
  assert.equal(Buffer.from(evaluate[2]!, "base64").toString(), "--cdp 1");
});

test("Chromium keeps its sandbox and sends loopback through the proxy too", () => {
  const args = chromiumArgs("http://proxy:3002", "/tmp/p");
  assert.ok(!args.includes("--no-sandbox"));
  assert.ok(args.includes("--proxy-server=http://proxy:3002"));
  assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
  assert.ok(args.includes("--disable-quic"));
  assert.ok(
    args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
  );
});

test("browser processes get a fixed environment without the control key", () => {
  process.env.BROWSER_CONTROL_KEY = "secret";
  try {
    const env = sessionEnvironment("/tmp/h");
    assert.deepEqual(Object.keys(env).sort(), [
      "AGENT_BROWSER_IDLE_TIMEOUT_MS",
      "HOME",
      "LANG",
      "PATH",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
    ]);
    assert.ok(!Object.values(env).includes("secret"));
  } finally {
    delete process.env.BROWSER_CONTROL_KEY;
  }
});

test("agent-browser only attaches: every command names the session and our debug port", async () => {
  const e = engine();
  await e.instance.call("u", a, parse({ kind: "snapshot" }));
  assert.equal(e.launches.length, 1);
  assert.deepEqual(e.calls[0]!.slice(0, 5), [
    "--session",
    a,
    "--cdp",
    "45555",
    "--json",
  ]);
  await e.instance.call("u", a, parse({ kind: "back" }));
  assert.equal(e.launches.length, 1, "the session is reused");
});

test("one session at a time, and another run's call never reuses it", async () => {
  const e = engine();
  await e.instance.call("u", a, parse({ kind: "back" }));
  await assert.rejects(
    e.instance.call("u", b, parse({ kind: "back" })),
    PublicBrowserBusy,
  );
  await assert.rejects(
    e.instance.call("other", a, parse({ kind: "back" })),
    PublicBrowserBusy,
  );
  // Another run's close does nothing to it.
  await e.instance.call("u", b, parse({ kind: "close" }));
  assert.deepEqual(e.killed, []);
});

test("closing kills the process group and deletes everything the session wrote", async () => {
  const e = engine();
  await e.instance.call("u", a, parse({ kind: "back" }));
  assert.equal(readdirSync(e.root).length, 1);
  await e.instance.call("u", a, parse({ kind: "close" }));
  assert.deepEqual(e.killed, [4242]);
  assert.equal(readdirSync(e.root).length, 0);
  await e.instance.call("u", b, parse({ kind: "back" }));
  assert.equal(e.launches.length, 2, "the next run starts from a new browser");
});

test("idle and over-age sessions are closed, freeing the slot", async () => {
  const idle = engine();
  await idle.instance.call("u", a, parse({ kind: "back" }));
  idle.advance(SESSION_IDLE_MS + 1);
  await idle.instance.sweep();
  assert.deepEqual(idle.killed, [4242]);

  const old = engine();
  await old.instance.call("u", a, parse({ kind: "back" }));
  for (let t = 0; t <= SESSION_MAX_MS; t += SESSION_IDLE_MS / 2) {
    old.advance(SESSION_IDLE_MS / 2);
    await old.instance.call("u", a, parse({ kind: "wait", ms: 1 }));
  }
  assert.ok(
    old.killed.length >= 1,
    "an active session still ends at its age limit",
  );
});

test("a session that cannot be proven gone fails closed", async () => {
  const e = engine({
    kill: () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    },
  });
  await e.instance.call("u", a, parse({ kind: "back" }));
  await assert.rejects(
    e.instance.call("u", a, parse({ kind: "close" })),
    PublicBrowserCleanupFailure,
  );
  const gone = engine({
    kill: () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
  });
  await gone.instance.call("u", a, parse({ kind: "back" }));
  await gone.instance.call("u", a, parse({ kind: "close" }));
});

test("results drop launch bookkeeping and page errors are bounded", () => {
  assert.deepEqual(
    parseResult('{"success":true,"data":{"lifecycle":{"x":1},"url":"u"}}'),
    { url: "u" },
  );
  assert.throws(
    () =>
      parseResult(JSON.stringify({ success: false, error: "x".repeat(900) })),
    (e: Error) => e.message.length === 500,
  );
  assert.throws(() => parseResult("not json"));
});

async function database() {
  const db = await migratedPGlite();
  const user = "owner";
  await ensureUser(db as any, user);
  return { db: db as any, user };
}
async function childRun(db: any, user: string, agentId: string) {
  const run = randomUUID();
  await db.query(
    "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,$2,'running')",
    [run, user],
  );
  await event(db, user, run, "agent.child_started", { agentId });
  return run;
}

test("the host refuses the browser on any run that is not the browser agent", async () => {
  const { db, user } = await database();
  const sent: unknown[] = [];
  const browser = new PublicBrowser(db, {
    call: async (_u, _s, command) => {
      sent.push(command);
      return { ok: true, result: {} };
    },
  });
  await assert.rejects(
    browser.act(user, randomUUID(), parse({ kind: "snapshot" })),
    /only inside the browser agent/,
  );
  const email = await childRun(db, user, "core/email");
  await assert.rejects(
    browser.act(user, email, parse({ kind: "snapshot" })),
    /only inside the browser agent/,
  );
  assert.equal(sent.length, 0);
  const allowed = await childRun(db, user, BROWSER_AGENT);
  await browser.act(user, allowed, parse({ kind: "snapshot" }));
  assert.equal(sent.length, 1);
  await assert.rejects(
    browser.act("someone-else", allowed, parse({ kind: "snapshot" })),
    /only inside the browser agent/,
  );
});

test("read takes its address on both sides of the text and refuses a page that moved", async () => {
  const steady = engine();
  const page: any = await steady.instance.call("u", a, parse({ kind: "read" }));
  assert.deepEqual(page, {
    result: "page text",
    url: "https://example.com/",
    scripted: false,
  });
  const moved = engine({ urls: ["https://evil.example/", "https://gov.sg/"] });
  await assert.rejects(
    moved.instance.call("u", a, parse({ kind: "read" })),
    /changed while it was being read/,
  );
  const blank = engine({ urls: ["about:blank", "about:blank"] });
  await assert.rejects(
    blank.instance.call("u", a, parse({ kind: "read" })),
    /no public address/,
  );
});

test("after a script, the rest of the session's reads are marked scripted", async () => {
  const e = engine();
  await e.instance.call("u", a, parse({ kind: "eval", js: "1" }));
  const page: any = await e.instance.call("u", a, parse({ kind: "read" }));
  assert.equal(page.scripted, true);
  await e.instance.call(
    "u",
    a,
    parse({ kind: "open", url: "https://a.example/" }),
  );
  const later: any = await e.instance.call("u", a, parse({ kind: "read" }));
  assert.equal(later.scripted, true);
});

test("a cancelled call waiting in the queue starts no browser", async () => {
  const e = engine();
  await assert.rejects(
    e.instance.call("u", a, parse({ kind: "back" }), AbortSignal.abort()),
  );
  assert.equal(e.launches.length, 0);
});

test("a browser process that will not die fails closed", async () => {
  const e = engine({ alive: () => true });
  await e.instance.call("u", a, parse({ kind: "back" }));
  await assert.rejects(
    e.instance.call("u", a, parse({ kind: "close" })),
    PublicBrowserCleanupFailure,
  );
});

test("agent-browser's daemon is killed too, from its pid file", async () => {
  const e = engine();
  await e.instance.call("u", a, parse({ kind: "back" }));
  const home = join(e.root, readdirSync(e.root)[0]!);
  mkdirSync(join(home, ".agent-browser"));
  writeFileSync(join(home, ".agent-browser", `${a}.pid`), "777\n");
  await e.instance.call("u", a, parse({ kind: "close" }));
  assert.deepEqual(e.killed, [4242, 777]);
});

test("read stores the whole page as an owner source and pages through it", async () => {
  const { db, user } = await database();
  const page = "x".repeat(10_000) + "END";
  const browser = new PublicBrowser(db, {
    call: async () => ({
      ok: true,
      result: { result: page, url: "https://example.com/p", scripted: false },
    }),
  });
  const run = await childRun(db, user, BROWSER_AGENT);
  const first: any = await browser.act(user, run, parse({ kind: "read" }));
  assert.equal(first.content.length, 8000);
  assert.equal(first.nextOffset, 8000);
  assert.equal(first.totalChars, page.length);
  assert.equal(first.sourceUrl, "https://example.com/p");
  // The projection the model gets leaves it whole, so paging skips nothing.
  const seen = projectObservation("public_browser", { result: first });
  assert.equal(seen.result.content.length, 8000);
  assert.equal(seen.result.truncated, undefined);
  const rest: any = await browser.act(
    user,
    run,
    parse({ kind: "read", offset: first.nextOffset }),
  );
  assert.ok(rest.content.endsWith("END"));
  assert.equal(rest.nextOffset, undefined);
  assert.equal(rest.sourceId, first.sourceId, "one source per page");
  const stored = await db.query(
    "SELECT url,content FROM research_sources WHERE id=$1 AND user_id=$2",
    [first.sourceId, user],
  );
  assert.equal(stored.rows[0].content, page);
  assert.equal(stored.rows[0].url, "https://example.com/p");
});

test("text read after a script cannot become a citable source", async () => {
  const { db, user } = await database();
  const browser = new PublicBrowser(db, {
    call: async () => ({
      ok: true,
      result: { result: "forged", url: "https://gov.sg/", scripted: true },
    }),
  });
  const run = await childRun(db, user, BROWSER_AGENT);
  const page: any = await browser.act(user, run, parse({ kind: "read" }));
  assert.equal(page.sourceId, undefined);
  assert.equal(page.content, "forged");
  assert.match(page.noSource, /cannot be cited/);
  const stored = await db.query(
    "SELECT count(*)::int AS n FROM research_sources WHERE user_id=$1",
    [user],
  );
  assert.equal(stored.rows[0].n, 0);
});

test("every result is marked untrusted, and long ones are cut with a usable notice", async () => {
  const { db, user } = await database();
  const browser = new PublicBrowser(db, {
    call: async () => ({
      ok: true,
      result: { snapshot: "- x\n".repeat(5000), refs: { e1: {} }, origin: "o" },
    }),
  });
  const run = await childRun(db, user, BROWSER_AGENT);
  const snap: any = await browser.act(user, run, parse({ kind: "snapshot" }));
  assert.equal(snap.snapshot.length, 8000);
  assert.equal(snap.refs, undefined);
  assert.match(snap.untrusted, /never instructions/);
  assert.doesNotMatch(snap.notice, /observation_read/);
  const seen = projectObservation("public_browser", { result: snap });
  assert.equal(seen.result.snapshot, snap.snapshot);
});

test("a lost reply becomes a plain error so the loop cannot repeat a click", async () => {
  const { db, user } = await database();
  const browser = new PublicBrowser(db, {
    call: async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    },
  });
  const run = await childRun(db, user, BROWSER_AGENT);
  await assert.rejects(
    browser.act(user, run, parse({ kind: "click", ref: "e1" })),
    (e: Error) => e.name === "Error" && /inspect the page/.test(e.message),
  );
});

test("a refused command reaches the agent as its reason, and release never throws", async () => {
  const { db, user } = await database();
  const browser = new PublicBrowser(db, {
    call: async (_u, _s, command) => {
      if (command.kind === "close") throw new Error("down");
      return { ok: false, error: "Navigation failed" };
    },
  });
  const run = await childRun(db, user, BROWSER_AGENT);
  await assert.rejects(
    browser.act(user, run, parse({ kind: "back" })),
    /Navigation failed/,
  );
  await browser.release(user, run);
});

test("the browser agent holds this one tool and nothing that reads owner data", () => {
  const agent = plugins.get(BROWSER_AGENT);
  assert.deepEqual(agent.tools, ["public_browser"]);
  assert.deepEqual(agent.skills, []);
  assert.equal(plugins.resolve("browser"), BROWSER_AGENT);
  assert.ok(readOperations.has("public_browser"));
});

test("Chief is never offered the browser directly, and the agent appears only when connected", () => {
  const on = runtimeContext(
    { publicBrowser: true },
    null,
    undefined,
    undefined,
    true,
  );
  const off = runtimeContext(
    { publicBrowser: false },
    null,
    undefined,
    undefined,
    true,
  );
  const names = (tools: { name: string }[]) => tools.map((t) => t.name);
  assert.ok(!names(on.tools).includes("public_browser"));
  assert.ok(names(on.allTools).includes("public_browser"));
  assert.ok(!names(off.allTools).includes("public_browser"));
  const types = (ctx: { context: string }) =>
    (JSON.parse(ctx.context).agentCatalogue ?? []).map(
      (a: { type: string }) => a.type,
    );
  assert.ok(types(on).includes("browser"));
  assert.ok(!types(off).includes("browser"));
});

test("the registry cannot combine the browser with anything else", () => {
  const root = new URL("../plugins/", import.meta.url).pathname;
  const registry = JSON.parse(readFileSync(`${root}registry.json`, "utf8"));
  const holders = registry.enabled.filter((p: any) =>
    p.allowTools.includes("public_browser"),
  );
  assert.deepEqual(
    holders.map((p: any) => p.path),
    ["core"],
  );
  assert.ok(registry.delegated.includes("public_browser"));

  // A copy of the core package whose browser agent also holds a tool that reads owner data.
  const copy = mkdtempSync(join(tmpdir(), "pb-plugins-"));
  cpSync(`${root}core`, join(copy, "core"), { recursive: true });
  const manifest = JSON.parse(
    readFileSync(join(copy, "core/plugin.json"), "utf8"),
  );
  manifest.agents.find((x: any) => x.id === "browser").tools.push("web_read");
  writeFileSync(join(copy, "core/plugin.json"), JSON.stringify(manifest));
  const core = registry.enabled.find((p: any) => p.path === "core");
  writeFileSync(
    join(copy, "registry.json"),
    JSON.stringify({
      ...registry,
      researchAgent: "core/web",
      aliases: {},
      delegated: [],
      enabled: [
        { ...core, sha256: contentHash(readBundle(join(copy, "core"))) },
      ],
    }),
  );
  assert.throws(() => new PluginRegistry(copy), /cannot hold public_browser/);
});

const toolCall = (name: string, args: unknown) => ({
  message: {
    role: "assistant" as const,
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});

async function runAgentTurn(
  type: string,
  agentMarker: string,
  steps: unknown[],
  rpc: (command: { kind: string }) => Record<string, unknown>,
  seed?: (db: any) => Promise<void>,
) {
  const pg = await migratedPGlite();
  const db = pg as any;
  await ensureUser(db, "owner");
  await seed?.(db);
  const sent: string[] = [];
  const tools = new JobTools(db, { call: async () => ({}) });
  (tools as any).publicBrowser = new PublicBrowser(db, {
    call: async (_user, _session, command) => {
      sent.push(command.kind);
      return rpc(command);
    },
  });
  let agentCalls = 0,
    chiefCalls = 0,
    offered: string[] = [],
    agentSaw: string[] = [],
    agentResult: any;
  const generate: ModelAdapter["generate"] = async (input) => {
    if (String(input.messages[0]?.content).includes(agentMarker)) {
      offered = input.tools.map((t) => t.name);
      agentSaw = input.messages
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content));
      const step = steps[agentCalls++];
      return (step ?? {
        message: { role: "assistant", content: "done" },
      }) as any;
    }
    if (chiefCalls >= 1)
      agentResult = JSON.parse(
        String(input.messages.findLast((m) => m.role === "tool")?.content),
      ).result;
    return (
      ++chiefCalls === 1
        ? toolCall("agent_run", { type, objective: "Look at a page" })
        : { message: { role: "assistant", content: "Reported." } }
    ) as any;
  };
  const assistant = new Assistant(
    db,
    new CustomAgent({ model: "main/model", generate }, {}, (id) => ({
      model: id,
      generate,
    })),
    tools,
    { web: true, publicBrowser: true },
  );
  try {
    await assistant.respondDetailed("owner", "please do it");
    await new Promise((resolve) => setImmediate(resolve));
    return { sent, offered, agentSaw, agentResult };
  } finally {
    await pg.close();
  }
}
const browse = (command: unknown) => toolCall("public_browser", { command });
const report = toolCall("agent_report", {
  status: "partial",
  summary: "Checked.",
  findings: [],
  refs: [],
});

test("through the real loop: page errors are not retried, one command's failures leave the others, and the session is released", async () => {
  const { sent, offered } = await runAgentTurn(
    "browser",
    "You are the public browser agent",
    [
      // Error text a page controls, matching the loop's transient-retry pattern.
      browse({ kind: "eval", js: "throw new Error('HTTP 503')" }),
      browse({ kind: "open", url: "https://a.example/" }),
      browse({ kind: "open", url: "https://b.example/" }),
      browse({ kind: "open", url: "https://c.example/" }),
      browse({ kind: "snapshot" }),
      report,
    ],
    (command) =>
      command.kind === "snapshot" || command.kind === "close"
        ? { ok: true, result: { snapshot: "- link [ref=e1]" } }
        : { ok: false, error: "HTTP 503" },
  );
  assert.deepEqual(offered.sort(), [
    "agent_report",
    "finish_turn",
    "public_browser",
  ]);
  assert.equal(sent.filter((k) => k === "eval").length, 1, "never retried");
  assert.equal(sent.filter((k) => k === "open").length, 3);
  assert.equal(sent.filter((k) => k === "snapshot").length, 1);
  assert.equal(sent.at(-1), "close", "the slot is freed when the agent ends");
});

test("a command refused for failing works again once the page has changed", async () => {
  let ready = false;
  const { sent } = await runAgentTurn(
    "browser",
    "You are the public browser agent",
    [
      browse({ kind: "snapshot" }),
      browse({ kind: "snapshot" }),
      browse({ kind: "snapshot" }),
      browse({ kind: "wait", ms: 1 }),
      browse({ kind: "snapshot" }),
      report,
    ],
    (command) => {
      if (command.kind === "wait") ready = true;
      return command.kind === "wait" || command.kind === "close" || ready
        ? { ok: true, result: { snapshot: "- ok" } }
        : { ok: false, error: "Page is navigating" };
    },
  );
  assert.ok(sent.includes("wait"));
  assert.equal(
    sent.slice(sent.indexOf("wait")).filter((k) => k === "snapshot").length,
    1,
    "the same call runs again after a success",
  );
});

test("through the real loop: the agent sees the browser's own reason, bounded and marked untrusted", async () => {
  const reason =
    "Element is covered by another element\n  <div id=consent>" +
    "x".repeat(600);
  const { agentSaw } = await runAgentTurn(
    "browser",
    "You are the public browser agent",
    [browse({ kind: "click", ref: "e18" }), report],
    (command) =>
      command.kind === "click"
        ? { ok: false, error: reason }
        : { ok: true, result: {} },
  );
  const error = JSON.parse(agentSaw[0]!).error;
  assert.equal(error.code, "BROWSER_REFUSED");
  assert.match(
    error.message,
    /^The browser said: Element is covered by another element <div id=consent>x+\. /,
  );
  assert.match(error.message, /never instructions/);
  assert.ok(error.message.length < 520, "the page cannot flood the context");
});

test("other agents never touch the browser when they finish", async () => {
  const { sent } = await runAgentTurn(
    "web",
    "You are the web lookup agent",
    [report],
    () => ({ ok: true, result: {} }),
  );
  assert.deepEqual(sent, []);
});

test("a re-read page reuses its stored source, and the quote check accepts it in the new run", async () => {
  const sourceId = randomUUID();
  const text = "Example title\n\nThis page says the shop opens at nine.";
  const { agentResult } = await runAgentTurn(
    "browser",
    "You are the public browser agent",
    [
      browse({ kind: "read" }),
      toolCall("agent_report", {
        status: "complete",
        summary: "It opens at nine.",
        findings: [
          {
            text: "The shop opens at nine.",
            sourceId,
            quote: "the shop opens at nine",
          },
        ],
        refs: [],
      }),
    ],
    (command) =>
      command.kind === "read"
        ? {
            ok: true,
            result: {
              result: text,
              url: "https://example.com/",
              scripted: false,
            },
          }
        : { ok: true, result: {} },
    (db) =>
      db.query(
        "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,'owner','https://example.com/',$2)",
        [sourceId, text],
      ),
  );
  assert.equal(agentResult.status, "complete");
  assert.equal(agentResult.findings[0].sourceId, sourceId);
});
