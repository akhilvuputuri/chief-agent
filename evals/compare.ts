import { readFile } from "node:fs/promises";
const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath)
  throw new Error(
    "Usage: npm run eval:compare -- BEFORE/report.json AFTER/report.json",
  );
const before = JSON.parse(await readFile(beforePath, "utf8")),
  after = JSON.parse(await readFile(afterPath, "utf8"));
if (
  before.fingerprint !== after.fingerprint ||
  JSON.stringify(before.settings) !== JSON.stringify(after.settings)
)
  throw new Error(
    "Fixtures, graders or model settings differ; not a controlled runtime comparison",
  );
console.log(`Baseline ${before.revision} -> candidate ${after.revision}`);
console.log(`Context retention: ${before.probe.pass} -> ${after.probe.pass}`);
for (const b of before.summaries) {
  const a = after.summaries.find((x: any) => x.name === b.name);
  if (!a) {
    console.log(`${b.name}: not run in candidate`);
    continue;
  }
  console.log(
    `${b.name}: pass ${b.score?.pass ?? "error"} -> ${a.score?.pass ?? "error"}; coverage ${b.score?.coverage ?? "?"} -> ${a.score?.coverage ?? "?"}; model calls ${b.modelCalls ?? "?"} -> ${a.modelCalls ?? "?"}; tool calls ${b.toolCalls ?? "?"} -> ${a.toolCalls ?? "?"}`,
  );
}
