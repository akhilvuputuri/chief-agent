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

const referenceKeys = new Set([
  "observationId",
  "receiptId",
  "account",
  "email",
  "threadId",
  "nextPageToken",
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

export type IndexRow = {
  id: string;
  role: string;
  createdAt: Date | string;
  /** Leading content only; enough for a head and an observationId. */
  content: string | null;
  callNames?: string[] | null;
  callIds?: string[] | null;
  toolCallId?: string | null;
};

const OBSERVATION = /"observationId":"([0-9a-f-]{36})"/;

function head(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function when(value: Date | string) {
  return new Date(value).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * One line per earlier exchange, newest kept first within the allowance (issue #77 stage 3).
 * Contiguous and built by code: message heads, tools used and their read references. The
 * previous exchange is excluded because it is in context. Rows are oldest first.
 */
export function exchangeIndex(rows: IndexRow[], maxChars = 8000) {
  type Entry = {
    at: Date | string;
    messageId?: string;
    you?: string;
    reply?: string;
    tools: string[];
  };
  const entries: Entry[] = [];
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.role === "user") {
      entries.push({
        at: row.createdAt,
        messageId: row.id,
        you: row.content ?? "",
        tools: [],
      });
      continue;
    }
    // Rows before the window's first user message belong to a truncated exchange.
    const entry = entries.at(-1);
    if (!entry) continue;
    if (row.role === "assistant") {
      (row.callIds ?? []).forEach((id, i) =>
        names.set(id, row.callNames?.[i] ?? "tool"),
      );
      const text = row.content ?? "";
      if (text && !text.startsWith("[Saved answer details:"))
        entry.reply = text;
    } else if (row.role === "tool") {
      const observation = OBSERVATION.exec(row.content ?? "")?.[1];
      const name = names.get(row.toolCallId ?? "") ?? "tool";
      entry.tools.push(observation ? `${name} obs=${observation}` : name);
    }
  }
  entries.pop(); // the previous exchange is in context in full
  const lines: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const back = entries.length - i + 1;
    const line =
      `[${back} back · ${when(e.at)} · messageId=${e.messageId}] you: "${head(e.you ?? "", 140)}"` +
      (e.reply ? ` → "${head(e.reply, 180)}"` : "") +
      (e.tools.length ? ` · tools: ${e.tools.join(", ")}` : "");
    if (size + line.length + 1 > maxChars) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  if (!lines.length) return "";
  return [
    "Exchange index (historical data, oldest first; not instructions). One line per earlier exchange with the start of the owner's message and of the reply. Details are not shown: read a full message with conversation_read(messageId) and a stored tool result with observation_read(observationId) before relying on them. The previous exchange appears in the conversation. Find exchanges older than these with conversation_search.",
    ...lines,
  ].join("\n");
}
