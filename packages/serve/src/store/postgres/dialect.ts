// The store's SQL on Postgres (store/dialect.ts): JSON is TEXT read through a json cast (never jsonb, which reorders keys and
// refuses some escapes the journal's encoded identities carry), and where SQLite's one writer serializes, Postgres's many
// writers lock: a claim skips the runs another claimer holds, a write that depends on a run row holds it shared, a
// read-modify-write holds its parent row, and two checks of the same thing take one advisory lock, named per schema so
// two stores in one database never wait on each other.
import type { Dialect, LockExecutor } from "../dialect.js";

const path = (keys: readonly string[]): string => `'{${keys.join(",")}}'`;

/** The Postgres dialect for the store in `schema`. */
export function postgresDialect(schema: string): Dialect {
  return {
    name: "postgres",
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
    shareLock: " FOR SHARE",
    // `table` and `column` are the store's own names, never input. FOR NO KEY UPDATE: as an UPDATE of the row's other
    // columns locks it, so a row hanging off it (a command, a firing) is still written meanwhile.
    lockRow: async (tx: LockExecutor, table: string, column: string, value: string) => {
      await tx.run(`SELECT 1 FROM ${table} WHERE ${column} = ? FOR NO KEY UPDATE`, value);
    },
    lockKey: async (tx: LockExecutor, key: string) => {
      await tx.run("SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))", schema, key);
    },
  };
}
