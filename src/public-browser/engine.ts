import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SerialQueue } from "../security.js";
import {
  commandArgs,
  URL_ARGS,
  type PublicBrowserCommand,
} from "./commands.js";

export const SESSION_IDLE_MS = 3 * 60 * 1000;
export const SESSION_MAX_MS = 10 * 60 * 1000;
const COMMAND_MS = 40_000;
const OUTPUT_BYTES = 2_000_000;

export class PublicBrowserBusy extends Error {
  constructor() {
    super("The public browser is in use by another task; try again shortly");
  }
}
/** Thrown when a session cannot be proven gone: the service exits and restarts clean. */
export class PublicBrowserCleanupFailure extends Error {}

export type Runner = (
  args: string[],
  options: { env: Record<string, string>; cwd: string; signal?: AbortSignal },
) => Promise<string>;
export type Launcher = (
  args: string[],
  env: Record<string, string>,
) => Pick<ChildProcess, "pid" | "exitCode">;

/**
 * agent-browser adds --no-sandbox whenever it launches Chromium in a container, so this service
 * launches Chromium itself and agent-browser only attaches. The sandbox stays on, and every page
 * request, loopback included, goes through the egress proxy; proved by
 * scripts/public-browser-probe.mjs.
 */
export function chromiumArgs(proxy: string, profile: string) {
  return [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--proxy-server=${proxy}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disk-cache-size=33554432",
    "--no-first-run",
    "about:blank",
  ];
}
/** Never the service environment: the control key must not reach a browser process. */
export function sessionEnvironment(home: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    // A daemon whose close failed must not outlive the session by its default hour.
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(SESSION_MAX_MS + 60_000),
  };
}

type Session = {
  id: string;
  user: string;
  home: string;
  port: string;
  pid: number;
  startedAt: number;
  lastActive: number;
  /** A script ran here, so page text no longer shows what the site served. */
  scripted: boolean;
};

const runAgentBrowser: Runner = (args, { env, cwd, signal }) =>
  new Promise((resolve, reject) => {
    execFile(
      "agent-browser",
      args,
      {
        env,
        cwd,
        signal,
        timeout: COMMAND_MS,
        killSignal: "SIGKILL",
        maxBuffer: OUTPUT_BYTES,
      },
      // agent-browser reports its own failures as JSON on stdout with a non-zero exit.
      (error, stdout) =>
        stdout || !error
          ? resolve(stdout)
          : reject(new Error("Browser command failed")),
    );
  });
const launchChromium: Launcher = (args, env) => {
  const child = spawn("/usr/bin/chromium", args, {
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  child.on("error", () => {});
  return child;
};

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class PublicBrowserEngine {
  private session?: Session;
  private queue = new SerialQueue();
  constructor(
    private proxy: string,
    private run: Runner = runAgentBrowser,
    private launch: Launcher = launchChromium,
    private kill: (pid: number) => void = (pid) =>
      process.kill(-pid, "SIGKILL"),
    private now: () => number = Date.now,
    private root = "/tmp",
    private alive: (pid: number) => boolean = groupAlive,
  ) {}
  call(
    user: string,
    id: string,
    command: PublicBrowserCommand,
    signal?: AbortSignal,
  ) {
    return this.queue.run("browser", () =>
      this.dispatch(user, id, command, signal),
    );
  }
  /** Closes sessions past their idle or age limit. */
  sweep() {
    return this.queue.run("browser", async () => {
      if (this.session && this.expired(this.session))
        await this.close(this.session);
    });
  }
  private expired(s: Session) {
    const now = this.now();
    return (
      now - s.lastActive > SESSION_IDLE_MS || now - s.startedAt > SESSION_MAX_MS
    );
  }
  private async dispatch(
    user: string,
    id: string,
    command: PublicBrowserCommand,
    signal?: AbortSignal,
  ) {
    const current = this.session;
    if (current && this.expired(current)) await this.close(current);
    // A call that waited in the queue behind its own cancellation must not start a browser.
    if (command.kind !== "close") signal?.throwIfAborted();
    if (command.kind === "close") {
      if (this.session?.id === id && this.session.user === user)
        await this.close(this.session);
      return { closed: true };
    }
    if (this.session && (this.session.id !== id || this.session.user !== user))
      throw new PublicBrowserBusy();
    const session = this.session ?? (await this.open(user, id));
    session.lastActive = this.now();
    if (command.kind === "read") return this.read(session, command, signal);
    if (command.kind === "eval") session.scripted = true;
    return this.send(session, commandArgs(command), signal);
  }
  private async send(session: Session, args: string[], signal?: AbortSignal) {
    const raw = await this.run(
      ["--session", session.id, "--cdp", session.port, "--json", ...args],
      { env: sessionEnvironment(session.home), cwd: session.home, signal },
    );
    return parseResult(raw);
  }
  /**
   * Page text with the address it came from. agent-browser reads location.href, which a page
   * cannot redefine, on both sides of the text, so a page cannot have its text filed under
   * another site's URL by navigating part way through.
   */
  private async read(
    session: Session,
    command: PublicBrowserCommand,
    signal?: AbortSignal,
  ) {
    const before = await this.send(session, URL_ARGS, signal);
    const page = await this.send(session, commandArgs(command), signal);
    const after = await this.send(session, URL_ARGS, signal);
    if (before.url !== after.url)
      throw new Error(
        "The page changed while it was being read; read it again",
      );
    if (typeof after.url !== "string" || !after.url.startsWith("https://"))
      throw new Error("This page has no public address to read from");
    return { result: page.result, url: after.url, scripted: session.scripted };
  }
  private async open(user: string, id: string) {
    const home = await mkdtemp(join(this.root, "public-browser-"));
    let pid: number | undefined;
    try {
      const profile = join(home, "profile");
      const child = this.launch(
        chromiumArgs(this.proxy, profile),
        sessionEnvironment(home),
      );
      pid = child.pid;
      if (!pid) throw new Error("Browser did not start");
      const port = await this.debugPort(profile, child);
      const now = this.now();
      return (this.session = {
        id,
        user,
        home,
        port,
        pid,
        startedAt: now,
        lastActive: now,
        scripted: false,
      });
    } catch (error) {
      await this.destroy(home, pid);
      throw error;
    }
  }
  private async debugPort(
    profile: string,
    child: Pick<ChildProcess, "exitCode">,
  ) {
    for (let i = 0; i < 60; i++) {
      const first = await readFile(join(profile, "DevToolsActivePort"), "utf8")
        .then((text) => text.split("\n")[0]!)
        .catch(() => "");
      if (/^\d{2,5}$/.test(first)) return first;
      if (child.exitCode !== null && child.exitCode !== undefined) break;
      await delay(250);
    }
    throw new Error("Browser did not start");
  }
  private async close(s: Session) {
    this.session = undefined;
    // The daemon exits on close; a failure here is settled by destroying the process group.
    await this.run(["--session", s.id, "--cdp", s.port, "--json", "close"], {
      env: sessionEnvironment(s.home),
      cwd: s.home,
    }).catch(() => "");
    await this.destroy(s.home, s.pid, s.id);
  }
  private async destroy(home: string, pid?: number, session?: string) {
    try {
      // agent-browser runs its daemon in its own session, out of Chromium's process group.
      const daemon = session
        ? await readFile(join(home, ".agent-browser", `${session}.pid`), "utf8")
            .then((text) => Number(text.trim()))
            .catch(() => 0)
        : 0;
      const groups = [pid, daemon].filter((p): p is number => !!p && p > 1);
      for (const group of groups)
        try {
          this.kill(group);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      for (let i = 0; groups.some((g) => this.alive(g)); i++) {
        if (i >= 30) throw new Error("Browser process survived");
        await delay(100);
      }
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      throw new PublicBrowserCleanupFailure("Public browser cleanup failed");
    }
  }
}

/** agent-browser's JSON, without its launch bookkeeping. Page-controlled, so bounded by the caller. */
export function parseResult(raw: string): Record<string, unknown> {
  let parsed: { success?: boolean; data?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Browser returned an unreadable result");
  }
  if (!parsed.success)
    throw new Error(
      typeof parsed.error === "string"
        ? parsed.error.slice(0, 500)
        : "Browser command failed",
    );
  const { lifecycle: _lifecycle, ...data } = (parsed.data ?? {}) as Record<
    string,
    unknown
  >;
  return data;
}
