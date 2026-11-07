// What a run's database relies on in node:sqlite, pinned so a Node upgrade that changes it goes red: a WAL database whose
// process ends with process.exit and no close keeps its WAL and leaves the database file as it was, and a fresh
// read-only, lock-free reader sees every row; a close checkpoints the WAL into the database file. A run's process ends
// the first way (store.ts, the exclusive profile's keepWal), and the server checkpoints when it takes the run back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openArchilStore } from "../src/store.ts";

const ROWS = 200;
/** A child that makes `file` WAL-exclusive with one table, records its size and sha256 (`<file>.before`), writes ROWS
 *  rows, and then ends by `how`: `exit` (process.exit(0), no close) or `close`. */
const CHILD = `
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
const [file, how] = process.argv.slice(1);
const db = new DatabaseSync(file);
db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
writeFileSync(file + ".before", JSON.stringify({ size: statSync(file).size, sha: createHash("sha256").update(readFileSync(file)).digest("hex") }));
const insert = db.prepare("INSERT INTO t(b) VALUES(?)");
for (let i = 0; i < ${ROWS}; i++) insert.run("x".repeat(500));
if (how === "close") db.close();
process.exit(0);
`;

const scratch = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "pdd-wal-exit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const writeIn = (file: string, how: "exit" | "close") => {
  const ran = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--input-type=module", "-e", CHILD, file, how], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(readFileSync(`${file}.before`, "utf8")) as { size: number; sha: string };
};
const rowsOf = (file: string): number => {
  const reader = new DatabaseSync(`file:${file}?mode=ro&vfs=unix-none`, { readOnly: true });
  try {
    reader.exec("PRAGMA locking_mode = EXCLUSIVE");
    return Number((reader.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n);
  } finally {
    reader.close();
  }
};

describe("node:sqlite, as a run's database relies on it", () => {
  it("process.exit without a close: the database file is as it was, the WAL holds every row, and a fresh unix-none reader sees them", (t) => {
    const file = join(scratch(t), "run.sqlite");
    const before = writeIn(file, "exit");
    assert.equal(statSync(file).size, before.size, "the database file's size is unchanged");
    assert.equal(sha(file), before.sha, "the database file's bytes are unchanged");
    assert.ok(existsSync(`${file}-wal`) && statSync(`${file}-wal`).size > ROWS * 500, "the WAL is there, with the rows");
    assert.equal(rowsOf(file), ROWS);
  });

  it("a close checkpoints: the rows go into the database file and the WAL is gone", (t) => {
    const file = join(scratch(t), "run.sqlite");
    const before = writeIn(file, "close");
    assert.notEqual(sha(file), before.sha, "the database file changed");
    assert.ok(statSync(file).size > before.size + ROWS * 400, "it holds the rows");
    assert.ok(!existsSync(`${file}-wal`) || statSync(`${file}-wal`).size === 0, "no WAL is left");
    assert.equal(rowsOf(file), ROWS);
  });
});

describe("the exclusive profile: a run's database", () => {
  it("reads back WAL, an exclusive lock, wal_autocheckpoint 0 and synchronous FULL", async (t) => {
    const store = await openArchilStore(join(scratch(t), "run.sqlite"));
    try {
      assert.deepEqual({ ...(await store.database.get("PRAGMA wal_autocheckpoint")) }, { wal_autocheckpoint: 0 });
      assert.deepEqual({ ...(await store.database.get("PRAGMA journal_mode")) }, { journal_mode: "wal" });
      assert.deepEqual({ ...(await store.database.get("PRAGMA locking_mode")) }, { locking_mode: "exclusive" });
    } finally {
      await store.database.close();
    }
  });

  it("a run's writer never checkpoints: after its writes and its exit, the WAL header's checkpoint sequence is still 0, with wal_autocheckpoint 0 read back", (t) => {
    // agentrun-pi's wal.ts keeps a verified walk under the WAL's inode and its header: true only while the writer never
    // checkpoints, so any rewrite of the WAL comes with a new header (new salts) and misses the kept walk.
    const file = join(scratch(t), "run.sqlite");
    const child = `
import { openArchilStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
import { writeFileSync } from "node:fs";
const [file] = process.argv.slice(1);
const store = await openArchilStore(file, "exclusive", { keepWal: true });
const auto = await store.database.get("PRAGMA wal_autocheckpoint");
await store.database.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)");
for (let i = 0; i < ${ROWS}; i++) await store.database.exec("INSERT INTO t(b) VALUES ('" + "x".repeat(500) + "')");
writeFileSync(file + ".auto", JSON.stringify(auto));
await store.database.close();
process.exit(0);
`;
    const ran = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", child, file], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(readFileSync(`${file}.auto`, "utf8")), { wal_autocheckpoint: 0 });
    const header = readFileSync(`${file}-wal`).subarray(0, 32);
    assert.equal(header.readUInt32BE(0) & 0xfffffffe, 0x377f0682, "a WAL");
    assert.equal(header.readUInt32BE(12), 0, "its checkpoint sequence: never checkpointed");
    assert.ok(statSync(`${file}-wal`).size > ROWS * 500, "every write in the WAL");
  });

  it("with keepWal, its close leaves the WAL and the database file as they are; the process's exit ends it", (t) => {
    const file = join(scratch(t), "run.sqlite");
    const child = `
import { openArchilStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
const [file] = process.argv.slice(1);
const store = await openArchilStore(file, "exclusive", { keepWal: true });
await store.database.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)");
await store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
writeFileSync(file + ".before", JSON.stringify({ size: statSync(file).size, sha: createHash("sha256").update(readFileSync(file)).digest("hex") }));
for (let i = 0; i < ${ROWS}; i++) await store.database.exec("INSERT INTO t(b) VALUES ('" + "x".repeat(500) + "')");
await store.database.close();
process.exit(0);
`;
    const ran = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", child, file], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const before = JSON.parse(readFileSync(`${file}.before`, "utf8")) as { size: number; sha: string };
    assert.equal(sha(file), before.sha, "the close checkpointed nothing");
    assert.ok(statSync(`${file}-wal`).size > ROWS * 500);
    assert.equal(rowsOf(file), ROWS);
  });
});
