// Whether a SQLite path names an in-memory database: ":memory:", "" (SQLite's private temporary one) or a memory URI.
// Each is its own data, with no file another process could share: it gets its own Store.where, and no owner lock file.

/** Whether `file` names an in-memory database rather than a file on disk. */
export const inMemory = (file: string): boolean => file === "" || file === ":memory:" || file.startsWith("file::memory:");
