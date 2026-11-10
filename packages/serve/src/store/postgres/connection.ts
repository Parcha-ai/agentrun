// The store's connection on Postgres (sqlite/connection.ts StoreConnection): a pool of node-postgres clients, every one in
// the store's schema (search_path), its lock waits bounded (lock_timeout) and its commits durable (synchronous_commit on).
// Statements are the shared code's, with `?` parameters, numbered here. Postgres has many writers, so unlike SQLite's one
// queue, calls run side by side; what must not interleave locks (postgres/dialect.ts), and a fenced statement that changes
// no row rolls its transaction back with the typed error, as SQLite's worker does. A server's connection also holds the
// store's owner lock (one server per schema): a session advisory lock on a client of its own, held until close.
import pg from "pg";
import { cleanText } from "../dialect.js";
import { type ConstraintRule, Fenced, RunFinal, StoreBusy, StoreClosed, StoreConstraint, StoreDeadline, StoreOwned } from "../store.js";
import { DEFAULT_TRANSACTION_DEADLINE_MS, type SqliteValue, type Statement, type StatementResult, type StoreConnection, type TransactionOptions, type Tx } from "../sqlite/connection.js";
import type { Dialect } from "../dialect.js";
import { postgresDialect } from "./dialect.js";

/** Which store this is, as two opens of the same data agree on it (StoreConnection.where): "postgres:" and the URL's host
 *  (and port), database and the schema, read from the parsed URL, never its user, password or query. */
export function postgresWhere(url: string, schema: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // URL's own TypeError holds the whole input (its `input`), the password with it: refused in words of its own.
    throw new TypeError("the store's URL is not a valid Postgres URL (its text is not shown: it may hold a password)");
  }
  return `postgres:${parsed.host}/${decodeURIComponent(parsed.pathname.replace(/^\//, ""))}/${schema}`;
}

/** A schema name the store takes: a plain lower-case identifier, so it is never quoted, and never input in SQL. */
export const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface PgConnectionOptions {
  /** postgres:// or postgresql:// URL. Never printed: it may carry a password. */
  readonly url: string;
  readonly schema: string;
  /** Take the owner lock (a server): waited for while another server holds the schema (ownerWaitMs), StoreOwned past it. */
  readonly owner?: boolean;
  /** How long a server waits for the owner lock another server holds, at its open and to take its own back once its
   *  lock's connection is lost (OWNER_WAIT_MS by default; 0 refuses at once). */
  readonly ownerWaitMs?: number;
  /** Told once, in words, when the open waits for another server to let the schema go (a deploy's old server stopping). */
  readonly onOwnerWait?: (message: string) => void;
  /** Told when this server's owner lock is lost for good (another server took the schema, or it could not be taken back
   *  within ownerWaitMs): every call is refused from then, and the process should exit so its platform restarts it. */
  readonly onOwnerLost?: (error: StoreOwned) => void;
  /** Asked on the owner connection each time the lock is taken back: why the schema is not one this build serves (a newer
   *  server migrated it while the lock was not held), or undefined. A reason gives the lock up for good (onOwnerLost). */
  readonly ownerCheck?: (client: pg.Client) => Promise<string | undefined>;
  /** How long a statement waits for another writer's lock before StoreBusy. */
  readonly busyTimeoutMs?: number;
  /** Most clients open at once. */
  readonly poolSize?: number;
  /** Deadlines on the store's own (test) clock, bound as parameters, instead of the database's (postgresDialect). */
  readonly testClock?: boolean;
  /** How long getting a connection may take (STORE_CONNECT_TIMEOUT_MS by default): a new one's connect and startup, or a
   *  wait for one of the pool's to come free. Past it the call is refused (StoreDeadline, naming the database's place,
   *  never its URL), never left hanging on a database that does not answer. */
  readonly connectTimeoutMs?: number;
}

/** The default bound on getting a connection to the store's Postgres (PgConnectionOptions.connectTimeoutMs), in ms. Below
 *  the runner's stop margin (runner.ts: lease 30 s, renew every 10 s, stop margin 5 s; a claim is let go when no renew has
 *  landed within lease - margin = 25 s of the last one's send, so two renew ticks, at +10 s and +20 s, fall inside it): a
 *  renew that cannot get a connection gives up within 4 s, inside the 5 s margin, and the next tick tries again. A renew
 *  never waits for a client behind other work: it has the lease connection (TransactionOptions.lease), and the whole
 *  renew, connect to commit, is bounded from its call (LEASE_DEADLINE_MS), so one sent at +10 s whose connection went
 *  silent fails by +19 s and the +20 s tick renews on a fresh connection before +25 s. */
export const STORE_CONNECT_TIMEOUT_MS = 4_000;

/** pg's and pg-pool's words for a connection not had in time: a connect or startup that never finished, or no pool client
 *  free. */
const CONNECT_TIMEOUT = /timeout exceeded when trying to connect|timeout expired|Connection terminated due to connection timeout/i;

/** Whether `error`, or an error it was made from, is a connection not had in time. */
function connectTimedOut(error: unknown): boolean {
  for (let e = error as { message?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (CONNECT_TIMEOUT.test(String(e.message ?? ""))) return true;
  }
  return false;
}

/** A COMMIT is bounded by what is left of its transaction's deadline, never less than this (a commit sent at the deadline
 *  still gets an answer's time). Past it the connection is taken as silent and let go (destroyed); the commit's outcome is
 *  then unknown, and the caller is told so (Unanswered). STORE_WRITE_DEADLINE_MS's users keep 2 s spare for it. */
const COMMIT_FLOOR_MS = 1_000;
/** How long the ROLLBACK after a failed statement may go unanswered before its client is let go (destroyed) instead:
 *  nothing waits on its answer, and a destroyed session's transaction is rolled back by the database. */
const ROLLBACK_ANSWER_MS = 2_000;
/** A claim renew's bound, from its call (TransactionOptions.lease): its connect, its statements and its commit (with
 *  COMMIT_FLOOR_MS, 9 s in all), under the runner's renew interval (RUNNER_RENEW_EVERY_MS, 10 s), so a renew on a
 *  connection gone silent has failed before the next tick, which renews on a fresh connection instead of being skipped
 *  (STORE_CONNECT_TIMEOUT_MS). As long as fits: a renewMany of many claims on a loaded database still lands. */
export const LEASE_DEADLINE_MS = 8_000;
/** How long the database lets a transaction sit idle, past its own deadline, before ending its session: a client that
 *  vanished mid-transaction (a partition: no FIN reached the database) holds its row locks no longer than this. */
const IDLE_IN_TRANSACTION_SLACK_MS = 5_000;
/** TCP keepalives, on both ends: a peer that vanished without a word is found dead in about 25 s (10 s idle, then 3 probes
 *  5 s apart on the database's end; the OS default waits 2 h). */
const KEEPALIVE_IDLE_S = 10;

/** A statement the database never answered within its bound: its connection taken as silent and let go. For a COMMIT,
 *  whether it landed is unknown. */
export class Unanswered extends Error {
  constructor(what: string, ms: number) {
    super(`the store's Postgres did not answer ${what} within ${ms} ms: its connection is taken as silent and let go${what === "its commit" ? ", and whether the commit landed is unknown" : ""}`);
    this.name = "Unanswered";
  }
}

/** `query`'s answer, or Unanswered past `ms`. */
async function answered<T>(query: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  query.catch(() => undefined);
  try {
    return await Promise.race([query, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Unanswered(what, ms)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Rolls `client`'s transaction back and lets the client go: kept when ROLLBACK answers, destroyed when it fails or goes
 *  unanswered (a silent connection is never waited on past its bound). */
async function rollBackAndRelease(client: pg.PoolClient): Promise<void> {
  await answered(client.query("ROLLBACK"), ROLLBACK_ANSWER_MS, "its rollback").then(() => client.release(), (error: Error) => client.release(error));
}

/** The refusal for a connection not had within `ms` from the database at `where` (postgresWhere: no user or password). */
function connectDeadline(where: string, ms: number): StoreDeadline {
  return new StoreDeadline(ms, `no connection to the store's Postgres at ${where} within ${ms} ms: it does not answer, or every connection of this store is in use`);
}

/** int8 as a JavaScript number: every integer the store keeps (ms, ids, epochs, counts) is one, and one outside the safe
 *  range is refused, as node:sqlite refuses it. */
function int8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new RangeError(`the store read the integer ${text}, outside JavaScript's safe range`);
  return value;
}
const types = { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === 20 ? int8 : pg.types.getTypeParser(oid, format as "text")) } as pg.CustomTypesConfig;

/** How long a server waits for the owner lock another server holds before it gives up (StoreOwned), in ms, at its open
 *  and to take its own back after its lock's connection is lost: a deploy's new server waits out the old one's drain
 *  (a runner's 35 s graceful stop, the server's own) instead of exiting, and a lost lock is never a 503 forever. */
export const OWNER_WAIT_MS = 120_000;
/** How often a waiting server asks for the owner lock again (ms). */
const OWNER_POLL_MS = 250;
/** How long after its lock's connection ends a server first asks for it back (ms): a server already waiting for the
 *  schema (a deploy's new one) takes it first, and this one then exits. */
const OWNER_RETAKE_DELAY_MS = 1_000;
/** The owner session's own keepalives on the database's end: a dead server's session, and its lock, end in about 60 s,
 *  later than this end finds the connection dead (Node's keepalive: 10 s, then 10 probes 1 s apart), so the database
 *  never lets the lock go while this server still believes it holds it. */
const OWNER_SESSION = "-c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The owner lock's session: its client, and the backend holding the lock (its pid and start), by which a later
 *  connection tells this server's own dead session from another server's. */
type OwnerSession = { readonly client: pg.Client; readonly pid: number; readonly startedAt: string };
/** What a server needs to take its owner lock back: the URL, how long it may take, and who is told when it is lost for
 *  good. */
type OwnerConfig = {
  readonly url: string;
  readonly waitMs: number;
  readonly onLost: ((error: StoreOwned) => void) | undefined;
  /** Why the schema, as the lock is taken back, is not one this build serves (another server migrated it meanwhile), or
   *  undefined when it is: PgConnectionOptions.ownerCheck. */
  readonly check: ((client: pg.Client) => Promise<string | undefined>) | undefined;
};
/** One ask for the owner lock: taken, or held by a backend (undefined when none holds it now: let go meanwhile). */
type OwnerTry = { readonly taken: OwnerSession } | { readonly heldBy: { readonly pid: number; readonly startedAt: string | null } | undefined };

/** How long one ask for the owner lock may wait for the database's answer once connected (ms): a connection that stays
 *  open but never answers is destroyed past it, so a wait or a take-back always reaches its own end. */
const OWNER_ASK_MS = 5_000;

/** Destroys `client`'s socket and lets it go: for a connection that never answered, whose own end would wait on it. */
function destroyed(client: pg.Client): Promise<void> {
  (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
  return client.end().catch(() => undefined);
}

/** Ends backend `pid` (this server's own lost owner session) from a connection of its own, bounded as an ask is. */
async function endSession(url: string, pid: number, connectMs: number): Promise<void> {
  const client = new pg.Client({ connectionString: url, types, application_name: "agentrun-store", connectionTimeoutMillis: connectMs });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await answered(client.query("SELECT pg_terminate_backend($1)", [pid]), OWNER_ASK_MS, "the end of the lost owner session");
    await client.end().catch(() => undefined);
  } catch {
    await destroyed(client);
  }
}

/** Asks for `schema`'s owner lock once, on a connection of its own: kept open, holding the lock, when taken. Bounded: its
 *  connect by `connectMs`, each of its statements by OWNER_ASK_MS (Unanswered past it, the connection destroyed). */
async function tryOwner(url: string, schema: string, connectMs: number, where: string): Promise<OwnerTry> {
  const client = new pg.Client({ connectionString: url, types, options: OWNER_SESSION, application_name: `agentrun-store-owner:${schema}`, connectionTimeoutMillis: connectMs, keepAlive: true, keepAliveInitialDelayMillis: KEEPALIVE_IDLE_S * 1_000 });
  // A lost owner connection lets the lock go: its error is never left unhandled (the store watches its end).
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw connectTimedOut(error) ? connectDeadline(where, connectMs) : typed(error);
  }
  try {
    const asked = (await answered(client.query("SELECT pg_try_advisory_lock(hashtext($1), hashtext('owner')) AS held, pg_backend_pid() AS pid, (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS started", [schema]), OWNER_ASK_MS, "the owner lock's ask")).rows[0] as { held: boolean; pid: number; started: string };
    if (asked.held === true) return { taken: { client, pid: Number(asked.pid), startedAt: String(asked.started) } };
    // Who holds it: the advisory lock (hashtext(schema), hashtext('owner')) in this database (advisory locks are per
    // database; pg_locks shows the whole cluster's), its two keys as pg_locks shows them.
    const holder = (await answered(client.query(`SELECT l.pid, a.backend_start::text AS started FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 2 AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid::bigint = (hashtext($1)::bigint & 4294967295) AND l.objid::bigint = (hashtext('owner')::bigint & 4294967295)`, [schema]), OWNER_ASK_MS, "the owner lock's holder")).rows[0] as { pid: number; started: string | null } | undefined;
    await client.end().catch(() => undefined);
    return { heldBy: holder ? { pid: Number(holder.pid), startedAt: holder.started ?? null } : undefined };
  } catch (error) {
    await destroyed(client);
    throw error instanceof Unanswered ? error : typed(error);
  }
}

/** `?` parameters numbered $1, $2 … (outside quoted text and identifiers), kept per statement text. */
const numbered = new Map<string, string>();
export function numberParams(sql: string): string {
  let out = numbered.get(sql);
  if (out !== undefined) return out;
  let n = 0;
  let quote: string | undefined;
  out = "";
  for (const char of sql) {
    if (quote) {
      if (char === quote) quote = undefined;
      out += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      out += char;
    } else out += char === "?" ? `$${++n}` : char;
  }
  if (numbered.size < 10_000) numbered.set(sql, out);
  return out;
}

/** A value as node-postgres binds it: bytes as a Buffer over the same memory, a bigint as its digits, text with no NUL. */
function bound(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "bigint") return value.toString();
  if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

/** Whether `sql` returns rows (a SELECT, or a write with RETURNING): its rows are its changes, as on SQLite's worker. */
const returnsRows = (sql: string): boolean => /^\s*(?:SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

/** Postgres's integrity SQLSTATEs, by the rule they name. */
const RULES: Record<string, ConstraintRule> = { "23514": "check", "23505": "unique", "23503": "foreign_key", "23502": "not_null" };

/** A unique violation's table and columns: the table Postgres names, and the columns of the index it names (a UNIQUE's or
 *  a primary key's is an index of the same name), read from the catalog by `columnsOf`. Any other error as it is. */
async function withUnique(error: Error, cause: unknown, columnsOf: (index: string) => Promise<string[]>): Promise<Error> {
  const e = cause as { table?: string; constraint?: string };
  if (!(error instanceof StoreConstraint) || error.rule !== "unique" || !e?.table || !e.constraint) return error;
  const columns = await columnsOf(e.constraint).catch(() => [] as string[]);
  return columns.length ? new StoreConstraint(error.message, { rule: "unique", unique: { table: e.table, columns } }) : error;
}

/** A Postgres error as the store's own: a refused row StoreConstraint, a lock or a conflict StoreBusy. */
function typed(error: unknown, deadlineMs?: number): Error {
  // Already the store's own (a failed statement's error, met again at the commit of a callback that caught it).
  if (error instanceof Fenced || error instanceof RunFinal || error instanceof StoreClosed || error instanceof StoreDeadline || error instanceof StoreConstraint || error instanceof StoreBusy || error instanceof Unanswered) return error;
  const e = error as { code?: string; message?: string };
  const message = String(e?.message ?? error);
  const code = typeof e?.code === "string" ? e.code : "";
  // 23: integrity, its rule by SQLSTATE; 22P02 a CHECK's json cast of text that is not JSON.
  if (code.startsWith("23") || code === "22P02") return new StoreConstraint(message, RULES[code] ? { rule: RULES[code] } : code === "22P02" ? { rule: "check" } : {});
  // 55P03 a lock not granted within lock_timeout; 40P01 a deadlock; 40001 a serialization failure.
  if (code === "55P03" || code === "40P01" || code === "40001") return new StoreBusy(`the store stayed locked past its busy wait: ${message}`);
  // 57014: a statement cancelled by the transaction's statement_timeout, its deadline.
  if (code === "57014" && deadlineMs !== undefined) return new StoreDeadline(deadlineMs);
  return new Error(`the store's Postgres: ${message}`, { cause: error });
}

type Queryable = Pick<pg.PoolClient, "query">;

async function step(client: Queryable, statement: Statement, columnsOf: (index: string) => Promise<string[]>, deadlineMs?: number): Promise<StatementResult> {
  let result: pg.QueryResult;
  try {
    result = await client.query(numberParams(statement.sql), (statement.params ?? []).map(bound));
  } catch (error) {
    throw await withUnique(typed(error, deadlineMs), error, columnsOf);
  }
  const rows = result.rows as Record<string, unknown>[];
  const changes = returnsRows(statement.sql) ? rows.length : (result.rowCount ?? 0);
  if (statement.expect && changes === 0) throw statement.expect.kind === "fenced" ? new Fenced(statement.expect.runId, statement.expect.epoch) : new RunFinal(statement.expect.runId);
  return { changes, rows };
}

export class PgConnection implements StoreConnection {
  readonly dialect: Dialect;
  readonly schema: string;
  /** Where this connection's data is (StoreConnection.where): postgresWhere, the URL's host, database and the schema. */
  readonly where: string;
  readonly #pool: pg.Pool;
  /** One connection kept for renewing claims (TransactionOptions.lease). */
  readonly #leasePool: pg.Pool;
  /** The owner lock's session (a server's), replaced when it is taken back after its connection was lost. */
  #owner: OwnerSession | undefined;
  /** What taking the owner lock back needs. */
  readonly #ownerConfig: OwnerConfig | undefined;
  readonly #busyTimeoutMs: number;
  /** The bound on getting a connection (PgConnectionOptions.connectTimeoutMs). */
  readonly #connectMs: number;
  #closed = false;
  /** Set while the owner lock is not held (its connection ended or failed, and it is being taken back), and for good once
   *  another server has the schema: every call is refused with it meanwhile. */
  #ownerLost: StoreOwned | undefined;
  /** Calls in flight: close waits for them. */
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Each unique index's columns, in its order, read from the catalog once (a unique violation names its index). */
  readonly #indexColumns = new Map<string, Promise<string[]>>();
  /** `index`'s columns, read through `via` (the pool, or a transaction's own client once rolled back: a pool of one has no
   *  second client to read it on). */
  readonly #columnsOf = (index: string, via: Queryable = this.#pool): Promise<string[]> => {
    let columns = this.#indexColumns.get(index);
    if (!columns) {
      columns = via.query(
        `SELECT a.attname AS column FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = i.relnamespace
           CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
           WHERE n.nspname = $1 AND i.relname = $2 ORDER BY k.ord`,
        [this.schema, index],
      ).then((result) => result.rows.map((row: { column: string }) => row.column));
      columns.catch(() => this.#indexColumns.delete(index));
      this.#indexColumns.set(index, columns);
    }
    return columns;
  };

  private constructor(pool: pg.Pool, owner: OwnerSession | undefined, schema: string, busyTimeoutMs: number, where: string, testClock: boolean, connectMs: number, leasePool: pg.Pool, ownerConfig: OwnerConfig | undefined) {
    this.#connectMs = connectMs;
    this.#pool = pool;
    this.#leasePool = leasePool;
    this.#owner = owner;
    this.#ownerConfig = ownerConfig;
    this.schema = schema;
    this.where = where;
    this.#busyTimeoutMs = busyTimeoutMs;
    this.dialect = postgresDialect(schema, { testClock });
    if (owner) this.#watch(owner);
  }

  /** The owner lock lives on its own connection: when that connection ends or fails (the database restarted, a failover,
   *  an operator killed it), the lock may be gone and another server may take the schema. From then this store refuses
   *  every call (StoreOwned), never writing beside a server that may hold the schema now, and takes the lock back
   *  (#retake). */
  #watch(session: OwnerSession): void {
    const lost = () => {
      if (this.#closed || this.#owner !== session || this.#ownerLost) return;
      this.#ownerLost = new StoreOwned(`the owner lock on the Postgres schema ${this.schema} was lost (its connection ended): this server is taking it back, and refuses every call until it holds it again`);
      void this.#retake(session);
    };
    session.client.on("error", lost);
    session.client.on("end", lost);
  }

  /** Takes the owner lock back on a fresh connection, after OWNER_RETAKE_DELAY_MS (a server waiting for the schema takes
   *  it first). Held by this server's own lost session (the database not yet told its client is gone: a partition), that
   *  session is ended and the lock taken. Held by another server, or not taken within ownerWaitMs, it is lost for good:
   *  every call is refused from then, and onOwnerLost is told, so the process exits and its platform restarts it. */
  async #retake(old: OwnerSession): Promise<void> {
    const config = this.#ownerConfig!;
    const until = Date.now() + OWNER_RETAKE_DELAY_MS + config.waitMs;
    await sleep(OWNER_RETAKE_DELAY_MS);
    while (!this.#closed) {
      const asked = await tryOwner(config.url, this.schema, this.#connectMs, this.where).catch(() => undefined);
      if (asked && "taken" in asked) {
        if (this.#closed) return void (await asked.taken.client.end().catch(() => undefined));
        // While the lock was not held, a newer server may have taken the schema, migrated it and let it go: this build
        // serves only the schema it opened, so a schema it does not know gives the lock up for good.
        const unknown = config.check ? await answered(config.check(asked.taken.client), OWNER_ASK_MS, "the schema's check").catch((error: Error) => `its schema could not be read (${error.message})`) : undefined;
        if (unknown !== undefined) {
          await asked.taken.client.end().catch(() => undefined);
          return this.#lostForGood(new StoreOwned(`the owner lock on the Postgres schema ${this.schema} was taken back, but ${unknown}: this server no longer serves the store`));
        }
        // Closed while the schema was checked: close() ended only the old session, so this one lets the lock go here.
        if (this.#closed) return void (await asked.taken.client.end().catch(() => undefined));
        this.#owner = asked.taken;
        this.#watch(asked.taken);
        this.#ownerLost = undefined;
        return;
      }
      const holder = asked?.heldBy;
      if (holder && holder.pid === old.pid && holder.startedAt === old.startedAt) {
        // This server's own session, its client gone but its backend not: ended, so its lock comes back.
        await endSession(config.url, old.pid, this.#connectMs);
      } else if (holder) {
        return this.#lostForGood(new StoreOwned(`another server took the store in the Postgres schema ${this.schema} after this server's owner lock was lost: this server no longer holds it`));
      }
      if (Date.now() >= until) {
        return this.#lostForGood(new StoreOwned(`the owner lock on the Postgres schema ${this.schema} was lost and could not be taken back within ${Math.round(config.waitMs / 1000)} s: this server no longer holds the store`));
      }
      await sleep(OWNER_POLL_MS);
    }
  }

  #lostForGood(error: StoreOwned): void {
    if (this.#closed) return;
    this.#ownerLost = error;
    this.#ownerConfig?.onLost?.(error);
  }

  /** The pool on `url` in `schema`, and (owner) the owner lock: StoreOwned when another server holds the schema. */
  static async open({ url, schema, owner = false, busyTimeoutMs = 10_000, poolSize = 10, testClock = false, connectTimeoutMs = STORE_CONNECT_TIMEOUT_MS, ownerWaitMs = OWNER_WAIT_MS, onOwnerWait, onOwnerLost, ownerCheck }: PgConnectionOptions): Promise<PgConnection> {
    if (!SCHEMA_NAME.test(schema)) throw new TypeError(`the store's schema is a lower-case name of letters, digits and underscores, not ${JSON.stringify(schema)}`);
    // The database's end of the keepalives (KEEPALIVE_IDLE_S): a vanished client's session, and its locks, ended in ~25 s.
    const keepalives = `-c tcp_keepalives_idle=${KEEPALIVE_IDLE_S} -c tcp_keepalives_interval=5 -c tcp_keepalives_count=3`;
    const session = `-c search_path=${schema} -c lock_timeout=${Math.max(0, Math.floor(busyTimeoutMs))} -c synchronous_commit=on ${keepalives}`;
    const connectMs = Math.max(1, Math.floor(connectTimeoutMs));
    const where = postgresWhere(url, schema);
    // connectionTimeoutMillis bounds a new connection's connect and startup, and a wait for a pool client to come free.
    // keepAlive: this end's TCP keepalives, from KEEPALIVE_IDLE_S (pg's default delay, 0, is the OS's 2 h).
    const tcp = { keepAlive: true, keepAliveInitialDelayMillis: KEEPALIVE_IDLE_S * 1_000 };
    const config: pg.PoolConfig = { connectionString: url, options: session, types, max: poolSize, allowExitOnIdle: true, application_name: "agentrun-store", connectionTimeoutMillis: connectMs, ...tcp };
    let lock: OwnerSession | undefined;
    const waitMs = Math.max(0, Math.floor(ownerWaitMs));
    if (owner) {
      // Another server's lock is waited for (a deploy's old server draining and stopping), asked again every
      // OWNER_POLL_MS, up to waitMs; past it StoreOwned. Its keepalives: OWNER_SESSION.
      const until = Date.now() + waitMs;
      let told = false;
      for (;;) {
        const asked = await tryOwner(url, schema, connectMs, where);
        if ("taken" in asked) {
          lock = asked.taken;
          break;
        }
        if (Date.now() >= until) {
          throw new StoreOwned(`another server holds the store in the Postgres schema ${schema}${waitMs > 0 ? `, and still held it after ${Math.round(waitMs / 1000)} s` : ""}`);
        }
        if (!told) {
          told = true;
          onOwnerWait?.(`another server holds the store in the Postgres schema ${schema}: waiting up to ${Math.round(waitMs / 1000)} s for it to let go`);
        }
        await sleep(OWNER_POLL_MS);
      }
    }
    const pool = new pg.Pool(config);
    // The lease connection: one more, for renewing claims only (TransactionOptions.lease), so a renew never waits for a
    // client behind the pool's other work, whatever the runner's loops hold.
    // Its connection named for its schema, as the owner lock's is. A lease connection whose backend dies while idle is
    // dropped by the pool (its 'error', handled below) and the next renew opens a fresh one within the connect deadline.
    // Kept, never idled out (idleTimeoutMillis 0; pg-pool's default lets an idle client go after 10 s), so a renew does
    // not open a fresh connection, and meet a database out of connections, every interval.
    const leasePool = new pg.Pool({ ...config, max: 1, application_name: `agentrun-store-lease:${schema}`, idleTimeoutMillis: 0 });
    // A client's error (its backend ended, the server went away) is never an unhandled event: an idle client's reaches
    // the pool ('error', below; the pool drops it), and a checked-out one's, which pg-pool does not listen for, its own
    // listener here. The call using it still fails, through its query's rejection.
    for (const each of [pool, leasePool]) {
      each.on("error", () => undefined);
      each.on("connect", (fresh) => fresh.on("error", () => undefined));
    }
    return new PgConnection(pool, lock, schema, busyTimeoutMs, where, testClock, connectMs, leasePool, lock ? { url, waitMs, onLost: onOwnerLost, check: ownerCheck } : undefined);
  }

  /** `work`, counted in flight, refused after close. A connection it never got in time is StoreDeadline, naming the
   *  database's place. */
  #call<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new StoreClosed());
    if (this.#ownerLost) return Promise.reject(this.#ownerLost);
    const running = work().catch((error: unknown) => {
      throw connectTimedOut(error) ? connectDeadline(this.where, this.#connectMs) : error;
    });
    this.#inFlight.add(running);
    const done = () => void this.#inFlight.delete(running);
    running.then(done, done);
    return running;
  }

  /** One statement on its own (autocommit) on a client of the pool, bounded past both a transaction's deadline and the
   *  busy wait (lock_timeout), so a statement waiting on a lock gets the database's StoreBusy first: unanswered past it,
   *  its client is let go (destroyed) and the call is Unanswered. */
  #single(statement: Statement): Promise<StatementResult> {
    return this.#call(async () => {
      let client: pg.PoolClient;
      try {
        client = await this.#pool.connect();
      } catch (error) {
        throw typed(error);
      }
      try {
        const result = await answered(step(client, statement, (index) => this.#columnsOf(index, client)), Math.max(DEFAULT_TRANSACTION_DEADLINE_MS, this.#busyTimeoutMs) + 2_000, "a statement");
        client.release();
        return result;
      } catch (error) {
        // A statement's own failure leaves its client fine; a silent one is destroyed.
        client.release(error instanceof Unanswered ? error : undefined);
        throw error;
      }
    });
  }

  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return (await this.#single({ sql, params })).rows[0] as T | undefined;
  }

  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return (await this.#single({ sql, params })).rows as T[];
  }

  /** One statement on its own (autocommit), its changes counted: the shared code's run outside a transaction. */
  async runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return (await this.#single({ sql, params })).changes;
  }

  write(statements: readonly Statement[], { full = false }: { full?: boolean } = {}): Promise<StatementResult[]> {
    return this.transaction(async (tx) => {
      const results: StatementResult[] = [];
      for (const statement of statements) results.push(await tx.step(statement));
      return results;
    }, { full });
  }

  /** A transaction on one client of the pool: READ COMMITTED for a write (its locks are explicit, dialect.ts); REPEATABLE
   *  READ READ ONLY for a read, one snapshot. Its statements are bounded by its deadline (statement_timeout), and a callback
   *  still running at the deadline is answered StoreDeadline while the rollback follows its statement in flight. Every
   *  commit is durable (synchronous_commit on), so `full` asks nothing more. */
  transaction<T>(callback: (transaction: Tx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const { read = false, lease = false } = options;
    // fromCall: the deadline runs from the call, so the wait for a client counts against it (the client got past it is
    // let go unused, nothing begun); else from the begin. A lease's renew runs on the store's own lease connection, never
    // behind the pool's other work, and all of it within LEASE_DEADLINE_MS of its call (TransactionOptions.lease).
    const deadlineMs = lease ? Math.min(options.deadlineMs ?? LEASE_DEADLINE_MS, LEASE_DEADLINE_MS) : (options.deadlineMs ?? DEFAULT_TRANSACTION_DEADLINE_MS);
    const fromCall = lease || (options.fromCall ?? false);
    const calledAt = Date.now();
    return this.#call(async () => {
      const pool = lease ? this.#leasePool : this.#pool;
      let client: pg.PoolClient;
      try {
        const connecting = pool.connect();
        if (!fromCall) client = await connecting;
        else {
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<"late">((resolve) => {
            timer = setTimeout(() => resolve("late"), Math.max(0, deadlineMs - (Date.now() - calledAt)));
          });
          let got: pg.PoolClient | "late";
          try {
            got = await Promise.race([connecting, late]);
          } finally {
            clearTimeout(timer);
          }
          if (got === "late") {
            connecting.then((unused) => unused.release(), () => undefined);
            throw new StoreDeadline(deadlineMs);
          }
          client = got;
        }
      } catch (error) {
        throw error instanceof StoreDeadline ? error : typed(error);
      }
      const leftMs = fromCall ? deadlineMs - (Date.now() - calledAt) : deadlineMs;
      if (leftMs <= 0) {
        client.release();
        throw new StoreDeadline(deadlineMs);
      }
      let live = true;
      let broken: Error | undefined;
      const check = () => {
        if (!live) throw new Error("the store's transaction is over: its handle takes no more statements");
      };
      // A unique violation names its index; its columns are read on this transaction's own client once it is rolled back,
      // never on a second client of the pool, which a pool of one does not have (the read would wait out the deadline).
      let rolledBack = false;
      const columnsOf = async (index: string) => {
        if (!rolledBack) {
          rolledBack = true;
          await client.query("ROLLBACK");
        }
        return this.#columnsOf(index, client);
      };
      const run = async (statement: Statement) => {
        check();
        // A statement that failed has aborted the transaction (or rolled it back): no later statement of it runs.
        if (broken) throw broken;
        try {
          return await step(client, statement, columnsOf, deadlineMs);
        } catch (error) {
          // A statement that failed has aborted the transaction: no later statement of it runs.
          broken ??= error as Error;
          throw error;
        }
      };
      const tx: Tx = {
        dialect: this.dialect,
        step: (statement) => run(statement),
        exec: async (sql) => void (await run({ sql })),
        run: async (sql, ...params) => void (await run({ sql, params })),
        runCounted: async (sql, ...params) => (await run({ sql, params })).changes,
        get: async <R extends object>(sql: string, ...params: SqliteValue[]) => (await run({ sql, params })).rows[0] as R | undefined,
        all: async <R extends object>(sql: string, ...params: SqliteValue[]) => (await run({ sql, params })).rows as R[],
      };
      const ms = Math.max(1, Math.floor(leftMs));
      // The deadline runs from before BEGIN: a connection that went silent (open, never answering: a load balancer's idle
      // drop, a failover) is bounded from its first statement on, not only once BEGIN has answered. Past it the client is
      // let go with the error, which destroys its socket (Postgres rolls a dead session's transaction back), never
      // waiting on a ROLLBACK that a silent connection would never answer.
      let timer: NodeJS.Timeout | undefined;
      const deadlineAt = Date.now() + ms;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StoreDeadline(deadlineMs)), ms);
      });
      deadline.catch(() => undefined);
      const abandon = (error: Error) => {
        live = false;
        clearTimeout(timer);
        // Its socket destroyed here: with no query in flight (a deadline between statements) pg's own end would send a
        // Terminate and wait for a FIN a silent connection never answers.
        (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
        client.release(error);
      };
      try {
        // statement_timeout: a statement still running at the deadline (a lock wait) is cancelled by the database itself;
        // idle_in_transaction_session_timeout: a transaction whose client vanished between statements is ended, its locks
        // let go (IDLE_IN_TRANSACTION_SLACK_MS).
        await Promise.race([client.query(`${read ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN"}; SET LOCAL statement_timeout = ${ms}; SET LOCAL idle_in_transaction_session_timeout = ${ms + IDLE_IN_TRANSACTION_SLACK_MS}`), deadline]);
      } catch (error) {
        abandon(error as Error);
        throw error instanceof StoreDeadline ? error : typed(error, deadlineMs);
      }
      let value: T;
      try {
        const running = callback(tx);
        running.catch(() => undefined);
        value = await Promise.race([running, deadline]);
      } catch (error) {
        if (error instanceof StoreDeadline) {
          abandon(error);
          throw error;
        }
        live = false;
        clearTimeout(timer);
        await rollBackAndRelease(client);
        throw error;
      }
      live = false;
      clearTimeout(timer);
      try {
        // A callback that caught a failed statement's error and went on still rolls back: Postgres aborted the transaction.
        if (broken) throw broken;
        await answered(client.query("COMMIT"), Math.max(COMMIT_FLOOR_MS, deadlineAt - Date.now()), "its commit");
      } catch (error) {
        if (error instanceof Unanswered) {
          client.release(error);
          // A read's snapshot has nothing to land: what it read stands.
          if (read) return value;
          throw error;
        }
        await rollBackAndRelease(client);
        throw typed(error, deadlineMs);
      }
      client.release();
      return value;
    });
  }

  /** The database's clock (ms): the runner compares its own with it at its start. */
  async clock(): Promise<number> {
    return Number((await this.get<{ now: string | number }>("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now"))!.now);
  }

  /** One client of the pool for setup (migrations), released after `work`. */
  async withClient<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.#call(async () => {
      const client = await this.#pool.connect();
      try {
        return await work(client);
      } finally {
        client.release();
      }
    });
  }

  /** How long a statement waits for a lock (lock_timeout). */
  get busyTimeoutMs(): number {
    return this.#busyTimeoutMs;
  }

  /** Waits for every call in flight, then ends the pool and lets the owner lock go. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#inFlight]);
    await this.#pool.end().catch(() => undefined);
    await this.#leasePool.end().catch(() => undefined);
    await this.#owner?.client.end().catch(() => undefined);
  }
}
