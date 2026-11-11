// Which store the store's tests run on: SQLite by default, Postgres when AGENTRUN_TEST_PG_URL is set (a local one:
// `npm run test:pg:up`, test/pg/compose.yaml). On Postgres every store a test opens is in a schema of its own, made by
// the server's migrations and dropped after the test; a run of this file that crashed leaves schemas behind, and the
// next run of the same file sweeps them first. `raw` reads and writes a store's rows directly, on either database, with
// the same `?` statements.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PG_URL = process.env.AGENTRUN_TEST_PG_URL || undefined;
/** Whether this run's stores are on Postgres. */
export const onPostgres = PG_URL !== undefined;

/** A test's options that skip it on Postgres, saying which SQLite-only thing it tests. */
export const sqliteOnly = (what) => ({ skip: onPostgres ? `SQLite only: ${what}` : false });
/** node:test's `test` for a file of the SQLite adapter's own tests (its worker, its file, its locks): each of them skipped
 *  on Postgres, saying `what`. */
export function sqliteAdapterTests(test, what) {
  if (!onPostgres) return test;
  const skip = `SQLite only: ${what}`;
  const skipped = (name, options, fn) => (typeof options === "function" ? test(name, { skip }, options) : test(name, { ...options, skip }, fn));
  // node:test's forms too (a file's test.skip, test.todo, test.only), each skipped the same way: a file that calls one
  // must load on Postgres, never fail as a whole.
  return Object.assign(skipped, { skip: skipped, todo: skipped, only: skipped });
}
/** A test's options that skip it on SQLite (a Postgres adapter test). */
export const postgresOnly = (what) => ({ skip: onPostgres ? false : `Postgres only (AGENTRUN_TEST_PG_URL): ${what}` });

const pg = onPostgres ? (await import("pg")).default : undefined;
const { numberParams } = onPostgres ? await import("../dist/store/postgres/connection.js") : {};

/** This test file's tag in its schemas' names: the same for every run of the file, so a later run sweeps an earlier one's
 *  (a process no longer running; sweep). */
const fileTag = createHash("sha256").update(basename(process.argv[1] ?? "unknown")).digest("hex").slice(0, 10);
/** This file's tag, as its schemas' names carry it (a test of the sweep makes such names). */
export const schemaTag = fileTag;
let made = 0;
let swept;

/** int8 as a number, as the store reads it. */
const types = onPostgres ? { getTypeParser: (oid, format) => (oid === 20 ? Number : pg.types.getTypeParser(oid, format)) } : undefined;

/** A client of its own on the test database, in `schema` when one is named. */
export async function client(schema) {
  // Named after its schema, so the schema's drop ends it first (a test that failed with its transaction open).
  const c = new pg.Client({ connectionString: PG_URL, types, application_name: schema ? `agentrun-test:${schema}` : "agentrun-test", ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  c.on("error", () => undefined);
  await c.connect();
  return c;
}

/** Whether process `pid` on this host is still running: its schemas are in use (another run of the same file at once). */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Drops the schemas an earlier run of this file left (once per process): only those of a process no longer running, never
 *  those of another run of the file going on at the same time. Each schema's name carries its process's pid. */
function sweep() {
  swept ??= (async () => {
    const c = await client();
    try {
      const left = await c.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE $1", [`t\\_${fileTag}\\_%`]);
      for (const { nspname } of left.rows) {
        const pid = Number(new RegExp(`^t_${fileTag}_(\\d+)_\\d+$`).exec(nspname)?.[1]);
        if (Number.isSafeInteger(pid) && pid !== process.pid && !running(pid)) await c.query(`DROP SCHEMA IF EXISTS ${nspname} CASCADE`);
      }
    } finally {
      await c.end();
    }
  })();
  return swept;
}

/** A new schema name for one store of this file (Postgres). */
export async function freshSchema() {
  await sweep();
  return `t_${fileTag}_${process.pid}_${++made}`;
}

/** Drops `schema` and everything in it, ending first any test client of it still holding a transaction open. */
export async function dropSchema(schema) {
  const c = await client();
  try {
    await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()", [`agentrun-test:${schema}`]);
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await c.end();
  }
}

/** A store's place as a test passes it around: SQLite's file path, or "pg:<schema>". */
export const schemaOf = (place) => (typeof place === "string" && place.startsWith("pg:") ? place.slice(3) : undefined);

/** Everything the store at `place` holds at rest, as [where, bytes]: on SQLite its file (required: an unreadable file
 *  fails, never passes having read nothing) and the -wal and -shm beside it when they are there (a fresh write sits in
 *  the WAL first); on Postgres every value of every column of every table in its schema (text and JSON as their text,
 *  bytea as its bytes, the rest as their text). A secret is at rest in the store when one of them holds its bytes. */
export async function storeAtRest(place) {
  const schema = schemaOf(place);
  if (schema === undefined) {
    const { readFileSync } = await import("node:fs");
    const found = [[place, readFileSync(place)]];
    for (const side of [`${place}-wal`, `${place}-shm`]) {
      try {
        found.push([side, readFileSync(side)]);
      } catch {}
    }
    return found;
  }
  const c = await client(schema);
  try {
    const tables = (await c.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1", [schema])).rows.map((row) => row.name);
    if (tables.length === 0) throw new Error(`no tables in the schema ${schema}: nothing was read`);
    const found = [];
    for (const table of tables) {
      for (const [index, row] of (await c.query(`SELECT * FROM ${table}`)).rows.entries()) {
        for (const [column, value] of Object.entries(row)) {
          if (value === null || value === undefined) continue;
          found.push([`${table}[${index}].${column}`, Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : String(value), "utf8")]);
        }
      }
    }
    return found;
  } finally {
    await c.end();
  }
}

/** Direct access to a store's rows at `place` (raw SQL with `?` parameters, on either database): run (its changes), get,
 *  all, exec (statements with no parameters), close. Bytes read back as Uint8Array on both. */
export async function raw(place, { readOnly = false } = {}) {
  const schema = schemaOf(place);
  if (schema === undefined) {
    const db = new DatabaseSync(place, { readOnly, timeout: 5_000 });
    return {
      kind: "sqlite",
      run: async (sql, ...params) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
      get: async (sql, ...params) => {
        const row = db.prepare(sql).get(...params);
        return row === undefined ? undefined : { ...row };
      },
      all: async (sql, ...params) => db.prepare(sql).all(...params).map((row) => ({ ...row })),
      exec: async (sql) => void db.exec(sql),
      close: async () => db.close(),
    };
  }
  const c = await client(schema);
  // Rows as SQLite's raw reads give them: bytes as a plain Uint8Array (ints are numbers already: client()'s parser).
  const plain = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? new Uint8Array(value) : value]));
  const query = (sql, params) => c.query(numberParams(sql), params.map((value) => (value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value)));
  return {
    kind: "postgres",
    client: c,
    run: async (sql, ...params) => ({ changes: (await query(sql, params)).rowCount ?? 0 }),
    get: async (sql, ...params) => {
      const row = (await query(sql, params)).rows[0];
      return row === undefined ? undefined : plain(row);
    },
    all: async (sql, ...params) => (await query(sql, params)).rows.map(plain),
    exec: async (sql) => void (await c.query(sql)),
    close: async () => c.end(),
  };
}
