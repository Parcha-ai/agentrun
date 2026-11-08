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


test("deleteAgent undoes a create: an agent with no run that was never archived goes with its revisions, and any other is refused", async () => {
  const { store } = await seeded();
  const fresh = store.createAgent({ name: "Fresh", id: "fresh" });
  await store.commitRevision(fresh.id, A, { setCurrent: true });
  await store.commitRevision(fresh.id, { ...A, instructions: "Answer briefly." }, { setCurrent: true });
  store.deleteAgent("fresh");
  assert.equal(store.readAgent("fresh"), undefined);
  assert.deepEqual(store.listAgents().map((a) => a.id), ["calc"]);
  assert.throws(() => store.deleteAgent("fresh"), refused("missing"));
  assert.throws(() => store.deleteAgent("calc"), refused("invalid"), "an agent with a run is archived, never deleted");
  const shelved = store.createAgent({ name: "Shelved", id: "shelved" });
  store.setArchived("agent", shelved.id, true);
  store.setArchived("agent", shelved.id, false);
  assert.throws(() => store.deleteAgent("shelved"), refused("invalid"), "an agent once archived keeps its archive rows, so it stays");
  assert.ok(store.readAgent("calc") && store.readAgent("shelved"));
  store.close();
});

test("a revision keeps the package it was applied from, as part of what makes it that revision", async () => {
  const { store } = await seeded();
  const record = { name: "brief", version: "1.0.0", source: "builtin", ref: null, sha: null, parameters: { topic: "solar" } };
  const applied = await store.commitRevision("calc", { ...A, package: record }, { setCurrent: true });
  assert.deepEqual(applied.body.package, record);
  assert.notEqual(applied.id, (await store.commitRevision("calc", A)).id, "the same body without it is another revision");
  await assert.rejects(store.commitRevision("calc", { ...A, package: "brief" }), refused("invalid"));
  store.close();
});

test("createAgentWith makes an agent and its first revision in one transaction: a revision that does not write leaves no agent", async () => {
  const { dir, store } = await seeded();
  const made = await store.createAgentWith({ name: "Whole", id: "whole" }, A);
  assert.equal(store.readAgent("whole").agent.current, made.revision.id);
  assert.equal(made.agent.current, made.revision.id);
  // A write that fails inside the transaction (a full disk, say), planted from another connection.
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("CREATE TRIGGER fail_revisions BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(store.createAgentWith({ name: "Half", id: "half" }, { ...A, instructions: "Another." }), /disk full/);
  assert.equal(store.readAgent("half"), undefined, "no agent without its revision");
  await assert.rejects(store.createAgentWith({ name: "Bad", id: "bad" }, { ...A, package: "x" }), refused("invalid"));
  assert.equal(store.readAgent("bad"), undefined, "a refused revision makes no agent");
  db.exec("DROP TRIGGER fail_revisions");
  db.close();
  store.close();
});
