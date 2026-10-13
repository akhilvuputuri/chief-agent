import {
  compact,
  buildSessionProjection,
  prepareBranchEntries,
  estimateTokens,
  type CompactionEntry,
  type CustomEntry,
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
  commitEmptyTail: () => string,
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
  const projection = buildSessionProjection(event.branchEntries);
  // The host supplies the current prompt separately, including forced phase text.
  const before = projection.messages.filter((m) => m.role !== "system");
  const tokens = (messages: typeof before) =>
    messages.reduce((n, m) => n + estimateTokens(m), 0);
  const beforeTokens = tokens(before);
  const fixedBytes =
    Buffer.byteLength(context.getSystemPrompt()) +
    Buffer.byteLength(JSON.stringify(tools));
  const timestamp = new Date().toISOString();
  const boundary: CustomEntry = {
    type: "custom",
    customType: "runtime_compaction_boundary",
    id: randomUUID(),
    parentId: event.branchEntries.at(-1)?.id ?? null,
    timestamp,
  };
  const project = (
    summary: string,
    firstKeptEntryId: string,
    emptyTail: boolean,
  ) => {
    const entry: CompactionEntry = {
      type: "compaction",
      id: randomUUID(),
      parentId: emptyTail ? boundary.id : boundary.parentId,
      timestamp,
      summary,
      firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    };
    const after = buildSessionProjection(
      [...event.branchEntries, ...(emptyTail ? [boundary] : []), entry],
      entry.id,
    ).messages.filter((m) => m.role !== "system");
    const afterTokens = tokens(after);
    return {
      after,
      afterTokens,
      projectedBytes: Buffer.byteLength(JSON.stringify(after)) + fixedBytes,
      projectedTokens: afterTokens + Math.ceil(fixedBytes / 4),
    };
  };
  const hasHeadroom = (value: ReturnType<typeof project>) =>
    value.projectedTokens <=
      model.contextWindow - event.preparation.settings.reserveTokens &&
    (requestByteLimit === undefined ||
      value.projectedBytes <= requestByteLimit * 0.75);
  const summaryTokenLimit = Math.floor(
    event.preparation.settings.reserveTokens / 2,
  );
  // Pi keeps complete assistant/tool-result groups. Even keepRecentTokens=0 can
  // retain a large last group. Choose the scope before making the summary call,
  // reserving space for a maximum-length accepted ASCII summary. Actual token
  // and byte checks below still apply, including Unicode/JSON overhead.
  const probe = project(
    "x".repeat(summaryTokenLimit * 4),
    event.preparation.firstKeptEntryId,
    false,
  );
  const emptyTail = !hasHeadroom(probe) || probe.afterTokens >= beforeTokens;
  // A long build is one turn. Summarizing its prefix separately can keep the old
  // history beside another summary. Make a single replacement of both inputs.
  let preparation = {
    ...event.preparation,
    isSplitTurn: false,
    messagesToSummarize: [
      ...event.preparation.messagesToSummarize,
      ...event.preparation.turnPrefixMessages,
    ],
    turnPrefixMessages: [],
  };
  if (emptyTail) {
    // Use the canonical active projection, never the raw append-only history.
    // Native preparation supplies file tracking and summary serialization.
    const activeEntries = projection.entries.flatMap(
      ({ sourceEntry, messages }) =>
        sourceEntry.type === "compaction"
          ? []
          : messages
              .filter((message) => message.role !== "system")
              .map((message) => ({
                type: "message" as const,
                id: sourceEntry.id,
                parentId: sourceEntry.parentId,
                timestamp: sourceEntry.timestamp,
                message,
              })),
    );
    // Branch preparation deliberately omits tool results from its messages.
    // Reuse only its file tracking: compaction must see observed results too.
    const whole = prepareBranchEntries(activeEntries);
    preparation = {
      ...preparation,
      firstKeptEntryId: boundary.id,
      messagesToSummarize: activeEntries.map((entry) => entry.message),
      fileOps: {
        read: new Set([...preparation.fileOps.read, ...whole.fileOps.read]),
        written: new Set([
          ...preparation.fileOps.written,
          ...whole.fileOps.written,
        ]),
        edited: new Set([
          ...preparation.fileOps.edited,
          ...whole.fileOps.edited,
        ]),
      },
    };
  }
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
  const projected = project(result.summary, result.firstKeptEntryId, emptyTail);
  const { after, afterTokens, projectedBytes, projectedTokens } = projected;
  const summaryTokens = estimateTokens({
    role: "user",
    content: result.summary,
    timestamp: Date.now(),
  });
  if (
    summaryTokens > summaryTokenLimit ||
    afterTokens >= beforeTokens ||
    !hasHeadroom(projected)
  )
    throw new ContextMaintenanceFailure(
      "Context compaction did not produce a smaller context with sufficient request headroom",
    );
  event.signal.throwIfAborted();
  return {
    ...result,
    // A real native metadata entry makes the empty retained range explicit.
    // Append it only after validation; the SDK then appends its compaction.
    firstKeptEntryId: emptyTail ? commitEmptyTail() : result.firstKeptEntryId,
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
        retainedMessages: after.filter((m) => m.role !== "compactionSummary")
          .length,
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
