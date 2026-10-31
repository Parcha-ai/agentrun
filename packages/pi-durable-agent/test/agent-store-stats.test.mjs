// AgentStoreReader.stats: counts and cost sums over store.sqlite, each an SQL aggregate read through an index. A cost
// that is not known is counted as unknown, never summed as $0; what is archived is left out and counted apart.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openStore, openStoreReader } from "../dist/index.js";
import { scratch } from "./support.mjs";

const A = { kind: "agentic", instructions: "Answer." };
const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();

/** A store with `agents` (each with one revision) and `runs` written as rows: `[agent, state, costUsd | null]`, the
 *  i-th started i seconds after the first. No run's folder is made: stats reads none. */
async function seeded(agents, runs) {
  const dir = await scratch();
  const store = openStore(dir);
  const revisions = {};
  for (const id of agents) {
    store.createAgent({ name: id.toUpperCase(), id });
    revisions[id] = (await store.commitRevision(id, A, { setCurrent: true })).id;
  }
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO runs (id, agent_id, revision_id, state, started_at, ended_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)");
  runs.forEach(([agent, state, cost], i) => insert.run(`run-${i}`, agent, revisions[agent], state, at(i), state === "running" ? null : at(i + 1), cost));
  db.exec("COMMIT");
  db.close();
  return { dir, store: openStore(dir) };
}

const zero = { total: 0, running: 0, completed: 0, failed: 0, stopped: 0, escalated: 0 };

test("stats counts runs by state and sums only the known costs: an unknown cost is counted, never read as $0", async () => {
  const { store } = await seeded(["alpha", "beta", "gamma"], [
    ["alpha", "completed", 0.25], ["alpha", "completed", null], ["alpha", "failed", 0.5], ["alpha", "escalated", 0],
    ["beta", "running", null], ["beta", "stopped", null], ["beta", "completed", 1],
  ]);
  const stats = store.stats();
  assert.equal(stats.agents, 3);
  assert.deepEqual(stats.runs, { total: 7, running: 1, completed: 3, failed: 1, stopped: 1, escalated: 1 });
  assert.deepEqual(stats.cost, { usd: 1.75, known: 4, unknown: 3 }, "a $0 cost is known; a null cost, and a running run's, are not");
  assert.deepEqual(stats.byAgent, [{ id: "alpha", name: "ALPHA", runs: 4 }, { id: "beta", name: "BETA", runs: 3 }, { id: "gamma", name: "GAMMA", runs: 0 }]);
  assert.deepEqual(stats.running, ["run-4"]);
  store.close();
});

test("a run opened again keeps its last cost on its row while it runs: that cost is out of date, so the run counts as unknown, never summed", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  store.createAgent({ name: "Chat", id: "chat" });
  await store.commitRevision("chat", A, { setCurrent: true });
  const first = await store.startRun({ agent: "chat" });
  store.carryBack(first.runId, { state: "completed", costUsd: 0.4 });
  const second = await store.startRun({ agent: "chat" });
  store.carryBack(second.runId, { state: "completed", costUsd: 0.25 });
  store.reopenRun(first.runId);
  assert.deepEqual([store.readRun(first.runId).state, store.readRun(first.runId).costUsd], ["running", 0.4], "the row keeps the cost of its last end");
  const stats = store.stats();
  assert.deepEqual(stats.cost, { usd: 0.25, known: 1, unknown: 1 });
  assert.deepEqual(stats.running, [first.runId]);
  store.close();
});

test("a store where every cost is unknown answers null for the total, never 0", async () => {
  const { store } = await seeded(["alpha"], [["alpha", "completed", null], ["alpha", "running", null], ["alpha", "failed", null]]);
  assert.deepEqual(store.stats().cost, { usd: null, known: 0, unknown: 3 });
  store.close();
  const empty = openStore(await scratch());
  assert.deepEqual(empty.stats(), { agents: 0, archivedAgents: 0, runs: zero, archivedRuns: 0, cost: { usd: null, known: 0, unknown: 0 }, byAgent: [], running: [] });
  empty.close();
});

test("archived agents and runs are left out of every number and counted apart; a run of an archived agent is archived with it", async () => {
  const { store } = await seeded(["alpha", "beta"], [
    ["alpha", "completed", 1], ["alpha", "running", null], ["alpha", "failed", 2],
    ["beta", "completed", 4], ["beta", "running", null],
  ]);
  store.setArchived("run", "run-2", true);
  store.setArchived("agent", "beta", true);
  store.setArchived("run", "run-4", true); // archived twice over: its own and its agent's, counted once
  const stats = store.stats();
  assert.deepEqual([stats.agents, stats.archivedAgents, stats.archivedRuns], [1, 1, 3]);
  assert.deepEqual(stats.runs, { ...zero, total: 2, running: 1, completed: 1 });
  assert.deepEqual(stats.cost, { usd: 1, known: 1, unknown: 1 });
  assert.deepEqual(stats.byAgent, [{ id: "alpha", name: "ALPHA", runs: 2 }]);
  assert.deepEqual(stats.running, ["run-1"]);
  store.setArchived("agent", "beta", false);
  store.setArchived("run", "run-2", false);
  const shown = store.stats();
  assert.deepEqual([shown.agents, shown.archivedAgents, shown.archivedRuns, shown.runs.total, shown.cost.usd], [2, 0, 1, 4, 7], "unarchived, they count again; run-4 is still archived on its own");
  store.close();
});

/** Every statement `stats` prepares, as it ran. */
function statementsOf(store) {
  const prepare = DatabaseSync.prototype.prepare;
  const seen = [];
  DatabaseSync.prototype.prepare = function (sql) {
    seen.push(sql);
    return prepare.call(this, sql);
  };
  try {
    store.stats();
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  return seen.filter((sql) => /\bFROM runs\b/.test(sql));
}
/** Each statement's plan rows for the runs table (alias r). */
function plans(dir, statements) {
  const db = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  try {
    return statements.map((sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).filter((detail) => / r\b/.test(detail)));
  } finally {
    db.close();
  }
}

test("each aggregate of stats reads runs through an index: EXPLAIN QUERY PLAN shows no full scan of the runs table", async () => {
  const agents = ["a1", "a2", "a3", "a4"];
  const { dir, store } = await seeded(agents, Array.from({ length: 200 }, (_, i) => [agents[i % 4], i % 7 ? "completed" : "running", i % 3 ? 0.01 : null]));
  store.setArchived("run", "run-5", true);
  const statements = statementsOf(store);
  assert.equal(statements.length, 2, "the grouped counts and the running ids");
  const found = plans(dir, statements);
  for (const [i, rows] of found.entries()) {
    assert.ok(rows.length > 0, `statement ${i} reads runs`);
    for (const row of rows) assert.match(row, /^(SCAN|SEARCH) r USING (COVERING )?INDEX /, `statement ${i}: ${row}`);
  }
  assert.deepEqual(found.map((rows) => rows.map((row) => /INDEX (\w+)/.exec(row)[1])), [["runs_by_agent"], ["runs_by_state"]]);
  // The positive control: without the store's indexes on runs, the same statements scan the table.
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  for (const name of ["runs_by_agent", "runs_by_state"]) db.exec(`DROP INDEX ${name}`);
  db.close();
  assert.deepEqual(plans(dir, statements).map((rows) => rows.filter((row) => row === "SCAN r").length), [1, 1]);
  store.close();
});

test("stats over 1,000 runs across several agents answers within 500 ms", async (t) => {
  const agents = ["a1", "a2", "a3", "a4", "a5"];
  const { store } = await seeded(agents, Array.from({ length: 1_000 }, (_, i) => [agents[i % 5], ["completed", "failed", "running", "stopped"][i % 4], i % 2 ? 0.01 : null]));
  for (let i = 0; i < 20; i++) store.setArchived("run", `run-${i * 50}`, true);
  const times = [];
  let stats;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    stats = store.stats();
    times.push(performance.now() - start);
  }
  t.diagnostic(`stats over 1,000 runs, 5 agents: first ${times[0].toFixed(1)} ms, slowest ${Math.max(...times).toFixed(1)} ms`);
  assert.ok(Math.max(...times) < 500, `slowest ${Math.max(...times).toFixed(1)} ms`);
  assert.equal(stats.runs.total + stats.archivedRuns, 1_000);
  assert.equal(stats.archivedRuns, 20);
  store.close();
});

test("a store written before runs_by_state opens: the reader answers stats, and the writer adds the index with no new version", async () => {
  const { dir, store } = await seeded(["alpha"], [["alpha", "completed", 0.5], ["alpha", "running", null]]);
  const before = store.stats();
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.exec("DROP INDEX runs_by_state");
  db.close();
  const reader = openStoreReader(dir);
  assert.deepEqual(reader.stats(), before);
  reader.close();
  openStore(dir).close();
  const again = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true });
  assert.deepEqual(again.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs' AND name LIKE 'runs_by_%' ORDER BY name").all().map((r) => r.name), ["runs_by_agent", "runs_by_state"]);
  assert.equal(again.prepare("PRAGMA user_version").get().user_version, 1);
  again.close();
});
