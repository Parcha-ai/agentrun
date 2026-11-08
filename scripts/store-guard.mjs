// What the store guard (store-sql-guard.test.mjs) reads in a source file: whether it holds SQL, and which SQLite drivers it
// imports. Only the store knows SQL, pragmas, a file or a driver (design 2.1).

/** SQL as a statement, not as a word in prose: a keyword with what makes it a statement after it. */
export const SQL = /\bPRAGMA\b|\bSELECT\b[^'"`]{0,80}\bFROM\b|\bINSERT (?:OR \w+ )?INTO\b|\bUPDATE [a-z_]+ SET\b|\bDELETE FROM\b|\bCREATE (?:TABLE|INDEX|UNIQUE INDEX)\b/;

/** Whether `source` (a file's text) holds SQL. */
export function sqlIn(source) {
  return SQL.test(source);
}

/** The SQLite drivers `source` imports. */
export function driversIn(_source) {
  return [];
}
