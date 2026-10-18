import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The in-box supervisor (docs/boxes.md). It holds the box credential, dials out to the
 * host, runs one task at a time through a runner, reports ordered events and ends the box
 * when its lifetime is spent, the host stays unreachable, its credential is refused or a
 * task's reset fails. It never accepts connections.
 */

/** Durable state on the box disk. Files are written so a crash or power loss cannot
 * leave a half-written or unrecorded credential. */
export class StateStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  read(name: string): string | undefined {
    try {
      return readFileSync(join(this.dir, name), "utf8");
    } catch {
      return undefined;
    }
  }
  json<T>(name: string, fallback: T): T {
    const raw = this.read(name);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  /** Temporary file, fsync, rename, then fsync of the directory. */
  write(name: string, value: string) {
    const target = join(this.dir, name);
    const temp = `${target}.tmp`;
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, value);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    let dir: number | undefined;
    try {
      dir = openSync(this.dir, "r");
      fsyncSync(dir);
    } catch (error) {
      // Some platforms cannot fsync a directory; Linux, where boxes run, can.
      if (!["EISDIR", "EINVAL", "EPERM"].includes((error as any)?.code))
        throw error;
    } finally {
      if (dir !== undefined) closeSync(dir);
    }
  }
}

export type TaskOutput =
  | { type: "progress"; payload?: Record<string, unknown> }
  | { type: "question"; payload?: Record<string, unknown> }
  | { type: "result"; payload: Record<string, unknown> }
  | { type: "failed"; payload: Record<string, unknown> };

export type TaskOutcome = {
  type: "result" | "failed";
  payload: Record<string, unknown>;
};

export interface RunningTask {
  /** Delivers an owner's answer or clarification to the task. */
  send(text: string): void;
  cancel(): void;
  /** Resolves with the task's final output. */
  done: Promise<TaskOutcome>;
}

export interface TaskRunner {
  start(
    task: { id: string; kind: string; payload: Record<string, unknown> },
    onOutput: (output: TaskOutput) => void,
  ): RunningTask;
  /** Removes everything a finished task left behind and checks that nothing remains. */
  reset(taskId: string): Promise<void>;
}

/** Bounds on what a task program may send back; matching the host's event limits. */
export const MAX_LINE = 256 * 1024;
export const MAX_PAYLOAD = 60_000;
/** Questions a task may have waiting for the one-per-second drainer before it is stopped. */
export const MAX_PENDING_QUESTIONS = 20;

/** A payload the host will accept: a plain object of bounded JSON size. */
export function boundedPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  try {
    return JSON.stringify(value).length <= MAX_PAYLOAD
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface TaskLimits {
  /** Longest a task may run before it is killed and failed. */
  deadlineMs: number;
  /** How long a task may keep running after its final line before it is killed. */
  graceMs: number;
}

const defaultLimits: TaskLimits = {
  deadlineMs: 2 * 3_600_000,
  graceMs: 10_000,
};

/**
 * Drives a task program over JSON lines: stdin receives the task and later messages,
 * stdout yields progress, questions and one final result. Output is bounded, the task is
 * killed a grace period after its final line or at its deadline, and writes after the
 * input has closed are dropped rather than crashing the agent.
 */
export function lineProtocol(
  child: ChildProcess,
  task: { id: string; kind: string; payload: Record<string, unknown> },
  onOutput: (output: TaskOutput) => void,
  kill: () => void,
  limits: TaskLimits,
): RunningTask {
  let final: TaskOutcome | undefined;
  const timers: NodeJS.Timeout[] = [];
  const settle = (outcome: TaskOutcome) => {
    if (final) return;
    final = outcome;
    child.stdin?.end();
    timers.push(setTimeout(kill, limits.graceMs));
  };
  child.stdin?.on("error", () => {});
  const done = new Promise<TaskOutcome>((resolve) => {
    let buffer = "";
    const line = (text: string) => {
      let output: TaskOutput;
      try {
        output = JSON.parse(text) as TaskOutput;
      } catch {
        return;
      }
      if (output.type === "result" || output.type === "failed") {
        const payload = boundedPayload(output.payload);
        settle(
          payload
            ? { type: output.type, payload }
            : {
                type: "failed",
                payload: {
                  error: "The task's result was not a bounded JSON object",
                },
              },
        );
      } else if (
        !final &&
        (output.type === "progress" || output.type === "question")
      )
        onOutput({
          type: output.type,
          payload: boundedPayload(output.payload) ?? {},
        });
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (text.length <= MAX_LINE) line(text);
      }
      if (buffer.length > MAX_LINE) {
        buffer = "";
        settle({
          type: "failed",
          payload: { error: "The task wrote an unbounded output line" },
        });
        kill();
      }
    });
    // A last line without a trailing newline still counts.
    child.stdout?.on("end", () => {
      if (buffer && buffer.length <= MAX_LINE) line(buffer);
      buffer = "";
    });
    timers.push(
      setTimeout(() => {
        settle({
          type: "failed",
          payload: { error: "The task passed its deadline" },
        });
        kill();
      }, limits.deadlineMs),
    );
    child.on("close", (code) => {
      for (const timer of timers) clearTimeout(timer);
      resolve(
        final ?? {
          type: "failed",
          payload: { error: `Task exited without a result (code ${code})` },
        },
      );
    });
    child.on("error", () => {
      for (const timer of timers) clearTimeout(timer);
      resolve({ type: "failed", payload: { error: "Task could not start" } });
    });
  });
  const write = (value: object) => {
    const stdin = child.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded)
      stdin.write(`${JSON.stringify(value)}\n`);
  };
  write({ type: "task", id: task.id, kind: task.kind, payload: task.payload });
  return {
    send: (text) => write({ type: "message", text }),
    cancel: kill,
    done,
  };
}

/** Runs a command to completion; a missing binary is a failure, never a hang. */
function exec(command: string, args: string[]) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    let out = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve({ code: -1, out }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

/**
 * Development and test runner: a task program as a child process with a fresh home and
 * workspace. Not a security boundary; production boxes use the container runner.
 */
export class ProcessRunner implements TaskRunner {
  constructor(
    private command: string[],
    private root: string,
    private limits: TaskLimits = defaultLimits,
  ) {}
  private dirs(taskId: string) {
    const base = join(this.root, taskId);
    return { base, home: join(base, "home"), work: join(base, "workspace") };
  }
  start(
    task: { id: string; kind: string; payload: Record<string, unknown> },
    onOutput: (output: TaskOutput) => void,
  ) {
    const { home, work } = this.dirs(task.id);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const [command, ...args] = this.command;
    const child = spawn(command!, args, {
      cwd: work,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
      stdio: [
        "pipe",
        "pipe",
        process.env.CHIEF_BOX_DEBUG ? "inherit" : "ignore",
      ],
      detached: true,
    });
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The process group has already exited.
      }
    };
    const running = lineProtocol(child, task, onOutput, kill, this.limits);
    return { ...running, done: running.done.finally(kill) };
  }
  async reset(taskId: string) {
    rmSync(this.dirs(taskId).base, { recursive: true, force: true });
  }
}

export interface DockerOptions {
  docker?: string;
  /** Extra `docker run` arguments, such as mounts in tests. */
  extra?: string[];
  /** Overrides the image's command; by default the image's own task program runs. */
  command?: string[];
  /** Per-task resource limits, e.g. "6g" and "3". */
  memory?: string;
  /** Labels this box's task containers, so a reset only ever inspects its own. */
  scope?: string;
  cpus?: string;
  limits?: TaskLimits;
}

/**
 * Production runner: a fresh container per task from the digest-pinned image, as an
 * unprivileged user with a fresh workspace, removed with everything it wrote afterwards.
 */
export class DockerRunner implements TaskRunner {
  private docker: string;
  private scope: string;
  constructor(
    private image: string,
    private root: string,
    private options: DockerOptions = {},
  ) {
    this.docker = options.docker ?? "docker";
    this.scope = (options.scope ?? "local").replace(/[^a-zA-Z0-9-]/g, "");
  }
  private name = (taskId: string) => `chief-task-${taskId}`;
  private work = (taskId: string) => join(this.root, taskId);
  start(
    task: { id: string; kind: string; payload: Record<string, unknown> },
    onOutput: (output: TaskOutput) => void,
  ) {
    const work = this.work(task.id);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    // The task user owns its workspace; the agent runs as root on a box.
    try {
      chownSync(work, 1000, 1000);
    } catch {
      chmodSync(work, 0o777);
    }
    const memory = this.options.memory
      ? ["--memory", this.options.memory, "--memory-swap", this.options.memory]
      : [];
    const cpus = this.options.cpus ? ["--cpus", this.options.cpus] : [];
    const child = spawn(
      this.docker,
      [
        "run",
        "--rm",
        "-i",
        "--name",
        this.name(task.id),
        "--label",
        `chief.box.task=${this.scope}`,
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=512m,mode=1777",
        "--tmpfs",
        "/home/worker:rw,size=1g,uid=1000,gid=1000,mode=0700",
        "--env",
        "HOME=/home/worker",
        "--pids-limit",
        "1024",
        ...memory,
        ...cpus,
        "--mount",
        `type=bind,source=${work},target=/workspace`,
        "--workdir",
        "/workspace",
        ...(this.options.extra ?? []),
        this.image,
        ...(this.options.command ?? []),
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const kill = () => {
      child.kill("SIGKILL");
      this.removing.set(
        task.id,
        exec(this.docker, ["rm", "-f", this.name(task.id)]),
      );
    };
    return lineProtocol(
      child,
      task,
      onOutput,
      kill,
      this.options.limits ?? defaultLimits,
    );
  }
  private removing = new Map<string, Promise<unknown>>();
  async reset(taskId: string) {
    // A kill may already be removing the container; wait for it before checking.
    await this.removing.get(taskId);
    this.removing.delete(taskId);
    // `rm -f` of a container that is already gone is fine; the listing below is the check.
    await exec(this.docker, ["rm", "-f", this.name(taskId)]);
    rmSync(this.work(taskId), { recursive: true, force: true });
    for (let attempt = 0; ; attempt++) {
      const left = await exec(this.docker, [
        "ps",
        "-aq",
        "--filter",
        `label=chief.box.task=${this.scope}`,
      ]);
      if (left.code !== 0)
        throw new Error("Could not confirm that no task container remains");
      if (!left.out.trim()) return;
      // Removal can lag briefly behind `rm -f`; persisting leftovers end the box.
      if (attempt >= 5) throw new Error("A task container survived its reset");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export interface AgentOptions {
  origin: string;
  boxId: string;
  /** Present only until the first successful hello stores a session credential. */
  bootstrap?: string;
  store: StateStore;
  runner: TaskRunner;
  /** Ends the box: OS shutdown on EC2 (which terminates it), process exit locally. */
  shutdown: (reason: string) => Promise<void> | void;
  /** Provider identity proof, such as the EC2 instance identity document. */
  identity?: () => Promise<unknown>;
  fetch?: typeof fetch;
  /** Back-off between failed requests. */
  retryMs?: number;
  /** A box that cannot reach the host for this long ends itself. */
  maxSilentMs?: number;
  /** How often the agent checks its own lifetime and host contact. */
  watchMs?: number;
  clock?: () => number;
}

type Message = { seq: number; kind: string; payload: any };
/**
 * Task journal: queued → running → finished (outcome stored) → reported → done. Each step
 * is durable, so a restart can finish exactly what was interrupted.
 */
type Journal = Record<
  string,
  {
    state: string;
    kind?: string;
    payload?: Record<string, unknown>;
    outcome?: TaskOutcome;
  }
>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BoxAgent {
  private credential = "";
  private epoch = 0;
  private stopped = false;
  private queue: {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    /** Set when the task is refused before it can run, e.g. oversized instructions. */
    refused?: TaskOutcome;
  }[] = [];
  /** The task being started or run; questions for any other task are discarded. */
  private active?: string;
  private questions = new Map<string, Record<string, unknown>[]>();
  private current?: { id: string; running: RunningTask };
  private pendingMessages = new Map<string, string[]>();
  private events: Promise<void> = Promise.resolve();
  private progressAt = new Map<string, number>();
  private readonly http: typeof fetch;
  private readonly clock: () => number;
  /** Local copy of the lifetime, enforced even when the host cannot be reached. */
  private deadline = Infinity;
  private lastContact: number;
  private watch?: NodeJS.Timeout;
  constructor(private o: AgentOptions) {
    this.http = o.fetch ?? fetch;
    this.clock = o.clock ?? (() => performance.now());
    this.lastContact = this.clock();
  }

  private url(path: string) {
    return `${this.o.origin}/boxes/${this.o.boxId}/${path}`;
  }

  /** Records host contact and the lifetime it reported. */
  private contact(remainingMs?: number) {
    this.lastContact = this.clock();
    if (remainingMs !== undefined) this.deadline = this.clock() + remainingMs;
  }

  private async end(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watch) clearInterval(this.watch);
    this.current?.running.cancel();
    await this.o.shutdown(reason);
  }

  /** Cancels the running task; used when the host stops the box. */
  cancelCurrent() {
    this.current?.running.cancel();
  }

  private async wait() {
    await new Promise((r) => setTimeout(r, this.o.retryMs ?? 2000));
  }

  private checkLimits() {
    if (this.clock() >= this.deadline) void this.end("Box lifetime reached");
    else if (
      this.clock() - this.lastContact >
      (this.o.maxSilentMs ?? 30 * 60_000)
    )
      void this.end("The host has been unreachable for too long");
  }

  /**
   * Exchanges the stored credential (or, on first boot only, the bootstrap secret) for the
   * next epoch's credential. Never runs concurrently with itself, and the replacement is
   * stored durably before any call uses it. Only a 401 is final; a box whose launch the
   * host has not recorded yet is answered 503 and keeps trying.
   */
  async connect() {
    const presented = this.o.store.read("credential") ?? this.o.bootstrap;
    if (!presented) return this.end("No box credential is available");
    while (!this.stopped) {
      let response: Response;
      try {
        response = await this.http(this.url("hello"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol: 1,
            credential: presented,
            ...(this.o.identity ? { identity: await this.o.identity() } : {}),
          }),
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        this.checkLimits();
        await this.wait();
        continue;
      }
      if (response.status === 401)
        // A real agent never presents a retired credential; this box cannot continue.
        return this.end("The host refused this box's credential");
      if (!response.ok) {
        this.checkLimits();
        await this.wait();
        continue;
      }
      const body = (await response.json()) as {
        credential: string;
        epoch: number;
        remainingMs: number;
      };
      this.o.store.write("credential", body.credential);
      this.credential = body.credential;
      this.epoch = body.epoch;
      this.contact(body.remainingMs);
      return;
    }
  }

  private nextSeq() {
    const key = `seq-${this.epoch}`;
    const seq = Number(this.o.store.read(key) ?? "0") + 1;
    this.o.store.write(key, String(seq));
    return seq;
  }

  /**
   * Reports one event in order; retried with the same sequence until the host has it.
   * A terminal task event the host rejects is replaced by a bounded failure, so the host's
   * task never stays open.
   */
  private report(event: Record<string, unknown>) {
    const epoch = this.epoch;
    let seq = this.nextSeq();
    let body = event;
    let replaced = false;
    this.events = this.events.then(async () => {
      while (!this.stopped) {
        try {
          const response = await this.http(this.url("events"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.credential}`,
            },
            body: JSON.stringify({ epoch, events: [{ seq, ...body }] }),
            signal: AbortSignal.timeout(30000),
          });
          if (response.status === 401)
            return this.end("The host refused this box's credential");
          if (response.ok) {
            this.contact();
            return;
          }
          if (response.status === 400) {
            const terminal =
              body.kind === "task.result" || body.kind === "task.failed";
            if (!terminal || replaced) return;
            replaced = true;
            seq = this.nextSeq();
            body = {
              kind: "task.failed",
              taskId: body.taskId,
              payload: { error: "The host rejected the task's result" },
            };
            continue;
          }
        } catch {
          // Network failure: retry the same event.
        }
        this.checkLimits();
        await this.wait();
      }
    });
    return this.events;
  }

  private journal() {
    return this.o.store.json<Journal>("tasks", {});
  }

  private mark(
    id: string,
    state: string,
    fields: Omit<Journal[string], "state"> = {},
  ) {
    const journal = this.journal();
    // Done tasks keep only their state: enough to refuse a redelivered assignment.
    journal[id] =
      state === "done" ? { state } : { ...journal[id], ...fields, state };
    this.o.store.write("tasks", JSON.stringify(journal));
  }

  /**
   * Reports a task's outcome and cleans up after it. The outcome is journalled before it
   * is sent, so an interrupted report or reset is completed after a restart.
   */
  private async finish(id: string, outcome: TaskOutcome) {
    this.mark(id, "finished", { outcome });
    await this.report({
      kind: outcome.type === "result" ? "task.result" : "task.failed",
      taskId: id,
      payload: outcome.payload,
    });
    this.mark(id, "reported");
    return this.cleanup(id);
  }

  private async cleanup(id: string) {
    try {
      await this.o.runner.reset(id);
    } catch {
      // A task that cannot be cleaned up must not be followed by another in this box.
      await this.end("A task left state behind that could not be removed");
      return false;
    }
    this.mark(id, "done");
    return true;
  }

  private handle(message: Message) {
    const p = message.payload ?? {};
    // Task messages must name a well-formed task; anything else is for a later protocol version.
    if (!message.kind.startsWith("task.")) return;
    if (typeof p.taskId !== "string" || !uuid.test(p.taskId)) return;
    if (message.kind === "task.assign") {
      // At-least-once delivery: a task already known is never started twice.
      if (this.journal()[p.taskId]) return;
      const payload = boundedPayload(p.payload ?? {});
      if (!payload) {
        // Instructions that do not fit are refused, never run as an empty task.
        const refused: TaskOutcome = {
          type: "failed",
          payload: {
            error: "The task's instructions exceed the box payload limit",
          },
        };
        // Journalled as finished, so a restart reports the refusal rather than running it.
        this.mark(p.taskId, "finished", { outcome: refused });
        this.queue.push({
          id: p.taskId,
          kind: String(p.kind),
          payload: {},
          refused,
        });
        return;
      }
      this.mark(p.taskId, "queued", { kind: String(p.kind), payload });
      this.queue.push({ id: p.taskId, kind: String(p.kind), payload });
    } else if (message.kind === "task.message") {
      const current = this.current;
      if (current && current.id === p.taskId)
        current.running.send(String(p.text));
      else {
        const list = this.pendingMessages.get(p.taskId) ?? [];
        list.push(String(p.text));
        this.pendingMessages.set(p.taskId, list);
      }
    } else if (message.kind === "task.cancel") {
      const current = this.current;
      if (current && current.id === p.taskId) current.running.cancel();
      this.queue = this.queue.filter((t) => t.id !== p.taskId);
    }
  }

  private output(taskId: string, output: TaskOutput) {
    if (taskId !== this.active) return;
    const key = `${taskId}:${output.type}`;
    if (output.type === "progress") {
      // Progress is advisory: at most one per second, and only the latest matters.
      const last = this.progressAt.get(key) ?? -Infinity;
      if (this.clock() - last < 1000) return;
      this.progressAt.set(key, this.clock());
      void this.report({
        kind: "task.progress",
        taskId,
        payload: output.payload ?? {},
      });
      return;
    }
    // Questions are queued and sent one per second by a single drainer, in order, and only
    // while their task is still the active one.
    const queue = this.questions.get(taskId) ?? [];
    // A task flooding questions is cut off rather than allowed to grow the agent's memory.
    if (queue.length >= MAX_PENDING_QUESTIONS) {
      this.current?.running.cancel();
      return;
    }
    queue.push(output.payload ?? {});
    this.questions.set(taskId, queue);
    if (queue.length === 1) void this.drain(taskId, key);
  }

  private async drain(taskId: string, key: string) {
    const queue = this.questions.get(taskId)!;
    while (queue.length && !this.stopped && this.active === taskId) {
      const wait =
        (this.progressAt.get(key) ?? -Infinity) + 1000 - this.clock();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this.stopped || this.active !== taskId) break;
      this.progressAt.set(key, this.clock());
      void this.report({
        kind: "task.question",
        taskId,
        payload: queue.shift()!,
      });
    }
    if (this.active !== taskId) this.questions.delete(taskId);
  }

  private async work() {
    while (!this.stopped) {
      const task = this.queue.shift();
      if (!task) return;
      await this.report({ kind: "box.state", state: "busy" });
      if (task.refused) {
        if (!(await this.finish(task.id, task.refused))) return;
        if (!this.queue.length)
          await this.report({ kind: "box.state", state: "idle" });
        continue;
      }
      this.mark(task.id, "running");
      await this.report({ kind: "task.started", taskId: task.id });
      let running: RunningTask;
      this.active = task.id;
      try {
        running = this.o.runner.start(task, (output) =>
          this.output(task.id, output),
        );
      } catch {
        running = {
          send: () => {},
          cancel: () => {},
          done: Promise.resolve({
            type: "failed" as const,
            payload: { error: "The task could not be started in this box" },
          }),
        };
      }
      this.current = { id: task.id, running };
      for (const text of this.pendingMessages.get(task.id) ?? [])
        running.send(text);
      this.pendingMessages.delete(task.id);
      const outcome = await running.done;
      this.current = undefined;
      this.active = undefined;
      this.questions.delete(task.id);
      for (const kind of ["progress", "question"])
        this.progressAt.delete(`${task.id}:${kind}`);
      if (!(await this.finish(task.id, outcome))) return;
      if (!this.queue.length)
        await this.report({ kind: "box.state", state: "idle" });
    }
  }

  /** Connects, recovers interrupted tasks, then polls until the box ends. */
  async run() {
    this.watch = setInterval(
      () => this.checkLimits(),
      this.o.watchMs ?? 10_000,
    );
    this.watch.unref?.();
    await this.connect();
    if (this.stopped) return;
    for (const [id, entry] of Object.entries(this.journal())) {
      let finished = true;
      if (entry.state === "running")
        // The box restarted mid-task: the task's process is gone, so report it honestly.
        finished = await this.finish(id, {
          type: "failed",
          payload: { error: "The box restarted while this task was running" },
        });
      else if (entry.state === "finished" && entry.outcome)
        // The outcome was recorded but may not have reached the host: report it again.
        finished = await this.finish(id, entry.outcome);
      else if (entry.state === "reported") finished = await this.cleanup(id);
      else if (entry.state === "queued" && entry.kind !== undefined)
        // Acknowledged but never started: it still runs.
        this.queue.push({ id, kind: entry.kind, payload: entry.payload ?? {} });
      if (!finished) return;
    }
    let working: Promise<void> = Promise.resolve();
    if (this.queue.length) working = this.work();
    else await this.report({ kind: "box.state", state: "idle" });
    while (!this.stopped) {
      this.checkLimits();
      if (this.stopped) break;
      const after = Number(this.o.store.read("cursor") ?? "0");
      let response: Response;
      try {
        response = await this.http(`${this.url("next")}?after=${after}`, {
          headers: { authorization: `Bearer ${this.credential}` },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        await this.wait();
        continue;
      }
      if (response.status === 401) {
        await this.end("The host refused this box's credential");
        break;
      }
      if (!response.ok) {
        await this.wait();
        continue;
      }
      const body = (await response.json()) as {
        messages: Message[];
        remainingMs: number;
      };
      this.contact(body.remainingMs);
      for (const message of body.messages) {
        this.handle(message);
        // Acknowledged by the next poll once handled; tasks are journalled durably first.
        this.o.store.write("cursor", String(message.seq));
      }
      if (this.queue.length && !this.current)
        working = working.then(() => this.work());
    }
    if (this.watch) clearInterval(this.watch);
    await working.catch(() => {});
  }
}
