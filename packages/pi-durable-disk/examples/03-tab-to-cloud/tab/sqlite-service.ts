// The SQLite end of the browser store: one database behind a message protocol. It runs inside a Worker (sqlite-worker.ts, SQLite-WASM
// on the origin's private file system through the opfs-sahpool VFS) and, with an in-memory database, in Node tests that put the same
// protocol under pi-durable's storage conformance suite. Portable: no Node API, no DOM API.
import type { SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

/** What a request asks; `id` pairs it with its answer. Values travel as structured clones (bigint and Uint8Array included). */
export type SqliteRequest =
  | { id: number; op: "open"; name: string }
  | { id: number; op: "exec"; sql: string }
  | { id: number; op: "run"; sql: string; params: SqliteValue[] }
  | { id: number; op: "get"; sql: string; params: SqliteValue[] }
  | { id: number; op: "all"; sql: string; params: SqliteValue[] }
  | { id: number; op: "close" }
  /** Pool operations (OPFS only): put a whole database file in place, read one out, drop one, list them. */
  | { id: number; op: "import"; name: string; bytes: Uint8Array }
  | { id: number; op: "export"; name: string }
  | { id: number; op: "unlink"; name: string }
  | { id: number; op: "files" };

export type SqliteResponse = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: { name: string; message: string; resultCode?: number } };

/** The part of SQLite-WASM's database object the service uses. */
export interface WasmDb {
  exec(opts: { sql: string; bind?: SqliteValue[]; rowMode?: "object"; returnValue?: "resultRows" }): unknown;
  close(): void;
}

/** Where databases come from: the OPFS pool in a page, memory in a test. */
export interface DbHost {
  open(name: string): WasmDb;
  import?(name: string, bytes: Uint8Array): Promise<number>;
  export?(name: string): Uint8Array;
  unlink?(name: string): boolean;
  files?(): string[];
}

/** Answer requests for one open database at a time, in the order they arrive. */
export function createSqliteService(host: DbHost): (request: SqliteRequest) => Promise<SqliteResponse> {
  let db: WasmDb | undefined;
  const live = (): WasmDb => {
    if (!db) throw new Error("no database is open");
    return db;
  };
  const rows = (sql: string, params: SqliteValue[]) => live().exec({ sql, bind: params, rowMode: "object", returnValue: "resultRows" }) as object[];
  const need = <T>(f: T | undefined, what: string): T => {
    if (!f) throw new Error(`${what} is not available in this host`);
    return f;
  };
  return async (request) => {
    try {
      let value: unknown;
      switch (request.op) {
        case "open":
          if (db) throw new Error("a database is already open");
          db = host.open(request.name);
          break;
        case "exec":
          live().exec({ sql: request.sql });
          break;
        case "run":
          live().exec({ sql: request.sql, bind: request.params });
          break;
        case "get":
          value = rows(request.sql, request.params)[0];
          break;
        case "all":
          value = rows(request.sql, request.params);
          break;
        case "close":
          db?.close();
          db = undefined;
          break;
        case "import":
          value = await need(host.import, "import")(request.name, request.bytes);
          break;
        case "export":
          value = need(host.export, "export")(request.name);
          break;
        case "unlink":
          value = need(host.unlink, "unlink")(request.name);
          break;
        case "files":
          value = need(host.files, "files")();
          break;
      }
      return { id: request.id, ok: true, value };
    } catch (error) {
      const e = error as { name?: string; message?: string; resultCode?: number };
      return { id: request.id, ok: false, error: { name: e.name ?? "Error", message: e.message ?? String(error), ...(typeof e.resultCode === "number" ? { resultCode: e.resultCode } : {}) } };
    }
  };
}
