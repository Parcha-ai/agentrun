// The store's Postgres schema, owned by AgentRun: versioned SQL files (migrations/NNNN_name.sql), applied in order by the
// server only, all pending ones in one transaction under an advisory lock (two servers starting at once apply each file
// once), each recorded in <schema>.schema_migrations with its file's SHA-256. An applied file is never edited: a server
// that finds one changed refuses to start, naming it. A runner applies nothing; it reads the version and refuses one it does
// not know (SchemaVersionUnknown), as on SQLite.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type pg from "pg";
import { SchemaVersionUnknown } from "../store.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** The migrations shipped beside this module (dist/store/postgres/migrations), in version order, numbered 1, 2, 3 … with
 *  no gap. */
export function migrationsIn(dir: URL = new URL("./migrations/", import.meta.url)): Migration[] {
  const found = readdirSync(dir)
    .map((file) => FILE.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => {
      const sql = readFileSync(new URL(match[0], dir), "utf8");
      return { version: Number(match[1]), name: match[2]!, sql, sha256: createHash("sha256").update(sql).digest("hex") };
    })
    .sort((a, b) => a.version - b.version);
  found.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`the store's Postgres migrations skip or repeat a version at ${String(migration.version).padStart(4, "0")}_${migration.name}.sql`);
  });
  if (found.length === 0) throw new Error("the store's Postgres migrations are missing from this build");
  return found;
}

/** Where a store in `schema` is, in words for an error: the schema, never the URL (it may carry a password). */
export const placeOf = (schema: string): string => `the Postgres schema ${schema}`;

const isMissing = (error: unknown): boolean => {
  const code = (error as { code?: string })?.code;
  // 42P01: no schema_migrations table; 3F000: no such schema.
  return code === "42P01" || code === "3F000";
};

/** The schema's version: the highest migration applied, or null when none is (no schema, or not set up yet). */
export async function versionOf(client: Pick<pg.ClientBase, "query">, schema: string): Promise<number | null> {
  try {
    const result = await client.query(`SELECT max(version) AS version FROM ${schema}.schema_migrations`);
    const version = result.rows[0]?.version;
    return version === null || version === undefined ? null : Number(version);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Removes the store in `schema` and everything in it, on its own connection: for a scratch store's cleanup (the conformance
 *  harness's world, the tests'), never a server's path. */
export async function dropPostgresSchema(url: string, schema: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new TypeError(`not a store schema name: ${JSON.stringify(schema)}`);
  const { default: postgres } = await import("pg");
  const client = new postgres.Client({ connectionString: url });
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Applies every pending migration to `schema`, in one transaction under the schema's migration lock, at `at` (ms). A
 *  schema at a version this build does not know is refused (SchemaVersionUnknown), and so is an applied file whose text
 *  changed since. Answers the version it leaves. */
export async function migrate(client: pg.ClientBase, schema: string, at: number, migrations: readonly Migration[] = migrationsIn()): Promise<number> {
  const known = migrations.at(-1)!.version;
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('migrate'))", [schema]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at BIGINT NOT NULL)");
    const applied = (await client.query("SELECT version, name, sha256 FROM schema_migrations ORDER BY version")).rows as { version: string | number; name: string; sha256: string }[];
    const top = applied.length === 0 ? null : Number(applied.at(-1)!.version);
    if (top !== null && top > known) throw new SchemaVersionUnknown(placeOf(schema), top, known);
    for (const row of applied) {
      const mine = migrations[Number(row.version) - 1];
      if (mine && mine.sha256 !== row.sha256) {
        throw new Error(`${placeOf(schema)} applied migration ${String(mine.version).padStart(4, "0")}_${mine.name}.sql with other text than this build's: an applied migration is never edited, a change is a new file`);
      }
    }
    for (const migration of migrations.slice(top ?? 0)) {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES ($1, $2, $3, $4)", [migration.version, migration.name, migration.sha256, at]);
    }
    await client.query("COMMIT");
    return known;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
