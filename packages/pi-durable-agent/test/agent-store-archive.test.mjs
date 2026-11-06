// Archiving in the agent store: an agent or a run is hidden, never deleted. Each change appends one row to
// archive_changes, written once; an item's archive state is its newest row. A store written before archiving opens.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore, openStoreReader } from "../dist/index.js";
import { scratch } from "./support.mjs";

const refused = (code) => (error) => error instanceof AgentHomeError && error.code === code;
const A = { kind: "agentic", instructions: "Answer.", tools: [] };
const changes = (dir) => {
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT kind, id, archived FROM archive_changes ORDER BY seq").all().map((r) => [r.kind, r.id, r.archived]);
  } finally {
    db.close();
  }
};

/** A store with one agent, its revision, and one ended run. */
async function seeded() {
  const dir = await scratch();
  const store = openStore(dir);
  const agent = store.createAgent({ name: "Calc", id: "calc" });
  await store.commitRevision(agent.id, A, { setCurrent: true });
  const { runId } = await store.startRun({ agent: agent.id });
  store.carryBack(runId, { state: "completed", costUsd: 0.25 });
  return { dir, store, runId };
}

test("archiving an agent or a run writes one row per change; the same change again writes nothing", async () => {
  const { dir, store, runId } = await seeded();
  const archived = store.setArchived("agent", "calc", true);
  assert.equal(typeof archived, "string");
  assert.equal(store.setArchived("agent", "calc", true), archived, "archiving it again keeps the first time");
  assert.equal(store.setArchived("run", runId, true) !== null, true);
  assert.equal(store.setArchived("run", runId, false), null);
  assert.equal(store.setArchived("run", runId, false), null);
  assert.deepEqual(changes(dir), [["agent", "calc", 1], ["run", runId, 1], ["run", runId, 0]]);
  store.close();
});

test("the reads carry archivedAt: an archived agent's, and a run's own or else its agent's", async () => {
  const { dir, store, runId } = await seeded();
  assert.equal(store.listAgents()[0].archivedAt, undefined);
  assert.equal(store.readRun(runId).archivedAt, undefined);
  const at = store.setArchived("agent", "calc", true);
  assert.equal(store.listAgents()[0].archivedAt, at);
  assert.equal(store.readAgent("calc").agent.archivedAt, at);
  assert.equal(store.listRuns()[0].archivedAt, at, "a run of an archived agent is archived with it");
  assert.equal(store.readRun(runId).archivedAt, at);
  store.setArchived("agent", "calc", false);
  assert.equal(store.listAgents()[0].archivedAt, undefined);
  assert.equal(store.listRuns()[0].archivedAt, undefined);
  const own = store.setArchived("run", runId, true);
  assert.equal(store.listRuns()[0].archivedAt, own);
  const reader = openStoreReader(dir);
  assert.equal(reader.readRun(runId).archivedAt, own, "the read-only reader reads it too");
  reader.close();
  store.close();
});

test("archiving refuses an unknown agent or run (missing) and a kind that is neither (invalid), writing nothing", async () => {
  const { dir, store } = await seeded();
  assert.throws(() => store.setArchived("agent", "nope", true), refused("missing"));
  assert.throws(() => store.setArchived("run", "nope", true), refused("missing"));
  assert.throws(() => store.setArchived("revision", "calc", true), refused("invalid"));
  assert.deepEqual(changes(dir), []);
  store.close();
});

test("nothing is deleted: an unarchive appends a row, and the database refuses an UPDATE or a DELETE of one", async () => {
  const { dir, store } = await seeded();
  store.setArchived("agent", "calc", true);
  store.setArchived("agent", "calc", false);
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  assert.throws(() => db.exec("UPDATE archive_changes SET archived = 0"), /written once/);
  assert.throws(() => db.exec("DELETE FROM archive_changes"), /written once/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM archive_changes").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents").get().n, 1);
  db.close();
});

