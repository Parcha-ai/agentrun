// An audit's shadow run (runner/audit.ts, id `audit.<run>`) is learning spend on the run it audits, never a run of its
// own: GET /stats and its analytics count it in no run count, no state, no time or token figure and no agent's runs,
// while its known cost stays in the dollars spent; and the money rule's read at a claim (pastRunsOverStore) finds each
// run's shadow in the page of runs it already listed, never with a read of its own a run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { stats } = await import("../dist/store-reads/stats.js");
const { analytics } = await import("../dist/store-reads/analytics.js");
const { pastRunsOverStore } = await import("../dist/store-reads/learning.js");

const LEARNS = { input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0 } };
const SHADOW = (of) => ({ input: { content: "Go." }, title: "t", place: { mode: "runner" }, audit: { of, workflow: "answer", digest: "a".repeat(16) } });

/** Agent `agent-1`: an agent run ($1.00), two served runs ($0.10 each), each audited by a shadow ($0.40 each), ended in
 *  that order a minute apart, every one with 100 output tokens and 1 s active. */
async function audited(t) {
  const clock = { now: Date.parse("2026-11-17T06:00:00Z") };
  const { store } = await storeOn(t, { clock });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", learning: true } });
  const end = async (id, cost, metrics, body = LEARNS) => {
    clock.now += 60_000;
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    clock.now += 1_000;
    await store.runs.update(claim, { state: "ended", costUsd: cost, metrics: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100, requests: 1, activeMs: 1_000, ...metrics } });
  };
  await end("run-1", 1, { path: "agent" });
  for (const id of ["run-2", "run-3"]) {
    await end(id, 0.1, { path: "workflow", workflow: "answer", workflow_digest: "a".repeat(16) });
    await end(`audit.${id}`, 0.4, { path: "audit", audit: { of: id, workflow: "answer", digest: "a".repeat(16) } }, SHADOW(id));
  }
  return store;
}

test("GET /stats' counts leave a shadow out of every run count and keep its cost in the dollars", async (t) => {
  const store = await audited(t);
  const read = await stats(store);
  assert.equal(read.runs.total, 3, JSON.stringify(read.runs));
  assert.equal(read.runs.completed, 3);
  assert.deepEqual(read.byAgent, [{ id: "agent-1", name: "Learns", runs: 3 }]);
  assert.deepEqual(read.cost, { usd: 2, known: 3, unknown: 0 }, "the shadows' $0.80 is spent, on no run of its own");
});

test("analytics leave a shadow out of the run counts, the time and the tokens, and keep its cost", async (t) => {
  const store = await audited(t);
  const read = await analytics(store, { agent: "agent-1" });
  assert.deepEqual([read.totals.runs, read.totals.completed, read.totals.runsWithMetrics, read.totals.output, read.totals.unknownCostRuns], [3, 3, 3, 300, 0], JSON.stringify(read.totals));
  assert.equal(Math.round(read.totals.costUsd * 1e6), 2_000_000);
  assert.deepEqual([read.time.endedRuns, read.time.activeRuns], [3, 3]);
  assert.deepEqual(read.byDay.map((day) => [day.runs, Math.round(day.costUsd * 1e6)]), [[3, 2_000_000]]);
});

test("the money rule's read at a claim finds each run's shadow in the page it listed: no read of its own a run, its all-in the same", async (t) => {
  const store = await audited(t);
  const gets = [];
  const counted = new Proxy(store, {
    get(target, key) {
      if (key !== "runs") return Reflect.get(target, key);
      return new Proxy(target.runs, { get: (runs, name) => (name === "get" ? (id) => (gets.push(id), runs.get(id)) : typeof runs[name] === "function" ? runs[name].bind(runs) : runs[name]) });
    },
  });
  const past = await pastRunsOverStore(counted, "agent-1");
  assert.deepEqual(past.map((one) => one.allInUsd).sort(), [0.5, 0.5, 1], "each served run all in with its shadow's");
  assert.deepEqual(gets.filter((id) => id.startsWith("audit.")), [], `no shadow read one at a time: ${JSON.stringify(gets)}`);
});
