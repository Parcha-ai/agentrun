// The Worker of the browser store: SQLite-WASM on the origin's private file system (OPFS) through the opfs-sahpool VFS, which needs no
// SharedArrayBuffer, so nothing here depends on cross-origin isolation. One pool holds the databases of this origin; a pool is held by one
// worker at a time, so a second tab (or a page still being torn down) waits for the first to let go, then fails with a plain message.
// Requests are answered in order (sqlite-service.ts); the page's end is sqlite-client.ts.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { createSqliteService, type DbHost, type SqliteRequest, type WasmDb } from "./sqlite-service.ts";

/** The pool's directory in OPFS; every database of the checked-out runs lives in it. */
const DIRECTORY = ".walks-home-store";
/** How long a pool held by a worker that is going away is waited for. */
const LOCK_WAIT_MS = 10_000;

/** The module's options (where its wasm is, silence) are real though its declaration takes none. */
const initSqlite = sqlite3InitModule as unknown as (options: { locateFile(file: string): string; print(): void; printErr(): void }) => ReturnType<typeof sqlite3InitModule>;

const scope = self as unknown as { postMessage(message: unknown): void; addEventListener(type: "message", listener: (event: { data: unknown }) => void): void; location: { href: string } };

async function installPool(): Promise<{ sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>; pool: SAHPoolUtil }> {
  const sqlite3 = await initSqlite({ locateFile: (file: string) => new URL(file, scope.location.href).href, print: () => undefined, printErr: () => undefined });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return { sqlite3, pool: await sqlite3.installOpfsSAHPoolVfs({ directory: DIRECTORY, initialCapacity: 12 }) };
    } catch (error) {
      // NoModificationAllowedError: the previous page's worker still holds the handles; it releases them as it is torn down.
      const held = /NoModificationAllowed|Access Handles cannot be created|locked/i.test(`${(error as Error).name} ${(error as Error).message}`);
      if (!held) throw error;
      if (Date.now() > deadline) throw new Error("the browser store is held by another tab of this site; close it and reload");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const ready = installPool().then(({ pool }): DbHost => ({
  open(name) {
    const db = new pool.OpfsSAHPoolDb(name) as unknown as WasmDb & { exec(sql: string): void };
    // The pool keeps one connection: no WAL, a journal file next to the database, a sync on every commit.
    db.exec("PRAGMA synchronous = FULL");
    return db;
  },
  import: (name, bytes) => pool.importDb(name, bytes),
  export: (name) => pool.exportFile(name),
  unlink: (name) => pool.unlink(name),
  files: () => pool.getFileNames(),
}));

const service = ready.then((host) => createSqliteService(host));
let line: Promise<unknown> = Promise.resolve();

scope.addEventListener("message", (event) => {
  const request = event.data as SqliteRequest;
  line = line.then(async () => {
    let serve: Awaited<typeof service>;
    try {
      serve = await service;
    } catch (error) {
      scope.postMessage({ id: request.id, ok: false, error: { name: "Error", message: (error as Error).message } });
      return;
    }
    scope.postMessage(await serve(request));
  });
});
