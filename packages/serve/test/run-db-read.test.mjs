// The server's lock-free read of a run's database (run-db.ts readRunDbSync: cap.ts, import-summary.ts), on its own: it
// reads a WAL's frames and leaves the WAL, makes none where there is none, and a read whose file changed between its look
// and its open is dropped and made again. A run database is written as a run's process wrote it (an exclusive WAL, kept
// at exit); its WAL goes as SQLite lets it go, at the close of a connection that opened it the same way.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { observeRunDbOpens, readRunDbSync, runDbTestHooks } from "../dist/run-db.js";
import { scratch } from "./support.mjs";

/** A run's process: its database opened exclusive in WAL mode, `rows` rows more, and process.exit with no close, its WAL
 *  kept. */
const WRITER = `
import { DatabaseSync } from "node:sqlite";
const [file, rows] = process.argv.slice(1);
const db = new DatabaseSync(file);
db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, b TEXT)");
const insert = db.prepare("INSERT INTO t(b) VALUES(?)");
for (let i = 0; i < Number(rows); i++) insert.run("x".repeat(2000));
process.exit(0);
`;

function write(file, rows) {
  const wrote = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--input-type=module", "-e", WRITER, file, String(rows)], { encoding: "utf8" });
  assert.equal(wrote.status, 0, wrote.stderr);
}

/** The WAL copied into the database file and removed: the close of a connection opened as the writer opened it. */
function letGoOfWal(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL");
  db.prepare("SELECT count(*) FROM sqlite_schema").get();
  db.close();
}

test("a lock-free reader of a run database with no WAL makes none; one with a WAL reads its frames and leaves it", async (t) => {
  const file = join(await scratch(t), "run.sqlite");
  write(file, 10);
  const count = () => readRunDbSync(file, false, (db) => [Number(db.prepare("SELECT count(*) AS n FROM t").get().n), existsSync(`${file}-wal`)]);
  assert.deepEqual(count(), [10, true], "the WAL's frames are read, and it stays");
  assert.ok(existsSync(`${file}-wal`), "a read-only close removes no WAL with frames in it");
  letGoOfWal(file);
  assert.equal(existsSync(`${file}-wal`), false);
  assert.deepEqual(count(), [10, false], "no WAL, so none is made: the database file alone");
  assert.equal(existsSync(`${file}-wal`), false);
});

test("a read of the database file alone that a run's write and its WAL's removal overlap is dropped and made again: the read shown is the whole file after them", async (t) => {
  const file = join(await scratch(t), "run.sqlite");
  write(file, 100);
  letGoOfWal(file);
  assert.equal(existsSync(`${file}-wal`), false, "no WAL: the next read is of the file alone");
  // Between the read's look (no WAL) and its open: a run's process writes and exits, and its WAL is let go, so the file
  // the read opens is not the one it looked at.
  let overlapped = 0;
  runDbTestHooks.afterPlan = () => {
    if (overlapped++ > 0) return;
    write(file, 50);
    letGoOfWal(file);
  };
  t.after(() => void (runDbTestHooks.afterPlan = undefined));
  const opens = [];
  t.after(observeRunDbOpens((open) => opens.push(open.mode)));
  const n = readRunDbSync(file, false, (db) => Number(db.prepare("SELECT count(*) AS n FROM t").get().n));
  assert.deepEqual(opens, ["read", "dropped", "read"], "the overlapped read is dropped, and one more is made");
  assert.equal(n, 150, "the read shown is the whole file after the write and the WAL's removal");
});
