// An ended workflow run's reads (its end's carry back, and its graph) are lock-free reads of its database (run-db.ts,
// agentrun-pi's unlocked reader): they make no -wal and no -shm beside it, and never remove a WAL that holds commits.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FAUX, flowAgent, follow, letGo, runDir, serve } from "./support.mjs";

/** The run's process, as it leaves its database: a commit in its WAL, kept by process.exit. */
const WRITER = `
import { DatabaseSync } from "node:sqlite";
const [file] = process.argv.slice(1);
const db = new DatabaseSync(file);
db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS later(n INTEGER); INSERT INTO later VALUES (1)");
process.exit(0);
`;

test("an ended workflow run's end and graph are read lock-free: no -wal or -shm made beside its database, and a WAL that holds commits is never removed", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX });
  assert.equal((await api("POST", "/agents", flowAgent("flow"))).status, 201);
  const run = await api("POST", "/agents/flow/runs", { input: { question: "Answer soon." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  await letGo(data, run.body.run_id);
  const file = join(runDir(data, run.body.run_id), "store", "run.sqlite");
  const beside = () => ["-wal", "-shm"].filter((end) => existsSync(`${file}${end}`));
  assert.deepEqual(beside(), [], "its end's reads made nothing beside its database");
  assert.equal((await api("GET", `/runs/${run.body.run_id}/graph`)).status, 200);
  assert.deepEqual(beside(), [], "its graph's read made nothing beside its database");
  // A WAL that holds a commit, as a process that ends by process.exit leaves it: the graph's read leaves it whole.
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", WRITER, file], { stdio: "ignore" });
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
  const size = statSync(`${file}-wal`).size;
  assert.ok(size > 0);
  const graph = await api("GET", `/runs/${run.body.run_id}/graph`);
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  assert.equal(statSync(`${file}-wal`).size, size, "the WAL is there, as it was");
  assert.equal(existsSync(`${file}-shm`), false, "and no -shm beside it");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL");
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM later").get().n), 1, "its commit kept");
  } finally {
    db.close();
  }
});
