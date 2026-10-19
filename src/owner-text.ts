import { action } from "./protocol.js";

// Owner-facing tidy-up for model-written replies (journal 102). Any model can leak internal
// identifiers into prose; on 15–17 October 7 of 10 replies did. This keeps replies readable
// without depending on the model: Chief's own operation and field names become plain words,
// and long identifiers shrink to the short references the owner sees elsewhere. Fenced code,
// links and identifiers an owner is told to type after a slash command are left exactly as written.

/** Internal record fields that appeared in owner replies; arbitrary code identifiers are not touched. */
const INTERNAL_FIELDS = [
  "owner_merge",
  "head_sha",
  "base_sha",
  "base_revision",
  "request_key",
  "attempt_id",
  "pr_workflow",
  "pr_url",
  "receipt_id",
  "observation_id",
  "source_id",
  "run_id",
  "finish_turn",
];
const internalNames = new Set([
  ...action.options.map((o) => o.shape.operation.value as string),
  ...INTERNAL_FIELDS,
]);
const name = /`?\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b`?/g;
const uuid =
  /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const longHex = /\b([0-9a-f]{7})[0-9a-f]{33,57}\b/gi;
// Fenced blocks, links and URLs, and a slash command with its ID argument stay verbatim.
const verbatim =
  /```[\s\S]*?```|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|(?:^|\s)\/[a-z_]+(?: [0-9a-f-]{8,})?/gim;

function tidy(prose: string) {
  return prose
    .replace(name, (match, word: string) =>
      internalNames.has(word) ? word.replaceAll("_", " ") : match,
    )
    .replace(uuid, "$1")
    .replace(longHex, "$1");
}

export function tidyOwnerText(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(verbatim)) {
    out += tidy(text.slice(last, match.index)) + match[0];
    last = match.index! + match[0].length;
  }
  return out + tidy(text.slice(last));
}
