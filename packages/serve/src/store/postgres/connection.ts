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
  readonly #owner: pg.Client | undefined;
  readonly #busyTimeoutMs: number;
  #closed = false;
  /** Calls in flight: close waits for them. */
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Each unique index's columns, in its order, read from the catalog once (a unique violation names its index). */
  readonly #indexColumns = new Map<string, Promise<string[]>>();
  readonly #columnsOf = (index: string): Promise<string[]> => {
    let columns = this.#indexColumns.get(index);
    if (!columns) {
      columns = this.#pool.query(
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

  private constructor(pool: pg.Pool, owner: pg.Client | undefined, schema: string, busyTimeoutMs: number, where: string) {
    this.#pool = pool;
    this.#owner = owner;
    this.schema = schema;
    this.where = where;
    this.#busyTimeoutMs = busyTimeoutMs;
    this.dialect = postgresDialect(schema);
  }

  /** The pool on `url` in `schema`, and (owner) the owner lock: StoreOwned when another server holds the schema. */
  static async open({ url, schema, owner = false, busyTimeoutMs = 10_000, poolSize = 10 }: PgConnectionOptions): Promise<PgConnection> {
    if (!SCHEMA_NAME.test(schema)) throw new TypeError(`the store's schema is a lower-case name of letters, digits and underscores, not ${JSON.stringify(schema)}`);
    const session = `-c search_path=${schema} -c lock_timeout=${Math.max(0, Math.floor(busyTimeoutMs))} -c synchronous_commit=on`;
    const config: pg.PoolConfig = { connectionString: url, options: session, types, max: poolSize, allowExitOnIdle: true, application_name: "agentrun-store" };
    let lock: pg.Client | undefined;
    if (owner) {
      lock = new pg.Client({ connectionString: url, types, application_name: "agentrun-store-owner" });
      // A lost owner connection lets the lock go; the error is not left unhandled.
      lock.on("error", () => undefined);
      await lock.connect();
      try {
        const held = await lock.query("SELECT pg_try_advisory_lock(hashtext($1), hashtext('owner')) AS held", [schema]);
        if (held.rows[0]?.held !== true) throw new StoreOwned(`another server holds the store in the Postgres schema ${schema}`);
      } catch (error) {
        await lock.end().catch(() => undefined);
        throw error instanceof StoreOwned ? error : typed(error);
      }
    }
    const pool = new pg.Pool(config);
    // An idle client's error (the server went away) surfaces at its next use, never as an unhandled event.
    pool.on("error", () => undefined);
    return new PgConnection(pool, lock, schema, busyTimeoutMs, postgresWhere(url, schema));
  }

  /** `work`, counted in flight, refused after close. */
  #call<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new StoreClosed());
    const running = work();
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
  transaction<T>(callback: (transaction: Tx) => Promise<T>, { read = false, deadlineMs = DEFAULT_TRANSACTION_DEADLINE_MS }: TransactionOptions = {}): Promise<T> {
    return this.#call(async () => {
      let client: pg.PoolClient;
      try {
        client = await this.#pool.connect();
      } catch (error) {
        throw typed(error);
      }
      let live = true;
      let broken: Error | undefined;
      const check = () => {
        if (!live) throw new Error("the store's transaction is over: its handle takes no more statements");
      };
      const run = async (statement: Statement) => {
        check();
        try {
          return await step(client, statement, this.#columnsOf, deadlineMs);
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
      const ms = Math.max(1, Math.floor(deadlineMs));
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
    const client = await this.#pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
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
    await this.#owner?.end().catch(() => undefined);
  }
}
