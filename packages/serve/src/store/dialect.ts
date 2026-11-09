// What the store's SQL says differently on each database it runs on: the few fragments of the shared domain code
// (sqlite/store.ts, sqlite/run-patch.ts, journal/storage.ts) that are not the same text on SQLite and on Postgres, and the
// locks a store with many writers takes where SQLite's one writer lock serializes for free. Everything else in the store's
// SQL is written once, with `?` parameters, for both.

/** The calls a lock needs: one statement in the open transaction. */
export interface LockExecutor {
  run(sql: string, ...params: (string | number)[]): Promise<void>;
}

export interface Dialect {
  readonly name: "sqlite" | "postgres";
  /** A JSON TEXT column's value at `path` (object keys), as SQL text to compare with a string parameter. */
  jsonText(column: string, path: readonly string[]): string;
  /** True unless the JSON TEXT column's value at `path` is false or 0 (absent or null count as true). */
  jsonNotFalse(column: string, path: readonly string[]): string;
  /** True when the JSON array in TEXT column `column` holds the string parameter that follows (one `?`). */
  jsonArrayHas(column: string): string;
  /** The length of the JSON array in TEXT column `column`. */
  jsonArrayLength(column: string): string;
  /** trigger_firings' insertion order: the tie-break of rows written in the same ms. */
  readonly firingOrder: string;
  /** No row limit, before an OFFSET. */
  readonly limitAll: string;
  /** `column` equals the parameter that follows (one `?`), NULL equal to NULL. */
  nullSafeEquals(column: string): string;
  /** The larger of two values. */
  readonly greatest: string;
  /** A `?` parameter read as a 64-bit integer where nothing else types it (a VALUES list). */
  readonly bigintParam: string;
  /** An INSERT that writes nothing when the row's key is there already: `${insertOrIgnore} INTO … VALUES (…)${onConflictIgnore}`. */
  readonly insertOrIgnore: string;
  readonly onConflictIgnore: string;
  /** What a run row's INSERT returns to name the row it inserted (fence.ts, the inserted-here form): SQLite's rowid; on
   *  Postgres nothing (NULL), since the fence names it by the inserting transaction. */
  readonly insertedRow: string;
  /** After a SELECT of runs to claim (claimMany, a poll over many): lock the rows picked, skipping any another claimer
   *  holds. */
  readonly claimLock: string;
  /** After the SELECT of the one run a claim names (claim(runId)): lock its row, waiting for a write in flight on it, so a
   *  run whose holder is merely writing is read as it is once that write ends, never skipped as held. */
  readonly claimOneLock: string;
  /** After a SELECT of a run row a write depends on: hold it, so a writer of the row (a run's end, a claim) waits, and this
   *  waits for one in flight, then reads its outcome. */
  readonly shareLock: string;
  /** Holds the row `table`.`column` = `value` until the transaction ends: a read-modify-write of what hangs off it (a
   *  trigger's firings, an agent's current revision) is not interleaved with another. */
  lockRow(tx: LockExecutor, table: string, column: string, value: string): Promise<void>;
  /** Holds the named lock until the transaction ends: two transactions that each check, then write what the other checks. */
  lockKey(tx: LockExecutor, key: string): Promise<void>;
}

/** Text as both stores write it: a NUL (which Postgres's TEXT cannot hold) becomes U+FFFD, a visible mark, so a model's stray
 *  NUL in a summary or a reason never fails a write on one store and passes on the other. Every string a statement binds
 *  goes through it (both connections), so a read that binds the same string finds the row. */
export function cleanText(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", "�") : text;
}

const jsonPath =(path: readonly string[]): string => `'$.${path.join(".")}'`;

/** SQLite: one writer at a time (BEGIN IMMEDIATE), so every lock is already held. */
export const SQLITE: Dialect = {
  name: "sqlite",
  jsonText: (column, path) => `json_extract(${column}, ${jsonPath(path)})`,
  jsonNotFalse: (column, path) => `json_extract(${column}, ${jsonPath(path)}) IS NOT 0`,
  jsonArrayHas: (column) => `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ?)`,
  jsonArrayLength: (column) => `json_array_length(${column})`,
  firingOrder: "rowid",
  limitAll: "LIMIT -1",
  nullSafeEquals: (column) => `${column} IS ?`,
  greatest: "max",
  bigintParam: "?",
  insertOrIgnore: "INSERT OR IGNORE",
  onConflictIgnore: "",
  insertedRow: "rowid",
  claimLock: "",
  claimOneLock: "",
  shareLock: "",
  lockRow: async () => undefined,
  lockKey: async () => undefined,
};
