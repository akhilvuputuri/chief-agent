import { action } from "./protocol.js";

// Owner-facing tidy-up for model-written replies (journal 102). Any model can leak internal
// identifiers into prose; on Gemini 4 Argon (5–17 October review window) 7 of 10 replies did. This keeps
// replies readable without depending on the model: Chief's own operation and field names
// become plain words, and long IDs in prose shrink to short references. Code (fenced or
// inline), links, URLs, paths and an ID right after a slash command are delivered exactly,
// so a value the owner asked for belongs in inline code. Shortened IDs are for reading only;
// commands such as /continue still need the full ID, which /status shows.

/** Internal record fields seen in owner replies; generic names (run_id, pr_url) are left alone. */
const INTERNAL_FIELDS = [
  "owner_merge",
  "head_sha",
  "base_sha",
  "base_revision",
  "request_key",
  "attempt_id",
  "pr_workflow",
  "finish_turn",
];
const internalNames = new Set([
  ...action.options.map((o) => o.shape.operation.value as string),
  ...INTERNAL_FIELDS,
]);
// A bare name, not part of a path, a dotted field, a call or a longer identifier.
const name = /(?<![\w./\\-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w./\\(-])/g;
const uuid =
  /(?<![\w-])([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w-])/gi;
// 40–64 hex characters with at least one letter, so long decimal numbers stay whole.
const longHex = /(?<!\w)(?=[0-9]*[a-f])([0-9a-f]{7})[0-9a-f]{33,57}(?!\w)/gi;
const verbatim = new RegExp(
  [
    "```[\\s\\S]*?```", // fenced code
    "`[^`\\n]+`", // inline code (an exact internal name is handled below)
    "\\[[^\\]\\n]{0,500}\\]\\((?:[^()\\s]|\\([^()\\s]*\\))*\\)", // Markdown link, one level of parentheses
    "https?:\\/\\/\\S+", // URL
    "\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)+\\/\\S*", // bare domain with a path
    "(?:^|(?<=[\\s(]))\\/[a-z_]+(?: [0-9a-f-]{8,})?", // slash command and its ID
  ].join("|"),
  "gim",
);

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
    const span = match[0];
    const inner =
      span.startsWith("`") && !span.startsWith("```") ? span.slice(1, -1) : "";
    out +=
      tidy(text.slice(last, match.index)) +
      (internalNames.has(inner) ? inner.replaceAll("_", " ") : span);
    last = match.index! + span.length;
  }
  return out + tidy(text.slice(last));
}
