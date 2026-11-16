// An agent's cost per run (GET /agents/{id}/learning/cost) and its learning view (GET /agents/{id}/learning) read the
// store a fixed number of times whatever the number of its runs: its runs' launches, every round its runs' learning kept
// and the learning runs those name, one read each, never a read a run. The store has one connection (SQLite's worker), so
// a read a run queues every other read behind it: a 478-run agent's tab took minutes, and the agent's own page with it.
// A settled run's journal is read once and kept (its notes read, what its claims laid, its learning run's end), so a read
// after the first reads no journal at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn, T0 } from "./store-helpers.mjs";

const { agentCostOverStore, agentLearningOverStore } = await import("../dist/store-reads/learning.js");

/** `store` with every call it takes counted by its path (`runs.launch`, `readJournal().scanEntries`): `journal` counts
 *  the reads of a run's journal, `rows` every other. */
function counted(store) {
  const calls = new Map();
  const wrap = (target, path) => new Proxy(target, {
    get(obj, key) {
      const value = Reflect.get(obj, key);
      if (typeof key === "symbol") return value;
      const at = path ? `${path}.${key}` : key;
      if (typeof value === "function") {
        return (...args) => {
          calls.set(at, (calls.get(at) ?? 0) + 1);
          const out = value.apply(obj, args);
          return out && typeof out === "object" && typeof out.then !== "function" && !Array.isArray(out) ? wrap(out, `${at}()`) : out;
        };
      }
      return value && typeof value === "object" && !Array.isArray(value) ? wrap(value, at) : value;
    },
  });
  const sum = (pick) => [...calls].filter(([at]) => pick(at)).reduce((a, [, n]) => a + n, 0);
  return { store: wrap(store, ""), rows: () => sum((at) => !at.startsWith("readJournal")), journal: () => sum((at) => at.startsWith("readJournal")), reset: () => calls.clear() };
}

const GIVEN = { given: [{ file: "a.md", name: "Alpha" }], seed: "a".repeat(40), section: "# Learned\n", seedNotes: 1, workflows: ["classify"] };
const iso = (ms) => new Date(ms).toISOString();

/** An agent with `n` ended runs: a quarter by hand first, then runs its learned workflow served (one in four handed
 *  back) between replays; each given a note and offered the workflow, each looked back, one in five proposed something a
 *  learning run graded. */
async function agentWith(t, n) {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", tools: ["read"], learning: true } });
  for (let i = 0; i < n; i++) {
    const id = `run-${String(i).padStart(4, "0")}`;
    const start = (clock.now = T0 + i * 60_000);
    const path = i < n / 4 ? "agent" : i % 2 ? "replay" : i % 8 === 0 ? "handed_back" : "workflow";
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Go." }, title: id, place: { mode: "runner" }, learning: GIVEN } });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    const answered = { answered_at: iso(start + 20_000), job_cost_usd: path === "agent" ? 1 : 0.3, look_back_usd: 0.01 };
    const graded = i % 5 === 0;
    const kept = graded ? { state: "proposed", proposal: { notes: [] }, detail: "proposed", ...answered } : { state: "dropped", reason: "empty", detail: "Nothing to keep.", ...answered };
    const also = [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }, ...(graded ? [{ table: "learning_run", row: { id: `${id}-learning` } }] : [])];
    await store.runs.update(claim, { state: "ended", costUsd: answered.job_cost_usd + 0.01, metrics: { path, workflow: path === "agent" ? null : "classify" }, endedAt: start + 30_000 }, { also });
    if (graded) await store.runs.update(await store.claim(`${id}-learning`, "runner-b", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.02 });
  }
  return store;
}

test("the cost per run reads the store as often for 300 runs as for 30: no read a run", { timeout: 300_000 }, async (t) => {
  const reads = {};
  for (const n of [30, 300]) {
    const c = counted(await agentWith(t, n));
    const cost = await agentCostOverStore(c.store, "agent-1");
    assert.equal(cost.total_runs, n);
    reads[n] = c.rows() + c.journal();
  }
  assert.ok(reads[30] <= 20, `a handful of reads, not ${reads[30]}`);
  assert.equal(reads[300], reads[30], `the same reads for 300 runs as for 30 (${reads[30]} for 30)`);
});

test("the learning view reads the store's rows as often for 300 runs as for 30, and once a run's journal is read it is kept: a second read reads no journal", { timeout: 300_000 }, async (t) => {
  const first = {};
  const again = {};
  for (const n of [30, 300]) {
    const c = counted(await agentWith(t, n));
    const view = await agentLearningOverStore(c.store, "agent-1");
    assert.equal(view.notes.get("a.md")?.given, n, "every run counted");
    first[n] = c.rows();
    c.reset();
    await agentLearningOverStore(c.store, "agent-1");
    again[n] = [c.rows(), c.journal()];
  }
  assert.ok(first[30] <= 30, `a handful of row reads, not ${first[30]}`);
  assert.equal(first[300], first[30], `the same row reads for 300 runs as for 30 (${first[30]} for 30)`);
  assert.deepEqual(again[300], [first[30], 0], "a second read: the same row reads, no journal read");
  assert.deepEqual(again[30], again[300]);
});

test("an agent's learning starts are read without any run's input or sealed bytes", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", tools: ["read"], learning: true } });
  const input = { content: "SECRET-INPUT ".repeat(2000) };
  await store.runs.create({ id: "run-a", agentId: "agent-1", revisionId: "rev-1" }, { body: { input, title: "a", place: { mode: "runner" }, learning: GIVEN }, sealed: new Uint8Array(4096).fill(7) });
  await store.runs.create({ id: "run-b", agentId: "agent-1", revisionId: "rev-1" }, { body: { input, title: "b", place: { mode: "runner" } } });
  const starts = await store.runs.learningStarts("agent-1");
  assert.deepEqual(starts.map((row) => Object.keys(row).sort()), [["learning", "runId"], ["learning", "runId"]]);
  const byRun = new Map(starts.map((row) => [row.runId, row.learning]));
  assert.deepEqual(byRun.get("run-a"), GIVEN);
  assert.equal(byRun.get("run-b"), undefined);
  assert.ok(!JSON.stringify(starts).includes("SECRET-INPUT"), "no run's input is read");
});
