// The owner's bill (GET /agents/{id}/learning/cost `bill`, learning-cost.ts billOf and amortize) and each run's share of
// it over v2 (GET /runs/{id} `path`, `cost.learning_usd`, `cost.all_in_usd`: store-reads/learning.ts runAllInOverStore):
//   - billOf on a fixed series: the cumulative booked $ run after run (each run all in, its audit shadow's cost
//     included, and a check's replay runs at the run they followed) against "the agent for all of it" (the mean own $ of
//     the agent runs before the first promotion, times the runs so far); break-even is the first run from the promotion
//     on after which the bill never again exceeds that line; before it, "not yet" with the current gap;
//   - amortize: a revision's check spend split over its first K served runs (K its check's compile_after), to the
//     micro-dollar; what a revision that stops, or has not yet served K runs, has not passed on is unattributed;
//   - over the store: each run's all-in, the series and the invariant (the sum of every run's all-in and the
//     unattributed remainder is the booked total).
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { billOf, amortize } = await import("../dist/learning-cost.js");
const { agentCostOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");

const A = "a".repeat(16);
const B = "b".repeat(16);
/** One run of the cost series (learning-cost.ts CostRun): `minute` its start, its own $ and what learning added. */
const row = (n, path, minute, cost, learning = 0) => ({
  n, run_id: `run-${String(n).padStart(2, "0")}`, started_at: new Date(Date.UTC(2026, 10, 17, 6, minute)).toISOString(), path, workflow: path === "agent" ? null : "answer", learned_revision: null,
  cost_usd: cost, cost_upper_bound: false, learning_usd: learning, total_usd: cost === null || learning === null ? null : Math.round((cost + learning) * 1e6) / 1e6,
});
const at = (minute) => new Date(Date.UTC(2026, 10, 17, 6, minute)).toISOString();
/** Three agent runs ($1.00, $1.20, $0.80), a check's two replay runs ($0.30 each), the promotion, then served runs: two
 *  audited (a $0.40 shadow on each), one handed back. */
const SERIES = [
  row(1, "agent", 1, 1.0), row(2, "agent", 2, 1.2), row(3, "agent", 3, 0.8),
  { ...row(4, "replay", 4, 0.3), run_id: "replay-1" }, { ...row(5, "replay", 5, 0.3), run_id: "replay-2" },
  row(6, "workflow", 7, 0.1, 0.4), row(7, "handed_back", 8, 0.95), row(8, "workflow", 9, 0.1), row(9, "workflow", 10, 0.1, 0.4),
  { ...row(10, "replay", 11, 0.5), run_id: "replay-3" },
  row(11, "workflow", 12, 0.1), row(12, "workflow", 13, 0.1),
];
const PROMOTED = at(6);

test("billOf: the cumulative booked $ against the agent for all of it, shadows and checks included; break-even once the bill stays at or under it", () => {
  const bill = billOf(SERIES, PROMOTED);
  assert.deepEqual(bill.baseline, { runs: 3, mean_usd: 1 }, "the agent runs before the promotion, own $");
  assert.deepEqual(bill.promoted, { n: 4, run_id: "run-06", at: PROMOTED }, "the first run from the promotion on, by its index among the runs");
  // The index counts the runs that do a job: a replay is no run of it; its cost joins the run it followed.
  assert.deepEqual(bill.points.map((p) => [p.n, p.run_id, p.actual_usd, p.agent_usd]), [
    [1, "run-01", 1, 1], [2, "run-02", 2.2, 2], [3, "run-03", 3.6, 3],
    [4, "run-06", 4.1, 4], [5, "run-07", 5.05, 5], [6, "run-08", 5.15, 6], [7, "run-09", 6.15, 7],
    [8, "run-11", 6.25, 8], [9, "run-12", 6.35, 9],
  ]);
  assert.deepEqual(bill.break_even, { n: 6, run_id: "run-08" }, "the bill is over the line at 5, at or under it from 6 on");
  assert.equal(bill.gap_usd, null);
  assert.equal(bill.withheld, 0);
  assert.equal(bill.booked_usd, 6.35);
});

test("billOf: not yet while the bill is over the line at its last run, with the gap; a run over it again moves break-even later", () => {
  const short = billOf(SERIES.slice(0, 7), PROMOTED);
  assert.equal(short.break_even, null);
  assert.equal(short.gap_usd, 0.05, "the bill less the line at the last run");
  // A dear shadow at run 7 puts the bill over the line again: break-even is where it stays under.
  const dear = SERIES.map((one) => (one.run_id === "run-09" ? { ...one, learning_usd: 1.5, total_usd: 1.6 } : one));
  const again = billOf(dear, PROMOTED);
  assert.deepEqual(again.points.slice(5).map((p) => [p.n, p.actual_usd, p.agent_usd]), [[6, 5.15, 6], [7, 7.25, 7], [8, 7.35, 8], [9, 7.45, 9]]);
  assert.deepEqual(again.break_even, { n: 8, run_id: "run-11" });
});

test("billOf: before any promotion the line is every agent run's mean and there is no break-even, only the gap; a run of unknown cost is on neither line and counted", () => {
  const before = billOf(SERIES.slice(0, 3), null);
  assert.deepEqual(before.baseline, { runs: 3, mean_usd: 1 });
  assert.equal(before.promoted, null);
  assert.equal(before.break_even, null);
  assert.equal(before.gap_usd, 0);
  const unknown = billOf(SERIES.map((one) => (one.run_id === "run-02" ? { ...one, cost_usd: null, total_usd: null } : one)), PROMOTED);
  assert.equal(unknown.withheld, 1);
  assert.deepEqual(unknown.baseline, { runs: 2, mean_usd: 0.9 });
  assert.deepEqual(unknown.points.slice(0, 3).map((p) => [p.n, p.actual_usd, p.agent_usd]), [[1, 1, 0.9], [3, 2.4, 1.8], [4, 2.9, 2.7]], "its index kept, the line counting the runs it shows");
  assert.equal(billOf([], null).points.length, 0);
});

test("amortize: a revision's spend over its first K served runs to the micro-dollar; what a stopped or short revision has not passed on is unattributed", () => {
  const revisions = [
    { workflow: "answer", digest: A, spend_usd: 0.6, k: 3, state: "serving" },
    { workflow: "answer", digest: B, spend_usd: 0.5, k: 4, state: "stopped" },
    { workflow: "other", digest: "c".repeat(16), spend_usd: 0.1, k: 3, state: "serving" },
  ];
  const served = [["run-06", A], ["run-07", A], ["run-08", A], ["run-09", A], ["run-10", B], ["run-11", "c".repeat(16)], ["run-12", "c".repeat(16)], ["run-13", "c".repeat(16)]].map(([run_id, digest]) => ({ run_id, digest }));
  const out = amortize(revisions, served);
  assert.deepEqual([...out.shares], [["run-06", 0.2], ["run-07", 0.2], ["run-08", 0.2], ["run-10", 0.125], ["run-11", 0.033334], ["run-12", 0.033333], ["run-13", 0.033333]], "paid after K: run-09 carries none");
  assert.deepEqual(out.revisions.map((one) => [one.digest, one.served, one.attributed_usd, one.unattributed_usd, one.state]), [[A, 3, 0.6, 0, "serving"], [B, 1, 0.125, 0.375, "stopped"], ["c".repeat(16), 3, 0.1, 0, "serving"]]);
  assert.equal(out.unattributed_usd, 0.375);
  // A spend no one knows: its runs' shares are unknown, never $0, and so is the remainder.
  const unknown = amortize([{ workflow: "answer", digest: A, spend_usd: null, k: 2, state: "serving" }], served.slice(0, 1));
  assert.deepEqual([...unknown.shares], [["run-06", null]]);
  assert.equal(unknown.unattributed_usd, null);
});

const LEARNS = { input: { content: "Go." }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0 } };

/** Agent `agent-1` on the store, its runs as SERIES has them: each started a minute apart, ended at its cost with its
 *  path; the shadows of run-06 and run-09 ($0.40 each); revision A promoted (compile_after 3) between the replays and
 *  run-06; revision B's check (replay-3) held it, stopped. */
async function ledgerStore(t) {
  const clock = { now: Date.parse(at(0)) };
  const { store } = await storeOn(t, { clock });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", learning: true } });
  const end = async (id, cost, metrics, body = LEARNS) => {
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: cost, metrics });
  };
  const served = (path, digest) => ({ path, workflow: "answer", workflow_digest: digest });
  const replay = (digest, of) => ({ path: "replay", workflow: "answer", workflow_digest: digest, replay: { of, outcome: "answered" } });
  const shadow = (of, digest) => ({ input: { content: "Go." }, title: "t", place: { mode: "runner" }, audit: { of, workflow: "answer", digest } });
  for (const one of SERIES) {
    clock.now = Date.parse(one.started_at);
    if (one.path === "agent") await end(one.run_id, one.cost_usd, { path: "agent" });
    else if (one.path === "replay") await end(one.run_id, one.cost_usd, replay(one.run_id === "replay-3" ? B : A, "run-01"), { ...LEARNS, replay: { of: "run-01", workflow: "answer", digest: one.run_id === "replay-3" ? B : A } });
    else await end(one.run_id, one.cost_usd, served(one.path, A));
    if (one.learning_usd) await end(`audit.${one.run_id}`, one.learning_usd, { path: "audit", audit: { of: one.run_id, workflow: "answer", digest: A } }, shadow(one.run_id, A));
  }
  const bar = { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  await store.settings.put("learning.promotions.agent-1", { v: 1, items: [
    { workflow: "answer", digest: A, at: PROMOTED, decided: "promote", reason: "checked: promoted", check: { ...bar, n: 2, agreed: 2, alone: 2, of: ["run-01", "run-02"], cost_usd: 0.6 } },
    { workflow: "answer", digest: B, at: at(11), decided: "hold", reason: "held", check: { ...bar, attempt: 2, n: 1, agreed: 0, alone: 1, of: ["run-01"], cost_usd: 0.5, stopped: true } },
  ] });
  return store;
}

test("over the store: the series' bill, each run's all-in over v2 (a shadow's cost on the run it audits, a check's over its revision's first K served runs), and the invariant", async (t) => {
  const store = await ledgerStore(t);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.bill.points.map((p) => [p.run_id, p.actual_usd, p.agent_usd]).at(-1), ["run-12", 6.35, 9]);
  assert.deepEqual(cost.bill.break_even, { n: 6, run_id: "run-08" });
  assert.equal(cost.bill.booked_usd, 6.35);
  assert.equal(cost.bill.unattributed_usd, 0.5, "B stopped with none of its check passed on");
  assert.deepEqual(cost.bill.revisions.map((one) => [one.digest, one.spend_usd, one.k, one.served, one.attributed_usd, one.unattributed_usd, one.state]), [[A, 0.6, 3, 3, 0.6, 0, "serving"], [B, 0.5, 3, 0, 0, 0.5, "stopped"]]);

  const all = {};
  for (const run of await store.runs.list({ agentId: "agent-1" })) all[run.id] = await runAllInOverStore(store, run.id);
  const pick = (id) => [all[id].path, all[id].learning_usd, all[id].all_in_usd];
  assert.deepEqual(pick("run-01"), ["agent", 0, 1]);
  assert.deepEqual(pick("run-06"), ["workflow", 0.6, 0.7], "its shadow's $0.40 and a third of A's check");
  assert.deepEqual(pick("run-07"), ["handed_back", 0.2, 1.15]);
  assert.deepEqual(pick("run-08"), ["workflow", 0.2, 0.3]);
  assert.deepEqual(pick("run-09"), ["workflow", 0.4, 0.5], "A's check is paid: its shadow alone");
  assert.deepEqual(pick("audit.run-06"), ["audit", 0, 0], "a shadow's spend is on the run it audits");
  assert.deepEqual(pick("replay-1"), ["replay", 0, 0], "a check's spend is on its revision's served runs");
  const sum = Object.values(all).reduce((total, one) => total + Math.round(one.all_in_usd * 1e6), 0);
  assert.equal(sum + Math.round(cost.bill.unattributed_usd * 1e6), Math.round(cost.bill.booked_usd * 1e6), "every run's all-in and the unattributed remainder are the booked total");
});
