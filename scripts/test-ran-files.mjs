// A node:test reporter for scripts/test-shard.mjs: one line per test file as soon as one
// of its tests finishes ("ran <file>"), and one the first time one fails ("failed <file>").
// The shared-process run reads it to find the files it must run again on their own.
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
}
