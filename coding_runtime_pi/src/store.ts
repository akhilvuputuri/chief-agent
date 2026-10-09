import {
  mkdir,
  readFile,
  rename,
  writeFile,
  open,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type { Task } from "./types.js";

export class TaskStore {
  readonly root: string;
  constructor(
    root: string,
    private key: string,
  ) {
    if (key.length < 32)
      throw new Error(
        "Task state requires a private signing key of at least 32 characters",
      );
    this.root = resolve(root);
  }
  private signature(body: string) {
    return createHmac("sha256", this.key).update(body).digest("hex");
  }
  path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid task identity");
    return join(this.root, id);
  }
  async save(task: Task) {
    const dir = this.path(task.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      const body = JSON.stringify(task);
      await file.writeFile(
        JSON.stringify({ body, signature: this.signature(body) }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(dir, "task.json"));
  }
  async get(id: string): Promise<Task> {
    const envelope = JSON.parse(
      await readFile(join(this.path(id), "task.json"), "utf8"),
    );
    if (
      typeof envelope.body !== "string" ||
      typeof envelope.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope.signature) ||
      !timingSafeEqual(
        Buffer.from(envelope.signature),
        Buffer.from(this.signature(envelope.body)),
      )
    )
      throw new Error("Task state integrity check failed");
    const task = JSON.parse(envelope.body) as Task;
    if (task.version !== 1 || task.id !== id)
      throw new Error("Unsupported task record");
    // A process restart never restarts a model or repeats tools.
    if (task.status === "running" && !this.processAlive(task.runnerPid)) {
      task.status = "paused";
      task.summary =
        "Interrupted; inspect the workspace before explicit resume";
    }
    return task;
  }
  private processAlive(pid?: number) {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  async cancellation(id: string) {
    try {
      const marker = await readFile(join(this.path(id), "cancel"), "utf8");
      return marker === this.signature(`cancel:${id}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }
  async requestCancel(id: string) {
    await writeFile(
      join(this.path(id), "cancel"),
      this.signature(`cancel:${id}`),
      { mode: 0o600 },
    );
  }
  async clearCancel(id: string) {
    await unlink(join(this.path(id), "cancel")).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  async runnerAlive() {
    try {
      const pid = Number(
        await readFile(join(this.root, "runner.lock"), "utf8"),
      );
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Invalid runner lock");
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
        return true;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }
  async reconcileLock() {
    if (await this.runnerAlive()) throw new Error("A runner is still alive");
    await unlink(join(this.root, "runner.lock")).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  async lock() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "runner.lock");
    const lock = await open(path, "wx", 0o600).catch(() => {
      throw new Error(
        "Runtime is locked; reconcile an interrupted runner before removing its lock",
      );
    });
    await lock.writeFile(String(process.pid));
    return async () => {
      await lock.close();
      await unlink(path);
    };
  }
}
