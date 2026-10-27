import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Booting PGlite compiles its WASM module and runs initdb, which costs more than the
// migrations themselves. Each test process compiles once, applies a migration list once,
// and restores every database from that snapshot. Each call still returns an independent
// database.
const dist = dirname(
  createRequire(import.meta.url).resolve("@electric-sql/pglite"),
);
let runtime:
  Promise<{ wasmModule: WebAssembly.Module; fsBundle: Blob }> | undefined;
const snapshots = new Map<string, Promise<Blob>>();

const loadRuntime = async () => ({
  wasmModule: await WebAssembly.compile(
    await readFile(join(dist, "pglite.wasm")),
  ),
  fsBundle: new Blob([await readFile(join(dist, "pglite.data"))]),
});

async function snapshot(files: string[]) {
  const template = await PGlite.create(await (runtime ??= loadRuntime()));
  for (const file of files)
    await template.exec(
      await readFile(new URL(`../../db/${file}`, import.meta.url), "utf8"),
    );
  const data = await template.dumpDataDir("none");
  await template.close();
  return data;
}

/**
 * A fresh database with `migrations` applied in order, by default every migration in
 * db/. Names may omit the `.sql` suffix.
 */
export async function migratedPGlite(migrations?: string[]): Promise<PGlite> {
  const files = migrations
    ? migrations.map((name) => (name.endsWith(".sql") ? name : `${name}.sql`))
    : (await readdir(new URL("../../db/", import.meta.url)))
        .filter((name) => /^\d+.*\.sql$/.test(name)) // as src/migrate.ts
        .sort();
  const key = files.join("\n");
  let data = snapshots.get(key);
  if (!data) snapshots.set(key, (data = snapshot(files)));
  return PGlite.create({
    ...(await (runtime ??= loadRuntime())),
    loadDataDir: await data,
  });
}

// node:test keeps finished tests and their hooks for reporting, so a hook closing over
// the database keeps its WASM heap reachable. This hook drops its reference first.
export function closeAfter(
  t: { after(fn: () => Promise<void>): void },
  database: PGlite,
) {
  const ref: { db?: PGlite } = { db: database };
  t.after(async () => {
    const db = ref.db;
    ref.db = undefined;
    await db?.close();
  });
}
