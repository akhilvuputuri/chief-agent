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
  seeds: { table: string; insert: string; rows: string }[];
  /** Role count at the start: event triggers do not see roles being created. */
  roles: number;
};
const idle = new Map<string, Pooled[]>();
const stats = { created: 0, reused: 0, discarded: 0 };
/** How databases were supplied so far in this process. */
export const databaseStats = () => ({ ...stats });

const USER_TABLES = `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
  WHERE schemaname !~ '^pg_' AND schemaname NOT IN ('information_schema', 'test_pool')`;
// What a reset cannot undo: schema changes, roles and large objects.
const UNCLEAN = `SELECT (SELECT count(*) FROM test_pool.changes)::int AS changes,
  (SELECT count(*) FROM pg_roles)::int AS roles,
  (SELECT count(*) FROM pg_largeobject_metadata)::int AS large_objects`;

async function pooled(pg: PGlite): Promise<Pooled> {
  // Event triggers record every schema change in a table, so a rolled-back change is
  // rolled back in the record too, and no session setting can clear it. ENABLE ALWAYS
  // keeps them firing when a test switches session_replication_role.
  await pg.exec(`
    CREATE SCHEMA test_pool;
    CREATE TABLE test_pool.changes (at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION test_pool.mark() RETURNS event_trigger LANGUAGE plpgsql AS
      $$ BEGIN INSERT INTO test_pool.changes DEFAULT VALUES; END $$;
    CREATE EVENT TRIGGER test_pool_ddl ON ddl_command_end EXECUTE FUNCTION test_pool.mark();
    CREATE EVENT TRIGGER test_pool_drop ON sql_drop EXECUTE FUNCTION test_pool.mark();
    ALTER EVENT TRIGGER test_pool_ddl ENABLE ALWAYS;
    ALTER EVENT TRIGGER test_pool_drop ENABLE ALWAYS;
    DELETE FROM test_pool.changes;`);
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
      table: name,
      insert: `INSERT INTO ${name} (${columns}) OVERRIDING SYSTEM VALUE
        SELECT ${columns} FROM json_populate_recordset(NULL::${name}, $1::json)`,
      rows,
    });
  }
  const { roles } = (await pg.query<{ roles: number }>(UNCLEAN)).rows[0]!;
  return { pg, probe, seeds, roles };
}

/** Empties a returned database. False means it cannot be reused and must be closed. */
async function reset({ pg, probe, seeds, roles }: Pooled): Promise<boolean> {
  await pg.exec("ROLLBACK");
  const unclean = (
    await pg.query<{ changes: number; roles: number; large_objects: number }>(
      UNCLEAN,
    )
  ).rows[0]!;
  if (unclean.changes || unclean.large_objects || unclean.roles !== roles)
    return false;
  const filled = [
    ...new Set([
      ...(probe
        ? (await pg.query<{ name: string }>(probe)).rows.map((row) => row.name)
        : []),
      ...seeds.map((seed) => seed.table),
    ]),
  ];
  if (filled.length) {
    // Replica mode skips foreign-key and user triggers, so the order of deletes is free
    // and nothing fires.
    await pg.exec(
      `SET session_replication_role = replica; ${filled
        .map((name) => `DELETE FROM ${name};`)
        .join(" ")}`,
    );
    // Without this, later rows can land in space the deleted ones left, and an unordered
    // SELECT then returns them in a different order than a fresh database would. Vacuum
    // gives an emptied table back all its pages; anything else is not reused.
    await pg.exec(`VACUUM ${filled.join(", ")}`);
    const { size } = (
      await pg.query<{ size: number }>(
        `SELECT coalesce(sum(pg_relation_size(name::regclass)), 0)::int AS size
           FROM unnest($1::text[]) AS name`,
        [filled],
      )
    ).rows[0]!;
    if (size) return false;
    for (const seed of seeds) await pg.query(seed.insert, [seed.rows]);
  }
  // Every sequence, since one moved with setval(..., false) reports no last value.
  await pg.query(
    `SELECT setval(format('%I.%I', schemaname, sequencename)::regclass, start_value, false)
       FROM pg_sequences`,
  );
  // Settings, prepared statements, SQL-level listeners, advisory locks and temporary
  // tables, and session_replication_role with them.
  await pg.exec("DISCARD ALL");
  // PGlite sets this for its session at start; DISCARD ALL returns it to the server default.
  await pg.exec("SET search_path TO public");
  return true;
}

/**
 * A handle that behaves like its own database: once closed, it refuses further calls.
 * Values that are not methods, such as an extension's namespace, are passed through as
 * they are and are not covered by that.
 */
function lease(key: string, entry: Pooled): PGlite {
  let closed = false;
  // PGlite keeps listener callbacks on the instance, where no SQL reaches them.
  const unsubscribe: (() => unknown)[] = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    const reusable = await (async () => {
      await entry.pg.exec("ROLLBACK");
      for (const stop of unsubscribe) await stop();
      return reset(entry);
    })().catch(() => false);
    if (reusable) {
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
      return (...args: unknown[]) => {
        if (closed) return Promise.reject(new Error("PGlite is closed"));
        const result: unknown = value.apply(target, args);
        if (property === "onNotification" && typeof result === "function")
          unsubscribe.push(result as () => unknown);
        if (property === "listen" && result instanceof Promise)
          return result.then((stop: unknown) => {
            if (typeof stop === "function")
              unsubscribe.push(stop as () => unknown);
            return stop;
          });
        return result;
      };
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
