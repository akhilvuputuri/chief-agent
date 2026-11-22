import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright-core";
import { SerialQueue } from "../security.js";
import {
  commandArgs,
  TEXT_ARGS,
  URL_ARGS,
  type DocumentCommand,
  type PublicBrowserCommand,
} from "./commands.js";

/** Every command the engine runs; `merge` needs no session and is the service's. */
export type EngineCommand =
  PublicBrowserCommand | Exclude<DocumentCommand, { kind: "merge" }>;
const FILE_BYTES = 20 * 1024 * 1024;
const LOAD_MS = 30_000;
const IMAGES_MS = 10_000;

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
  /** Documents opened so far, each written to its own file. */
  documents: number;
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
  call(user: string, id: string, command: EngineCommand, signal?: AbortSignal) {
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
    command: EngineCommand,
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
    switch (command.kind) {
      case "document":
        return this.document(session, command);
      case "text":
        return (await this.send(session, TEXT_ARGS, signal)).result;
      case "print":
        return this.print(session, command);
      case "screenshot":
        return this.withPage(session, async (page) => ({
          data: (
            await page.screenshot({
              fullPage: command.fullPage,
              type: "png",
              timeout: LOAD_MS,
            })
          ).toString("base64"),
          title: await page.title(),
        }));
      case "download":
        return this.download(session, command, signal);
    }
    return this.send(session, commandArgs(command), signal);
  }
  /**
   * The page agent-browser drives, through Playwright on the same debug port. The connection
   * lasts one command; closing it disconnects and leaves the browser and its pages running.
   */
  private async withPage<T>(session: Session, use: (page: Page) => Promise<T>) {
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${session.port}`,
      { timeout: 10_000 },
    );
    try {
      const pages = browser.contexts().flatMap((c) => c.pages());
      let page = pages.length === 1 ? pages[0] : undefined;
      if (!page) {
        const { url } = await this.send(session, URL_ARGS);
        page = pages.find((p) => p.url() === url) ?? pages.at(-1);
      }
      if (!page) throw new Error("No page is open");
      return await use(page);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  /**
   * A document the gateway supplies, opened from the session's own folder. HTML gets a
   * Content-Security-Policy that turns scripts off and, unless remote images are on, keeps
   * every load inside the document.
   */
  private async document(
    session: Session,
    command: Extract<DocumentCommand, { kind: "document" }>,
  ) {
    const file = join(
      session.home,
      `document-${++session.documents}.${command.type}`,
    );
    await writeFile(
      file,
      command.type === "html"
        ? withPolicy(command.data, command.remoteImages)
        : Buffer.from(command.data, "base64"),
    );
    return this.withPage(session, async (page) => {
      try {
        await page.goto(pathToFileURL(file).href, {
          waitUntil: "domcontentloaded",
          timeout: LOAD_MS,
        });
      } catch {
        throw new Error(
          command.type === "pdf"
            ? "Chromium did not show this PDF"
            : "The document did not open",
        );
      }
      // The content is there; one slow image host must not fail the open.
      const loaded = await page
        .waitForLoadState("load", { timeout: IMAGES_MS })
        .then(
          () => true,
          () => false,
        );
      return {
        opened: true,
        title: await page.title(),
        ...(loaded
          ? {}
          : {
              note: "Some images or other resources were still loading after 10 seconds; they may be missing from the page and from a print made now.",
            }),
      };
    });
  }
  private async print(
    session: Session,
    c: Extract<DocumentCommand, { kind: "print" }>,
  ) {
    const path = join(session.home, "print.pdf");
    const margin = `${c.marginMm}mm`;
    const small = `font-size:8px;width:100%;margin:0 ${margin};display:flex;justify-content:space-between`;
    try {
      const title = await this.withPage(session, async (page) => {
        const url = page.url().startsWith("https://")
          ? '<span class="url"></span>'
          : "<span></span>";
        await page.pdf({
          path,
          format: c.paper,
          landscape: c.landscape,
          printBackground: c.background,
          scale: c.scale,
          pageRanges: c.pageRanges ?? "",
          margin: { top: margin, right: margin, bottom: margin, left: margin },
          displayHeaderFooter: c.headerFooter,
          headerTemplate: `<div style="${small}"><span class="date"></span><span class="title"></span></div>`,
          footerTemplate: `<div style="${small}">${url}<span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
        });
        return page.title();
      });
      const data = await readFile(path);
      if (data.length > FILE_BYTES)
        throw new Error("The PDF is larger than 20 MiB");
      return {
        data: data.toString("base64"),
        pages: await pageCount(path),
        title,
      };
    } finally {
      await rm(path, { force: true });
    }
  }
  /** A file the page offers: by clicking a ref, or by opening its public address. */
  private async download(
    session: Session,
    c: Extract<DocumentCommand, { kind: "download" }>,
    signal?: AbortSignal,
  ) {
    if (!c.ref === !c.url) throw new Error("Pass ref or url");
    return this.withPage(session, async (page) => {
      const started = page.waitForEvent("download", { timeout: LOAD_MS });
      if (c.ref)
        await this.send(
          session,
          ["click", c.ref.startsWith("@") ? c.ref : `@${c.ref}`],
          signal,
        );
      else await page.goto(c.url!, { timeout: LOAD_MS }).catch(() => {});
      const download = await started.catch(() => {
        throw new Error("No download started");
      });
      try {
        const data = await readFile(await download.path());
        if (data.length > FILE_BYTES)
          throw new Error("The download is larger than 20 MiB");
        return {
          data: data.toString("base64"),
          name: download.suggestedFilename(),
        };
      } finally {
        await download.delete().catch(() => {});
      }
    });
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
        documents: 0,
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

/**
 * The document's policy, first in its head: no scripts, frames or form posts, and with
 * remoteImages off nothing loaded from outside the document. Policies only add up, so one in
 * the document itself can tighten this and never loosen it.
 */
export function withPolicy(html: string, remoteImages: boolean) {
  const remote = remoteImages ? " https:" : "";
  const policy = `default-src 'none'; style-src 'unsafe-inline' data:${remote}; img-src data:${remote}; font-src data:${remote}; media-src data:${remote}; form-action 'none'`;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  return doctype + meta + html.slice(doctype.length);
}
const execFileAsync = promisify(execFile);
const QPDF = { env: { PATH: "/usr/bin:/bin" }, timeout: COMMAND_MS };
/** qpdf exits 3 when it succeeded with warnings, which ordinary PDFs often give. */
async function qpdf(args: string[]) {
  try {
    return (await execFileAsync("qpdf", args, QPDF)).stdout;
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string };
    if (failed.code === 3) return failed.stdout ?? "";
    throw new Error("qpdf could not read these PDFs");
  }
}
export async function pageCount(path: string) {
  return Number((await qpdf(["--show-npages", path])).trim());
}
/** PDFs joined in order into one, with its page count. */
export async function mergePdfs(files: string[], root = "/tmp") {
  const dir = await mkdtemp(join(root, "pdf-merge-"));
  try {
    const inputs = files.map((_, i) => join(dir, `${i}.pdf`));
    await Promise.all(
      files.map((data, i) =>
        writeFile(inputs[i]!, Buffer.from(data, "base64")),
      ),
    );
    const out = join(dir, "merged.pdf");
    await qpdf(["--empty", "--pages", ...inputs, "--", out]);
    const data = await readFile(out);
    if (data.length > FILE_BYTES)
      throw new Error("The joined PDF would be larger than 20 MiB");
    return { data: data.toString("base64"), pages: await pageCount(out) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
