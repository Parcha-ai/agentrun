// assertStoreFree, the lock probe a run under its host's epoch makes before it reaps anything: against a store a writer
// holds while its first transaction is still in its WAL (frames, no commit yet), it is refused, and it leaves that WAL,
// every row the writer then commits, and the writer's later commits whole. A probe that opened that WAL would recover no
// frame and remove it at its close, under the writer.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertStoreFree } from "../src/run.ts";
import { HeldError } from "../src/errors.ts";
import { scratchRoot } from "./_run-support.ts";

/** A run's process: its first transaction spans pages (a cache of 2 pages spills them into the WAL before the commit); it
 *  says `spilled`, waits for `go`, commits, adds 10 rows one commit each, says how many it holds, and ends by
 *  process.exit with its WAL kept. */
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

describe("assertStoreFree", () => {
  it("against a held store whose WAL has frames and no commit yet: refused (STORE_BUSY), the WAL left, and every row the holder commits after it is there", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("probe");
    const file = join(dir.root, "run.sqlite");
    try {
      const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", WRITER, file, dir.root], { stdio: ["ignore", "ignore", "inherit"] });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      let refused: unknown;
      try {
        await until(() => existsSync(join(dir.root, "spilled")));
        assert.ok(existsSync(`${file}-wal`), "frames in the WAL, no commit yet");
        try {
          assertStoreFree(file);
        } catch (error) {
          refused = error;
        }
        assert.ok(existsSync(`${file}-wal`), "the probe left the WAL the holder is writing");
      } finally {
        writeFileSync(join(dir.root, "go"), "");
      }
      assert.ok(refused instanceof HeldError && refused.code === "STORE_BUSY", `refused by the store's lock: ${String(refused)}`);
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
      // The store free now: the probe takes it for its read and lets it go.
      assertStoreFree(file);
    } finally {
      dir.remove();
    }
  });
});
