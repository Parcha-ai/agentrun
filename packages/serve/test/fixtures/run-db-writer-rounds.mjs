// A worker for run-db-commit.test.mjs: `rounds` runs of a run's process's database, each on a fresh WAL whose first
// transaction spans pages (a schema, an index and 8 rows of 3,000 bytes), then 5 single-row commits; each round ends as a
// process.exit does, its connection never closed. Before each round it asks the test's thread to remove the files and
// waits until it has: the removal stands for the take-back, which runs on the server's thread between its reads, never
// within one. It counts the rounds whose 13 committed rows a fresh open no longer finds.
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const { file, rounds, removed } = workerData;
const flag = new Int32Array(removed);
const kept = [];
let lost = 0;
for (let round = 0; round < rounds; round++) {
  Atomics.store(flag, 0, 0);
  parentPort.postMessage({ remove: round });
  while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0, 50);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; PRAGMA mmap_size=0; PRAGMA cache_size=2");
  db.exec("BEGIN");
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT); CREATE INDEX i ON t(b)");
  const insert = db.prepare("INSERT INTO t(b) VALUES(?)");
  for (let i = 0; i < 8; i++) insert.run("x".repeat(3000));
  db.exec("COMMIT");
  for (let i = 0; i < 5; i++) insert.run("y".repeat(50));
  // What survives, read through the WAL as a take-back would: a read-only connection of this thread, the writer's lock
  // being this thread's own.
  let n = -1;
  const check = new DatabaseSync(`file:${file}?mode=ro&vfs=unix-none`, { readOnly: true });
  try {
    check.exec("PRAGMA locking_mode = EXCLUSIVE");
    n = Number(check.prepare("SELECT count(*) AS n FROM t").get().n);
  } catch {
    n = -1;
  } finally {
    check.close();
  }
  if (n !== 13) lost++;
  // Held, never closed: a close would checkpoint, which the process's end never does.
  kept.push(db);
}
parentPort.postMessage({ lost, rounds });
