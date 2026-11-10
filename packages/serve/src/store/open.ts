// The one store opener the server and the runner both go through: Postgres when AGENTRUN_STORE_URL is a postgres:// or
// postgresql:// URL (in the schema AGENTRUN_STORE_SCHEMA names, "agentrun" by default), else SQLite in the data
// directory, as before. The URL may hold the database's password, so it is a secret: the launcher hands it over its pipe
// and takes it out of the environment (agentrun-serve's list), and it is read here by name (secrets.ts secret), never
// from an environment. Nothing else reads those two variables.
import type { Store, StoreOwned, StoreRole } from "./store.js";
import { openSqliteStore, STORE_FILE } from "./sqlite/store.js";
import { DEFAULT_SCHEMA, openPostgresStore } from "./postgres/store.js";
import { secret } from "../secrets.js";
import { join } from "node:path";

/** Where a store is: SQLite's file in a data directory, or a schema on a Postgres. */
export type StoreTarget = { readonly kind: "sqlite"; readonly dataDir: string } | { readonly kind: "postgres"; readonly url: string; readonly schema: string };

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

/** This process's store URL: the AGENTRUN_STORE_URL secret as the launcher handed it over (secrets.ts secret). */
const storeUrl = (): string | undefined => secret("AGENTRUN_STORE_URL");

/** The store named by `url` (this process's AGENTRUN_STORE_URL secret by default) and `env`'s AGENTRUN_STORE_SCHEMA:
 *  Postgres for a postgres:// or postgresql:// URL, else SQLite in `dataDir`. Any other URL is refused (never read as
 *  SQLite by mistake). */
export function storeTarget(dataDir: string, env: NodeJS.ProcessEnv = process.env, url: string | undefined = storeUrl()): StoreTarget {
  const named = url?.trim();
  if (!named) return { kind: "sqlite", dataDir };
  if (!POSTGRES_URL.test(named)) throw new TypeError("AGENTRUN_STORE_URL is a postgres:// or postgresql:// URL, or unset for the SQLite store in the data directory");
  return { kind: "postgres", url: named, schema: env.AGENTRUN_STORE_SCHEMA?.trim() || DEFAULT_SCHEMA };
}

/** Where `target` is, in words for a person: the store's file, or the Postgres schema (never its URL, which may carry a
 *  password). */
export function storePlace(target: StoreTarget): string {
  return target.kind === "sqlite" ? join(target.dataDir, STORE_FILE) : `the Postgres schema ${target.schema}`;
}

export interface OpenStoreOptions {
  /** The data directory (the server's and every runner's): the SQLite store's place, when no Postgres is named. */
  readonly dataDir: string;
  /** Who opens it (StoreRole): the server sets the store up; a runner refuses a schema version it does not know. */
  readonly role?: StoreRole;
  /** The store's clock, in ms (Date.now). */
  readonly now?: () => number;
  /** The store's URL, for a caller that holds it itself (a test, the conformance harness). By default this process's
   *  AGENTRUN_STORE_URL secret (secrets.ts secret: as the launcher handed it over), never an environment's. */
  readonly url?: string;
  /** The environment AGENTRUN_STORE_SCHEMA is read from (process.env). The schema's name is no secret. */
  readonly env?: NodeJS.ProcessEnv;
  /** Told what a person should know at the open (a runner's clock far from Postgres's; a server waiting for another to
   *  let the Postgres schema go). */
  readonly warn?: (message: string) => void;
  /** A server's, on Postgres: told when its owner lock is lost for good (PostgresStoreOptions.onOwnerLost). */
  readonly onOwnerLost?: (error: StoreOwned) => void;
}

/** Opens the store `options` names (storeTarget): the server's and the runner's one way in. */
export function openStore({ dataDir, role = "server", now, url, env = process.env, warn, onOwnerLost }: OpenStoreOptions): Promise<Store> {
  const target = storeTarget(dataDir, env, url ?? storeUrl());
  if (target.kind === "sqlite") return openSqliteStore({ dataDir, role, ...(now ? { now } : {}) });
  return openPostgresStore({ url: target.url, schema: target.schema, role, ...(now ? { now } : {}), ...(warn ? { warn } : {}), ...(onOwnerLost ? { onOwnerLost } : {}) });
}
