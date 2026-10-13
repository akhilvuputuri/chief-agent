// Manual acceptance preparation, never a paid runner or an approval grant.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url)),
  repository = resolve(here, "../..");
const [candidateArgument, outputArgument] = process.argv.slice(2);
if (
  !candidateArgument ||
  !outputArgument ||
  !isAbsolute(candidateArgument) ||
  !isAbsolute(outputArgument)
)
  throw Error(
    "Usage: node scripts/pi-acceptance/prepare-oracle.mjs /absolute/candidate /absolute/external-output",
  );
const candidate = realpathSync(candidateArgument);
mkdirSync(outputArgument, { recursive: true, mode: 0o700 });
const output = realpathSync(outputArgument),
  within = relative(candidate, output);
if (!within.startsWith("../") && within !== "..")
  throw Error("Oracle must be outside the agent workspace");
const manifest = JSON.parse(readFileSync(join(here, "workloads.json"), "utf8"));
const source = execFileSync(
  "git",
  [
    "-c",
    `safe.directory=${repository}`,
    "show",
    `${manifest.fixtureSource ?? manifest.source}:tests/coding.test.ts`,
  ],
  { cwd: repository, encoding: "utf8" },
);
const ast = ts.createSourceFile(
  "coding.test.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const prelude = ast.statements
  .filter(
    (n) =>
      ts.isImportDeclaration(n) ||
      (ts.isFunctionDeclaration(n) && n.name?.text === "fixture") ||
      (ts.isVariableStatement(n) &&
        n.declarationList.declarations.some((d) =>
          ["settings", "base"].includes(d.name.getText(ast)),
        )),
  )
  .map((n) => n.getText(ast))
  .join("\n");
// Only implementation imports point at the candidate. The fixture and oracle
// are read from trusted baseline/reviewer files, never from agent-edited tests.
const body = (
  prelude +
  "\n" +
  readFileSync(join(here, "oracles.ts.txt"), "utf8")
)
  .replaceAll("../src/", candidate + "/src/")
  .replaceAll("../db/", candidate + "/db/")
  .replaceAll("../config/", candidate + "/config/");
writeFileSync(join(output, "oracle.test.ts"), body, { mode: 0o600 });
try {
  symlinkSync(
    join(repository, "node_modules"),
    join(output, "node_modules"),
    "dir",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
console.log(
  JSON.stringify({
    source: manifest.source,
    output: join(output, "oracle.test.ts"),
    workloads: manifest.workloads.map((w) => w.id),
    paidCalls: 0,
  }),
);
