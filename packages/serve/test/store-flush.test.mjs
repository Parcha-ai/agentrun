// A commit does not wait for the disk; a flush does (design 2.2). The store runs WAL with synchronous=NORMAL, so a process
// crash loses nothing, and flush() is one commit at FULL that makes every earlier commit durable. A writer process with the
// fsync-snapshot shim preloaded makes a run, flushed or not, and is killed; the box loss then puts each store file back to
// its last fsync. What was not flushed is gone with the box; what was flushed is there; and a kill with no box loss loses
// nothing.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { openSqliteStore } from "../dist/store/sqlite/store.js";

const WRITER = fileURLToPath(new URL("./store-fixtures/store-writer.mjs", import.meta.url));
const SHIM_SRC = fileURLToPath(new URL("./store-fixtures/fsync-snapshot.c", import.meta.url));
const LINUX = process.platform === "linux";

let shim;
before(() => {
  if (!LINUX) return;
  const dir = mkdtempSync(join(tmpdir(), "store-flush-shim-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", out, SHIM_SRC, "-ldl"], { encoding: "utf8" });
  if (built.status === 0) shim = out;
  // CI has a C compiler: there, a shim that does not build fails the suite rather than skipping the box-loss cases.
  else if (process.env.CI) throw new Error(`the fsync-snapshot shim did not build: ${built.error?.message ?? built.stderr}`);
});

/** A writer process on `file` making run `runId` (flushed when `flush`), killed with SIGKILL once it says it wrote. */
async function writtenThenKilled(dir, file, runId, { flush, boxLoss }) {
  const env = { ...process.env, ...(boxLoss ? { LD_PRELOAD: shim, FSYNC_SNAPSHOT_DIR: dir } : {}) };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--no-warnings", WRITER, file, runId, flush ? "flush" : "no-flush"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  for (const end = Date.now() + 60_000; !out.includes("written");) {
    assert.equal(child.exitCode, null, `the writer ended first: ${out}`);
    assert.ok(Date.now() < end, `the writer did not write within 60 s: ${out}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

/** The box is lost: each store file goes back to its state at its last sync; a file never synced is gone. */
function loseTheBox(file) {
  for (const each of [file, `${file}-wal`]) {
    if (existsSync(`${each}.synced`)) renameSync(`${each}.synced`, each);
    else rmSync(each, { force: true });
  }
  rmSync(`${file}-shm`, { force: true });
  const dir = join(file, "..");
  for (const name of readdirSync(dir)) if (name.endsWith(".synced") || name.endsWith(".syncing")) rmSync(join(dir, name));
}

/** The run ids the store holds, as the next process opens it. */
async function runIdsIn(file) {
  const store = await openSqliteStore({ file });
  try {
    return (await store.runs.list({})).map((run) => run.id).sort();
  } finally {
    await store.close();
  }
}

test("a store's open is durable: its schema is there after a box loss with nothing else written", { skip: !LINUX && "the fsync shim is Linux only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-flush-open-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  await writtenThenKilled(dir, file, "run-flushed", { flush: true, boxLoss: true });
  loseTheBox(file);
  assert.deepEqual(await runIdsIn(file), ["run-flushed"], "the flushed run and the schema it lives in survive the box");
});

test("a commit with no flush is lost with the box; a commit before flush() is kept", { skip: !LINUX && "the fsync shim is Linux only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-flush-lost-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  await writtenThenKilled(dir, file, "run-a", { flush: true, boxLoss: true });
  await writtenThenKilled(dir, file, "run-b", { flush: false, boxLoss: true });
  loseTheBox(file);
  assert.deepEqual(await runIdsIn(file), ["run-a"], "run-b was never flushed: the box took it; run-a was flushed");
});

test("a process kill with no box loss loses nothing, flushed or not", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-flush-kill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  await writtenThenKilled(dir, file, "run-a", { flush: false, boxLoss: false });
  await writtenThenKilled(dir, file, "run-b", { flush: false, boxLoss: false });
  assert.deepEqual(await runIdsIn(file), ["run-a", "run-b"]);
});
