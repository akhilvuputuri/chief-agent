import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BoxProvider, LaunchRequest, ProviderState } from "./provider.js";

type Meta = {
  boxId: string;
  environment: string;
  clientToken: string;
  status: "running" | "stopped" | "terminated";
  env: Record<string, string>;
};

/**
 * Development and CI provider: each box is a box-agent process with its own state
 * directory, standing in for an instance and its disk. Stopping ends the process but
 * keeps the directory, so a start resumes like a stopped EC2 instance. Not isolation.
 */
export class LocalProcessProvider implements BoxProvider {
  readonly kind = "local";
  readonly canStop = true;
  private children = new Map<string, ChildProcess>();
  constructor(
    private root: string,
    /** How to run the agent, e.g. [node, --import, tsx, src/boxes/agent-main.ts]. */
    private agent: string[],
    /** Extra agent environment, such as the runner and task command. */
    private agentEnv: Record<string, string>,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private dir(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid local box id");
    return join(this.root, id);
  }
  private meta(id: string): Meta | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir(id), "meta.json"), "utf8"));
    } catch {
      return undefined;
    }
  }
  private save(id: string, meta: Meta) {
    writeFileSync(join(this.dir(id), "meta.json"), JSON.stringify(meta), {
      mode: 0o600,
    });
  }
  private run(id: string, meta: Meta) {
    const [command, ...args] = this.agent;
    const child = spawn(command!, args, {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...meta.env,
        CHIEF_BOX_STATE: join(this.dir(id), "state"),
        CHIEF_BOX_SHUTDOWN: "exit",
      },
      stdio: process.env.CHIEF_BOX_DEBUG ? "inherit" : "ignore",
    });
    this.children.set(id, child);
    child.on("exit", () => {
      if (this.children.get(id) === child) this.children.delete(id);
      // An agent that ends the box on its own (lifetime, refused credential) terminates it.
      const current = this.meta(id);
      if (current?.status === "running") {
        current.status = "terminated";
        this.save(id, current);
      }
    });
  }
  async launch(request: LaunchRequest) {
    const id = request.clientToken;
    if (this.meta(id)) return id;
    mkdirSync(this.dir(id), { recursive: true, mode: 0o700 });
    const meta: Meta = {
      boxId: request.boxId,
      environment: request.environment,
      clientToken: request.clientToken,
      status: "running",
      env: {
        ...this.agentEnv,
        CHIEF_BOX_ORIGIN: request.bootstrap.origin,
        CHIEF_BOX_ID: request.bootstrap.boxId,
        CHIEF_BOX_BOOTSTRAP: request.bootstrap.secret,
      },
    };
    this.save(id, meta);
    this.run(id, meta);
    return id;
  }
  async find(boxId: string) {
    if (!existsSync(this.root)) return undefined;
    for (const id of readdirSync(this.root)) {
      const meta = this.meta(id);
      if (meta?.boxId === boxId && meta.status !== "terminated") return id;
    }
    return undefined;
  }
  async describe(id: string): Promise<ProviderState> {
    const meta = this.meta(id);
    if (!meta) return "missing";
    if (meta.status === "running" && !this.children.has(id)) return "stopped";
    return meta.status;
  }
  private async kill(id: string) {
    const child = this.children.get(id);
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }
  async stop(id: string) {
    const meta = this.meta(id);
    if (!meta || meta.status === "terminated") return;
    meta.status = "stopped";
    this.save(id, meta);
    await this.kill(id);
  }
  async start(id: string) {
    const meta = this.meta(id);
    if (!meta || meta.status === "terminated") throw new Error("Box is gone");
    if (this.children.has(id)) return;
    meta.status = "running";
    this.save(id, meta);
    this.run(id, meta);
  }
  async terminate(id: string) {
    const meta = this.meta(id);
    if (!meta) return;
    meta.status = "terminated";
    this.save(id, meta);
    await this.kill(id);
    rmSync(join(this.dir(id), "state"), { recursive: true, force: true });
  }
  async list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).flatMap((id) => {
      const meta = this.meta(id);
      return meta && meta.status !== "terminated"
        ? [{ providerId: id, boxId: meta.boxId, environment: meta.environment }]
        : [];
    });
  }
  /** Ends every agent process; for test teardown. */
  async close() {
    await Promise.all([...this.children.keys()].map((id) => this.kill(id)));
  }
}
