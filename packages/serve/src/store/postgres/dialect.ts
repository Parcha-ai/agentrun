// The store's SQL on Postgres (store/dialect.ts): JSON is TEXT read through a json cast (never jsonb, which reorders keys and
// refuses some escapes the journal's encoded identities carry), and where SQLite's one writer serializes, Postgres's many
// writers lock: a claim skips the runs another claimer holds, a write that depends on a run row holds it shared, a
// read-modify-write holds its parent row, and two checks of the same thing take one advisory lock, named per schema so
// two stores in one database never wait on each other.
import type { Dialect, LockExecutor } from "../dialect.js";

const path = (keys: readonly string[]): string => `'{${keys.join(",")}}'`;

/** The database's clock in ms: clock_timestamp(), the moment the statement reads it (after any lock it waited for), never the
 *  transaction's start. */
export const DATABASE_NOW_MS = "(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint";

/** The Postgres dialect for the store in `schema`. Its deadlines run on the database's clock (DATABASE_NOW_MS) unless
 *  `testClock`: a test that moves the store's clock by hand, bound as a parameter as SQLite's is. */
export function postgresDialect(schema: string, { testClock = false }: { testClock?: boolean } = {}): Dialect {
  return {
    name: "postgres",
    ...(testClock ? {} : { nowSql: DATABASE_NOW_MS }),
    jsonText: (column, keys) => `(${column}::json #>> ${path(keys)})`,
    // SQLite's json_extract(...) IS NOT 0: true unless the value is false or the number 0 (absent and null are true).
    jsonNotFalse: (column, keys) => `COALESCE((${column}::json #> ${path(keys)})::text NOT IN ('false', '0'), TRUE)`,
    jsonArrayHas: (column) => `EXISTS (SELECT 1 FROM json_array_elements_text(${column}::json) AS element(value) WHERE element.value = ?)`,
    jsonArrayLength: (column) => `json_array_length(${column}::json)`,
    firingOrder: "ord",
    limitAll: "LIMIT ALL",
    nullSafeEquals: (column) => `${column} IS NOT DISTINCT FROM ?`,
    greatest: "GREATEST",
    bigintParam: "CAST(? AS BIGINT)",
    insertOrIgnore: "INSERT",
    onConflictIgnore: " ON CONFLICT DO NOTHING",
    insertedRow: "NULL",
    claimLock: " FOR UPDATE SKIP LOCKED",
    claimOneLock: " FOR UPDATE",
    // FOR KEY SHARE: conflicts only with FOR UPDATE (an epoch's move: lockRow "update", a claim), never with a renew's
    // FOR NO KEY UPDATE, so a renew never waits behind a journal commit or a command in flight.
    shareLock: " FOR KEY SHARE",
    // `table` and `column` are the store's own names, never input. FOR NO KEY UPDATE: as an UPDATE of the row's other
    // columns locks it, so a row hanging off it (a command, a firing) is still written meanwhile. FOR UPDATE ("update"): a
    // write that moves a run's epoch, which waits for every write under the claim holding the row shared.
    lockRow: async (tx: LockExecutor, table: string, column: string, value: string, mode?: "update") => {
      await tx.run(`SELECT 1 FROM ${table} WHERE ${column} = ? FOR ${mode === "update" ? "UPDATE" : "NO KEY UPDATE"}`, value);
    },
    lockKey: async (tx: LockExecutor, key: string) => {
      await tx.run("SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))", schema, key);
    },
  };
}
