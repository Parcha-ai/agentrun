// raw()'s SQLite connection (store-target.mjs), on a worker thread of its own. node:sqlite is synchronous: on the test's
// main thread a write behind the store's lock would busy-wait there, and when the holder is this process's own store (a
// server or runner a test started in process) its transaction commits only from that same main thread, so the write
// could never get the lock and failed at its timeout, however long ("database is locked"). Here the wait blocks only
// this thread, as the store's own connection waits on its worker (src/store/sqlite/worker.ts).
// Messages: {id, op: "run" | "get" | "all" | "exec" | "close", sql, params}; each answered {id, ok, value} or
// {id, ok: false, error}. The open is answered first, as {id: 0}.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const errorOf = (error) => ({ message: String(error?.message ?? error), code: error?.code, errcode: error?.errcode, errstr: error?.errstr });
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: workerData.readOnly, timeout: workerData.timeout });
  parentPort.postMessage({ id: 0, ok: true });
} catch (error) {
  parentPort.postMessage({ id: 0, ok: false, error: errorOf(error) });
}

parentPort.on("message", ({ id, op, sql, params = [] }) => {
  try {
    let value;
    if (op === "run") value = { changes: Number(db.prepare(sql).run(...params).changes) };
    else if (op === "get") {
      const row = db.prepare(sql).get(...params);
      value = row === undefined ? undefined : { ...row };
    } else if (op === "all") value = db.prepare(sql).all(...params).map((row) => ({ ...row }));
    else if (op === "exec") db.exec(sql);
    else if (op === "close") db.close();
    parentPort.postMessage({ id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: errorOf(error) });
  }
});
