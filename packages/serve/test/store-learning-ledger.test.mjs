// The learning ledger on the store itself (SQLite here, Postgres under `npm run test:pg`): what a run's end writes
// (learning_ledger, learning_spend: store/sqlite/run-patch.ts recordLedger) and how the readers read it
// (store-reads/learning.ts):
//   - an end records its row with why it was not served alone (`cost_stop`, `cut`); the ledger reads both tables as one
//     read, scoped to the runs asked for;
//   - a run's end again (after a reopen) writes its spend rows anew, none left from the end before; healCost records the
//     row again with the healed cost; a purge takes the run's row and every spend row it booked or that audits it;
//   - a run that ended with no row is recorded once, at the server's open (run-patch.ts backfillLedger), at the figures
//     its end would have written; no read records one;
//   - a cancel that wins an end keeping its job's end (keepsEnd) moves its ended_at after its row is written: the row
//     is read as written, no round read again;
//   - the money rule's read at a claim (pastRunsOverStore) is bounded: the agent's newest PAST_RUNS runs on no named disk,
//     the ledger of those runs alone, no agent-wide read; its
//     by-hand side is the job's own cost of the `agent` runs among the same runs as its served side (since the reset, no
//     named disk), and the cost page says the same.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { raw } from "./store-target.mjs";

const { agentCostOverStore, pastRunsOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { PAST_RUNS, workflowCostsOf } = await import("../dist/runner/workflow-first.js");
const { keepResetAt } = await import("../dist/learn/promote.js");

const C = "c".repeat(16);
const D = "d".repeat(16);
const AT = "2026-11-24T00:00:00.000Z";
const SERVED = { path: "workflow", workflow: "answer", workflow_digest: C };
const KEPT = { meters: { tools: 0, tokens: 0.1, browser: { usd: 0, seconds: 0 }, others: 0, known: { tokens: 0.1, browser: 0, others: 0 } }, spend: { usd: 0.1, basis: "list" }, learning: { state: "dropped", reason: null } };
/** A kept round `n`: its job's cost as it answered, its compile turn's (look_back_usd), and the draft it kept. */
const kept = (n, job, look, extra = {}) => ({ table: "learning_proposals", row: { round: n, turn: {}, proposal: { state: "dropped", reason: "empty", detail: "d", answered_at: AT, job_cost_usd: job, look_back_usd: look, ...extra } } });

/** A store with agent-1 and its revision, and `end`: run `id` made and ended at the clock's next second, its row's cost
 *  `costUsd` and its metrics, with `also`'s rows; on a named disk with `disk`; an audit's shadow with `audit`. */
async function ledgerStore(t) {
  const clock = { now: T0 };
  const { store, file } = await storeOn(t, { clock });
  await agentWithRevision(store, "agent-1", "rev-1");
  const end = async (id, costUsd, metrics = { path: "agent" }, { also = [], disk, audit } = {}) => {
    clock.now += 1_000;
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "q" }, title: "t", place: { mode: "runner" }, ...(disk ? { archil_disk: { disk_id: disk, kind: "launch" } } : {}), ...(audit ? { audit } : {}) } });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    clock.now += 1_000;
    await store.runs.update(claim, { state: "ended", costUsd, metrics }, also.length ? { also } : undefined);
  };
  return { store, file, clock, end };
}

test("an end records its ledger row with why it was not served alone (cost_stop, cut); the ledger reads the rows and spend of the runs it is asked for", async (t) => {
  const { store, end } = await ledgerStore(t);
  await end("r-stop", 0.4, { path: "agent", not_served: "cost_stop" });
  await end("r-cut", 0.2, { path: "handed_back", workflow: "answer", workflow_digest: C, workflow_cut: true });
  await end("r-compile", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  const all = await store.learning.ledger("agent-1");
  const byId = new Map(all.rows.map((row) => [row.runId, row]));
  assert.deepEqual([byId.get("r-stop").notServed, byId.get("r-cut").notServed, byId.get("r-compile").notServed], ["cost_stop", "cut", null]);
  assert.equal(Object.hasOwn(byId.get("r-stop"), "epoch"), false, "a row says no epoch");
  const scoped = await store.learning.ledger("agent-1", ["r-cut", "r-compile"]);
  assert.deepEqual(scoped.rows.map((row) => row.runId).sort(), ["r-compile", "r-cut"], "the rows of the runs asked for alone");
  assert.deepEqual(scoped.spend.map((one) => [one.runId, one.kind, one.round, one.digest, one.usd]), [["r-compile", "compile", 1, C, 0.3]]);
  assert.deepEqual((await store.learning.ledger("agent-1", [])).rows, [], "no run asked for: none");
});

test("a run's end again writes its spend rows anew, none left from the end before; healCost records its row again; a purge takes its row and every spend row it booked or that audits it", async (t) => {
  const { store, clock, end } = await ledgerStore(t);
  await end("r1", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  assert.deepEqual((await store.learning.ledger("agent-1", ["r1"])).spend.map((one) => [one.round, one.digest, one.usd]), [[1, C, 0.3]]);
  // A follow-up opens it again; its second end drafted D in its second round.
  const steer = await store.runs.reopen("r1", { kind: "steer", body: { text: "again" } });
  const claim = await store.claim("r1", "runner-a", { leaseMs: 60_000 });
  await store.take(claim, steer.id);
  clock.now += 1_000;
  await store.runs.update(claim, { state: "ended", costUsd: 2, metrics: { path: "agent" } }, { also: [kept(2, 1.5, 0.2, { compiled: { workflow: "answer", digest: D } })] });
  const again = await store.learning.ledger("agent-1", ["r1"]);
  assert.deepEqual(again.spend.map((one) => [one.round, one.digest, one.usd]), [[1, C, 0.3], [2, D, 0.2]], "each round's compile once: the rows of the end before are replaced, not added to");

  await end("r2", null);
  assert.equal((await store.learning.ledger("agent-1", ["r2"])).rows[0].cost, "unknown");
  const ended = await store.runs.get("r2");
  assert.equal(await store.runs.healCost("r2", { epoch: ended.epoch, endedAt: ended.endedAt }, { costUsd: 0.7, costUpperBound: false }), true);
  assert.deepEqual((({ cost, jobUsd }) => ({ cost, jobUsd }))((await store.learning.ledger("agent-1", ["r2"])).rows[0]), { cost: "known", jobUsd: 0.7 }, "the healed cost is the job's");

  await end("audit.r1", 0.05, { path: "audit", audit: { of: "r1", workflow: "answer", digest: D } });
  await store.runs.purge("r1", KEPT);
  const left = await store.learning.ledger("agent-1");
  assert.deepEqual(left.rows.map((row) => row.runId).sort(), ["audit.r1", "r2"], "the purged run's row is gone");
  assert.deepEqual(left.spend.filter((one) => one.runId === "r1" || one.ofRun === "r1"), [], "and every spend row it booked or that audits it");
});

test("a run that ended with no ledger row (a build before the ledger ended it) is recorded once, at the server's open, at the figures its end would have written; no read records it", async (t) => {
  const { store, file, clock, end } = await ledgerStore(t);
  await end("r1", 1);
  await end("r2", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  await end("s1", 0.1, SERVED);
  const figures = async (on) => ({
    page: (await agentCostOverStore(on, "agent-1")).runs.map((run) => [run.run_id, run.cost_usd, run.learning_usd, run.compile_usd, run.total_usd]),
    run: await runAllInOverStore(on, "r2"),
    past: await pastRunsOverStore(on, "agent-1"),
    ledger: await on.learning.ledger("agent-1"),
  });
  const before = await figures(store);
  assert.deepEqual(before.page.find(([id]) => id === "r2"), ["r2", 1, 0.3, 0.3, 1.3]);
  const db = await raw(file);
  await db.run("DELETE FROM learning_ledger WHERE run_id IN (?, ?)", "r1", "r2");
  await db.run("DELETE FROM learning_spend WHERE run_id IN (?, ?)", "r1", "r2");
  await db.close();
  await pastRunsOverStore(store, "agent-1");
  assert.deepEqual((await store.learning.ledger("agent-1", ["r1", "r2"])).rows, [], "a read records neither");
  await store.close();
  const { store: reopened } = await storeOn(t, { file, clock });
  assert.deepEqual(await figures(reopened), before, "the server's open recorded both from their run rows and rounds, as their ends did");
});

test("a cancel that wins an end keeping its job's end (keepsEnd) moves its ended_at after its row is written: the row is read as written, and no read records it again", async (t) => {
  const { store, clock, end } = await ledgerStore(t);
  await end("R", 1.1, { path: "agent" }, { also: [kept(1, 1, 0.1, { compiled: { workflow: "answer", digest: C } })] });
  const first = await store.runs.get("R");
  const steer = await store.runs.reopen("R", { kind: "steer", body: { text: "the answer is B", feedback: { round: 2, correct: false, kept: { endedAt: first.endedAt } } } }, { endedAt: first.endedAt });
  const claim = await store.claim("R", "runner-a", { leaseMs: 60_000 });
  await store.take(claim, steer.id);
  // A person's message and a cancel wait at the round's end: the cancel is that message's run's, and wins it at this
  // commit's time (run-patch.ts refuseLeftovers), after the end wrote its row.
  await store.command("R", { kind: "steer", body: { text: "and again?" } });
  await store.command("R", { kind: "cancel" });
  clock.now += 5_000;
  await store.runs.update(claim, { state: "ended", costUsd: 1.4, metrics: { path: "agent" }, endedAt: first.endedAt, keepsEnd: true }, { also: [kept(2, 1, 0.3, { compiled: { workflow: "answer", digest: D } })] });
  const after = await store.runs.get("R");
  assert.deepEqual([after.state, after.outcome], ["stopped", "cancelled"]);
  assert.ok(after.endedAt > first.endedAt, `the cancel's commit moved its ended_at: ${first.endedAt} then ${after.endedAt}`);
  const row = (await store.learning.ledger("agent-1", ["R"])).rows[0];
  assert.deepEqual([row.cost, row.jobUsd], ["known", 1], "the row its end wrote");
  // No read records it again: its rounds are never read.
  const rounds = [];
  const counted = new Proxy(store, {
    get: (target, key) => (key === "learning" ? new Proxy(target.learning, { get: (inner, name) => (name === "proposal" ? (...args) => (rounds.push(args), inner.proposal(...args)) : typeof inner[name] === "function" ? inner[name].bind(inner) : inner[name]) }) : Reflect.get(target, key)),
  });
  for (let read = 0; read < 3; read++) await pastRunsOverStore(counted, "agent-1");
  assert.deepEqual(rounds, [], "three reads at a claim, no round read");
});

test("the money rule's read at a claim is bounded: the agent's newest PAST_RUNS runs on no named disk and their ledger alone, no agent-wide read", async (t) => {
  const { store, end } = await ledgerStore(t);
  assert.equal(typeof PAST_RUNS, "number", "the window is one number the launch and the cost page share");
  await end("r1", 1);
  await end("s1", 0.1, SERVED);
  const calls = [];
  const spy = (name, object, keys) => new Proxy(object, { get: (target, key) => (keys.includes(key) ? (...args) => (calls.push([`${name}.${String(key)}`, ...args]), target[key](...args)) : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
  const counted = new Proxy(store, {
    get: (target, key) => (key === "runs" ? spy("runs", target.runs, ["list", "learningStarts"]) : key === "learning" ? spy("learning", target.learning, ["ledger", "kept"]) : Reflect.get(target, key)),
  });
  const past = await pastRunsOverStore(counted, "agent-1");
  assert.equal(past.runs.length, 2);
  assert.deepEqual(calls.filter(([name]) => name === "runs.list"), [["runs.list", { agentId: "agent-1", disk: null, limit: PAST_RUNS }]], "one page of the newest runs on no named disk");
  const ledgers = calls.filter(([name]) => name === "learning.ledger");
  assert.equal(ledgers.length, 1);
  assert.deepEqual([ledgers[0][1], [...ledgers[0][2]].sort()], ["agent-1", ["r1", "s1"]], "the ledger of those runs alone");
  assert.deepEqual(calls.filter(([name]) => name === "learning.kept" || name === "runs.learningStarts"), [], "no read of every run the agent has");
});

test("the money rule's by-hand side is the job's own cost of the agent's runs on its own path among the same runs as its served side: since its learning's reset, on no named disk; the cost page says the same", async (t) => {
  const { store, clock, end } = await ledgerStore(t);
  await end("old", 5);
  clock.now += 1_000;
  await keepResetAt(store.settings, "agent-1", clock.now);
  // Its job $1, its compile turn $0.30: by hand it is $1, its all-in $1.30.
  await end("r1", 1.3, { path: "agent" }, { also: [kept(1, 1, 0.3, { compiled: { workflow: "answer", digest: C } })] });
  await end("on-disk", 9, { path: "agent" }, { disk: "disk-a" });
  for (const id of ["s1", "s2", "s3"]) await end(id, 0.1, SERVED);
  await end("late", 2);
  const past = await pastRunsOverStore(store, "agent-1");
  assert.deepEqual([past.by_hand, past.by_hand_unknown], [{ runs: 2, mean_usd: 1.5 }, 0], "r1's job and late's: not the run before the reset ($5), not the one on a named disk ($9), never r1's compile turn");
  const page = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(page.workflows.map((one) => one.by_hand), [{ runs: 2, mean_usd: 1.5 }], "the cost page's money rule reads the same runs");
  assert.notDeepEqual(page.summary.before, past.by_hand, "the series' before is over every run it shows, a wider set");
});

test("once the newest PAST_RUNS runs hold no run by hand, the money rule holds the workflow to the newest runs by hand before them: 500 served, then 10 at twice the by-hand cost, stops it", async (t) => {
  const { store, end } = await ledgerStore(t);
  for (let at = 0; at < 10; at++) await end(`h${String(at).padStart(2, "0")}`, 1);
  for (let at = 0; at < PAST_RUNS; at++) await end(`s${String(at).padStart(3, "0")}`, 0.1, SERVED);
  for (let at = 0; at < 10; at++) await end(`x${String(at).padStart(2, "0")}`, 2, SERVED);
  const past = await pastRunsOverStore(store, "agent-1");
  assert.equal(past.runs.filter((run) => run.metrics.path === "agent").length, 0, "no run by hand in the window");
  assert.deepEqual(past.by_hand, { runs: 10, mean_usd: 1 }, "the 10 by hand before the window");
  assert.deepEqual(workflowCostsOf(past).map((one) => [one.state, one.served, one.by_hand]), [["needs_revision", { runs: 10, mean_usd: 2 }, { runs: 10, mean_usd: 1 }]]);
  assert.deepEqual((await agentCostOverStore(store, "agent-1")).workflows.map((one) => one.state), ["needs_revision"], "the cost page says the same");
});

test("a shadow that failed before its end wrote its metrics books its cost at its end, on the run its launch audits", async (t) => {
  const { store, end } = await ledgerStore(t);
  await end("s1", 0.1, SERVED);
  await end("audit.s1", 0.05, {}, { audit: { of: "s1", workflow: "answer", digest: C } });
  const ledger = await store.learning.ledger("agent-1");
  assert.deepEqual(ledger.rows.filter((row) => row.runId === "audit.s1").map((row) => row.path), ["audit"]);
  assert.deepEqual(ledger.spend.map((one) => [one.runId, one.kind, one.ofRun, one.usd]), [["audit.s1", "audit", "s1", 0.05]]);
  assert.equal((await runAllInOverStore(store, "s1")).shadow_usd, 0.05);
});
