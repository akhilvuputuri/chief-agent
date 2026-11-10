import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

// Booting PGlite compiles its WASM module and runs initdb, which costs more than the
// migrations themselves. Each test process compiles once, applies a migration list once,
// and restores databases from that snapshot. Each call still returns an independent
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

// Production compiles pgvector into Postgres; PGlite loads it as an extension.
const extensionsFor = (files: string[]) =>
  files.some((file) => file.startsWith("034_")) ? { vector } : undefined;

async function snapshot(files: string[]) {
  const template = await PGlite.create({
    ...(await (runtime ??= loadRuntime())),
    extensions: extensionsFor(files),
  });
  for (const file of files)
    await template.exec(
      await readFile(new URL(`../../db/${file}`, import.meta.url), "utf8"),
    );
  const data = await template.dumpDataDir("none");
  await template.close();
  return data;
}

// A database handed back with `close()` is emptied and kept for the next caller, which
// costs a few milliseconds against well over a hundred to restore the snapshot. Set
// TEST_DB_REUSE=0 to restore the snapshot every time instead.
type Pooled = {
  pg: PGlite;
  /** Finds the tables that hold rows, so an untouched table costs nothing to reset. */
  probe: string;
  /** Rows the migrations themselves inserted, put back after each reset. */
  seeds: { insert: string; rows: string }[];
};
const idle = new Map<string, Pooled[]>();
const stats = { created: 0, reused: 0, discarded: 0 };
/** How databases were supplied so far in this process. */
export const databaseStats = () => ({ ...stats });

const USER_TABLES = `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
  WHERE schemaname !~ '^pg_' AND schemaname NOT IN ('information_schema', 'test_pool')`;

async function pooled(pg: PGlite): Promise<Pooled> {
  // Event triggers see every schema change, including ones a rolled-back transaction
  // undoes (the setting rolls back with it). A changed schema is never reused.
  await pg.exec(`
    CREATE SCHEMA test_pool;
    CREATE FUNCTION test_pool.mark() RETURNS event_trigger LANGUAGE plpgsql AS
      $$ BEGIN PERFORM set_config('test_pool.dirty', '1', false); END $$;
    CREATE EVENT TRIGGER test_pool_ddl ON ddl_command_end EXECUTE FUNCTION test_pool.mark();
    CREATE EVENT TRIGGER test_pool_drop ON sql_drop EXECUTE FUNCTION test_pool.mark();
    SELECT set_config('test_pool.dirty', '', false);`);
  const tables = (await pg.query<{ name: string }>(USER_TABLES)).rows.map(
    (row) => row.name,
  );
  const probe = tables
    .map(
      (name) => `SELECT '${name}' AS name WHERE EXISTS (SELECT 1 FROM ${name})`,
    )
    .join(" UNION ALL ");
  const seeds: Pooled["seeds"] = [];
  for (const { name } of tables.length
    ? (await pg.query<{ name: string }>(probe)).rows
    : []) {
    // Generated columns cannot be inserted; everything else round-trips through JSON.
    const columns = (
      await pg.query<{ column: string }>(
        `SELECT format('%I', attname) AS column FROM pg_attribute
          WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
            AND attgenerated = '' ORDER BY attnum`,
        [name],
      )
    ).rows.map((row) => row.column);
    const rows = (
      await pg.query<{ rows: string }>(
        `SELECT coalesce(json_agg(t), '[]')::text AS rows FROM ${name} t`,
      )
    ).rows[0]!.rows;
    seeds.push({
      insert: `INSERT INTO ${name} (${columns}) OVERRIDING SYSTEM VALUE
        SELECT ${columns} FROM json_populate_recordset(NULL::${name}, $1::json)`,
      rows,
    });
  }
  return { pg, probe, seeds };
}

/** Empties a returned database. False means it cannot be reused and must be closed. */
async function reset({ pg, probe, seeds }: Pooled): Promise<boolean> {
  await pg.exec("ROLLBACK");
  const { dirty } = (
    await pg.query<{ dirty: string }>(
      "SELECT coalesce(current_setting('test_pool.dirty', true), '') AS dirty",
    )
  ).rows[0]!;
  if (dirty) return false;
  const filled = probe
    ? (await pg.query<{ name: string }>(probe)).rows.map((row) => row.name)
    : [];
  // Replica mode skips foreign-key and user triggers, so the order of deletes is free and
  // nothing fires. Deleted rows are never vacuumed here, so new rows still land in
  // insertion order, as they would in a fresh database.
  await pg.exec(
    `SET session_replication_role = replica; ${filled
      .map((name) => `DELETE FROM ${name};`)
      .join(" ")}`,
  );
  for (const seed of seeds) await pg.query(seed.insert, [seed.rows]);
  await pg.query(
    `SELECT setval(format('%I.%I', schemaname, sequencename)::regclass, start_value, false)
       FROM pg_sequences WHERE last_value IS NOT NULL`,
  );
  // Settings, prepared statements, listeners, advisory locks and temporary tables.
  await pg.exec("DISCARD ALL");
  // PGlite sets this for its session at start; DISCARD ALL returns it to the server default.
  await pg.exec("SET search_path TO public");
  return true;
}

/** A handle that behaves like its own database: once closed, it refuses further use. */
function lease(key: string, entry: Pooled): PGlite {
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (await reset(entry).catch(() => false)) {
      const list = idle.get(key);
      if (list) list.push(entry);
      else idle.set(key, [entry]);
      return;
    }
    stats.discarded++;
    await entry.pg.close();
  };
  return new Proxy(entry.pg, {
    get(target, property) {
      if (property === "close" || property === Symbol.asyncDispose)
        return close;
      if (property === "closed") return closed || target.closed;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      // PGlite's methods read private fields, so they must run on the real instance.
      return (...args: unknown[]) =>
        closed
          ? Promise.reject(new Error("PGlite is closed"))
          : value.apply(target, args);
    },
  });
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
  const reuse = process.env.TEST_DB_REUSE !== "0";
  const kept = reuse ? idle.get(key)?.pop() : undefined;
  if (kept) {
    stats.reused++;
    return lease(key, kept);
  }
  let data = snapshots.get(key);
  if (!data) snapshots.set(key, (data = snapshot(files)));
  const pg = await PGlite.create({
    ...(await (runtime ??= loadRuntime())),
    extensions: extensionsFor(files),
    loadDataDir: await data,
  });
  stats.created++;
  return reuse ? lease(key, await pooled(pg)) : pg;
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
