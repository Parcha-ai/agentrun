// The browser store's SQLite worker, in process: SQLite-WASM on an in-memory database behind the same message protocol, with every
// message passing through a structured clone as it does between a page and its Worker.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteService, type DbHost, type SqliteRequest, type WasmDb } from "../tab/sqlite-service.ts";
import type { WorkerLike } from "../tab/sqlite-client.ts";

const sqlite3 = await (sqlite3InitModule as unknown as (options: { print(): void; printErr(): void }) => ReturnType<typeof sqlite3InitModule>)({ print: () => undefined, printErr: () => undefined });

/** A database host on memory: `open` makes a fresh in-memory database whatever its name. */
export const memoryHost: DbHost = { open: (): WasmDb => new sqlite3.oo1.DB(":memory:") as unknown as WasmDb };

export function loopbackWorker(host: DbHost = memoryHost): WorkerLike & { terminated: boolean } {
  const serve = createSqliteService(host);
  const listeners: ((event: { data: unknown }) => void)[] = [];
  let line: Promise<unknown> = Promise.resolve();
  const worker = {
    terminated: false,
    postMessage(message: unknown) {
      if (worker.terminated) throw new Error("the worker was terminated");
      const request = structuredClone(message) as SqliteRequest;
      line = line.then(async () => {
        const response = structuredClone(await serve(request));
        if (!worker.terminated) for (const listener of listeners) listener({ data: response });
      });
    },
    terminate() {
      worker.terminated = true;
    },
    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
      if (type === "message") listeners.push(listener);
    },
  };
  return worker as WorkerLike & { terminated: boolean };
}
