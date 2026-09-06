import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { ensureUser, event } from "./db.js";
import {
  agentResponse,
  type AgentRequest,
  type AgentResponse,
} from "./protocol.js";
import type { JobTools } from "./tools.js";
export interface Agent {
  run(request: AgentRequest): Promise<AgentResponse>;
}
export class Hermes implements Agent {
  constructor(
    private url: string,
    private token: string,
  ) {}
  async run(request: AgentRequest) {
    const res = await fetch(new URL("/v1/turn", this.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error("Agent unavailable");
    return agentResponse.parse(await res.json());
  }
}
export class Assistant {
  readonly capabilities = new Map<
    string,
    { user: string; run: string; expires: number }
  >();
  constructor(
    private db: Database,
    private agent: Agent,
    readonly tools: JobTools,
  ) {}
  async respond(user: string, message: string) {
    if (!message.trim() || message.length > 20000)
      throw new Error("Message must be between 1 and 20000 characters");
    await ensureUser(this.db, user);
    const run = randomUUID();
    const capability = randomBytes(32).toString("hex");
    this.capabilities.set(capability, {
      user,
      run,
      expires: Date.now() + 180000,
    });
    try {
      await event(this.db, user, run, "turn.started");
      const history =
        (
          await this.db.query(
            "SELECT history FROM conversations WHERE user_id=$1",
            [user],
          )
        ).rows[0]?.history ?? [];
      const memories = (
        await this.db.query(
          "SELECT key,value FROM memories WHERE user_id=$1 ORDER BY key",
          [user],
        )
      ).rows;
      const output = await this.agent.run({
        runId: run,
        capability,
        message,
        history,
        memories,
      });
      await this.db.query(
        "INSERT INTO conversations(user_id,history) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET history=$2::jsonb,updated_at=now()",
        [user, JSON.stringify(output.history)],
      );
      await event(this.db, user, run, "turn.completed");
      const approvals = (
        await this.db.query(
          "SELECT id,operation,payload FROM approvals WHERE user_id=$1 AND run_id=$2 AND status='pending' AND expires_at>now() ORDER BY created_at",
          [user, run],
        )
      ).rows;
      // Render the authoritative preview ourselves; never rely on model wording.
      const notices = approvals.map(
        (a) =>
          `Approval required — saved action\n${a.operation === "skill_activate" ? a.payload.preview + "\nAgent evaluation: " + a.payload.evaluation : `Delete role ${a.payload.id}: ${JSON.stringify(a.payload.title)} at ${JSON.stringify(a.payload.company)}`}\nWithin 15 minutes, send /approve ${a.id} or /deny ${a.id}`,
      );
      return [output.reply, ...notices].join("\n\n");
    } catch (error) {
      await event(this.db, user, run, "turn.failed");
      throw error;
    } finally {
      this.capabilities.delete(capability);
    }
  }
  async call(capability: string, input: unknown) {
    const scope = this.capabilities.get(capability);
    if (!scope || scope.expires < Date.now())
      throw new Error("Invalid run capability");
    return this.tools.execute(scope.user, scope.run, input);
  }
}
