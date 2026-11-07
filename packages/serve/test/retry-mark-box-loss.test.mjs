// A guard, green with no barrier before pi-ai's retry (pi-durable-disk barriers.ts, NORMAL_PRECONDITIONS.retryMarkSynced:
// no barrier needed). A capped request's lost attempt is marked ended at its hold before the retry is sent, and that mark
// is not synced: a box lost while the retry is out may drop it. The request then reads as one a crash cut, at its start
// mark's hold, which modelRequestStarted synced before it left: the same figure the lost mark carries. And no answer of
// the retry can survive without the lost mark, which comes before it in the WAL. So the cap reads the request at its hold
// whether or not the lost mark survives: here a box lost while the retry is out, and a process killed then, which keeps
// every commit. Run on a real run store at NORMAL with pi-durable-disk's fsync-snapshot shim preloaded.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import { REQUEST_ENDED, REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { spentIn } from "../dist/cap.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/box-loss-retry.mjs", import.meta.url));
const SHIM_SRC = fileURLToPath(new URL("../../pi-durable-disk/test/fixtures/fsync-snapshot/shim.c", import.meta.url));
const HOLD = 0.001;
const LINUX = process.platform === "linux";

let shim;
before(() => {
  if (!LINUX) return;
  const dir = mkdtempSync(join(tmpdir(), "retry-shim-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", out, SHIM_SRC, "-ldl"], { encoding: "utf8" });
  if (built.status === 0) shim = out;
  else if (process.env.CI) throw new Error(`the fsync-snapshot shim did not build: ${built.error?.message ?? built.stderr}`);
});

/** The box is lost: each store file goes back to its state at its last sync; a file never synced is gone. */
function loseTheBox(file) {
  for (const each of [file, `${file}-wal`]) {
    if (existsSync(`${each}.synced`)) renameSync(`${each}.synced`, each);
    else rmSync(each, { force: true });
  }
  const dir = join(file, "..");
  for (const name of readdirSync(dir)) if (name.endsWith(".synced") || name.endsWith(".syncing")) rmSync(join(dir, name));
}

const marksOf = (file) => {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'entries'").get()) return [];
    return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(row.record)).filter((e) => e.kind === REQUEST_STARTED || e.kind === REQUEST_ENDED).map((e) => [e.kind, e.data]);
  } finally {
    db.close();
  }
};

/** The request's lost attempt, then its retry out; the process killed (`boxLoss`: and the box lost). */
async function cutDuringRetry(t, boxLoss) {
  const dir = mkdtempSync(join(tmpdir(), "retry-box-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [store, signal] = [join(dir, "store", "run.sqlite"), join(dir, "retry-out")];
  const env = { ...process.env, ...(boxLoss ? { LD_PRELOAD: shim, FSYNC_SNAPSHOT_DIR: join(dir, "store") } : {}) };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [FIXTURE, dir, signal], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => child.kill("SIGKILL"));
  for (const end = Date.now() + 60_000; !existsSync(signal);) {
    assert.equal(child.exitCode, null, `the retry is sent: the process ended first: ${out.slice(-2000)}`);
    assert.ok(Date.now() < end, `the retry is sent within 60 s: ${out.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  await exited;
  if (boxLoss) loseTheBox(store);
  return { marks: marksOf(store), spent: spentIn(store) };
}

test("guard (retryMarkSynced, no barrier needed): a capped request's lost attempt, then pi-ai's retry out, then the process killed or the box lost: the cap reads the request at its hold whether or not the lost mark survived", { skip: !LINUX && "the shim preloads on Linux", timeout: 120_000 }, async (t) => {
  if (!shim) return void assert.ok(!process.env.CI, "the shim is required in CI");
  const killed = await cutDuringRetry(t, false);
  assert.deepEqual(killed.marks, [[REQUEST_STARTED, { heldUsd: HOLD }], [REQUEST_ENDED, { lost: true, heldUsd: HOLD }]], "a killed process keeps every commit: the start and the lost mark");
  const lost = await cutDuringRetry(t, true);
  assert.deepEqual(lost.marks[0], [REQUEST_STARTED, { heldUsd: HOLD }], "the start mark, synced before the request left (modelRequestStarted), survives the box");
  assert.deepEqual([killed.spent, lost.spent], [HOLD, HOLD], `the request reads at its hold either way: the start mark carries the lost mark's figure (box loss kept ${lost.marks.length} mark(s))`);
});
