// What a run's store keeps through a crash, at NORMAL with barriers (barriers.ts) and at FULL. A process crash is a
// SIGKILL of the writer. A box loss is simulated by a preloaded shim (fixtures/fsync-snapshot/shim.c) that copies each
// store file as it stood at its last fsync: after the writer is killed, those copies replace the files, which is what a
// lost box leaves on its disk.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scratchRoot } from "./_run-support.ts";

const SHIM_SRC = new URL("fixtures/fsync-snapshot/shim.c", import.meta.url).pathname;
const WRITER = new URL("fixtures/fsync-snapshot/writer.ts", import.meta.url).pathname;
const RUN_END = new URL("fixtures/fsync-snapshot/run-end.ts", import.meta.url).pathname;

let shim: string | undefined;
let shimDir: { root: string; remove(): void } | undefined;

before(() => {
  if (process.platform !== "linux") return;
  shimDir = scratchRoot("fsync-shim");
  const out = join(shimDir.root, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", out, SHIM_SRC, "-ldl"], { encoding: "utf8" });
  if (built.status === 0) shim = out;
  // CI has a C compiler: there, a shim that does not build fails the suite rather than skipping the box-loss tests.
  else if (process.env.CI) throw new Error(`the fsync-snapshot shim did not build: ${built.error?.message ?? built.stderr}`);
});

/** Run the writer on a fresh store; `boxLoss` preloads the shim. Returns the commits it saw resolve and the store's path. */
function write(dir: string, level: "FULL" | "NORMAL", script: string, boxLoss: boolean): { file: string; acked: number; barrierAfter: number[] } {
  const file = join(dir, "store", "run.sqlite");
  const env = { ...process.env, ...(boxLoss ? { LD_PRELOAD: shim!, FSYNC_SNAPSHOT_DIR: join(dir, "store") } : {}) };
  const child = spawnSync(process.execPath, [WRITER, file, level, script], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(child.signal, "SIGKILL", `the writer ended by its own SIGKILL: ${child.stderr}`);
  assert.match(child.stdout, /done\n$/);
  const acked = [...child.stdout.matchAll(/^commit (\d+)$/gm)].length;
  const barrierAfter = [...child.stdout.matchAll(/^barrier after (\d+)$/gm)].map((m) => Number(m[1]));
  return { file, acked, barrierAfter };
}

/** The box is lost: each store file goes back to its state at its last sync; a file never synced is gone. */
function loseTheBox(file: string): void {
  for (const each of [file, `${file}-wal`]) {
    if (existsSync(`${each}.synced`)) renameSync(`${each}.synced`, each);
    else rmSync(each, { force: true });
  }
  const dir = join(file, "..");
  for (const name of readdirSync(dir)) if (name.endsWith(".synced") || name.endsWith(".syncing")) rmSync(join(dir, name));
}

function rows(file: string): { n: number[]; integrity: string } {
  if (!existsSync(file)) return { n: [], integrity: "no file" };
  const db = new DatabaseSync(file);
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 't'").get();
    const n = has ? (db.prepare("SELECT n FROM t ORDER BY n").all() as { n: number }[]).map((r) => r.n) : [];
    return { n, integrity: String(Object.values(db.prepare("PRAGMA integrity_check").get()!)[0]) };
  } finally {
    db.close();
  }
}

const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const c = (n: number) => Array.from({ length: n }, () => "c").join(",");

describe("a run's store through a crash", () => {
  it("at NORMAL, a process crash (SIGKILL) loses no commit that resolved", () => {
    const dir = scratchRoot("crash-kill");
    try {
      const { file, acked } = write(dir.root, "NORMAL", c(40), false);
      assert.equal(acked, 40);
      assert.deepEqual(rows(file), { n: upTo(40), integrity: "ok" });
    } finally {
      dir.remove();
    }
  });

  it("at NORMAL, a box loss keeps every commit up to the last barrier, the barrier's own included, and the commits after it are gone", { skip: process.platform !== "linux" && "the shim preloads on Linux" }, () => {
    if (!shim) return void assert.ok(!process.env.CI, "the shim is required in CI");
    const dir = scratchRoot("crash-box");
    try {
      const { file, acked, barrierAfter } = write(dir.root, "NORMAL", `${c(25)},b,${c(10)},b,${c(15)}`, true);
      assert.deepEqual([acked, barrierAfter], [50, [25, 35]]);
      loseTheBox(file);
      assert.deepEqual(rows(file), { n: upTo(35), integrity: "ok" }, "commits 1-35 (before the last barrier) kept, 36-50 lost");
    } finally {
      dir.remove();
    }
  });

  it("at NORMAL with no barrier, a box loss takes every commit since the store was opened: the control", { skip: process.platform !== "linux" && "the shim preloads on Linux" }, () => {
    if (!shim) return void assert.ok(!process.env.CI, "the shim is required in CI");
    const dir = scratchRoot("crash-box-control");
    try {
      const { file, acked } = write(dir.root, "NORMAL", c(30), true);
      assert.equal(acked, 30);
      loseTheBox(file);
      assert.deepEqual(rows(file).n, [], "no commit was synced, so none survives");
    } finally {
      dir.remove();
    }
  });

  it("at FULL, a box loss keeps every commit that resolved: today's store", { skip: process.platform !== "linux" && "the shim preloads on Linux" }, () => {
    if (!shim) return void assert.ok(!process.env.CI, "the shim is required in CI");
    const dir = scratchRoot("crash-box-full");
    try {
      const { file, acked } = write(dir.root, "FULL", `${c(20)},b,${c(20)}`, true);
      assert.equal(acked, 40);
      loseTheBox(file);
      assert.deepEqual(rows(file), { n: upTo(40), integrity: "ok" });
    } finally {
      dir.remove();
    }
  });
});

type End = "done" | "sleeping" | "release";
type NextView = { previous: { status: string; detail: unknown; wakeAt: string | null } | null; instructions: string | null };

/** A run that ends the way named, then its box is lost the moment the end resolved; the next incarnation's view. */
async function endThenLoseTheBox(root: string, end: End): Promise<NextView> {
  const child = spawn(process.execPath, [RUN_END, root, end, "first", "1"], { env: { ...process.env, LD_PRELOAD: shim!, FSYNC_SNAPSHOT_DIR: join(root, "store") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  for (const deadline = Date.now() + 60_000; !out.includes("ended\n"); await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill("SIGKILL");
      throw new Error(`the run never ended: ${err.slice(-600)}`);
    }
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  loseTheBox(join(root, "store", "run.sqlite"));
  const next = spawnSync(process.execPath, [RUN_END, root, end, "resume", "2"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(next.status, 0, next.stderr.slice(-600));
  return JSON.parse(next.stdout.trim().split("\n").pop()!);
}

describe("a run's ends through a box loss, at NORMAL (barriers.ts runStatus, runRelease)", () => {
  const cases: { name: string; end: End; expected: NextView }[] = [
    { name: "a done status (Run.setStatus)", end: "done", expected: { previous: { status: "done", detail: { ended: true }, wakeAt: null }, instructions: "kept through the end" } },
    { name: "a sleeping status with its wake time (Run.setStatus, as a park writes it)", end: "sleeping", expected: { previous: { status: "sleeping", detail: { reason: "waiting" }, wakeAt: "2030-01-01T00:00:00.000Z" }, instructions: "kept through the end" } },
    { name: "a release (DurableRun.release, its WAL kept)", end: "release", expected: { previous: { status: "paused", detail: null, wakeAt: null }, instructions: "kept through the end" } },
  ];
  for (const { name, end, expected } of cases) {
    it(`${name} is in the store after a box loss, with every commit before it`, { skip: process.platform !== "linux" && "the shim preloads on Linux" }, async () => {
      if (!shim) return void assert.ok(!process.env.CI, "the shim is required in CI");
      const dir = scratchRoot(`crash-end-${end}`);
      try {
        assert.deepEqual(await endThenLoseTheBox(join(dir.root, "run"), end), expected);
      } finally {
        dir.remove();
      }
    });
  }
});

process.on("exit", () => shimDir?.remove());
