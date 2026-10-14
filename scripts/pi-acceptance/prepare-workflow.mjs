import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, "../.."),
  manifest = JSON.parse(readFileSync(join(here, "workloads.json"), "utf8"));
const source = execFileSync(
    "git",
    ["show", `${manifest.fixtureSource}:tests/coding.test.ts`],
    { cwd: root, encoding: "utf8" },
  ),
  tree = ts.createSourceFile(
    "coding.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
const prelude = tree.statements
  .filter(
    (n) =>
      ts.isImportDeclaration(n) ||
      (ts.isFunctionDeclaration(n) && n.name?.text === "fixture") ||
      (ts.isVariableStatement(n) &&
        n.declarationList.declarations.some((d) =>
          ["settings", "base"].includes(d.name.getText(tree)),
        )),
  )
  .map((n) => n.getText(tree))
  .join("\n")
  .replace('"c".repeat(64)', "acceptanceKey")
  .replaceAll("../src/", "../dist/");
if (!prelude.includes("acceptanceKey"))
  throw Error("Fixture key replacement failed");
const target = join(root, "tests/pi-acceptance.manual.ts");
writeFileSync(
  target + ".tmp",
  prelude + "\n" + readFileSync(join(here, "workflow.ts.txt"), "utf8"),
  { mode: 0o444 },
);
renameSync(target + ".tmp", target);
console.log(
  JSON.stringify({ prepared: target, source: manifest.source, paidCalls: 0 }),
);
