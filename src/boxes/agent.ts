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
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * The in-box supervisor (docs/boxes.md). It holds the box credential, dials out to the
 * host, runs one task at a time through a runner, reports ordered events and ends the box
 * when its lifetime is spent or its credential is refused. It never accepts connections.
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

export interface RunningTask {
  /** Delivers an owner's answer or clarification to the task. */
  send(text: string): void;
  cancel(): void;
  /** Resolves with the task's final output. */
  done: Promise<{
    type: "result" | "failed";
    payload: Record<string, unknown>;
  }>;
}

export interface TaskRunner {
  start(
    task: { id: string; kind: string; payload: Record<string, unknown> },
    onOutput: (output: TaskOutput) => void,
  ): RunningTask;
  /** Removes everything a finished task left behind and checks that nothing remains. */
  reset(taskId: string): Promise<void>;
}

/**
 * Drives a task program over JSON lines: stdin receives the task and later messages,
 * stdout yields progress, questions and one final result.
 */
function lineProtocol(
  child: ChildProcess,
  task: { id: string; kind: string; payload: Record<string, unknown> },
  onOutput: (output: TaskOutput) => void,
): RunningTask {
  let final:
    { type: "result" | "failed"; payload: Record<string, unknown> } | undefined;
  const done = new Promise<{
    type: "result" | "failed";
    payload: Record<string, unknown>;
  }>((resolve) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      let output: TaskOutput;
      try {
        output = JSON.parse(line) as TaskOutput;
      } catch {
        return;
      }
      if (output.type === "result" || output.type === "failed") {
        final ??= {
          type: output.type,
          payload: output.payload ?? {},
        };
        child.stdin?.end();
      } else if (output.type === "progress" || output.type === "question")
        onOutput(output);
    });
    child.on("close", (code) =>
      resolve(
        final ?? {
          type: "failed",
          payload: { error: `Task exited without a result (code ${code})` },
        },
      ),
    );
    child.on("error", () =>
      resolve({ type: "failed", payload: { error: "Task could not start" } }),
    );
  });
  const write = (value: object) => {
    if (child.stdin && !child.stdin.destroyed)
      child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  write({ type: "task", id: task.id, kind: task.kind, payload: task.payload });
  return {
    send: (text) => write({ type: "message", text }),
    cancel: () => child.kill("SIGKILL"),
    done,
  };
}

/**
 * Development and test runner: a task program as a child process with a fresh home and
 * workspace. Not a security boundary; production boxes use the container runner.
 */
export class ProcessRunner implements TaskRunner {
  constructor(
    private command: string[],
    private root: string,
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
    const running = lineProtocol(child, task, onOutput);
    return {
      ...running,
      cancel: () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      },
      done: running.done.finally(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // The process group has already exited.
        }
      }),
    };
  }
  async reset(taskId: string) {
    rmSync(this.dirs(taskId).base, { recursive: true, force: true });
  }
}

/**
 * Production runner: a fresh container per task from the digest-pinned image, as an
 * unprivileged user with a fresh workspace, removed with everything it wrote afterwards.
 */
export class DockerRunner implements TaskRunner {
  constructor(
    private image: string,
    private root: string,
    private docker = "docker",
    private extra: string[] = [],
    /** Overrides the image's command; by default the image's own task program runs. */
    private command: string[] = [],
  ) {}
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
    const child = spawn(
      this.docker,
      [
        "run",
        "--rm",
        "-i",
        "--name",
        this.name(task.id),
        "--label",
        "chief.box.task=1",
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
        "--mount",
        `type=bind,source=${work},target=/workspace`,
        "--workdir",
        "/workspace",
        ...this.extra,
        this.image,
        ...this.command,
      ],
      { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } },
    );
    const running = lineProtocol(child, task, onOutput);
    return {
      ...running,
      cancel: () => {
        spawn(this.docker, ["rm", "-f", this.name(task.id)], {
          stdio: "ignore",
        });
      },
    };
  }
  async reset(taskId: string) {
    await new Promise<void>((resolve) => {
      spawn(this.docker, ["rm", "-f", this.name(taskId)], {
        stdio: "ignore",
      }).on("close", () => resolve());
    });
    rmSync(this.work(taskId), { recursive: true, force: true });
    const left = await new Promise<string>((resolve) => {
      let out = "";
      const ps = spawn(
        this.docker,
        ["ps", "-aq", "--filter", "label=chief.box.task=1"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      ps.stdout.on("data", (d) => (out += d));
      ps.on("close", () => resolve(out.trim()));
    });
    if (left) throw new Error("A task container survived its reset");
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
}

type Message = { seq: number; kind: string; payload: any };

export class BoxAgent {
  private credential = "";
  private epoch = 0;
  private remainingMs = Infinity;
  private stopped = false;
  private queue: {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
  }[] = [];
  private current?: { id: string; running: RunningTask };
  private pendingMessages = new Map<string, string[]>();
  private events: Promise<void> = Promise.resolve();
  private readonly http: typeof fetch;
  constructor(private o: AgentOptions) {
    this.http = o.fetch ?? fetch;
  }

  private url(path: string) {
    return `${this.o.origin}/boxes/${this.o.boxId}/${path}`;
  }

  private async end(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.current?.running.cancel();
    await this.o.shutdown(reason);
  }

  private async wait() {
    await new Promise((r) => setTimeout(r, this.o.retryMs ?? 2000));
  }

  /**
   * Exchanges the stored credential (or, on first boot only, the bootstrap secret) for the
   * next epoch's credential. Never runs concurrently with itself, and the replacement is
   * stored durably before any call uses it.
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
        await this.wait();
        continue;
      }
      if (response.status === 401)
        // A real agent never presents a retired credential; this box cannot continue.
        return this.end("The host refused this box's credential");
      if (!response.ok) {
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
      this.remainingMs = body.remainingMs;
      return;
    }
  }

  /** Reports one event in order; retried with the same sequence until the host has it. */
  private report(event: Record<string, unknown>) {
    const key = `seq-${this.epoch}`;
    const seq = Number(this.o.store.read(key) ?? "0") + 1;
    this.o.store.write(key, String(seq));
    const epoch = this.epoch;
    this.events = this.events.then(async () => {
      while (!this.stopped) {
        try {
          const response = await this.http(this.url("events"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.credential}`,
            },
            body: JSON.stringify({ epoch, events: [{ seq, ...event }] }),
            signal: AbortSignal.timeout(30000),
          });
          if (response.status === 401)
            return this.end("The host refused this box's credential");
          // A malformed event will never be accepted; dropping it keeps later ones flowing.
          if (response.ok || response.status === 400) return;
        } catch {
          // Network failure: retry the same event.
        }
        await this.wait();
      }
    });
    return this.events;
  }

  private tasks() {
    return this.o.store.json<Record<string, string>>("tasks", {});
  }

  private mark(id: string, state: string) {
    const tasks = this.tasks();
    tasks[id] = state;
    this.o.store.write("tasks", JSON.stringify(tasks));
  }

  private handle(message: Message) {
    const p = message.payload ?? {};
    if (message.kind === "task.assign") {
      // At-least-once delivery: a task already known is never started twice.
      if (this.tasks()[p.taskId]) return;
      this.mark(p.taskId, "queued");
      this.queue.push({ id: p.taskId, kind: p.kind, payload: p.payload ?? {} });
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

  private async work() {
    while (!this.stopped) {
      const task = this.queue.shift();
      if (!task) return;
      await this.report({ kind: "box.state", state: "busy" });
      this.mark(task.id, "running");
      await this.report({ kind: "task.started", taskId: task.id });
      let running: RunningTask;
      try {
        running = this.o.runner.start(task, (output) => {
          void this.report({
            kind:
              output.type === "question" ? "task.question" : "task.progress",
            taskId: task.id,
            payload: output.payload ?? {},
          });
        });
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
      await this.report({
        kind: outcome.type === "result" ? "task.result" : "task.failed",
        taskId: task.id,
        payload: outcome.payload,
      });
      this.mark(task.id, "done");
      try {
        await this.o.runner.reset(task.id);
      } catch {
        // A task that cannot be cleaned up must not be followed by another in this box.
        return this.end("A task left state behind that could not be removed");
      }
      if (!this.queue.length)
        await this.report({ kind: "box.state", state: "idle" });
    }
  }

  /** Connects, recovers interrupted tasks, then polls until the box ends. */
  async run() {
    await this.connect();
    if (this.stopped) return;
    for (const [id, state] of Object.entries(this.tasks()))
      if (state === "queued" || state === "running") {
        // The box restarted mid-task: the task's process is gone, so report it honestly.
        this.mark(id, "done");
        await this.report({
          kind: "task.failed",
          taskId: id,
          payload: { error: "The box restarted while this task was open" },
        });
        await this.o.runner.reset(id).catch(() => {});
      }
    await this.report({ kind: "box.state", state: "idle" });
    let working: Promise<void> = Promise.resolve();
    while (!this.stopped) {
      if (this.remainingMs <= 0) return this.end("Box lifetime reached");
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
      if (response.status === 401)
        return this.end("The host refused this box's credential");
      if (!response.ok) {
        await this.wait();
        continue;
      }
      const body = (await response.json()) as {
        messages: Message[];
        remainingMs: number;
      };
      this.remainingMs = body.remainingMs;
      for (const message of body.messages) {
        this.handle(message);
        // Acknowledged by the next poll only after the message is durably handled.
        this.o.store.write("cursor", String(message.seq));
      }
      if (this.queue.length && !this.current)
        working = working.then(() => this.work());
    }
    await working.catch(() => {});
  }
}
