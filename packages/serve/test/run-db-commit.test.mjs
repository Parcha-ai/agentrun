// A lock-free reader of a run's database must never open a WAL that holds frames but no commit yet: SQLite's recovery
// takes a WAL's end at its last verified commit frame, so such a reader recovers no frame, and its close, an empty
// checkpoint, removes the WAL the run's process is still writing, its committed rows with it. That window is a fresh WAL's
// first transaction while it holds more than one page: pi-durable's schema commit, and every relaunch's first commit after
// a take-back checkpointed and removed the WAL. Both reader paths (run-db.ts readRunDbSync, agentrun-pi's `unlocked`
// read) read such a database as the file alone, and no row the writer committed is lost.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { keptWalWalks } from "@parcha/agentrun-pi/durable";
import { withDurableFile } from "../../pi/dist/durable/readers.js";
import { checkpointRunDb, readRunDbSync } from "../dist/run-db.js";
import { scratch } from "./support.mjs";

/** A run's process whose first transaction spans many pages (a schema and 40 rows of 3,000 bytes, a cache of 2 pages so
 *  they spill into the WAL before its commit): it says `spilled` once frames are in the WAL with no commit, waits for
 *  `go`, commits, adds 10 rows, says how many it holds, and ends by process.exit, its WAL kept. */
const WRITER = `
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
const [file, dir, schema] = process.argv.slice(1);
const db = new DatabaseSync(file);
db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; PRAGMA mmap_size=0; PRAGMA cache_size=2");
db.exec("BEGIN");
if (schema === "1") db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)");
const ins = db.prepare("INSERT INTO t(b) VALUES(?)");
for (let i = 0; i < 40; i++) ins.run("x".repeat(3000));
writeFileSync(dir + "/spilled", "");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(dir + "/go")) Atomics.wait(wait, 0, 0, 5);
db.exec("COMMIT");
for (let i = 0; i < 10; i++) ins.run("y".repeat(100));
writeFileSync(dir + "/done", JSON.stringify({ rows: db.prepare("SELECT count(*) AS n FROM t").get().n }));
process.exit(0);
`;

const until = async (done, ms = 20_000) => {
  for (const end = Date.now() + ms; !done(); await new Promise((resolve) => setTimeout(resolve, 5))) assert.ok(Date.now() < end, "timed out");
};

/** One writer run in `dir`: started, read mid-first-transaction by `read`, then let go (always, so a failed check never
 *  leaves it waiting); what the read saw and left, and the rows the writer says it committed. */
async function writerRun(dir, file, schema, read) {
  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--input-type=module", "-e", WRITER, file, dir, schema ? "1" : "0"], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let said;
  let walBefore = false;
  let walAfter = false;
  try {
    await until(() => existsSync(join(dir, "spilled")));
    walBefore = existsSync(`${file}-wal`);
    try {
      said = read();
    } catch (error) {
      said = `failed: ${error.message}`;
    }
    walAfter = existsSync(`${file}-wal`);
  } finally {
    writeFileSync(join(dir, "go"), "");
  }
  try {
    await until(() => existsSync(join(dir, "done")));
  } catch (error) {
    child.kill();
    throw error;
  }
  assert.equal(await exited, 0, err);
  const committed = JSON.parse(readFileSync(join(dir, "done"), "utf8")).rows;
  return { said, committed, walBefore, walAfter };
}

/** The rows a fresh open of `file` finds, as the take-back's checkpoint opens it. */
const rowsOf = (file) => {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL");
    return Number(db.prepare("SELECT count(*) AS n FROM t").get().n);
  } catch (error) {
    return `none (${error.message})`;
  } finally {
    db.close();
  }
};

const PATHS = {
  "run-db readRunDbSync": (file) => readRunDbSync(file, true, (db) => db.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n),
  "agentrun-pi unlocked": (file) => withDurableFile(file, (db) => db.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n, { unlocked: true }),
};

for (const [path, read] of Object.entries(PATHS)) {
  test(`${path}: a read during a fresh WAL's first, multi-frame transaction (the schema's) leaves that WAL, and every committed row is there after the writer's exit`, { timeout: 60_000 }, async (t) => {
    const dir = await scratch(t);
    const file = join(dir, "run.sqlite");
    const run = await writerRun(dir, file, true, () => read(file));
    const found = rowsOf(file);
    t.diagnostic(`writer committed ${run.committed}; a fresh open after its exit finds ${found}; WAL before the read ${run.walBefore}, after ${run.walAfter}`);
    assert.equal(run.committed, 50);
    assert.ok(run.walBefore, "frames are in the WAL, with no commit yet");
    assert.ok(run.walAfter, "the read left the WAL the writer is writing");
    assert.equal(found, 50, "the rows the writer committed survive the read");
  });

  test(`${path}: a read during a relaunch's first, multi-frame transaction after the take-back checkpointed and removed the WAL leaves the new WAL, and no row is lost`, { timeout: 60_000 }, async (t) => {
    const dir = await scratch(t);
    const file = join(dir, "run.sqlite");
    const first = join(dir, "first");
    const again = join(dir, "again");
    for (const step of [first, again]) mkdirSync(step);
    await writerRun(first, file, true, () => 0);
    read(file);
    const kept = keptWalWalks();
    await checkpointRunDb(file, false);
    assert.equal(existsSync(`${file}-wal`), false, "the take-back removed the WAL");
    assert.equal(keptWalWalks(), kept - 1, "and what was kept of its walk");
    const run = await writerRun(again, file, false, () => read(file));
    const found = rowsOf(file);
    t.diagnostic(`writer committed ${run.committed}; a fresh open after its exit finds ${found}; WAL before the read ${run.walBefore}, after ${run.walAfter}`);
    assert.equal(run.committed, 100);
    assert.ok(run.walBefore, "frames are in the relaunch's new WAL, with no commit yet");
    assert.ok(run.walAfter, "the read left the WAL the relaunch is writing");
    assert.equal(found, 100, "the relaunch's committed rows survive the read");
  });
}

test("readers polling as fast as they can across many fresh WALs whose first transaction spans pages: no round loses a row", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const file = join(dir, "run.sqlite");
  const ROUNDS = 60;
  const removed = new SharedArrayBuffer(4);
  const flag = new Int32Array(removed);
  const worker = new Worker(new URL("./fixtures/run-db-writer-rounds.mjs", import.meta.url), { workerData: { file, rounds: ROUNDS, removed } });
  let finished = false;
  const done = new Promise((resolve, reject) => {
    worker.on("message", (said) => {
      if (said.remove === undefined) return (finished = true), resolve(said);
      // The take-back's part, on this thread between reads: the run's files go, and the next run starts on none.
      for (const path of [file, `${file}-wal`, `${file}-shm`]) rmSync(path, { force: true });
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });
    worker.once("error", (error) => ((finished = true), reject(error)));
  });
  let reads = 0;
  while (!finished) {
    if (existsSync(file)) {
      for (const read of Object.values(PATHS)) {
        try {
          read(file);
          reads++;
        } catch {}
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const { lost } = await done;
  assert.ok(reads > ROUNDS, `the readers read (${reads})`);
  assert.equal(lost, 0, `rounds whose committed rows were lost: ${lost} of ${ROUNDS}`);
});
