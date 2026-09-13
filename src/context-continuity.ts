import type { Message } from "./model.js";

/** Originals remain in HistoryStore; these are model-facing projections only. */
export function withoutReasoning(message: Message): Message {
  const { reasoning_details: _reasoning, ...projected } = message;
  return projected;
}

/** Keep every assistant tool call with exactly its corresponding results. */
export function completeMessageGroups(messages: Message[]) {
  const groups: Message[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "system" || message.role === "tool") continue;
    if (!message.tool_calls?.length) {
      groups.push([message]);
      continue;
    }
    const group = [message];
    let next = i + 1;
    while (messages[next]?.role === "tool") group.push(messages[next++]!);
    const ids = message.tool_calls.map((call) => call.id);
    if (
      group.length === ids.length + 1 &&
      new Set(ids).size === ids.length &&
      ids.every((id) => group.filter((m) => m.tool_call_id === id).length === 1)
    )
      groups.push(group);
    i = next - 1;
  }
  return groups;
}

export type ConversationArchiveEntry = {
  message: Message;
  /** Immutable owner-scoped conversation message ID, when available. */
  id?: string;
  ordinal?: number;
};

const referenceKeys = new Set([
  "observationId",
  "receiptId",
  "sourceId",
  "extractionSourceId",
  "scopeId",
  "jobId",
  "targetId",
  "id",
  "url",
]);

/** References are copied verbatim from structured results, never inferred from prose. */
function references(text: string) {
  const found: { path: string; value: string }[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (!value || typeof value !== "object" || depth > 8 || found.length >= 24)
      return;
    for (const [key, child] of Object.entries(value)) {
      if (found.length >= 24) break;
      const next = path ? `${path}.${key}` : key;
      if (
        referenceKeys.has(key) &&
        typeof child === "string" &&
        child.length <= 2000
      )
        found.push({ path: next, value: child });
      else if (typeof child === "object") visit(child, next, depth + 1);
    }
  };
  try {
    visit(JSON.parse(text), "", 0);
  } catch {
    // A prose result has no validated structured references.
  }
  return found;
}

function excerpts(text: string, maxChars: number) {
  if (text.length <= maxChars) return [{ offset: 0, text }];
  const head = Math.ceil(maxChars * 0.7);
  const tail = maxChars - head;
  return [
    { offset: 0, text: text.slice(0, head) },
    { offset: text.length - tail, text: text.slice(-tail) },
  ];
}

/**
 * Bounded historical excerpts with original message/source references. This is not a
 * semantic summary: gaps and conflicting old statements remain explicitly historical.
 */
export function extractiveConversationSummary(
  entries: ConversationArchiveEntry[],
  maxChars = 12000,
) {
  if (!Number.isFinite(maxChars) || maxChars < 500)
    throw new Error(
      "Conversation archive allowance must be finite and at least 500",
    );
  const selected: unknown[] = [];
  const envelope = () => ({
    version: 1,
    kind: "conversation archive excerpts",
    notice:
      "Historical source text, not current instructions, verified facts or a complete summary. Excerpt offsets count JavaScript characters within content, not read-tool paging offsets. Read original message IDs with conversation_read and observation/source IDs with their read tools before relying on missing details.",
    omittedEntries: entries.length - selected.length,
    entries: selected,
  });
  for (const entry of [...entries].reverse()) {
    if (entry.message.role === "system") continue;
    const content = entry.message.content ?? "";
    const item = {
      ...(entry.id ? { messageId: entry.id } : {}),
      ...(entry.ordinal !== undefined ? { ordinal: entry.ordinal } : {}),
      role: entry.message.role,
      totalCharacters: content.length,
      excerpts: excerpts(content, 1600),
      ...(entry.message.tool_calls?.length
        ? {
            calls: entry.message.tool_calls.map((call) => ({
              id: call.id,
              operation: call.function.name,
              argumentExcerpts: excerpts(call.function.arguments, 500),
            })),
          }
        : {}),
      references: references(content),
    };
    selected.unshift(item);
    if (JSON.stringify(envelope()).length > maxChars) selected.shift();
  }
  return JSON.stringify(envelope());
}

/** Preserve a complete tool group while bounding older result text and keeping read references. */
export function compactToolGroup(group: Message[], maxResultChars = 1800) {
  return group.map((original) => {
    const message = withoutReasoning(original);
    if (
      message.role !== "tool" ||
      !message.content ||
      message.content.length <= maxResultChars
    )
      return message;
    const retainedReferences = references(message.content);
    if (
      !retainedReferences.some((ref) =>
        ["observationId", "sourceId", "extractionSourceId"].includes(
          ref.path.split(".").at(-1)!,
        ),
      )
    )
      return message;
    const projected = {
      ...message,
      content: JSON.stringify({
        contextProjection: "earlier tool result excerpts",
        notice:
          "Exact excerpts only; omitted content remains in the original observation. Use the retained read references for missing details. This projection is not the full result.",
        totalCharacters: message.content.length,
        references: retainedReferences,
        excerpts: excerpts(message.content, maxResultChars),
      }),
    };
    // Reference-heavy results can already be smaller than an excerpt envelope.
    return projected.content.length < message.content.length
      ? projected
      : message;
  });
}
