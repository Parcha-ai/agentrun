// The Store on Postgres: the same domain code as SQLite's (sqlite/store.ts storeOver) over a Postgres connection
// (connection.ts) in the store's own schema (default "agentrun"). The server sets the schema up (migrate.ts) and holds the
// owner lock, one server per schema; runners are many, set nothing up, and refuse a schema version they do not know.
import { SchemaVersionUnknown, type Store, type StoreOwned, type StoreRole } from "../store.js";
import { storeOver } from "../sqlite/store.js";
import { PgConnection, SCHEMA_NAME } from "./connection.js";
import { migrate, migrationsIn, placeOf, versionOf } from "./migrate.js";

/** The schema a store is in when none is named. */
export const DEFAULT_SCHEMA = "agentrun";

/** How far a runner's clock may be from the database's before it says so at its start (ms). Leases are 30 s, so a gap this
 *  size changes nothing; one far past it would make a runner's claims run out early or late. */
export const CLOCK_WARN_MS = 2_000;

export { postgresWhere } from "./connection.js";

export interface PostgresStoreOptions {
  /** postgres:// or postgresql:// URL. Never printed: it may carry a password. */
  readonly url: string;
  /** The store's own schema (a lower-case name), "agentrun" by default. */
  readonly schema?: string;
  /** Who opens it (StoreRole): the server sets the schema up and holds the owner lock; a runner only checks the version. */
  readonly role?: StoreRole;
  /** This process's clock, in ms (Date.now): the times rows are stamped with (a run's start and end, a command's). Every
   *  deadline (a claim's lease, a refresh lease, a run's wake and backoff, the sign-in settle window) is stamped and judged
   *  on the database's clock instead, one clock for every store process sharing the database. */
  readonly now?: () => number;
  /** For tests: a clock moved by hand, which then also runs the deadlines in place of the database's (bound as SQLite binds
   *  its store clock), so a test can jump past a lease. Never set outside a test. */
  readonly testClock?: () => number;
  /** How long a statement waits for another writer's lock before StoreBusy. */
  readonly busyTimeoutMs?: number;
  /** Most connections the store holds at once (10 by default). */
  readonly poolSize?: number;
  /** How long getting a connection may take, in ms: a new one's connect and startup, or a wait for one of the pool's to
   *  come free (STORE_CONNECT_TIMEOUT_MS, 4 s, by default). Past it the call, or the open, is refused (StoreDeadline,
   *  naming the database's host, database and schema, never the URL), never left hanging. */
  readonly connectTimeoutMs?: number;
  /** Told, at a runner's open, when its clock is more than CLOCK_WARN_MS from the database's; at a server's, when it waits
   *  for another server to let the schema go. */
  readonly warn?: (message: string) => void;
  /** A server's: how long it waits for the owner lock another server holds, at its open and to take its own back after its
   *  lock's connection is lost (OWNER_WAIT_MS, 2 min, by default; 0 refuses at once with StoreOwned). */
  readonly ownerWaitMs?: number;
  /** A server's: told when its owner lock is lost for good (another server took the schema, or it could not be taken back
   *  within ownerWaitMs). Every call is refused from then: the process should exit non-zero, so its platform restarts it. */
  readonly onOwnerLost?: (error: StoreOwned) => void;
}

/** Opens the store in `schema` on the Postgres at `url`. As the server (the default): takes the owner lock (StoreOwned when
 *  another server holds the schema) and applies the pending migrations. As a runner: sets nothing up, and warns when its
 *  clock is far from the database's. Either refuses a schema version this build does not know (SchemaVersionUnknown), a
 *  runner also a schema not set up yet. */
export async function openPostgresStore(options: PostgresStoreOptions): Promise<Store> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_NAME.test(schema)) throw new TypeError(`the store's schema is a lower-case name of letters, digits and underscores, not ${JSON.stringify(schema)}`);
  const role = options.role ?? "server";
  const now = options.testClock ?? options.now ?? Date.now;
  const migrations = migrationsIn();
  const known = migrations.at(-1)!.version;
  const connection = await PgConnection.open({
    url: options.url, schema, owner: role === "server", testClock: options.testClock !== undefined,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.poolSize === undefined ? {} : { poolSize: options.poolSize }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.ownerWaitMs === undefined ? {} : { ownerWaitMs: options.ownerWaitMs }),
    ...(options.warn ? { onOwnerWait: options.warn } : {}),
    ...(options.onOwnerLost ? { onOwnerLost: options.onOwnerLost } : {}),
  });
  try {
    const found = await connection.withClient((client) => (role === "server" ? migrate(client, schema, now(), migrations) : versionOf(client, schema)));
    if (found !== known) throw new SchemaVersionUnknown(placeOf(schema), found, known);
    if (role === "runner" && options.warn) {
      const gap = now() - (await connection.clock());
      if (Math.abs(gap) > CLOCK_WARN_MS) {
        options.warn(`this runner's clock is ${Math.round(gap / 100) / 10} s ${gap > 0 ? "ahead of" : "behind"} the store's database: claims run on the database's clock, but the times this runner stamps (a run's start and end) are off by as much, so keep the clocks in sync (NTP)`);
      }
    }
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
  return storeOver(connection, now);
}
