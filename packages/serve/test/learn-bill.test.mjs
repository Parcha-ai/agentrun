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

// r2 (#3087, TL decisions on the A8 split and the review threads).

test("billOf: booked spend after a withheld last job joins no point but is in the gap: a priced replay after it leaves no false break-even", () => {
  // The r1 series breaks even at run 6; a last job of unknown cost, then a $3.00 replay after it.
  const tail = [...SERIES, row(13, "workflow", 14, null), { ...row(14, "replay", 15, 3), run_id: "replay-4" }];
  const bill = billOf(tail, PROMOTED);
  assert.equal(bill.withheld, 1, "the job of unknown cost is on neither line");
  assert.equal(bill.points.at(-1).run_id, "run-12", "no point for it, nor for the replay after it");
  assert.equal(bill.booked_usd, 9.35, "the replay is booked");
  assert.equal(bill.break_even, null, "$9.35 booked is over the agent for all of it at the last point ($9.00)");
  assert.equal(bill.gap_usd, 0.35);
  // Booked spend with no point before it is carried to the next point that has one.
  const carried = billOf([...tail, row(15, "workflow", 16, 0.1)], PROMOTED);
  assert.deepEqual(carried.points.at(-1), { n: 11, run_id: "run-15", actual_usd: 9.45, agent_usd: 10 });
  assert.deepEqual(carried.break_even, { n: 6, run_id: "run-08" }, "carried, it never put a point over the line");
  assert.equal(carried.gap_usd, null);
  assert.equal(carried.booked_usd, 9.45);
});

const C = "c".repeat(16);
const compiled = (digest, cost) => (digest ? { workflow: "answer", from_notes: [], attempts: [{ ok: true, errors: [] }], digest } : { workflow: "answer", from_notes: [], attempts: [{ ok: false, errors: [cost.error] }] });
/** A kept round that looked back: its job's cost, its look-back's (the compile turn's among it) and, when it compiled,
 *  the compile turn's spend and the draft it kept (none when every draft failed its checks). */
const kept = ({ job, look, compile, digest, error }) => ({
  state: "dropped", reason: "empty", detail: "kept nothing", answered_at: at(0), job_cost_usd: job, look_back_usd: look,
  ...(compile === undefined ? {} : { compile_usd: compile, compiled: compiled(digest, { error }), ...(digest ? {} : { draft_errors: [error] }) }),
});

/** Agent `agent-1` over the A8 split, each run a minute apart:
 *  - run-01, an agent run ($1.00, it looked back on nothing: $0);
 *  - run-02, an agent run whose session compiled revision C: its row $1.50, the job $1.00, its look-back $0.50 of which
 *    the compile turn $0.30;
 *  - run-03, an agent run whose compile drafts all failed: its row $1.25, the job $1.00, its look-back $0.25 of which the
 *    compile turn $0.20;
 *  - C's check: replay-1 and replay-2 at `replay` each ($0.30 by default);
 *  - C promoted (compile_after 3), then four runs it served at $0.10 (run-04 to run-07);
 *  - run-08, an agent run at $3.00 by hand after them;
 *  - `records`: the promotion feed (C's promote by default). */
async function splitStore(t, { replay = 0.3, records } = {}) {
  const clock = { now: Date.parse(at(0)) };
  const { store } = await storeOn(t, { clock });
  await store.agents.create({ id: "agent-1", name: "Learns" }, { id: "rev-1", kind: "agentic", body: { instructions: "Go.", learning: true } });
  let minute = 0;
  const end = async (id, cost, metrics, { body = LEARNS, round } = {}) => {
    clock.now = Date.parse(at((minute += 1)));
    await store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd: cost, metrics }, round ? { also: [{ table: "learning_proposals", row: { turn: {}, proposal: round } }] } : undefined);
  };
  const served = { path: "workflow", workflow: "answer", workflow_digest: C };
  await end("run-01", 1, { path: "agent" });
  await end("run-02", 1.5, { path: "agent" }, { round: kept({ job: 1, look: 0.5, compile: 0.3, digest: C }) });
  await end("run-03", 1.25, { path: "agent" }, { round: kept({ job: 1, look: 0.25, compile: 0.2, error: "its draft failed its checks" }) });
  for (const id of ["replay-1", "replay-2"]) await end(id, replay, { path: "replay", workflow: "answer", workflow_digest: C, replay: { of: "run-01", outcome: "answered" } }, { body: { ...LEARNS, replay: { of: "run-01", workflow: "answer", digest: C } } });
  const promotedAt = at((minute += 1));
  for (const id of ["run-04", "run-05", "run-06", "run-07"]) await end(id, 0.1, served);
  await end("run-08", 3, { path: "agent" });
  const bar = { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  const promote = { workflow: "answer", digest: C, at: promotedAt, decided: "promote", reason: "checked: promoted", check: { ...bar, n: 2, agreed: 2, alone: 2, of: ["run-01", "run-02"] } };
  await store.settings.put("learning.promotions.agent-1", { v: 1, items: records ?? [promote] });
  return store;
}

/** Every run's v2 figures (runAllInOverStore) by id, and the invariant: their all-in and the bill's unattributed are its booked total. */
async function v2Of(store, bill) {
  const all = {};
  for (const run of await store.runs.list({ agentId: "agent-1" })) all[run.id] = await runAllInOverStore(store, run.id);
  if (bill) {
    const sum = Object.values(all).reduce((total, one) => total + Math.round(one.all_in_usd * 1e6), 0);
    assert.equal(sum + Math.round(bill.unattributed_usd * 1e6), Math.round(bill.booked_usd * 1e6), `Σ all_in + unattributed = booked: ${JSON.stringify(all)}`);
  }
  return all;
}

test("A8 (1): the run whose session compiled revision C reports cost.usd its job alone, and its learning_usd leaves the compile turn out; a look-back that compiles nothing stays its own run's learning", async (t) => {
  const store = await splitStore(t);
  const cost = await agentCostOverStore(store, "agent-1");
  const all = await v2Of(store, cost.bill);
  const pick = (id) => [all[id].path, all[id].usd, all[id].learning_usd, all[id].all_in_usd];
  assert.deepEqual(pick("run-02"), ["agent", 1, 0.2, 1.2], "its job $1.00; its look-back less the compile turn, $0.20");
  assert.deepEqual(pick("run-01"), ["agent", 1, 0, 1]);
  assert.deepEqual(pick("run-08"), ["agent", 3, 0, 3]);
});

test("A8 (2): C's next K = compile_after served runs each carry (compile + check)/K; the run past the K-th carries none", async (t) => {
  const store = await splitStore(t);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.bill.revisions.map((one) => [one.digest, one.compile_usd, one.check_usd, one.spend_usd, one.k, one.served, one.attributed_usd, one.unattributed_usd, one.state]), [[C, 0.3, 0.6, 0.9, 3, 3, 0.9, 0, "serving"]]);
  const all = await v2Of(store, cost.bill);
  const pick = (id) => [all[id].path, all[id].usd, all[id].learning_usd, all[id].all_in_usd];
  for (const id of ["run-04", "run-05", "run-06"]) assert.deepEqual(pick(id), ["workflow", 0.1, 0.3, 0.4], `${id}: a third of $0.30 compile + $0.60 check`);
  assert.deepEqual(pick("run-07"), ["workflow", 0.1, 0, 0.1], "C is paid");
  assert.deepEqual(pick("replay-1"), ["replay", 0.3, 0, 0], "a check's spend is on its revision's served runs");
});

test("A8 (3): a compile whose drafts all failed has no revision to serve: its turn's spend is unattributed on the agent ledger, never on a run", async (t) => {
  const store = await splitStore(t);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.equal(cost.bill.unattributed_usd, 0.2, "run-03's compile turn");
  const all = await v2Of(store, cost.bill);
  assert.deepEqual([all["run-03"].usd, all["run-03"].learning_usd, all["run-03"].all_in_usd], [1, 0.05, 1.05], "its look-back less its compile turn");
  assert.equal(cost.bill.booked_usd, 7.75);
});

test("A8: a served run whose revision's check cost is unknown reports learning_usd and all_in_usd null, never $0; the ledger's remainder is unknown too", async (t) => {
  const store = await splitStore(t, { replay: null });
  const cost = await agentCostOverStore(store, "agent-1");
  assert.equal(cost.bill.unattributed_usd, null);
  const all = await v2Of(store);
  assert.deepEqual([all["run-04"].usd, all["run-04"].learning_usd, all["run-04"].all_in_usd], [0.1, null, null]);
  assert.deepEqual([all["run-07"].learning_usd, all["run-07"].all_in_usd], [0, 0.1], "past the K-th: none of it to carry");
});

test("A8: with the promotion feed trimmed below the first promotion, the invariant and the baseline hold: an aged-out revision's spend is unattributed, the cutoff is the first served run", async (t) => {
  const kept = await splitStore(t);
  const whole = (await agentCostOverStore(kept, "agent-1")).bill;
  // A later revision's hold, its record the only one the feed still keeps (recordPromotion trims it to 200).
  const hold = { workflow: "answer", digest: "e".repeat(16), at: at(30), decided: "hold", reason: "its draft failed its checks" };
  const store = await splitStore(t, { records: [hold] });
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.bill.baseline, whole.baseline, "the agent runs before the first served run, as with the feed whole");
  assert.deepEqual(cost.bill.baseline, { runs: 3, mean_usd: 1 }, "run-08, by hand after the served runs, is no part of it");
  assert.deepEqual([whole.promoted, cost.bill.promoted], [{ n: 4, run_id: "run-04", at: at(7) }, { n: 4, run_id: "run-04", at: at(7) }], "from the first served run's start");
  assert.deepEqual(cost.bill.revisions.map((one) => one.digest), ["e".repeat(16)]);
  assert.equal(cost.bill.unattributed_usd, 1.1, "C's compile and check, and run-03's failed compile, carried by no run");
  const all = await v2Of(store, cost.bill);
  assert.deepEqual([all["run-04"].learning_usd, all["run-02"].learning_usd], [0, 0.2]);
});

test("the bill's holds: each at its run of the whole series, placed by the server whatever the runs listed", async (t) => {
  const store = await ledgerStore(t);
  const read = await agentCostOverStore(store, "agent-1", 2);
  assert.deepEqual(read.runs.map((run) => run.run_id), ["run-11", "run-12"], "only the 2 latest runs listed");
  assert.deepEqual(read.bill.holds, [{ n: 8, at: at(11), workflow: "answer", by: "check", reason: "held" }], "B's hold at run-11, the first job from it on");
});
