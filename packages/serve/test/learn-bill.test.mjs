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

const { billOf, amortize, costSummary } = await import("../dist/learning-cost.js");
const { agentCostOverStore, runAllInOverStore } = await import("../dist/store-reads/learning.js");
const { forgetRunCopies, PROMOTIONS_KEPT, recordPromotion } = await import("../dist/learn/promote.js");

const A = "a".repeat(16);
const B = "b".repeat(16);
/** One run of the cost series (learning-cost.ts CostRun): `minute` its start, its own $ and what learning added. */
const row = (n, path, minute, cost, learning = 0) => ({
  n, run_id: `run-${String(n).padStart(2, "0")}`, started_at: new Date(Date.UTC(2026, 10, 17, 6, minute)).toISOString(), path, workflow: path === "agent" ? null : "answer", digest: path === "agent" ? null : A, audited: learning > 0,
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
].map((one, at, all) => ({ ...one, n: one.path === "replay" ? null : all.slice(0, at + 1).filter((r) => r.path !== "replay").length }));
const PROMOTED = at(6);
// The bill over a series, with the takeover and before level its summary gives.
const billFor = (runs) => billOf(runs, costSummary(runs));

test("billOf: the cumulative booked $ against the agent for all of it, shadows and checks included; break-even once the bill stays at or under it", () => {
  const bill = billFor(SERIES);
  assert.deepEqual(costSummary(SERIES).before, { runs: 3, mean_usd: 1 }, "the agent runs before the promotion, own $");
  assert.deepEqual(costSummary(SERIES).takeover, { n: 4, run_id: "run-06" }, "the first run a learned workflow served, by its index among the runs");
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
  const short = billFor(SERIES.slice(0, 7));
  assert.equal(short.break_even, null);
  assert.equal(short.gap_usd, 0.05, "the bill less the line at the last run");
  // A dear shadow at run 7 puts the bill over the line again: break-even is where it stays under.
  const dear = SERIES.map((one) => (one.run_id === "run-09" ? { ...one, learning_usd: 1.5, total_usd: 1.6 } : one));
  const again = billFor(dear);
  assert.deepEqual(again.points.slice(5).map((p) => [p.n, p.actual_usd, p.agent_usd]), [[6, 5.15, 6], [7, 7.25, 7], [8, 7.35, 8], [9, 7.45, 9]]);
  assert.deepEqual(again.break_even, { n: 8, run_id: "run-11" });
});

test("billOf: before any promotion the line is every agent run's mean and there is no break-even, only the gap; a run of unknown cost is on neither line and counted", () => {
  const before = billFor(SERIES.slice(0, 3));
  assert.deepEqual(costSummary(SERIES.slice(0, 3)).before, { runs: 3, mean_usd: 1 });
  assert.equal(costSummary(SERIES.slice(0, 3)).takeover, null);
  assert.equal(before.break_even, null);
  assert.equal(before.gap_usd, 0);
  const unknown = billFor(SERIES.map((one) => (one.run_id === "run-02" ? { ...one, cost_usd: null, total_usd: null } : one)));
  assert.equal(unknown.withheld, 1);
  assert.deepEqual(unknown.points.slice(0, 3).map((p) => [p.n, p.actual_usd, p.agent_usd]), [[1, 1, 0.9], [3, 2.4, 1.8], [4, 2.9, 2.7]], "its index kept, the line counting the runs it shows");
  assert.equal(billFor([]).points.length, 0);
});

test("amortize: a revision's spend over its first K served runs to the micro-dollar; what a stopped or short revision has not passed on is unattributed", () => {
  const revisions = [
    { workflow: "answer", digest: A, spend_usd: 0.6, k: 3, state: "serving" },
    { workflow: "answer", digest: B, spend_usd: 0.5, k: 4, state: "stopped" },
    { workflow: "other", digest: "c".repeat(16), spend_usd: 0.1, k: 3, state: "serving" },
  ];
  const served = [["run-06", A], ["run-07", A], ["run-08", A], ["run-09", A], ["run-10", B], ["run-11", "c".repeat(16)], ["run-12", "c".repeat(16)], ["run-13", "c".repeat(16)]].map(([run_id, digest]) => ({ run_id, workflow: digest === "c".repeat(16) ? "other" : "answer", digest }));
  const out = amortize(revisions, served);
  assert.deepEqual([...out.shares], [["run-06", 0.2], ["run-07", 0.2], ["run-08", 0.2], ["run-10", 0.125], ["run-11", 0.033334], ["run-12", 0.033333], ["run-13", 0.033333]], "paid after K: run-09 carries none");
  assert.deepEqual(out.revisions.map((one) => [one.digest, one.served, one.attributed_usd, one.unattributed_usd, one.state]), [[A, 4, 0.6, 0, "serving"], [B, 1, 0.125, 0.375, "stopped"], ["c".repeat(16), 3, 0.1, 0, "serving"]], "A served four runs; the first three carry it");
  assert.equal(out.unattributed_usd, 0.375);
  // A spend no one knows: its runs' shares are unknown, never $0, and so is the remainder.
  const unknown = amortize([{ workflow: "answer", digest: A, spend_usd: null, k: 2, state: "serving" }], served.slice(0, 1));
  assert.deepEqual([...unknown.shares], [["run-06", null]]);
  assert.equal(unknown.unattributed_usd, null);
});

test("A8 (5): spend under a micro-dollar is booked as the usage row books it: the bill's points, total and gap, and a revision's split, never rounded to the micro-dollar", () => {
  // Two TypeSafe decisions at 120 tokens x $0.042/M each: $0.00001008 a run.
  const runs = [1, 2].map((n) => ({ ...row(n, "agent", n, 0.00001008), total_usd: 0.00001008 }));
  const bill = billFor(runs);
  assert.deepEqual(bill.points.map((point) => point.actual_usd), [0.00001008, 0.00002016]);
  assert.equal(bill.booked_usd, 0.00002016);
  assert.equal(costSummary(runs).before.mean_usd, 0.00001, "a mean is a quotient, rounded to the micro-dollar");
  assert.equal(bill.gap_usd, 0.00000016, "the booked total less the line, to the sub-micro-dollar");
  // $0.0000105 over K = 2: whole micro-dollars split ($0.000005 each), the half micro-dollar left on the K-th run.
  const revision = { workflow: "answer", digest: A, spend_usd: 0.0000105, k: 2, state: "serving" };
  const served = ["run-06", "run-07"].map((run_id) => ({ run_id, workflow: "answer", digest: A }));
  const one = amortize([revision], served.slice(0, 1));
  assert.deepEqual([[...one.shares], one.revisions[0].attributed_usd, one.unattributed_usd], [[["run-06", 0.000005]], 0.000005, 0.0000055]);
  const both = amortize([revision], served);
  assert.deepEqual([[...both.shares], both.revisions[0].attributed_usd, both.unattributed_usd], [[["run-06", 0.000005], ["run-07", 0.0000055]], 0.0000105, 0]);
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
  assert.deepEqual(cost.bill.revisions.map((one) => [one.digest, one.spend_usd, one.k, one.served, one.attributed_usd, one.unattributed_usd, one.state]), [[A, 0.6, 3, 6, 0.6, 0, "serving"], [B, 0.5, 3, 0, 0, 0.5, "stopped"]]);

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
  const bill = billFor(tail);
  assert.equal(bill.withheld, 1, "the job of unknown cost is on neither line");
  assert.equal(bill.points.at(-1).run_id, "run-12", "no point for it, nor for the replay after it");
  assert.equal(bill.booked_usd, 9.35, "the replay is booked");
  assert.equal(bill.break_even, null, "$9.35 booked is over the agent for all of it at the last point ($9.00)");
  assert.equal(bill.gap_usd, 0.35);
  // Booked spend with no point before it is carried to the next point that has one.
  const carried = billFor([...tail, row(15, "workflow", 16, 0.1)]);
  assert.deepEqual(carried.points.at(-1), { n: 11, run_id: "run-15", actual_usd: 9.45, agent_usd: 10 });
  assert.deepEqual(carried.break_even, { n: 6, run_id: "run-08" }, "carried, it never put a point over the line");
  assert.equal(carried.gap_usd, null);
  assert.equal(carried.booked_usd, 9.45);
});

test("billOf: replay spend with no job to join is still booked: an owner who archived every job run keeps the replays' dollars", () => {
  const replays = [{ ...row(1, "replay", 1, 0.3), run_id: "replay-1" }, { ...row(2, "replay", 2, 0.3), run_id: "replay-2" }];
  const bill = billFor(replays);
  assert.deepEqual(bill.points, [], "no job, no point");
  assert.equal(bill.booked_usd, 0.6, "both replays booked");
  assert.deepEqual([bill.break_even, bill.gap_usd, bill.withheld], [null, null, 0]);
});

const C = "c".repeat(16);
const compiled = (digest, cost, workflow = "answer") => (digest ? { workflow, from_notes: [], attempts: [{ ok: true, errors: [] }], digest } : { workflow, from_notes: [], attempts: [{ ok: false, errors: [cost.error] }] });
/** A kept round of the end-of-run step: its job's cost and its compile turn's (`look_back_usd`: the step's only model
 *  turn is its compile turn) and the draft it kept (none when every draft failed its checks), of `workflow` ("answer" by
 *  default). `capped`: the cap refused a later attempt of the compile, so the round closed no_budget with the turn's
 *  spend and no draft at all (runner/reflect-hook.ts `capped`). */
const kept = ({ job, look, digest, error, capped = false, workflow }) => ({
  state: "dropped", reason: capped ? "no_budget" : "empty", detail: "kept nothing", answered_at: at(0), job_cost_usd: job, look_back_usd: look,
  ...(capped ? {} : { compiled: compiled(digest, { error }, workflow), ...(digest ? {} : { draft_errors: [error] }) }),
});

/** Agent `agent-1` over the A8 split, each run a minute apart:
 *  - run-01, an agent run ($1.00, it compiled nothing: no round);
 *  - run-02, an agent run whose session compiled revision C: its row $1.30, the job $1.00, the compile turn $0.30;
 *  - run-03, an agent run whose compile drafts all failed: its row $1.20, the job $1.00, the compile turn $0.20;
 *  - C's check: replay-1 and replay-2 at `replay` each ($0.30 by default);
 *  - C promoted (compile_after 3), then four runs it served at $0.10 (run-04 to run-07);
 *  - run-08, an agent run at $3.00 by hand after them;
 *  - `records`: the promotion feed (C's promote by default);
 *  - `capped`: run-03's compile spent its $0.20 on a draft the checks refused, then the cap refused its next attempt, so
 *    its round kept the spend and no draft;
 *  - `recompiled`: run-09 after them, an agent run at $1.07 whose session recompiled the workflow into revision R (the job
 *    $1.00, the compile turn $0.07), which no record names: its check has not started;
 *  - `fresh`: run-10 after them, an agent run at $1.05 whose session recompiled the workflow into revision D (the job
 *    $1.00, the compile turn $0.05). */
const R = "f".repeat(16);
const D = "d".repeat(16);
async function splitStore(t, { replay = 0.3, records, capped = false, recompiled = false, fresh = false } = {}) {
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
  await end("run-02", 1.3, { path: "agent" }, { round: kept({ job: 1, look: 0.3, digest: C }) });
  await end("run-03", 1.2, { path: "agent" }, { round: kept({ job: 1, look: 0.2, error: "its draft failed its checks", capped }) });
  for (const id of ["replay-1", "replay-2"]) await end(id, replay, { path: "replay", workflow: "answer", workflow_digest: C, replay: { of: "run-01", outcome: "answered" } }, { body: { ...LEARNS, replay: { of: "run-01", workflow: "answer", digest: C } } });
  const promotedAt = at((minute += 1));
  for (const id of ["run-04", "run-05", "run-06", "run-07"]) await end(id, 0.1, served);
  await end("run-08", 3, { path: "agent" });
  if (recompiled) await end("run-09", 1.07, { path: "agent" }, { round: kept({ job: 1, look: 0.07, digest: R }) });
  if (fresh) await end("run-10", 1.05, { path: "agent" }, { round: kept({ job: 1, look: 0.05, digest: D }) });
  const bar ={ compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
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

test("A8 (1): the run whose session compiled revision C reports cost.usd its job alone, and its learning_usd leaves the compile turn out (the compile turn is the end-of-run step's only model turn)", async (t) => {
  const store = await splitStore(t);
  const cost = await agentCostOverStore(store, "agent-1");
  const all = await v2Of(store, cost.bill);
  const pick = (id) => [all[id].path, all[id].usd, all[id].learning_usd, all[id].all_in_usd];
  assert.deepEqual(pick("run-02"), ["agent", 1, 0, 1], "its job $1.00; its compile turn is C's, none of it the run's");
  assert.deepEqual(pick("run-01"), ["agent", 1, 0, 1]);
  assert.deepEqual(pick("run-08"), ["agent", 3, 0, 3]);
});

test("A8 (2): C's next K = compile_after served runs each carry (compile + check)/K; the run past the K-th carries none", async (t) => {
  const store = await splitStore(t);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.bill.revisions.map((one) => [one.digest, one.compile_usd, one.check_usd, one.spend_usd, one.k, one.served, one.attributed_usd, one.unattributed_usd, one.state]), [[C, 0.3, 0.6, 0.9, 3, 4, 0.9, 0, "serving"]]);
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
  assert.deepEqual([all["run-03"].usd, all["run-03"].learning_usd, all["run-03"].all_in_usd], [1, 0, 1], "its compile turn is the ledger's, never the run's");
  assert.equal(cost.bill.booked_usd, 7.5);
});

test("A8 (3b): a compile the cap stopped after a refused draft keeps its turn's spend apart: unattributed on the agent ledger, never on its run's learning_usd", async (t) => {
  const store = await splitStore(t, { capped: true });
  const cost = await agentCostOverStore(store, "agent-1");
  assert.equal(cost.bill.unattributed_usd, 0.2, "run-03's compile turn, no draft kept");
  const all = await v2Of(store, cost.bill);
  assert.deepEqual([all["run-03"].usd, all["run-03"].learning_usd, all["run-03"].all_in_usd], [1, 0, 1], "its compile turn is the ledger's, never the run's");
});

test("a recompile's revision whose check has not started is a `drafted` row carrying its compile; once its check starts the row is its record's, the same compile, never counted twice", async (t) => {
  const store = await splitStore(t, { recompiled: true });
  const pick = (one) => [one.workflow, one.digest, one.compile_usd, one.check_usd, one.spend_usd, one.k, one.served, one.attributed_usd, one.unattributed_usd, one.state];
  const micro = (usd) => Math.round(usd * 1e6);
  const sumOf = (rows, field) => rows.reduce((total, one) => total + micro(one[field]), 0);
  // The rest no revision names: the bill's unattributed less each row's.
  const unnamed = (bill) => micro(bill.unattributed_usd) - sumOf(bill.revisions, "unattributed_usd");

  // Its check never started: no record names R.
  const drafted = (await agentCostOverStore(store, "agent-1")).bill;
  assert.deepEqual(drafted.revisions.map(pick), [
    ["answer", C, 0.3, 0.6, 0.9, 3, 4, 0.9, 0, "serving"],
    ["answer", R, 0.07, 0, 0.07, 3, 0, 0, 0.07, "drafted"],
  ], "R's compile on R's own row, at K its workflow's checked compile_after");
  assert.equal(drafted.booked_usd, 8.57);
  assert.equal(unnamed(drafted), micro(0.2), "the rest no row names is run-03's failed compile alone, never R's");
  const all = await v2Of(store, drafted);
  assert.deepEqual([all["run-09"].usd, all["run-09"].learning_usd, all["run-09"].all_in_usd], [1, 0, 1], "run-09's compile turn is R's, never the run's");

  // Its check starts: a replaying record names R.
  const { items } = await store.settings.get("learning.promotions.agent-1");
  const bar = { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  await store.settings.put("learning.promotions.agent-1", { v: 1, items: [...items, { workflow: "answer", digest: R, at: at(40), decided: "replaying", reason: "its check is replaying", check: bar, runs: ["replay-r"], inputs: ["run-08"], replay_id: "rp-r" }] });
  const checking = (await agentCostOverStore(store, "agent-1")).bill;
  assert.deepEqual(checking.revisions.map(pick), [
    ["answer", C, 0.3, 0.6, 0.9, 3, 4, 0.9, 0, "serving"],
    ["answer", R, 0.07, 0, 0.07, 3, 0, 0, 0.07, "checking"],
  ], "one R row, its record's now");
  await v2Of(store, checking);
  // Across both reads: the same compile, the same booked total and the same rest, each once.
  assert.deepEqual([sumOf(checking.revisions, "compile_usd"), micro(checking.booked_usd), micro(checking.unattributed_usd), unnamed(checking)], [sumOf(drafted.revisions, "compile_usd"), micro(drafted.booked_usd), micro(drafted.unattributed_usd), unnamed(drafted)]);
  assert.equal(sumOf(checking.revisions, "compile_usd"), micro(0.37), "C's $0.30 and R's $0.07");
});

/** The split store with R and D compiled (run-09 at m12, run-10 at m13), its feed made full and then trimmed by one write
 *  (recordPromotion): C's promote, `champions` other workflows' promotes (each its workflow's champion: the trim keeps
 *  it), with `replaying` workflow w-r's check of C at work since m6+30s (the trim keeps it while it replays), R's check stopped with nothing to check it on (runner/promotion.ts stopUnchecked's record: n 0, stopped, no
 *  replay ran it) at m12+30s, another workflow's holds at m12+40s (the newest naming run-08 in a disagreement), then the
 *  write's own hold at m12+50s. The trim drops R's stop. */
const trimBar = { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
const after = (minute, seconds) => new Date(Date.parse(at(minute)) + seconds * 1000).toISOString();
const otherHold = (when, extra = {}) => ({ workflow: "other", digest: "0".repeat(16), at: when, decided: "hold", reason: "its draft failed its checks", ...extra });
const replayingRecord = { workflow: "w-r", digest: C, at: after(6, 30), decided: "replaying", reason: "its check is replaying", check: trimBar, runs: ["replay-w"], inputs: ["run-08"], replay_id: "rp-w" };
async function trimmedStore(t, { champions = 0, replaying = false } = {}) {
  const store = await splitStore(t, { recompiled: true, fresh: true });
  const key = "learning.promotions.agent-1";
  const { items: [promote] } = await store.settings.get(key);
  const stop = { workflow: "answer", digest: R, at: after(12, 30), decided: "hold", reason: "nothing to check it on: the agent has no completed run of its own to check it against. It is not promoted, and it stops", check: { ...trimBar, n: 0, agreed: 0, alone: 0, of: [], stopped: true } };
  const others = Array.from({ length: champions }, (_, i) => ({ workflow: `w-${i}`, digest: C, at: after(6, i + 1), decided: "promote", reason: "checked: promoted", check: { ...trimBar, n: 2, agreed: 2, alone: 2, of: [] } }));
  const holds = PROMOTIONS_KEPT - 2 - champions - (replaying ? 1 : 0);
  const named = { check: { ...trimBar, n: 1, agreed: 0, alone: 0, of: ["run-08"], disagreements: [{ run: "run-08", input: "Go.", agent: "its answer" }] } };
  const fillers = Array.from({ length: holds }, (_, i) => otherHold(after(12, 40), i === holds - 1 ? named : {}));
  await store.settings.put(key, { v: 1, items: [promote, ...others, ...(replaying ? [replayingRecord] : []), stop, ...fillers] });
  assert.ok((await recordPromotion(store.settings, "agent-1", otherHold(after(12, 50)), () => true)).won);
  const feed = await store.settings.get(key);
  assert.equal(feed.items.length, PROMOTIONS_KEPT);
  assert.ok(feed.items.some((one) => one.digest === C && one.workflow === "answer"), "C's promote, its workflow's champion, is kept");
  assert.ok(!feed.items.some((one) => one.digest === R), "the trim dropped R's stop");
  return { store, key, stop, feed };
}
const answerRows = (bill) => bill.revisions.filter((one) => one.workflow === "answer").map((one) => [one.digest, one.compile_usd, one.check_usd, one.spend_usd, one.k, one.served, one.attributed_usd, one.unattributed_usd, one.state]);
const unnamedMicro = (bill) => Math.round(bill.unattributed_usd * 1e6) - bill.revisions.reduce((total, one) => total + Math.round(one.unattributed_usd * 1e6), 0);

test("dropped_at (a): a revision whose zero-input stop the trim dropped is never `drafted`: its compile stays the unnamed rest", async (t) => {
  const { store } = await trimmedStore(t);
  const bill = (await agentCostOverStore(store, "agent-1")).bill;
  assert.ok(!answerRows(bill).some(([digest]) => digest === R), `no R row: ${JSON.stringify(answerRows(bill))}`);
  assert.equal(unnamedMicro(bill), 270_000, "the rest no row names: run-03's failed compile ($0.20) and R's compile turn ($0.07)");
  await v2Of(store, bill);
});

test("dropped_at (b): a draft compiled after the trim's newest drop is `drafted`, its compile on its own row", async (t) => {
  const { store } = await trimmedStore(t);
  const bill = (await agentCostOverStore(store, "agent-1")).bill;
  assert.deepEqual(answerRows(bill).filter(([digest]) => digest !== R), [
    [C, 0.3, 0.6, 0.9, 3, 4, 0.9, 0, "serving"],
    [D, 0.05, 0, 0.05, 3, 0, 0, 0.05, "drafted"],
  ]);
  await v2Of(store, bill);
});

test("dropped_at (c): with more than RECENT_KEPT records the trim protects, a stop newer than the 100th-newest record kept is dropped, and its revision is still never `drafted`", async (t) => {
  const { store, stop, feed } = await trimmedStore(t, { champions: 120 });
  assert.ok(Date.parse(stop.at) > Date.parse(feed.items[feed.items.length - PROMOTIONS_KEPT / 2].at), "the stop is newer than the oldest of the newest 100 records kept: a newest-100 bound would call R drafted");
  const bill = (await agentCostOverStore(store, "agent-1")).bill;
  assert.deepEqual(answerRows(bill).map(([digest, , , , , , , , state]) => [digest, state]), [[C, "serving"], [D, "drafted"]], "no R row");
  assert.equal(unnamedMicro(bill), 270_000);
  await v2Of(store, bill);
});

test("dropped_at (d): it is the newest drop ever, and every later write of the feed keeps it: one that trims nothing, one whose trim drops only older records, and the unread-skip write", async (t) => {
  const { store, key, stop } = await trimmedStore(t, { replaying: true });
  const droppedAt = async () => (await store.settings.get(key)).dropped_at;
  assert.equal(await droppedAt(), stop.at, "the newest `at` the trim dropped");
  // A write that trims nothing: a purge blanks run-08's disagreement (forgetRunCopies).
  await forgetRunCopies(store.settings, "agent-1", "run-08");
  const blanked = (await store.settings.get(key)).items.at(-2);
  assert.deepEqual(blanked.check.disagreements, [{ run: "run-08", input: "", agent: null }], "the purge wrote");
  assert.equal(await droppedAt(), stop.at, "a write that trims nothing keeps it");
  // w-r's check settles (held): its replaying record, kept while it replayed, is the oldest one the trim may drop now,
  // older than the drop before.
  const { runs: _runs, inputs: _inputs, replay_id: _id, ...check } = replayingRecord;
  assert.ok((await recordPromotion(store.settings, "agent-1", { ...check, at: after(12, 52), decided: "hold", reason: "checked: held" }, () => true)).won);
  assert.ok(!(await store.settings.get(key)).items.some((one) => one.at === replayingRecord.at), "the trim dropped w-r's replaying record");
  assert.equal(await droppedAt(), stop.at, "the newest drop ever, never the newest of this trim");
  // The purge gate could not read a commit: the write trims nothing (Refused.unread).
  const unread = async () => Object.assign(() => false, { unread: true });
  assert.ok((await recordPromotion(store.settings, "agent-1", otherHold(after(12, 55)), () => true, unread)).won);
  assert.equal((await store.settings.get(key)).items.length, PROMOTIONS_KEPT + 1, "the unread-skip write trimmed nothing");
  assert.equal(await droppedAt(), stop.at, "the unread-skip write keeps it");
});

test("dropped_at (e): one that is no time drafts nothing: what was dropped, and when, is unknown", async (t) => {
  const store = await splitStore(t, { recompiled: true, fresh: true });
  const key = "learning.promotions.agent-1";
  await store.settings.put(key, { ...(await store.settings.get(key)), dropped_at: "not a time" });
  const bill = (await agentCostOverStore(store, "agent-1")).bill;
  assert.deepEqual(answerRows(bill).map(([digest, , , , , , , , state]) => [digest, state]), [[C, "serving"]], "neither R nor D is drafted");
  assert.equal(unnamedMicro(bill), 320_000, "run-03's failed compile, R's and D's compile turns");
  await v2Of(store, bill);
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
  const wholeCost = await agentCostOverStore(kept, "agent-1");
  const whole = wholeCost.bill;
  const wholeSummary = wholeCost.summary;
  // A later revision's hold, its record the only one the feed still keeps (recordPromotion trims it to 200).
  const hold = { workflow: "answer", digest: "e".repeat(16), at: at(30), decided: "hold", reason: "its draft failed its checks" };
  const store = await splitStore(t, { records: [hold] });
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.summary.before, wholeSummary.before, "the agent runs before the first served run, as with the feed whole");
  assert.deepEqual(cost.summary.before, { runs: 3, mean_usd: 1 }, "run-08, by hand after the served runs, is no part of it");
  assert.deepEqual([wholeSummary.takeover, cost.summary.takeover], [{ n: 4, run_id: "run-04" }, { n: 4, run_id: "run-04" }], "from the first served run");
  assert.deepEqual(cost.bill.revisions.map((one) => one.digest), ["e".repeat(16)]);
  assert.equal(cost.bill.unattributed_usd, 1.1, "C's compile and check, and run-03's failed compile, carried by no run");
  const all = await v2Of(store, cost.bill);
  assert.deepEqual([all["run-04"].learning_usd, all["run-02"].learning_usd], [0, 0]);
});

test("the bill's holds: each at its run of the whole series, placed by the server whatever the runs listed", async (t) => {
  const store = await ledgerStore(t);
  const read = await agentCostOverStore(store, "agent-1", 2);
  assert.deepEqual(read.runs.map((run) => run.run_id), ["run-11", "run-12"], "only the 2 latest runs listed");
  assert.deepEqual(read.bill.holds, [{ n: 8, at: at(11), workflow: "answer", by: "check", reason: "held" }], "B's hold at run-11, the first job from it on");
});

test("the bill's holds say what held each: a hold this release's workflow DSL wrote (neither check nor audit) is `dsl`, never a check's", async (t) => {
  const { DSL_REFUSES } = await import("../dist/runner/promotion.js");
  const store = await ledgerStore(t);
  const { items } = await store.settings.get("learning.promotions.agent-1");
  // At run-12's start (minute 13): the 9th run that does a job.
  const refused = { workflow: "answer", digest: A, at: at(13), decided: "hold", reason: `${DSL_REFUSES}: SCHEMA_UNKNOWN_KEY at root: a key this release does not take`, commit: "c".repeat(40) };
  await store.settings.put("learning.promotions.agent-1", { v: 1, items: [...items, refused] });
  const read = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(read.bill.holds.map((one) => [one.n, one.by]), [[8, "check"], [9, "dsl"]], JSON.stringify(read.bill.holds));
  assert.equal(read.bill.holds[1].reason, refused.reason);
});

// r4 (#3087, Greptile PRRT_kwDOUmdVMs64qI6K): a revision is its workflow and its digest, never the digest alone.

test("A8 (4): two workflows whose workflow.json is the same text (one digest): each revision's compile, check and served runs are its own workflow's, and the sums still reconcile with unattributed_usd", async (t) => {
  const D = "d".repeat(16);
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
  // "answer" compiled at $0.30 and checked at $0.30; "lookup", the same text, compiled at $0.60 and checked at $0.90.
  await end("run-01", 1.3, { path: "agent" }, { round: kept({ job: 1, look: 0.3, digest: D }) });
  await end("run-02", 1.6, { path: "agent" }, { round: kept({ job: 1, look: 0.6, digest: D, workflow: "lookup" }) });
  const replay = (workflow) => [{ path: "replay", workflow, workflow_digest: D, replay: { of: "run-01", outcome: "answered" } }, { body: { ...LEARNS, replay: { of: "run-01", workflow, digest: D } } }];
  await end("replay-a", 0.3, ...replay("answer"));
  await end("replay-l", 0.9, ...replay("lookup"));
  const promotedAt = at((minute += 1));
  // Served in turns: answer, lookup, answer, lookup, ... (K = 3 each), the last two past their K-th.
  const served = ["answer", "lookup", "answer", "lookup", "answer", "lookup", "answer", "lookup"];
  for (const [i, workflow] of served.entries()) await end(`run-${String(i + 3).padStart(2, "0")}`, 0.1, { path: "workflow", workflow, workflow_digest: D });
  const bar = { compile_after: 3, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  const promote = (workflow) => ({ workflow, digest: D, at: promotedAt, decided: "promote", reason: "checked: promoted", check: { ...bar, n: 1, agreed: 1, alone: 1, of: ["run-01"] } });
  await store.settings.put("learning.promotions.agent-1", { v: 1, items: [promote("answer"), promote("lookup")] });

  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.bill.revisions.map((one) => [one.workflow, one.digest, one.compile_usd, one.check_usd, one.spend_usd, one.served, one.attributed_usd, one.unattributed_usd]), [["answer", D, 0.3, 0.3, 0.6, 4, 0.6, 0], ["lookup", D, 0.6, 0.9, 1.5, 4, 1.5, 0]]);
  assert.equal(cost.bill.unattributed_usd, 0);
  const all = await v2Of(store, cost.bill);
  const pick = (id) => [all[id].path, all[id].usd, all[id].learning_usd, all[id].all_in_usd];
  for (const id of ["run-03", "run-05", "run-07"]) assert.deepEqual(pick(id), ["workflow", 0.1, 0.2, 0.3], `${id} (answer): a third of $0.30 + $0.30`);
  for (const id of ["run-04", "run-06", "run-08"]) assert.deepEqual(pick(id), ["workflow", 0.1, 0.5, 0.6], `${id} (lookup): a third of $0.60 + $0.90`);
  for (const id of ["run-09", "run-10"]) assert.deepEqual(pick(id), ["workflow", 0.1, 0, 0.1], `${id}: past its revision's K-th`);
  assert.deepEqual([pick("run-01"), pick("run-02")], [["agent", 1, 0, 1], ["agent", 1, 0, 1]], "each compile turn its own workflow's revision's, never its run's");
});

// The Learning tab tells one story (tab polish): one run numbering, the bill's; a revision's served count is every run it
// served; each run names the workflow revision that ran it and whether it was audited; the bill says what learning booked.

test("one numbering: the series numbers the runs that do a job as the bill does (a replay none), and the takeover is the bill's first served run", async (t) => {
  const store = await ledgerStore(t);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.runs.map((run) => [run.run_id, run.n]), [
    ["run-01", 1], ["run-02", 2], ["run-03", 3], ["replay-1", null], ["replay-2", null], ["run-06", 4], ["run-07", 5], ["run-08", 6], ["run-09", 7], ["replay-3", null], ["run-11", 8], ["run-12", 9],
  ], "a replay checks a revision: drawn, never numbered as a job");
  assert.equal(cost.summary.takeover.n, cost.runs.find((run) => run.run_id === cost.summary.takeover.run_id).n, "one takeover: the first served run, numbered as the bill's points are");
  assert.deepEqual(cost.bill.points.map((point) => point.n), cost.runs.filter((run) => run.n !== null).map((run) => run.n), "the bill's points and the series share their numbers");
  // A first served run that handed back is the takeover too: the bill's baseline ends there, and so does the before side.
  const handed = SERIES.map((one) => (one.run_id === "run-06" ? { ...one, path: "handed_back" } : one));
  assert.deepEqual(costSummary(handed).takeover, { n: 4, run_id: "run-06" }, "the first run a learned workflow served, alone or handed back");
});

test("a revision's served count is every run it served (its first K carry its spend), each run names the revision that ran it and whether it was audited, and the bill says what learning booked", async (t) => {
  const store = await ledgerStore(t);
  const cost = await agentCostOverStore(store, "agent-1");
  assert.deepEqual(cost.bill.revisions.map((one) => [one.digest, one.k, one.served, one.attributed_usd]), [[A, 3, 6, 0.6], [B, 3, 0, 0]], "A served six runs; its first three carry its check");
  assert.deepEqual(cost.runs.map((run) => [run.run_id, run.digest, run.audited]), [
    ["run-01", null, false], ["run-02", null, false], ["run-03", null, false], ["replay-1", A, false], ["replay-2", A, false],
    ["run-06", A, true], ["run-07", A, false], ["run-08", A, false], ["run-09", A, true], ["replay-3", B, false], ["run-11", A, false], ["run-12", A, false],
  ], "the workflow revision that ran each run, never the learning folder's commit");
  assert.equal("learned_revision" in cost.runs[0], false, "one revision a run: the workflow's");
  assert.equal(cost.bill.learning_usd, 1.9, "the three replays ($1.10) and the two shadows ($0.80): the booked total less the jobs' own $");
});
