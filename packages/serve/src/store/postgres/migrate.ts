// The store's Postgres schema, owned by AgentRun: versioned SQL files (migrations/NNNN_name.sql), applied in order by the
// server only, all pending ones in one transaction under an advisory lock (two servers starting at once apply each file
// once), each recorded in <schema>.schema_migrations with its file's SHA-256. An applied file is never edited: a server
// that finds one changed refuses to start, naming it. A runner applies nothing: it reads the version and the runner floor
// (runnerFloorOf), waits for a server on a schema behind its build (StoreAwaitsServer), and runs on one ahead of it while
// the floor is at most the version its build knows; past the floor it is refused (RunnerBelowFloor).
//
// Migrations are additive by default: a runner of an earlier build keeps running on the schema one leaves. A migration
// that an earlier build's runner cannot run beside (it drops or renames something, changes a column's type, makes a
// column NOT NULL, adds one NOT NULL without a default) says so on a line of its leading comment, RUNNERS_BREAKING, and
// the server records it (schema_migrations.runners_breaking): the floor rises to its version. migration-lint.ts finds such
// statements, and a test fails a migration past LAST_UNMARKED that has one and no header.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type pg from "pg";
import { RunnerBelowFloor, SchemaVersionUnknown } from "../store.js";
import { SCHEMA_NAME } from "./connection.js";

/** `schema` as SQL takes it here, unquoted: refused (TypeError) unless it is a store schema name (SCHEMA_NAME), before any
 *  statement is sent. Every entry point checks it too; this is the last line, for a caller that comes here directly. */
function schemaName(schema: string): string {
  if (typeof schema !== "string" || !SCHEMA_NAME.test(schema)) throw new TypeError(`not a store schema name: ${JSON.stringify(schema)}`);
  return schema;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
  /** The migration's check (NNNN_name.check.sql beside it), run just before it: a query whose rows are the reasons the
   *  schema cannot take the migration yet, each in a `refusal` column, in words that name what holds it back and what to do.
   *  Not part of the file's hash: it runs only before the migration applies. */
  readonly check?: string;
  /** The file says RUNNERS_BREAKING in its leading comment: a runner of a build that does not know this version cannot run
   *  on the schema it leaves, so applying it raises the runner floor to its version. */
  readonly breaking: boolean;
}

/** The line of a migration's leading comment that marks it breaking for runners of earlier builds (Migration.breaking). */
export const RUNNERS_BREAKING = "-- runners: breaking";

/** The newest migration written before migrations said whether they break runners: none of 0001-0023 carries the header,
 *  and a runner of a build before the floor opened only the exact version it knew. Each one up to it counts as breaking,
 *  so the floor is never below it on a schema that has it. */
export const LAST_UNMARKED = 23;

/** Whether `sql`'s leading comment (its first lines, each a `--` comment or blank) holds RUNNERS_BREAKING. */
export function marksBreaking(sql: string): boolean {
  for (const line of sql.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    if (!text.startsWith("--")) return false;
    if (text === RUNNERS_BREAKING) return true;
  }
  return false;
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
      const checkFile = new URL(`${match[1]}_${match[2]}.check.sql`, dir);
      const check = existsSync(checkFile) ? readFileSync(checkFile, "utf8") : undefined;
      return { version: Number(match[1]), name: match[2]!, sql, sha256: createHash("sha256").update(sql).digest("hex"), breaking: marksBreaking(sql), ...(check === undefined ? {} : { check }) };
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
  schemaName(schema);
  try {
    const result = await client.query(`SELECT max(version) AS version FROM ${schema}.schema_migrations`);
    const version = result.rows[0]?.version;
    return version === null || version === undefined ? null : Number(version);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** A schema's version and its runner floor, as a runner and `agentrun-serve store-schema` read them. */
export interface SchemaState {
  /** The highest migration applied; null when none is (no schema, or not set up yet). */
  readonly version: number | null;
  /** The oldest schema version a runner's build must know to run on this schema: the highest migration applied that is
   *  breaking for runners (Migration.breaking), or LAST_UNMARKED and before; null when none is applied. */
  readonly runnerFloor: number | null;
}

/** `schema`'s version and runner floor (SchemaState), read without a lock or a write. A ledger an earlier server kept,
 *  with no runners_breaking column, has every version up to it unmarked: its floor is its version. */
export async function runnerFloorOf(client: Pick<pg.ClientBase, "query">, schema: string): Promise<SchemaState> {
  schemaName(schema);
  const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  try {
    const result = await client.query(`SELECT max(version) AS version, max(version) FILTER (WHERE runners_breaking OR version <= ${LAST_UNMARKED}) AS floor FROM ${schema}.schema_migrations`);
    return { version: number(result.rows[0]?.version), runnerFloor: number(result.rows[0]?.floor) };
  } catch (error) {
    if (isMissing(error)) return { version: null, runnerFloor: null };
    // 42703: undefined_column, a ledger from before the floor.
    if ((error as { code?: string })?.code !== "42703") throw error;
    const version = await versionOf(client, schema);
    return { version, runnerFloor: version };
  }
}

/** What a runner of a build that knows version `known` does on a schema at `state`: opens it, waits for its server to
 *  migrate it (behind), or is refused (none set up yet, or past the floor). */
export function runnerOn(state: SchemaState, known: number): "opens" | "waits" | "refused" {
  if (state.version === null) return "refused";
  if (state.version < known) return "waits";
  return (state.runnerFloor ?? state.version) <= known ? "opens" : "refused";
}

/** Refuses a runner of a build that knows `known` on `schema` at `state`, the way its open does: SchemaVersionUnknown when
 *  none is set up, StoreAwaitsServer's words left to the caller (behind), RunnerBelowFloor past the floor. */
export function refuseBelowFloor(schema: string, state: SchemaState, known: number): void {
  if (state.version !== null && state.version > known && (state.runnerFloor ?? state.version) > known) {
    throw new RunnerBelowFloor(placeOf(schema), state.version, known, state.runnerFloor ?? state.version);
  }
}

/** Removes the store in `schema` and everything in it, on its own connection: for a scratch store's cleanup (the conformance
 *  harness's world, the tests'), never a server's path. */
export async function dropPostgresSchema(url: string, schema: string): Promise<void> {
  schemaName(schema);
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

/** Makes `schema` (absent, under the migration lock). A role with no CREATE on the database is refused in words that say
 *  what to do: the schema made ahead of time, owned by this role, or CREATE granted. */
async function createSchema(client: pg.ClientBase, schema: string): Promise<void> {
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    // 42501: insufficient_privilege.
    if ((error as { code?: string })?.code !== "42501") throw error;
    throw new Error(`${placeOf(schema)} does not exist, and this role may not create it (no CREATE on the database): create the schema ahead of time, owned by this role, or grant this role CREATE on the database`, { cause: error });
  }
}

/** Applies every pending migration to `schema`, in one transaction under the schema's migration lock, at `at` (ms). A
 *  schema at a version this build does not know is refused (SchemaVersionUnknown), and so is an applied file whose text
 *  changed since. Answers the version it leaves. */
export async function migrate(client: pg.ClientBase, schema: string, at: number, migrations: readonly Migration[] = migrationsIn()): Promise<number> {
  schemaName(schema);
  const known = migrations.at(-1)!.version;
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('migrate'))", [schema]);
    // Made only when absent: Postgres checks CREATE on the database before IF NOT EXISTS, so a role that owns a schema an
    // administrator made ahead of time, with no CREATE on the database, could not start on it otherwise.
    const exists = (await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount !== 0;
    if (!exists) await createSchema(client, schema);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at BIGINT NOT NULL)");
    // Whether each applied migration raised the runner floor (runnerFloorOf). Added only where missing: an ALTER that finds
    // the column would still lock the ledger every runner reads its floor from, until this transaction ends.
    const marked = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'schema_migrations' AND column_name = 'runners_breaking'", [schema])).rowCount !== 0;
    if (!marked) await client.query("ALTER TABLE schema_migrations ADD COLUMN runners_breaking BOOLEAN NOT NULL DEFAULT false");
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
      if (migration.check !== undefined) {
        const refusals = (await client.query(migration.check)).rows.map((row: { refusal?: unknown }) => String(row.refusal));
        if (refusals.length > 0) throw new Error(`${placeOf(schema)} cannot take migration ${String(migration.version).padStart(4, "0")}_${migration.name}.sql, so nothing was applied: ${refusals.join("; ")}`);
      }
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version, name, sha256, applied_at, runners_breaking) VALUES ($1, $2, $3, $4, $5)", [migration.version, migration.name, migration.sha256, at, migration.breaking]);
    }
    await client.query("COMMIT");
    return known;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
