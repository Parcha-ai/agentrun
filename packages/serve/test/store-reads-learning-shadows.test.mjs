// An audit's shadow run (runner/audit.ts, id `audit.<run>`) is learning spend on the run it audits, never a run of its
// own: GET /stats and its analytics count it in no run count, no state, no time or token figure and no agent's runs,
// while its known cost stays in the dollars spent, and one at work or of unknown cost leaves the run it audits of unknown
// cost (learn/ledger.ts shadowUsdOf, the ledger's rule), never $0; and the money rule's read at a claim (pastRunsOverStore) finds each
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
  assert.deepEqual(read.cost, { usd: 2, known: 3, unknown: 0, basis: "estimate" }, "the shadows' $0.80 is spent, on no run of its own");
});

test("analytics leave a shadow out of the run counts, the time and the tokens, and keep its cost", async (t) => {
  const store = await audited(t);
  const read = await analytics(store, { agent: "agent-1" });
  assert.deepEqual([read.totals.runs, read.totals.completed, read.totals.runsWithMetrics, read.totals.output, read.totals.unknownCostRuns], [3, 3, 3, 300, 0], JSON.stringify(read.totals));
  assert.equal(Math.round(read.totals.costUsd * 1e6), 2_000_000);
  assert.deepEqual([read.time.endedRuns, read.time.activeRuns], [3, 3]);
  assert.deepEqual(read.byDay.map((day) => [day.runs, Math.round(day.costUsd * 1e6)]), [[3, 2_000_000]]);
});

test("a shadow's $ is on the run it audits: a served run at 23:59 audited by a shadow that starts at 00:01 books it on the first day, and a filter for the second day doesn't show it", async (t) => {
  const clock = { now: Date.parse("2026-11-17T23:59:00Z") };
  const { store } = await storeOn(t, { clock });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", learning: true } });
  const end = async (id, cost, metrics, body = LEARNS) => {
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    clock.now += 1_000;
    await store.runs.update(claim, { state: "ended", costUsd: cost, metrics: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100, requests: 1, activeMs: 1_000, ...metrics } });
  };
  await end("run-1", 0.1, { path: "workflow", workflow: "answer", workflow_digest: "a".repeat(16) });
  clock.now = Date.parse("2026-11-18T00:01:00Z");
  await end("audit.run-1", 0.4, { path: "audit", audit: { of: "run-1", workflow: "answer", digest: "a".repeat(16) } }, SHADOW("run-1"));
  const read = await analytics(store, { agent: "agent-1" });
  assert.deepEqual(read.byDay.map((day) => [day.day, day.runs, Math.round(day.costUsd * 1e6)]), [["2026-11-17", 1, 500_000]], JSON.stringify(read.byDay));
  assert.equal(Math.round(read.totals.costUsd * 1e6), 500_000);
  const second = await analytics(store, { agent: "agent-1", from: "2026-11-18T00:00:00Z", to: "2026-11-19T00:00:00Z" });
  assert.deepEqual([second.totals.runs, second.totals.costUsd, second.byDay], [0, null, []], JSON.stringify(second));
  const first = await analytics(store, { agent: "agent-1", from: "2026-11-17T00:00:00Z", to: "2026-11-18T00:00:00Z" });
  assert.equal(Math.round(first.totals.costUsd * 1e6), 500_000, "the first day's filter has it with its run");
  assert.deepEqual((await stats(store)).cost, { usd: 0.5, known: 1, unknown: 0, basis: "estimate" });
});

test("a shadow's known $ stays in the dollars while the run it audits has no known cost: never a null for the group", async (t) => {
  const store = await audited(t);
  // Agent `agent-2`: one served run whose cost is unknown, audited by a $0.40 shadow.
  await store.agents.create({ id: "agent-2", name: "Unknown" }, { id: "rev-2", kind: "agentic", body: { instructions: "Go.", learning: true } });
  for (const [id, cost, metrics, body] of [["run-x", null, { path: "workflow", workflow: "answer", workflow_digest: "a".repeat(16) }, LEARNS], ["audit.run-x", 0.4, { path: "audit" }, SHADOW("run-x")]]) {
    await store.runs.create({ id, agentId: "agent-2", revisionId: "rev-2" }, { body });
    const claimed = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claimed, { state: "ended", costUsd: cost, metrics: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100, requests: 1, activeMs: 1_000, ...metrics } });
  }
  const read = await analytics(store, { agent: "agent-2" });
  assert.deepEqual([read.totals.runs, read.totals.unknownCostRuns, Math.round(read.totals.costUsd * 1e6)], [1, 1, 400_000], JSON.stringify(read.totals));
  const all = await stats(store);
  assert.deepEqual(all.cost, { usd: 2.4, known: 3, unknown: 1, basis: "estimate" }, JSON.stringify(all.cost));
});

test("a shadow at work, or one that ended at an unknown cost, leaves the run it audits of unknown cost in GET /stats and analytics, never $0; once its cost is known, the run's is", async (t) => {
  const clock = { now: Date.parse("2026-11-17T06:00:00Z") };
  const { store } = await storeOn(t, { clock });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", learning: true } });
  const metered = { input: 0, cacheRead: 0, cacheWrite: 0, output: 100, requests: 1, activeMs: 1_000 };
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: LEARNS });
  await store.runs.update(await store.claim("run-1", "runner-a", { leaseMs: 60_000 }), { state: "ended", costUsd: 0.1, metrics: { ...metered, path: "workflow", workflow: "answer", workflow_digest: "a".repeat(16) } });
  await store.runs.create({ id: "audit.run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: SHADOW("run-1") });
  const read = async () => {
    const totals = (await analytics(store, { agent: "agent-1" })).totals;
    return { stats: (await stats(store)).cost, analytics: [totals.runs, totals.unknownCostRuns, Math.round(totals.costUsd * 1e6)] };
  };
  const unknown = { stats: { usd: 0.1, known: 0, unknown: 1, basis: "estimate" }, analytics: [1, 1, 100_000] };
  assert.deepEqual(await read(), unknown, "queued: the run's $0.10 spent, its cost with its shadow unknown");
  const claim = await store.claim("audit.run-1", "runner-a", { leaseMs: 60_000 });
  assert.deepEqual(await read(), unknown, "running");
  await store.runs.update(claim, { state: "ended", costUsd: null, metrics: { ...metered, path: "audit" } });
  assert.deepEqual(await read(), unknown, "ended at an unknown cost");
  await store.runs.healCost("audit.run-1", await store.runs.get("audit.run-1"), { costUsd: 0.4, costUpperBound: false });
  assert.deepEqual(await read(), { stats: { usd: 0.5, known: 1, unknown: 0, basis: "estimate" }, analytics: [1, 0, 500_000] }, "its cost known: the run's all-in is");
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
  const past = (await pastRunsOverStore(counted, "agent-1")).runs;
  assert.deepEqual(past.map((one) => one.allInUsd).sort(), [0.5, 0.5, 1], "each served run all in with its shadow's");
  assert.deepEqual(gets.filter((id) => id.startsWith("audit.")), [], `no shadow read one at a time: ${JSON.stringify(gets)}`);
});
