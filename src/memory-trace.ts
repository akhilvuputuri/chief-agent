import { randomUUID, createHash } from "node:crypto";
import type { Database } from "./db.js";
// Best-effort credential scrubbing; private traces still contain personal source data.
export function scrub(value: unknown): any {
  if (typeof value === "string")
    return value
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,}|\d{7,12}:[A-Za-z0-9_-]{25,}|1\/\/[A-Za-z0-9_-]{20,})\b/g,
        "[REDACTED_CREDENTIAL]",
      )
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED_CREDENTIAL]");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(api_?key|access_token|refresh_token|authorization|client_secret|password)$/i.test(
          k,
        )
          ? "[REDACTED_CREDENTIAL]"
          : scrub(v),
      ]),
    );
  return value;
}
export class MemoryTrace {
  constructor(
    private db: Database,
    private user: string,
    private run: string,
  ) {}
  async begin(
    input: unknown,
    model: string | undefined,
    attempt: number,
    memories: { revisionId?: string }[],
  ) {
    const id = randomUUID();
    const clean = scrub(input);
    const store = async (value: unknown) => {
      const serialized = JSON.stringify(value),
        hash = createHash("sha256").update(serialized).digest("hex");
      await this.db.query(
        "INSERT INTO trace_blobs(user_id,hash,content) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING",
        [this.user, hash, serialized],
      );
      return hash;
    };
    const request = {
      ...clean,
      messages: undefined,
      tools: undefined,
      messageHashes: await Promise.all(clean.messages.map(store)),
      toolsHash: await store(clean.tools),
      scrubbed: JSON.stringify(input) !== JSON.stringify(clean),
      format: "blobs-v1",
    };
    await this.db.query(
      "INSERT INTO model_invocations(id,run_id,user_id,attempt,model,request) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [
        id,
        this.run,
        this.user,
        attempt,
        model ?? null,
        JSON.stringify(request),
      ],
    );
    const ids = new Set(
      memories.flatMap((m) => (m.revisionId ? [m.revisionId] : [])),
    );
    // Only IDs actually present in supplied messages count as included. Tool observations can carry older revisions.
    const collect = (v: any) => {
      if (!v) return;
      if (typeof v === "string") {
        try {
          collect(JSON.parse(v));
        } catch {}
        return;
      }
      if (Array.isArray(v)) {
        v.forEach(collect);
        return;
      }
      if (typeof v === "object") {
        if (typeof v.revisionId === "string") ids.add(v.revisionId);
        Object.values(v).forEach(collect);
      }
    };
    collect((input as any).messages);
    const serialized = JSON.stringify(input);
    for (const revision of ids) {
      if (!/^[0-9a-f-]{36}$/.test(revision) || !serialized.includes(revision))
        continue;
      await this.db.query(
        "INSERT INTO invocation_memories(invocation_id,user_id,revision_id,via) SELECT $1,$2,id,$4 FROM memory_revisions WHERE id=$3 AND user_id=$2 ON CONFLICT DO NOTHING",
        [
          id,
          this.user,
          revision,
          memories.some((m) => m.revisionId === revision)
            ? "selected_memory"
            : "tool_context",
        ],
      );
    }
    return id;
  }
  async end(
    id: string,
    state: string,
    response: unknown,
    latency: number,
    usage: unknown = null,
    provider: string | null = null,
  ) {
    await this.db.query(
      "UPDATE model_invocations SET state=$3,response=$4::jsonb,latency_ms=$5,usage=$6::jsonb,provider=$7,finished_at=now() WHERE id=$1 AND user_id=$2",
      [
        id,
        this.user,
        state,
        JSON.stringify(scrub(response)),
        latency,
        JSON.stringify(usage),
        provider,
      ],
    );
  }
}
