// The take-back's checkpoint of a run's database (run-db.ts checkpointRunDb) against the server's lock-free readers,
// which do not wait on it: every reader path (run-db.ts openRunReader: readStore, tookMessage, cap.ts, import-summary,
// import.ts; and agentrun-pi's `unlocked` read: durableDecisions) reads in other processes, over and over, while runs'
// processes write and exit with their WAL kept and the server checkpoints after each. No read fails, and none sees
// fewer rows than one before it: the checkpoint copies into the database file only pages the WAL also holds, and lets
// go of the WAL by removing it, never by cutting a file a reader still reads. And no reader makes or removes a WAL: SQLite's
// reader makes one where there is none and removes an empty one at its close, so a reader opens a database with no WAL,
// or an empty one, as an immutable file (run-db.ts runReaderUri).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkpointRunDb, openRunReader } from "../dist/run-db.js";
import { scratch } from "./support.mjs";

const READER = new URL("./fixtures/run-db-reader.mjs", import.meta.url).pathname;
/** A run's process: its database as pi-durable-disk's exclusive profile opens it, `rows` rows more, and process.exit with
 *  no close, its WAL kept. */
const WRITER = `
import { DatabaseSync } from "node:sqlite";
const [file, rows] = process.argv.slice(1);
const db = new DatabaseSync(file);
db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, b TEXT)");
const insert = db.prepare("INSERT INTO t(b) VALUES(?)");
for (let i = 0; i < Number(rows); i++) insert.run("x".repeat(2000));
process.exit(0);
`;

const reader = (file, how, ms) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", READER, file, how, String(ms)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.once("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`reader ${how} exited ${code}: ${err}`))));
});

test("the take-back's checkpoint never tears a lock-free read: readers of every path, in other processes, during twelve write-exit-checkpoint rounds, see no failure and never fewer rows", { timeout: 120_000 }, async (t) => {
  const file = join(await scratch(t), "run.sqlite");
  const round = () => {
    const wrote = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--input-type=module", "-e", WRITER, file, "300"], { encoding: "utf8" });
    assert.equal(wrote.status, 0, wrote.stderr);
  };
  round();
  const reading = Promise.all(["run-db", "run-db", "durable", "durable"].map((how) => reader(file, how, 8_000)));
  for (let i = 0; i < 12; i++) {
    await checkpointRunDb(file, false);
    // As in the server, where every read opens, reads and closes in one turn of its event loop: no read is still open when
    // a run's process starts. A reader in another process here may have made an empty WAL after the checkpoint; it is
    // gone once that read closes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    round();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await checkpointRunDb(file, false);
  const results = await reading;
  // No write was lost: no reader removed a WAL a run's process was writing.
  const db = openRunReader(file);
  try {
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM t").get().n), 13 * 300, "every round's rows are in the database");
  } finally {
    db.close();
  }
  for (const [i, result] of results.entries()) {
    assert.ok(result.reads > 50, `reader ${i} read (${JSON.stringify(result)})`);
    assert.equal(result.errors, 0, `reader ${i} never failed: ${JSON.stringify(result)}`);
    assert.equal(result.behind, 0, `reader ${i} never saw fewer rows: ${JSON.stringify(result)}`);
  }
});

test("a lock-free reader of a run database with no WAL makes none, and removes none a writer made meanwhile; one with a WAL reads its frames", async (t) => {
  const file = join(await scratch(t), "run.sqlite");
  const wrote = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--input-type=module", "-e", WRITER, file, "10"], { encoding: "utf8" });
  assert.equal(wrote.status, 0, wrote.stderr);
  const count = () => {
    const db = openRunReader(file);
    try {
      return [Number(db.prepare("SELECT count(*) AS n FROM t").get().n), existsSync(`${file}-wal`)];
    } finally {
      db.close();
    }
  };
  assert.deepEqual(count(), [10, true], "the WAL's frames are read, and it stays");
  assert.ok(existsSync(`${file}-wal`), "a read-only close removes no WAL with frames in it");
  await checkpointRunDb(file, false);
  assert.equal(existsSync(`${file}-wal`), false);
  assert.deepEqual(count(), [10, false], "no WAL, so none is made: the database file alone");
  assert.equal(existsSync(`${file}-wal`), false);
});

