// Decides whether a pull request changes only documentation, so `checks` can skip the
// jobs that build and run code. Reads changed paths, one per line, and prints true or
// false. Anything unrecognised means false, so an unexpected change runs everything.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// AGENTS.md and CLAUDE.md are left out: they configure how agents work, not just describe it.
const ROOT_DOCS = new Set(["README.md", "HANDOVER.md", "CONTRIBUTING.md"]);

function isDoc(path) {
  return (
    ROOT_DOCS.has(path) || (path.startsWith("docs/") && !path.includes(".."))
  );
}

export function isDocsOnly(changedPaths) {
  const paths = changedPaths.filter(Boolean);
  return paths.length > 0 && paths.every(isDoc);
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  console.log(isDocsOnly(readFileSync(0, "utf8").split("\n")));
}
