// The Store on Postgres: the same domain code as SQLite's (sqlite/store.ts storeOver) over a Postgres connection
// (connection.ts) in the store's own schema (default "agentrun"). The server sets the schema up (migrate.ts) and holds the
// owner lock, one server per schema; runners are many, set nothing up, and refuse a schema version they do not know.
import { SchemaVersionUnknown, type Store, type StoreRole } from "../store.js";
import { storeOver } from "../sqlite/store.js";
import { PgConnection, SCHEMA_NAME } from "./connection.js";
import { migrate, migrationsIn, placeOf, versionOf } from "./migrate.js";

/** The schema a store is in when none is named. */
export const DEFAULT_SCHEMA = "agentrun";

/** How far a runner's clock may be from the database's before it says so at its start (ms). Leases are 30 s, so a gap this
 *  size changes nothing; one far past it would make a runner's claims run out early or late. */
export const CLOCK_WARN_MS = 2_000;

/** Which store this is, as two opens of the same data agree on it: "postgres:" and the URL's host (and port), database and
 *  the schema, read from the parsed URL, never its user, password or query. */
export function postgresWhere(url: string, schema: string): string {
  const parsed = new URL(url);
  return `postgres:${parsed.host}/${decodeURIComponent(parsed.pathname.replace(/^\//, ""))}/${schema}`;
}

export interface PostgresStoreOptions {
  /** postgres:// or postgresql:// URL. Never printed: it may carry a password. */
  readonly url: string;
  /** The store's own schema (a lower-case name), "agentrun" by default. */
  readonly schema?: string;
  /** Who opens it (StoreRole): the server sets the schema up and holds the owner lock; a runner only checks the version. */
  readonly role?: StoreRole;
  /** The store's clock, in ms (Date.now): claimed_until and every row's time, as on SQLite. */
  readonly now?: () => number;
  /** How long a statement waits for another writer's lock before StoreBusy. */
  readonly busyTimeoutMs?: number;
  /** Most connections the store holds at once. */
  readonly poolSize?: number;
  /** Told, at a runner's open, when its clock is more than CLOCK_WARN_MS from the database's. */
  readonly warn?: (message: string) => void;
}

/** Opens the store in `schema` on the Postgres at `url`. As the server (the default): takes the owner lock (StoreOwned when
 *  another server holds the schema) and applies the pending migrations. As a runner: sets nothing up, and warns when its
 *  clock is far from the database's. Either refuses a schema version this build does not know (SchemaVersionUnknown), a
 *  runner also a schema not set up yet. */
export async function openPostgresStore(options: PostgresStoreOptions): Promise<Store> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_NAME.test(schema)) throw new TypeError(`the store's schema is a lower-case name of letters, digits and underscores, not ${JSON.stringify(schema)}`);
  const role = options.role ?? "server";
  const now = options.now ?? Date.now;
  const migrations = migrationsIn();
  const known = migrations.at(-1)!.version;
  const connection = await PgConnection.open({
    url: options.url, schema, owner: role === "server",
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.poolSize === undefined ? {} : { poolSize: options.poolSize }),
  });
  try {
    const found = await connection.withClient((client) => (role === "server" ? migrate(client, schema, now(), migrations) : versionOf(client, schema)));
    if (found !== known) throw new SchemaVersionUnknown(placeOf(schema), found, known);
    if (role === "runner" && options.warn) {
      const gap = now() - (await connection.clock());
      if (Math.abs(gap) > CLOCK_WARN_MS) {
        options.warn(`this runner's clock is ${Math.round(gap / 100) / 10} s ${gap > 0 ? "ahead of" : "behind"} the store's database: claims run on the runners' clocks, so keep them in sync (NTP)`);
      }
    }
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
  return storeOver(connection, now, postgresWhere(options.url, schema));
}
