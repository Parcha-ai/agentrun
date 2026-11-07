// A non-pi harness's model request through a box loss, on the run's store at synchronous NORMAL (pi-durable-disk
// barriers.ts sideRequestStarted): the server's start mark for the request (REQUEST_STARTED, harness-app.ts) is committed
// and synced before the request leaves. claude-agent on the faux harness, whose script holds a request admitted and never
// answered, saying so in a file the moment it is admitted. The run's process carries pi-durable-disk's fsync-snapshot
// shim, which keeps each store file as it stood at its last sync; with the request admitted, those copies are put back
// in place of the store's files and the process is killed: what a lost box leaves on its disk. The store then holds the
// request's start mark, so the run's spend counts it.
// At FULL (the run's store on main today) every commit syncs, so this passes with or without the barrier; it bites at
// NORMAL, shown red on the flip branch with the barrier removed, and runs at NORMAL in CI once the flip lands.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { agent, runDir, runRecordOf, scratch, serve, withEnv } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SHIM = new URL("../../pi-durable-disk/test/fixtures/fsync-snapshot/shim.c", import.meta.url).pathname;

/** The marks of `kind` in a copy of the store files in `dir` (the copy is read, never the run's own files). */
function marksIn(store, kind, scratchDir) {
  mkdirSync(scratchDir, { recursive: true });
  for (const name of readdirSync(join(store, ".."))) if (name.startsWith("run.sqlite") && !/\.(synced|syncing)$/.test(name)) copyFileSync(join(store, "..", name), join(scratchDir, name));
  const db = new DatabaseSync(join(scratchDir, "run.sqlite"));
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'entries'").get()) return [];
    return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(row.record)).filter((entry) => entry.kind === kind);
  } finally {
    db.close();
  }
}

test("a non-pi harness's model request through a box loss: its start mark is in the store the box leaves", { skip: process.platform !== "linux" && "the shim preloads on Linux", timeout: 240_000 }, async (t) => {
  const dir = await scratch(t);
  const lib = join(dir, "shim.so");
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", lib, SHIM, "-ldl"], { encoding: "utf8" });
  if (built.status !== 0) {
    assert.ok(!process.env.CI, `the fsync-snapshot shim did not build: ${built.stderr}`);
    return;
  }
  const data = join(dir, "agents");
  // The run's process inherits these (runs.ts childEnv): the shim keeps the files under the data root as of their last sync.
  withEnv(t, { LD_PRELOAD: lib, FSYNC_SNAPSHOT_DIR: join(realpathSync(dir), "agents") });
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS, data });
  const signal = join(dir, "in-flight");
  assert.equal((await api("POST", "/agents", agent("side", { harness: "claude-agent", instructions: `Hold a request unanswered (signal ${signal}).` }))).status, 201);
  const started = await api("POST", "/agents/side/runs", { input: { content: "go" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  for (const end = Date.now() + 90_000; !existsSync(signal); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, "the model request is in flight");
  // The box is lost with the request in flight: the store's files go back to their last sync, then the process dies.
  const store = join(runDir(data, runId), "store", "run.sqlite");
  const holder = runRecordOf(data, runId).holder.pid;
  // The database file was written and synced by the server when it seeded the run, before this process: one this
  // process never synced is as the server left it. Its WAL is this process's alone: unsynced, it is gone.
  if (existsSync(`${store}.synced`)) renameSync(`${store}.synced`, store);
  if (existsSync(`${store}-wal.synced`)) renameSync(`${store}-wal.synced`, `${store}-wal`);
  else rmSync(`${store}-wal`, { force: true });
  process.kill(holder, "SIGKILL");
  const marks = marksIn(store, REQUEST_STARTED, join(dir, "read"));
  assert.equal(marks.length, 1, `the request's start mark is in the store the box left: ${JSON.stringify(marks)}`);
  assert.equal(marks[0].data.request, 1);
  await api("POST", `/runs/${runId}/cancel`, {});
});
