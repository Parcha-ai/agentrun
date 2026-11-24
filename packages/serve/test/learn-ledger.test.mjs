// The ledger (learn/ledger.ts): what a run's end writes (record: one row a run, one spend row a learning cost, keyed to
// the workflow revision it is for), the one formula a run's figures take (figuresOf), and the one reading of them all
// (summarize), which GET /agents/{id}/learning/cost and GET /runs/{id}'s cost both read:
//   - record on each kind of end: a run by hand, a compile that drafted a revision, one whose drafts failed, one the cap
//     stopped, a bound, a replay, an audit's shadow, a money-rule stop;
//   - figuresOf: the series' learning (the look-back and the shadow) against the run read's (the follow-ups, the shadow
//     and the share: its compile turns are its revision's);
//   - summarize: the by-hand side is one function (the summary's `before`, the money rule's by_hand), and a compile's
//     spend sits on its revision whether or not a promotion record names it;
//   - over HTTP: every run of the cost route reads the same figures on GET /runs/{id}, and every run's all-in and the
//     bill's unattributed add up to its booked total.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

const { figuresOf, record, summarize } = await import("../dist/learn/ledger.js");
const { byHandSide } = await import("../dist/learning-cost.js");
const { pastRunsOf } = await import("../dist/store-reads/learning.js");
const { promotionsKey } = await import("../dist/learn/promote.js");

const C = "c".repeat(16);
const AT = "2026-11-24T00:00:00.000Z";
/** A run's end as record() reads it: `r` of agent `a`, its row's cost, its metrics and the rounds its learning kept. */
const endOf = ({ id = "r", startedAt = 0, costUsd = null, costAtMostUsd = null, metrics = { path: "agent" }, rounds = [] }) => ({ id, agentId: "a", startedAt, costUsd, costAtMostUsd, metrics, rounds });
/** A kept round: its job's cost as it answered, its compile turn's (look_back_usd), and the draft it kept. */
const round = (job, look, extra = {}) => ({ round: 1, proposal: { state: "dropped", reason: "empty", detail: "d", answered_at: AT, job_cost_usd: job, look_back_usd: look, ...extra } });
const row = (over) => ({ runId: "r", agentId: "a", startedAt: 0, path: "agent", workflow: null, digest: null, notServed: null, jobUsd: null, lookBackUsd: 0, cost: "known", ...over });
const spendRow = (over) => ({ runId: "r", agentId: "a", round: 0, ofRun: null, workflow: null, digest: null, usd: null, ...over });

test("record: one ledger row a run, and a spend row for each compile turn, check and audit, keyed to the revision it is for", () => {
  const served = { path: "workflow", workflow: "answer", workflow_digest: C };
  for (const [why, end, want] of [
    ["by hand, no rounds", endOf({ costUsd: 0.5 }), { row: row({ jobUsd: 0.5 }), spend: [] }],
    ["a compile that drafted C: its turn is C's", endOf({ costUsd: 1.3, rounds: [round(1, 0.3, { compiled: { workflow: "answer", digest: C } })] }), { row: row({ jobUsd: 1, lookBackUsd: 0.3 }), spend: [spendRow({ round: 1, kind: "compile", workflow: "answer", digest: C, usd: 0.3 })] }],
    ["drafts that failed their checks: the workflow, no revision", endOf({ costUsd: 1.2, rounds: [round(1, 0.2, { compiled: { workflow: "answer", digest: C }, draft_errors: ["no root"] })] }), { row: row({ jobUsd: 1, lookBackUsd: 0.2 }), spend: [spendRow({ round: 1, kind: "compile", workflow: "answer", usd: 0.2 })] }],
    ["a digest out of shape names no revision", endOf({ costUsd: 1.2, rounds: [round(1, 0.2, { compiled: { workflow: "answer", digest: "zz" } })] }), { row: row({ jobUsd: 1, lookBackUsd: 0.2 }), spend: [spendRow({ round: 1, kind: "compile", workflow: "answer", usd: 0.2 })] }],
    ["the cap stopped it: no draft, the spend on no revision", endOf({ costUsd: 1.2, rounds: [round(1, 0.2)] }), { row: row({ jobUsd: 1, lookBackUsd: 0.2 }), spend: [spendRow({ round: 1, kind: "compile", usd: 0.2 })] }],
    ["a round that asked no turn books none", endOf({ costUsd: 1, rounds: [round(1, 0)] }), { row: row({ jobUsd: 1 }), spend: [] }],
    ["a bound is at most, never a cost", endOf({ costAtMostUsd: 0.5 }), { row: row({ cost: "at_most" }), spend: [] }],
    ["an unknown cost", endOf({}), { row: row({ cost: "unknown" }), spend: [] }],
    ["a served run", endOf({ costUsd: 0.1, metrics: served }), { row: row({ path: "workflow", workflow: "answer", digest: C, jobUsd: 0.1 }), spend: [] }],
    ["a check's replay: its cost is its revision's", endOf({ costUsd: 0.3, metrics: { ...served, path: "replay" } }), { row: row({ path: "replay", workflow: "answer", digest: C, jobUsd: 0.3 }), spend: [spendRow({ kind: "check", workflow: "answer", digest: C, usd: 0.3 })] }],
    ["an audit's shadow: its cost is the run it audits'", endOf({ costUsd: 0.05, metrics: { path: "audit", audit: { of: "s", workflow: "answer", digest: C } } }), { row: row({ path: "audit", workflow: "answer", digest: C, jobUsd: 0.05 }), spend: [spendRow({ kind: "audit", ofRun: "s", workflow: "answer", digest: C, usd: 0.05 })] }],
    ["the money rule stopped its workflow", endOf({ costUsd: 0.4, metrics: { path: "agent", not_served: "cost_stop" } }), { row: row({ notServed: "cost_stop", jobUsd: 0.4 }), spend: [] }],
    ["a path no one knows names none", endOf({ costUsd: 0.4, metrics: { path: "sideways" } }), { row: row({ path: null, jobUsd: 0.4 }), spend: [] }],
  ]) assert.deepEqual(record(end), want, why);
});

test("figuresOf: one formula; the series' learning is the look-back and the shadow, the run read's the follow-ups, the shadow and the share", () => {
  const figures = (over, parts) => figuresOf(row(over), { compile: 0, shadow: 0, share: 0, ...parts });
  assert.deepEqual(figures({ jobUsd: 1, lookBackUsd: 0.3 }, { compile: 0.3 }), { usd: 1, compile_usd: 0.3, followup_usd: 0, shadow_usd: 0, share_usd: 0, series_learning_usd: 0.3, series_total_usd: 1.3, learning_usd: 0, all_in_usd: 1 }, "its compile turn is its revision's, never its own learning");
  assert.deepEqual(figures({ jobUsd: 0.5, lookBackUsd: 0.7 }, { compile: 0.3 }), { usd: 0.5, compile_usd: 0.3, followup_usd: 0.4, shadow_usd: 0, share_usd: 0, series_learning_usd: 0.7, series_total_usd: 1.2, learning_usd: 0.4, all_in_usd: 0.9 }, "a follow-up's turns are its learning");
  assert.deepEqual(figures({ path: "workflow", jobUsd: 0.1 }, { shadow: 0.05, share: 0.3 }), { usd: 0.1, compile_usd: 0, followup_usd: 0, shadow_usd: 0.05, share_usd: 0.3, series_learning_usd: 0.05, series_total_usd: 0.15, learning_usd: 0.35, all_in_usd: 0.45 }, "a served run carries its shadow and its share");
  assert.deepEqual(figures({ path: "replay", jobUsd: 0.3 }, { share: 0.2 }), { usd: 0.3, compile_usd: 0, followup_usd: 0, shadow_usd: 0, share_usd: 0, series_learning_usd: 0, series_total_usd: 0.3, learning_usd: 0, all_in_usd: 0 }, "a replay carries none: its spend is on the runs it serves");
  const open = figures({ path: "workflow", jobUsd: 0.1 }, { shadow: null });
  assert.deepEqual([open.series_total_usd, open.learning_usd, open.all_in_usd], [null, null, null], "a shadow at work: unknown, never $0");
  const bound = figures({ cost: "at_most", jobUsd: null });
  assert.deepEqual([bound.usd, bound.series_total_usd, bound.all_in_usd], [null, null, null], "a bound: no cost");
});

/** An agent's series as its runs' ends wrote it, a minute apart: two runs by hand (the second compiled C at $0.30 of its
 *  $1.30), a check's replay of C ($0.30), then three runs C served at $0.10, the first audited ($0.05 shadow). */
const SERIES = (() => {
  const minute = (i) => Date.UTC(2026, 10, 24, 0, i);
  const served = { path: "workflow", workflow: "answer", workflow_digest: C };
  const ends = [
    endOf({ id: "r1", startedAt: minute(1), costUsd: 1 }),
    endOf({ id: "r2", startedAt: minute(2), costUsd: 1.3, rounds: [round(1, 0.3, { compiled: { workflow: "answer", digest: C } })] }),
    endOf({ id: "replay-1", startedAt: minute(3), costUsd: 0.3, metrics: { ...served, path: "replay" } }),
    endOf({ id: "r3", startedAt: minute(4), costUsd: 0.1, metrics: served }),
    endOf({ id: "r4", startedAt: minute(5), costUsd: 0.1, metrics: served }),
    endOf({ id: "r5", startedAt: minute(6), costUsd: 0.1, metrics: served }),
  ].map(record);
  const shadow = record(endOf({ id: "audit.r3", startedAt: minute(7), costUsd: 0.05, metrics: { path: "audit", audit: { of: "r3", workflow: "answer", digest: C } } }));
  return { rows: ends.map((one) => one.row), spend: [...ends.flatMap((one) => one.spend), ...shadow.spend], shadows: new Map([["r3", "ended"]]), compileAfter: 2 };
})();

test("summarize: a compile's spend sits on its revision whether or not a record names it, spread over its first K served runs; every run's all-in and the unattributed add up to the booked total", () => {
  const bare = summarize({ ...SERIES, revisions: [] });
  assert.deepEqual(bare.bill.revisions.map((one) => [one.workflow, one.digest, one.compile_usd, one.check_usd, one.k, one.served, one.attributed_usd, one.state]), [["answer", C, 0.3, 0.3, 2, 3, 0.6, "checking"]], "no record: C still pays its compile and check, at the default K");
  const share = (out, id) => out.figures.get(id).share_usd;
  assert.deepEqual(["r3", "r4", "r5"].map((id) => share(bare, id)), [0.3, 0.3, 0]);
  const named = summarize({ ...SERIES, revisions: [{ workflow: "answer", digest: C, k: 3, state: "serving" }] });
  assert.deepEqual(["r3", "r4", "r5"].map((id) => share(named, id)), [0.2, 0.2, 0.2], "the record's K");
  assert.deepEqual(named.bill.revisions.map((one) => [one.digest, one.k, one.state]), [[C, 3, "serving"]], "named once");
  for (const out of [bare, named]) {
    assert.equal(out.bill.booked_usd, 2.95);
    const carried = [...out.figures.values()].reduce((total, one) => total + Math.round(one.all_in_usd * 1e6), 0);
    assert.equal(carried + Math.round(out.bill.unattributed_usd * 1e6), Math.round(out.bill.booked_usd * 1e6), "Σ all_in + unattributed = booked");
  }
  const r2 = bare.runs.find((run) => run.run_id === "r2");
  assert.deepEqual([r2.cost_usd, r2.learning_usd, r2.total_usd, r2.compile_usd, r2.share_usd], [1, 0.3, 1.3, 0.3, 0], "the series row keeps its look-back; its compile is named apart");
  const r3 = bare.runs.find((run) => run.run_id === "r3");
  assert.deepEqual([r3.audited, r3.shadow_usd, r3.share_usd, r3.total_usd], [true, 0.05, 0.3, 0.15]);
  assert.equal(bare.figures.get("r3").learning_usd, 0.35);
});

test("summarize: the by-hand side is one function: the mean job $ of the agent runs before the first served run, the summary's before and the money rule's by_hand", () => {
  const out = summarize({ ...SERIES, revisions: [] });
  const jobs = byHandSide(out.runs).map((run) => run.cost_usd);
  assert.deepEqual(jobs, [1, 1], "r1, and r2's job without its compile turn");
  assert.deepEqual(out.summary.before, { runs: 2, mean_usd: 1 });
  const past = pastRunsOf(out, [], () => true);
  assert.deepEqual([past.by_hand, past.by_hand_unknown], [out.summary.before, 0], "the money rule's by-hand side is the cost page's");
  const unknown = summarize({ ...SERIES, rows: SERIES.rows.map((one) => (one.runId === "r1" ? { ...one, jobUsd: null, cost: "unknown" } : one)), revisions: [] });
  assert.deepEqual([unknown.summary.before, pastRunsOf(unknown, [], () => true).by_hand_unknown], [{ runs: 1, mean_usd: 1 }, 1], "an unknown cost is left out of the mean and counted");
});

const LEARNS = { input: { content: "What is 1 plus 41?" }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: "a".repeat(40), section: "", seedNotes: 0, workflows: ["answer"] } };

test("GET /agents/{id}/learning/cost and GET /runs/{id} read one ledger: each run's job $ and learning parts agree, and every run's all-in and the unattributed are the booked total", async (t) => {
  // No runner: each run is ended in the store as a runner ends it, with the metrics and kept round its end writes.
  const { api, store, baseUrl } = await serve(t, { learning: "on", runner: false });
  assert.equal((await api("POST", "/agents", agent("source", { learning: { audit_every: 1 } }))).status, 201);
  const revisionId = (await store.agents.get("source")).currentRevision;
  const end = async (id, costUsd, metrics, { body = LEARNS, kept } = {}) => {
    // A run a few milliseconds after the one before: the series orders by start.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.runs.create({ id, agentId: "source", revisionId }, { body });
    const claim = await store.claim(id, "runner-a", { leaseMs: 60_000 });
    await store.runs.update(claim, { state: "ended", costUsd, metrics }, kept ? { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }] } : undefined);
  };
  const served = { path: "workflow", workflow: "answer", workflow_digest: C };
  await end("run-01", 1, { path: "agent" });
  await end("run-02", 1.3, { path: "agent" }, { kept: round(1, 0.3, { compiled: { workflow: "answer", digest: C } }).proposal });
  await end("replay-1", 0.3, { ...served, path: "replay", replay: { of: "run-01", outcome: "answered" } }, { body: { ...LEARNS, replay: { of: "run-01", workflow: "answer", digest: C } } });
  const check = { compile_after: 2, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 1, agreed: 1, alone: 1, of: ["run-01"] };
  await store.settings.put(promotionsKey("source"), { v: 1, items: [{ workflow: "answer", digest: C, at: new Date().toISOString(), decided: "promote", reason: "checked: promoted", check }] });
  await end("run-03", 0.1, served);
  const audit = { of: "run-03", workflow: "answer", digest: C };
  await end("audit.run-03", 0.05, { path: "audit", audit }, { body: { input: LEARNS.input, title: "t", place: { mode: "runner" }, audit } });
  await end("run-04", 0.1, served);
  await end("run-05", 0.1, served);

  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const meets = (path, value) => assert.deepEqual(schemaProblems(doc, doc.paths[path].get.responses["200"].content["application/json"].schema, value), [], `${path}: ${JSON.stringify(value)}`);
  const { status, body: cost } = await api("GET", "/agents/source/learning/cost");
  assert.equal(status, 200, JSON.stringify(cost));
  meets("/agents/{agent_id}/learning/cost", cost);
  assert.deepEqual(cost.runs.map((run) => run.run_id), ["run-01", "run-02", "replay-1", "run-03", "run-04", "run-05"]);
  const views = {};
  for (const id of [...cost.runs.map((run) => run.run_id), "audit.run-03"]) {
    const read = await api("GET", `/runs/${id}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    meets("/runs/{run_id}", read.body);
    views[id] = read.body.cost;
  }
  const micro = (usd) => (usd === null ? null : Math.round(usd * 1e6));
  for (const run of cost.runs) {
    const view = views[run.run_id];
    assert.deepEqual([view.usd, view.compile_usd, view.followup_usd, view.shadow_usd, view.share_usd], [run.cost_usd, run.compile_usd, run.followup_usd, run.shadow_usd, run.share_usd], `${run.run_id}: one ledger: ${JSON.stringify({ run, view })}`);
    if (run.path !== "replay") assert.equal(micro(view.learning_usd), micro(view.followup_usd) + micro(view.shadow_usd) + micro(view.share_usd), `${run.run_id}: its learning is its parts`);
  }
  const pick = (id) => [views[id].usd, views[id].compile_usd, views[id].share_usd, views[id].learning_usd, views[id].all_in_usd];
  assert.deepEqual(pick("run-02"), [1, 0.3, 0, 0, 1], "its compile turn is C's, named apart, never its learning");
  assert.deepEqual(pick("run-03"), [0.1, 0, 0.3, 0.35, 0.45], "its shadow and half of C's compile and check");
  assert.deepEqual(pick("run-04"), [0.1, 0, 0.3, 0.3, 0.4]);
  assert.deepEqual(pick("run-05"), [0.1, 0, 0, 0, 0.1], "C is paid");
  assert.deepEqual([views["replay-1"].learning_usd, views["replay-1"].all_in_usd, views["audit.run-03"].all_in_usd], [0, 0, 0], "a check's and a shadow's spend are on the runs they serve");
  const carried = Object.values(views).reduce((total, one) => total + micro(one.all_in_usd), 0);
  assert.equal(carried + micro(cost.bill.unattributed_usd), micro(cost.bill.booked_usd), `Σ all_in + unattributed = booked: ${JSON.stringify(cost.bill)}`);
  assert.equal(cost.bill.booked_usd, 2.95);
});
