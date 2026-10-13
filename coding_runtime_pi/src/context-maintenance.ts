import {
  compact,
  buildSessionProjection,
  estimateTokens,
  type CompactionEntry,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID, createHash } from "node:crypto";

type Stream = NonNullable<Parameters<typeof compact>[7]>;
export class ContextMaintenanceFailure extends Error {}

/** Replace old summaries once; validate before Pi appends an immutable entry. */
export async function compactContext(
  event: SessionBeforeCompactEvent,
  context: ExtensionContext,
  stream: Stream,
  tools: unknown,
  requestByteLimit?: number,
) {
  const model = context.model;
  if (!model)
    throw new ContextMaintenanceFailure(
      "Context compaction has no selected model",
    );
  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok)
    throw new ContextMaintenanceFailure(
      "Context compaction authentication is unavailable",
    );
  // A long build is one turn. Summarizing its prefix separately can keep the old
  // history beside another summary. Make a single replacement of both inputs.
  const preparation = {
    ...event.preparation,
    isSplitTurn: false,
    messagesToSummarize: [
      ...event.preparation.messagesToSummarize,
      ...event.preparation.turnPrefixMessages,
    ],
    turnPrefixMessages: [],
  };
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.headers ?? {}))
    if (typeof value === "string") headers[key] = value;
  const result = await compact(
    preparation,
    auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
    auth.apiKey,
    headers,
    "Create one concise replacement working-state summary, not an accumulating narrative. Target at most 1200 tokens. Preserve decisions, verified edits/check outcomes, remaining concrete work and unresolved blockers. The protected owner objective, instructions and complete approved documents remain supplied by the host; refer to their identifiers instead of copying their text. Do not reproduce source, tool output, prior summaries or lists of every investigation step. Preserve uncertainty and actual approval/check boundaries. For approved implementation identify the next concrete change or the precise missing fact that prevents it.",
    event.signal,
    context.thinkingLevel,
    stream,
    auth.env,
    { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  );
  if (!result.summary.trim())
    throw new ContextMaintenanceFailure(
      "Context compaction returned an empty summary",
    );
  const entry: CompactionEntry = {
    ...result,
    type: "compaction",
    id: randomUUID(),
    parentId: event.branchEntries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
  };
  const before = buildSessionProjection(event.branchEntries).messages;
  const after = buildSessionProjection(
    [...event.branchEntries, entry],
    entry.id,
  ).messages;
  const tokens = (messages: typeof before) =>
    messages.reduce((n, m) => n + estimateTokens(m), 0);
  const beforeTokens = tokens(before),
    afterTokens = tokens(after);
  const fixedBytes =
    Buffer.byteLength(context.getSystemPrompt()) +
    Buffer.byteLength(JSON.stringify(tools));
  const projectedBytes = Buffer.byteLength(JSON.stringify(after)) + fixedBytes;
  const summaryTokens = estimateTokens({
    role: "user",
    content: result.summary,
    timestamp: Date.now(),
  });
  const projectedTokens = afterTokens + Math.ceil(fixedBytes / 4);
  if (
    summaryTokens > Math.floor(preparation.settings.reserveTokens / 2) ||
    afterTokens >= beforeTokens ||
    projectedTokens >
      model.contextWindow - preparation.settings.reserveTokens ||
    (requestByteLimit !== undefined && projectedBytes > requestByteLimit * 0.75)
  )
    throw new ContextMaintenanceFailure(
      "Context compaction did not produce a smaller context with sufficient request headroom",
    );
  return {
    ...result,
    estimatedTokensAfter: afterTokens,
    details: {
      ...((result.details as object) ?? {}),
      contextMaintenance: {
        version: 1,
        beforeTokens,
        afterTokens,
        projectedTokens,
        projectedBytes,
        summaryCharacters: result.summary.length,
      },
    },
  };
}

/** Detect repeated maintenance with neither changed artifacts nor new observations. */
export class ContextProgress {
  private observations = new Set<string>();
  private checkpoints = new Map<
    string,
    { artifact: string; observations: number; unchanged: number }
  >();
  observe(
    name: string,
    content: unknown,
    failed: boolean,
    argumentsValue?: unknown,
  ) {
    if (
      failed ||
      !["read", "grep", "find", "ls", "read_document", "bash"].includes(name)
    )
      return;
    this.observations.add(
      createHash("sha256")
        .update(JSON.stringify([name, canonical(argumentsValue), content]))
        .digest("hex"),
    );
  }
  checkpoint(artifact: string, channel = "compactions") {
    const current = { artifact, observations: this.observations.size };
    const previous = this.checkpoints.get(channel);
    const unchanged =
      previous?.artifact === artifact &&
      previous.observations === current.observations
        ? previous.unchanged + 1
        : 0;
    this.checkpoints.set(channel, { ...current, unchanged });
    if (unchanged >= 3)
      throw new ContextMaintenanceFailure(
        `Implementation stalled: no workspace progress or new observations across repeated ${channel}`,
      );
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
