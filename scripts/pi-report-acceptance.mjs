// Prepare a paid-test harness from the checked-in controller fixtures. This command
// makes no model call. The operator supplies a scoped model proxy to the generated
// test via stdin and explicitly runs it in a disposable guarded Linux container.
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const output = process.argv[2];
if (!output)
  throw new Error(
    "Provide the output test file path; preparation makes no model calls",
  );
const path = new URL("../tests/coding.test.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const ast = ts.createSourceFile(
  path.pathname,
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
writeFileSync(
  resolve(output),
  prelude +
    "\n" +
    readFileSync(
      new URL("fixtures/pi-report-acceptance.ts", import.meta.url),
      "utf8",
    ),
  { mode: 0o600 },
);
