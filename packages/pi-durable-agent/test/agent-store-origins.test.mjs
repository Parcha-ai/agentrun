// A run's origin: the key its caller starts it under, recorded in the transaction that writes its row, so the same key
// never starts a second run, after a crash or from two starts at once. Real stores in temp dirs; no model calls.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore } from "../dist/index.js";
import { scratch } from "./support.mjs";

const A = { kind: "agentic", instructions: "Answer.", skills: { "read/SKILL.md": "Read.\n" }, tools: ["read"] };
const rows = (dir, sql) => {
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  try { return db.prepare(sql).all().map((row) => ({ ...row })); } finally { db.close(); }
};
const runDirs = (dir) => readdirSync(path.join(dir, "runs")).sort();

async function aStore() {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = await store.createAgent({ name: "Answerer" });
  await store.commitRevision(agent.id, A, { setCurrent: true });
  return { dir, store, agent };
}

test("an origin starts one run: the same key again, even from a store opened again, returns that run with the fingerprint it was recorded with, and seeds and writes nothing", async () => {
  const { dir, store, agent } = await aStore();
  const first = await store.startRun({ agent: agent.id, origin: { key: "k-1", fingerprint: "f-1" } });
  assert.equal(first.existing, undefined, "a new run");
  assert.deepEqual(rows(dir, "SELECT key, run_id, fingerprint FROM run_origins"), [{ key: "k-1", run_id: first.runId, fingerprint: "f-1" }]);
  const again = await store.startRun({ agent: agent.id, origin: { key: "k-1", fingerprint: "f-2" } });
  assert.deepEqual({ ...again, revision: again.revision.id }, { ...first, revision: first.revision.id, existing: { fingerprint: "f-1" } });
  assert.equal(rows(dir, "SELECT id FROM runs").length, 1);
  assert.deepEqual(runDirs(dir), [first.runId], "nothing seeded");
  assert.equal(store.runOfOrigin("k-1").runId, first.runId);
  assert.equal(store.runOfOrigin("k-2"), undefined);
  store.close();
  const reopened = openStore(dir);
  assert.equal((await reopened.startRun({ agent: agent.id, origin: { key: "k-1" } })).runId, first.runId, "kept in the file");
  const other = await reopened.startRun({ agent: agent.id, origin: { key: "k-2" } });
  assert.notEqual(other.runId, first.runId);
  assert.deepEqual(other.existing, undefined);
  assert.deepEqual(reopened.runOfOrigin("k-2").existing, {}, "no fingerprint recorded");
  assert.equal(rows(dir, "SELECT id FROM runs").length, 2);
  reopened.close();
});

test("two starts under one origin at once, on one handle or two, make one run: the later one's seeded directory goes, and it returns the first", async () => {
  const { dir, store, agent } = await aStore();
  const second = openStore(dir);
  for (const [key, a, b] of [["same", store, store], ["two", store, second]]) {
    const started = await Promise.all([a.startRun({ agent: agent.id, origin: { key } }), b.startRun({ agent: agent.id, origin: { key } })]);
    assert.equal(started[0].runId, started[1].runId, key);
    assert.equal(started.filter((run) => run.existing).length, 1, key);
  }
  assert.equal(rows(dir, "SELECT id FROM runs").length, 2);
  assert.deepEqual(runDirs(dir), rows(dir, "SELECT run_id FROM run_origins ORDER BY run_id").map((r) => r.run_id), "no stray directory");
  second.close();
  store.close();
});

test("with no origin a start is as before: a new run each time, no origin written; an origin that is not a key is refused before anything is seeded", async () => {
  const { dir, store, agent } = await aStore();
  const one = await store.startRun({ agent: agent.id });
  const two = await store.startRun({ agent: agent.id });
  assert.notEqual(one.runId, two.runId);
  assert.equal(one.existing, undefined);
  assert.deepEqual(rows(dir, "SELECT * FROM run_origins"), []);
  for (const origin of [{}, { key: "" }, { key: 7 }, { key: "x".repeat(257) }, { key: "k", fingerprint: 7 }, "k"]) {
    await assert.rejects(store.startRun({ agent: agent.id, origin }), (error) => error instanceof AgentHomeError && error.code === "invalid", JSON.stringify(origin));
  }
  assert.equal(rows(dir, "SELECT id FROM runs").length, 2);
  assert.equal(runDirs(dir).length, 2);
  store.close();
});

test("an origin is written once: the file refuses an UPDATE or a DELETE of one", async () => {
  const { dir, store, agent } = await aStore();
  await store.startRun({ agent: agent.id, origin: { key: "k-1" } });
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  assert.throws(() => db.exec("UPDATE run_origins SET key = 'k-2'"), /written once/);
  assert.throws(() => db.exec("DELETE FROM run_origins"), /written once/);
  db.close();
});
