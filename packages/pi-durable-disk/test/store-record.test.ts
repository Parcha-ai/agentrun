// A run keeps its record in its own store, and the store's own lock is the only lock: no run.json, no owner.lock, no
// heartbeat. A library caller with no host epoch gets the previous record's generation plus 1, read under that lock.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exitCodeFor, HeldError } from "../src/errors.ts";
import { localRun } from "../src/local-run.ts";
import { openDurableRun } from "../src/run.ts";
import { readLocalRunStatus } from "../src/index.ts";
import { scratchRoot, scriptedHarness } from "./_run-support.ts";

const ref = { disk: "local", region: "local", id: "record-1" };

/** A run's process as store-probe.test.ts has it: its first transaction spills pages into the WAL before the commit; it
 *  says `spilled`, waits for `go`, commits, adds 10 rows one commit each, says how many it holds, and exits with its WAL
 *  kept. */
const WRITER = `
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
const [file, dir] = process.argv.slice(1);
const db = new DatabaseSync(file);
db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; PRAGMA cache_size=2");
db.exec("BEGIN; CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)");
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

const until = async (done: () => boolean) => {
  for (const end = Date.now() + 20_000; !done(); await new Promise((resolve) => setTimeout(resolve, 5))) assert.ok(Date.now() < end, "timed out");
};

describe("a run's record, in its store", () => {
  it("an open with no epoch writes no run.json and no owner.lock, and takes the previous record's generation plus 1", async () => {
    const dir = scratchRoot("store-record");
    try {
      const scripted = scriptedHarness();
      const options = { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } };
      const first = await openDurableRun(ref, options);
      assert.equal(first.generation, 1);
      assert.equal(first.record.status, "running");
      await first.setStatus("paused", { why: "a planned stop" });
      await first.release();
      const second = await openDurableRun(ref, options);
      assert.equal(second.generation, 2, "the previous record's generation plus 1");
      await second.setStatus("done", { record: 42 });
      await second.release();
      assert.deepEqual(readdirSync(dir.root).filter((name) => /^(run\.json|run\.json\.tmp|owner\.lock)/.test(name)), [], "no lease file in the run's directory");
      const record = await readLocalRunStatus(dir.root);
      assert.equal(record?.status, "done");
      assert.equal(record?.generation, 2);
      assert.deepEqual(record?.detail, { record: 42 });
    } finally {
      dir.remove();
    }
  });

  it("a leftover run.json and owner.lock beside the store are ignored and left as they were", async () => {
    const dir = scratchRoot("store-record-leftover");
    try {
      const scripted = scriptedHarness();
      const options = { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } };
      const stale = JSON.stringify({ run: ref.id, status: "running", generation: 41, sealedSeq: 999, wakeAt: null, holder: { driver: "local", host: "h", bootId: null, pid: process.pid, since: new Date().toISOString() }, heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString(), detail: null });
      writeFileSync(join(dir.root, "run.json"), stale);
      writeFileSync(join(dir.root, "owner.lock"), "");
      const run = await openDurableRun(ref, options);
      assert.equal(run.generation, 1, "the generation comes from the store, not from a leftover file");
      await run.release();
      assert.equal(readFileSync(join(dir.root, "run.json"), "utf8"), stale, "the leftover file is never read nor written");
      assert.ok(existsSync(join(dir.root, "owner.lock")));
    } finally {
      dir.remove();
    }
  });

  it("two opens at once: one holds the run and the other is refused by the store's lock, HeldError store, exit 76", async () => {
    const dir = scratchRoot("store-record-two");
    try {
      const scripted = scriptedHarness();
      const options = { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } };
      await (await openDurableRun(ref, options)).release();
      const settled = await Promise.allSettled([openDurableRun(ref, options), openDurableRun(ref, options)]);
      const opened = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      const refused = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
      assert.equal(opened.length, 1, `exactly one open holds the run: ${refused.map(String).join("; ")}`);
      assert.equal(refused.length, 1);
      assert.ok(refused[0] instanceof HeldError, String(refused[0]));
      assert.equal((refused[0] as HeldError).holder, "store");
      assert.equal(exitCodeFor(refused[0]), 76);
      assert.equal(opened[0]!.generation, 2);
      await assert.rejects(readLocalRunStatus(dir.root), (error: unknown) => error instanceof HeldError && error.holder === "store", "a held run's record is not read beside it");
      await opened[0]!.release();
    } finally {
      dir.remove();
    }
  });

  it("readLocalRunStatus beside a live writer mid-first-transaction (frames, no commit): HeldError store, the WAL left, and every row it then commits there", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("store-record-live");
    const store = join(dir.root, "store");
    const file = join(store, "run.sqlite");
    try {
      mkdirSync(store, { recursive: true });
      const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", WRITER, file, dir.root], { stdio: ["ignore", "ignore", "inherit"] });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      let refused: unknown;
      try {
        await until(() => existsSync(join(dir.root, "spilled")));
        assert.ok(existsSync(`${file}-wal`), "frames in the WAL, no commit yet");
        refused = await readLocalRunStatus(dir.root).then(() => undefined, (error: unknown) => error);
        assert.ok(existsSync(`${file}-wal`), "the read left the WAL the holder is writing");
      } finally {
        writeFileSync(join(dir.root, "go"), "");
      }
      assert.ok(refused instanceof HeldError && refused.holder === "store", `refused by the store's lock: ${String(refused)}`);
      assert.equal(exitCodeFor(refused), 76);
      await until(() => existsSync(join(dir.root, "done")));
      assert.equal(await exited, 0);
      assert.equal(JSON.parse(readFileSync(join(dir.root, "done"), "utf8")).rows, 50);
      const db = new DatabaseSync(file);
      try {
        db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL");
        assert.equal(Number((db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n), 50, "every row the holder committed");
      } finally {
        db.close();
      }
    } finally {
      dir.remove();
    }
  });
});
