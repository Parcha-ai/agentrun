// `agentrun-serve store-schema [--data DIR]`: the live store's schema version and runner floor, beside the version this
// build knows, as one line of JSON, for a deploy pipeline's skew guard. It reads, and nothing else: no owner lock, no
// migration, no schema made, no runner presence. The store is the one the server and a runner open (store/open.ts:
// Postgres when AGENTRUN_STORE_URL names one, in AGENTRUN_STORE_SCHEMA; else SQLite in --data), and its URL is never
// printed. Exit 0 once read (whatever it says), 1 when the store could not be read, 2 for bad arguments. `--build` reads no
// store: it prints the versions this build knows, `{"build":{"postgres":N,"sqlite":M}}`, for a label an image build stamps.
//
// What the line says, run with the build about to be deployed:
//   schema       the store's version now (null: none set up yet)
//   runnerFloor  the oldest version a runner's build must know to run on it (null: none set up yet)
//   build        the version this build knows
//   server       what this build's server does at its start: "sets up", "opens", "migrates", or "refuses" (the store is
//                ahead of this build: a rollback across a migration, which the skew guard refuses)
//   runner       what this build's runner does: "opens", "waits" (for the server to migrate), or "refused" (none set up,
//                or the floor is above this build)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { migrationsIn, runnerFloorOf, runnerOn, type SchemaState } from "./postgres/migrate.js";
import { STORE_CONNECT_TIMEOUT_MS } from "./postgres/connection.js";
import { storePlace, storeTarget, type StoreTarget } from "./open.js";
import { SCHEMA_VERSION } from "./schema.js";
import { STORE_FILE } from "./sqlite/store.js";

/** The line `agentrun-serve store-schema` prints. */
export interface StoreSchemaReport {
  readonly store: StoreTarget["kind"];
  /** Where the store is, in words: the SQLite file, or the Postgres schema (never its URL). */
  readonly where: string;
  readonly schema: number | null;
  readonly runnerFloor: number | null;
  readonly build: number;
  readonly server: "sets up" | "opens" | "migrates" | "refuses";
  readonly runner: "opens" | "waits" | "refused";
}

/** The SQLite store's versions the server upgrades in place (sqlite/store.ts openSqliteStore). */
const SQLITE_UPGRADES = new Set([11, 12, 13]);

/** What a build that knows `build` does with a store at `state`, on `kind`. */
export function storeSchemaReport(target: StoreTarget, state: SchemaState, build: number): StoreSchemaReport {
  const { version } = state;
  const server: StoreSchemaReport["server"] =
    version === null ? "sets up" : version === build ? "opens" : version > build ? "refuses" : target.kind === "postgres" || SQLITE_UPGRADES.has(version) ? "migrates" : "refuses";
  // A SQLite runner opens only its own version: its floor is the version (sqlite/store.ts schemaState).
  const runner = runnerOn(target.kind === "sqlite" ? { version, runnerFloor: version } : state, build);
  return { store: target.kind, where: storePlace(target), schema: version, runnerFloor: state.runnerFloor, build, server, runner };
}

/** The SQLite store's version in `dataDir`, read-only: null when there is no file, or no schema in it. */
function sqliteState(dataDir: string): SchemaState {
  const file = join(dataDir, STORE_FILE);
  if (!existsSync(file)) return { version: null, runnerFloor: null };
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    const table = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'store_meta'").get();
    const row = table ? (db.prepare("SELECT schema_version FROM store_meta WHERE singleton = 1").get() as { schema_version?: number } | undefined) : undefined;
    const version = row?.schema_version ?? null;
    return { version, runnerFloor: version };
  } finally {
    db.close();
  }
}

/** The Postgres schema's version and floor, on a connection of its own that sets nothing and is ended at once. */
async function postgresState(url: string, schema: string): Promise<SchemaState> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: STORE_CONNECT_TIMEOUT_MS, application_name: "agentrun-store-schema" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await runnerFloorOf(client, schema);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Reads the store `dataDir` and `env` name (and the URL, this process's AGENTRUN_STORE_URL secret unless given). */
export async function readStoreSchema(dataDir: string, env: NodeJS.ProcessEnv = process.env, url?: string): Promise<StoreSchemaReport> {
  const target = url === undefined ? storeTarget(dataDir, env) : storeTarget(dataDir, env, url);
  if (target.kind === "sqlite") return storeSchemaReport(target, sqliteState(dataDir), SCHEMA_VERSION);
  return storeSchemaReport(target, await postgresState(target.url, target.schema), migrationsIn().at(-1)!.version);
}

/** The versions this build knows, read from its own files, with no store: `postgres`, its newest migration; `sqlite`,
 *  SCHEMA_VERSION. */
export const buildSchema = (): { readonly postgres: number; readonly sqlite: number } => ({ postgres: migrationsIn().at(-1)!.version, sqlite: SCHEMA_VERSION });

/** `agentrun-serve store-schema [--data DIR]`, or `--build` (this build's versions, no store read): the exit code (the
 *  file's head). */
export async function storeSchemaMain(argv: readonly string[], defaultDataDir: string, usage: string): Promise<number> {
  let data: string | undefined;
  let build: boolean | undefined;
  try {
    ({ data, build } = parseArgs({ args: [...argv], options: { data: { type: "string" }, build: { type: "boolean" } } }).values);
  } catch (error) {
    console.error(`agentrun-serve store-schema: ${(error as Error).message}\n\n${usage}`);
    return 2;
  }
  if (build) {
    console.log(JSON.stringify({ build: buildSchema() }));
    return 0;
  }
  try {
    console.log(JSON.stringify(await readStoreSchema(data ?? defaultDataDir)));
    return 0;
  } catch (error) {
    // Never the URL: a connection error's own words name the host at most.
    console.error(`agentrun-serve store-schema: the store could not be read: ${(error as Error)?.message ?? String(error)}`);
    return 1;
  }
}
