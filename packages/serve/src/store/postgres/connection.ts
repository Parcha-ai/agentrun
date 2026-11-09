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
  const parsed = new URL(url);
  return `postgres:${parsed.host}/${decodeURIComponent(parsed.pathname.replace(/^\//, ""))}/${schema}`;
}

/** A schema name the store takes: a plain lower-case identifier, so it is never quoted, and never input in SQL. */
export const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface PgConnectionOptions {
  /** postgres:// or postgresql:// URL. Never printed: it may carry a password. */
  readonly url: string;
  readonly schema: string;
  /** Take the owner lock (a server): StoreOwned when another server holds the schema. */
  readonly owner?: boolean;
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
 *  never waits for a client behind other work: it has the lease connection (TransactionOptions.lease). */
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
  if (error instanceof Fenced || error instanceof RunFinal || error instanceof StoreClosed || error instanceof StoreDeadline) return error;
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
  readonly #owner: pg.Client | undefined;
  readonly #busyTimeoutMs: number;
  /** The bound on getting a connection (PgConnectionOptions.connectTimeoutMs). */
  readonly #connectMs: number;
  #closed = false;
  /** Set once the owner lock's connection ended or failed: every call is refused with it from then. */
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

  private constructor(pool: pg.Pool, owner: pg.Client | undefined, schema: string, busyTimeoutMs: number, where: string, testClock: boolean, connectMs: number, leasePool: pg.Pool) {
    this.#connectMs = connectMs;
    this.#pool = pool;
    this.#leasePool = leasePool;
    this.#owner = owner;
    this.schema = schema;
    this.where = where;
    this.#busyTimeoutMs = busyTimeoutMs;
    this.dialect = postgresDialect(schema, { testClock });
    // The owner lock lives on its own connection: when that connection ends or fails (the database went away, or killed
    // it), the lock is gone and another server may take the schema. From then this store refuses every call (StoreOwned),
    // never writing beside the server that holds the schema now.
    const lost = () => {
      if (!this.#closed) this.#ownerLost ??= new StoreOwned(`the owner lock on the Postgres schema ${schema} was lost (its connection ended): this server no longer holds the store`);
    };
    owner?.on("error", lost);
    owner?.on("end", lost);
  }

  /** The pool on `url` in `schema`, and (owner) the owner lock: StoreOwned when another server holds the schema. */
  static async open({ url, schema, owner = false, busyTimeoutMs = 10_000, poolSize = 10, testClock = false, connectTimeoutMs = STORE_CONNECT_TIMEOUT_MS }: PgConnectionOptions): Promise<PgConnection> {
    if (!SCHEMA_NAME.test(schema)) throw new TypeError(`the store's schema is a lower-case name of letters, digits and underscores, not ${JSON.stringify(schema)}`);
    const session = `-c search_path=${schema} -c lock_timeout=${Math.max(0, Math.floor(busyTimeoutMs))} -c synchronous_commit=on`;
    const connectMs = Math.max(1, Math.floor(connectTimeoutMs));
    const where = postgresWhere(url, schema);
    // connectionTimeoutMillis bounds a new connection's connect and startup, and a wait for a pool client to come free.
    const config: pg.PoolConfig = { connectionString: url, options: session, types, max: poolSize, allowExitOnIdle: true, application_name: "agentrun-store", connectionTimeoutMillis: connectMs };
    let lock: pg.Client | undefined;
    if (owner) {
      lock = new pg.Client({ connectionString: url, types, application_name: `agentrun-store-owner:${schema}`, connectionTimeoutMillis: connectMs });
      // A lost owner connection lets the lock go; the error is not left unhandled.
      lock.on("error", () => undefined);
      try {
        await lock.connect();
      } catch (error) {
        await lock.end().catch(() => undefined);
        throw connectTimedOut(error) ? connectDeadline(where, connectMs) : typed(error);
      }
      try {
        const held = await lock.query("SELECT pg_try_advisory_lock(hashtext($1), hashtext('owner')) AS held", [schema]);
        if (held.rows[0]?.held !== true) throw new StoreOwned(`another server holds the store in the Postgres schema ${schema}`);
      } catch (error) {
        await lock.end().catch(() => undefined);
        throw error instanceof StoreOwned ? error : typed(error);
      }
    }
    const pool = new pg.Pool(config);
    // The lease connection: one more, for renewing claims only (TransactionOptions.lease), so a renew never waits for a
    // client behind the pool's other work, whatever the runner's loops hold.
    // Its connection named for its schema, as the owner lock's is. A lease connection whose backend dies while idle is
    // dropped by the pool (its 'error', handled below) and the next renew opens a fresh one within the connect deadline.
    const leasePool = new pg.Pool({ ...config, max: 1, application_name: `agentrun-store-lease:${schema}` });
    // An idle client's error (the server went away) surfaces at its next use, never as an unhandled event.
    pool.on("error", () => undefined);
    leasePool.on("error", () => undefined);
    return new PgConnection(pool, lock, schema, busyTimeoutMs, where, testClock, connectMs, leasePool);
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

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#call(async () => (await step(this.#pool, { sql, params }, this.#columnsOf)).rows[0] as T | undefined);
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#call(async () => (await step(this.#pool, { sql, params }, this.#columnsOf)).rows as T[]);
  }

  /** One statement on its own (autocommit), its changes counted: the shared code's run outside a transaction. */
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.#call(async () => (await step(this.#pool, { sql, params }, this.#columnsOf)).changes);
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
  transaction<T>(callback: (transaction: Tx) => Promise<T>, { read = false, deadlineMs = DEFAULT_TRANSACTION_DEADLINE_MS, fromCall = false, lease = false }: TransactionOptions = {}): Promise<T> {
    // fromCall: the deadline runs from the call, so the wait for a client counts against it (the client got past it is
    // let go unused, nothing begun); else from the begin. A lease's renew runs on the store's own lease connection, never
    // behind the pool's other work (TransactionOptions.lease).
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
          const got = await Promise.race([connecting, late]);
          clearTimeout(timer);
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
      let timer: NodeJS.Timeout | undefined;
      try {
        await client.query(`${read ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN"}; SET LOCAL statement_timeout = ${ms}`);
      } catch (error) {
        client.release(error as Error);
        throw typed(error, deadlineMs);
      }
      let value: T;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StoreDeadline(deadlineMs)), ms);
        });
        const running = callback(tx);
        running.catch(() => undefined);
        value = await Promise.race([running, deadline]);
      } catch (error) {
        live = false;
        clearTimeout(timer);
        await client.query("ROLLBACK").then(() => client.release(), (rollback: Error) => client.release(rollback));
        throw error;
      }
      live = false;
      clearTimeout(timer);
      try {
        // A callback that caught a failed statement's error and went on still rolls back: Postgres aborted the transaction.
        if (broken) throw broken;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").then(() => client.release(), (rollback: Error) => client.release(rollback));
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
    await this.#owner?.end().catch(() => undefined);
  }
}
