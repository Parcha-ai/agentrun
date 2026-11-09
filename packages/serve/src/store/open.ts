// The one store opener the server and the runner both go through: Postgres when AGENTRUN_STORE_URL is a postgres:// or
// postgresql:// URL (in the schema AGENTRUN_STORE_SCHEMA names, "agentrun" by default), else SQLite in the data
// directory, as before. Nothing else reads those two variables.
import type { Store, StoreRole } from "./store.js";
import { openSqliteStore, STORE_FILE } from "./sqlite/store.js";
import { DEFAULT_SCHEMA, openPostgresStore } from "./postgres/store.js";
import { join } from "node:path";

/** Where a store is: SQLite's file in a data directory, or a schema on a Postgres. */
export type StoreTarget = { readonly kind: "sqlite"; readonly dataDir: string } | { readonly kind: "postgres"; readonly url: string; readonly schema: string };

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

/** The store `env` names: Postgres for a postgres:// or postgresql:// AGENTRUN_STORE_URL, else SQLite in `dataDir`. Any
 *  other AGENTRUN_STORE_URL is refused (never read as SQLite by mistake). */
export function storeTarget(dataDir: string, env: NodeJS.ProcessEnv = process.env): StoreTarget {
  const url = env.AGENTRUN_STORE_URL?.trim();
  if (!url) return { kind: "sqlite", dataDir };
  if (!POSTGRES_URL.test(url)) throw new TypeError("AGENTRUN_STORE_URL is a postgres:// or postgresql:// URL, or unset for the SQLite store in the data directory");
  return { kind: "postgres", url, schema: env.AGENTRUN_STORE_SCHEMA?.trim() || DEFAULT_SCHEMA };
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
  /** The environment AGENTRUN_STORE_URL and AGENTRUN_STORE_SCHEMA are read from (process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /** Told what a person should know at the open (a runner's clock far from Postgres's). */
  readonly warn?: (message: string) => void;
}

/** Opens the store `options.env` names (storeTarget): the server's and the runner's one way in. */
export function openStore({ dataDir, role = "server", now, env = process.env, warn }: OpenStoreOptions): Promise<Store> {
  const target = storeTarget(dataDir, env);
  if (target.kind === "sqlite") return openSqliteStore({ dataDir, role, ...(now ? { now } : {}) });
  return openPostgresStore({ url: target.url, schema: target.schema, role, ...(now ? { now } : {}), ...(warn ? { warn } : {}) });
}
