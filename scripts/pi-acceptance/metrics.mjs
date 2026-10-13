import { createHash } from "node:crypto";

const navigation = new Set(["read", "grep", "find", "ls", "read_document"]);
const knownTools = new Set([...navigation, "bash", "edit", "write", "report"]);
const sizeFields = [
  "beforeTokens",
  "afterTokens",
  "projectedTokens",
  "projectedBytes",
  "summaryCharacters",
  "retainedMessages",
];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;

/** Structural evidence only: never export source, arguments, summaries or paths. */
export function summarizeSessions(sessions) {
  const tools = {},
    observations = new Set(),
    documents = new Set();
  const compactions = [];
  let successfulReads = 0,
    documentReads = 0,
    failedTools = 0;
  for (const { entries } of sessions) {
    const calls = new Map();
    for (const entry of entries) {
      if (entry.type === "compaction") {
        const sizes = entry.details?.contextMaintenance;
        compactions.push(
          Object.fromEntries(
            sizeFields
              .filter(
                (key) => Number.isSafeInteger(sizes?.[key]) && sizes[key] >= 0,
              )
              .map((key) => [key, sizes[key]]),
          ),
        );
      }
      const message = entry.type === "message" ? entry.message : undefined;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const call of message.content) {
          if (call.type === "toolCall") calls.set(call.id, call);
        }
      }
      if (message?.role !== "toolResult") continue;
      const call = calls.get(message.toolCallId);
      const name = knownTools.has(message.toolName)
        ? message.toolName
        : "unknown";
      tools[name] = (tools[name] ?? 0) + 1;
      if (message.isError) {
        failedTools++;
        continue;
      }
      if (!navigation.has(name)) continue;
      successfulReads++;
      const digest = createHash("sha256")
        .update(
          JSON.stringify(
            canonical([name, call?.arguments ?? null, message.content]),
          ),
        )
        .digest("hex");
      observations.add(digest);
      if (name === "read_document") {
        documentReads++;
        documents.add(digest);
      }
    }
  }
  return {
    sessionCount: sessions.length,
    tools,
    failedTools,
    successfulReads,
    uniqueReads: observations.size,
    repeatedReads: successfulReads - observations.size,
    documentReads,
    repeatedDocumentReads: documentReads - documents.size,
    compactions,
  };
}
