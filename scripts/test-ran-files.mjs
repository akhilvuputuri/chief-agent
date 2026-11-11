// A node:test reporter for scripts/test-shard.mjs: one line per test file as soon as one
// of its tests finishes ("ran <file>"), one the first time one fails ("failed <file>"), and
// "complete" when node has run everything. The shared-process run reads it to find the
// files it must run again on their own. A run cut short, even by an exit with code 0,
// never writes "complete".
export default async function* ranFiles(source) {
  const ran = new Set();
  const failed = new Set();
  for await (const { type, data } of source) {
    if ((type !== "test:pass" && type !== "test:fail") || !data.file) continue;
    if (!ran.has(data.file)) {
      ran.add(data.file);
      yield `ran ${data.file}\n`;
    }
    if (type === "test:fail" && !failed.has(data.file)) {
      failed.add(data.file);
      yield `failed ${data.file}\n`;
    }
  }
  yield "complete\n";
}
