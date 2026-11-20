// An agent's cost per run, run after run (GET /v2/agents/{id}/learning/cost): each ended run in order, its own cost, what
// learning added for it (its compile turn), the path it took (a learned workflow alone, a learned workflow the
// agent went on from, or the agent with none) and the workflow revision that ran it; and what the series shows (the
// takeover, the mean before it with learning left out, the mean of the runs it served after it with learning kept in, and "times cheaper" only
// once 20 runs follow the takeover). The same runs as CSV for the CLI.
import assert from "node:assert/strict";
import { promoteChecked } from "./learned-workflow-seed-support.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { CHEAPER_AFTER_RUNS, costCsv, costSummary, runCostOf } from "../dist/learning-cost.js";
import { runPathOf } from "../dist/runner/learning-end.js";
import { costRunOf, servingReplayOf } from "../dist/store-reads/learning.js";
import { git, resnap, savedOf } from "./learn-support.mjs";
import { agent, answerFlow, follow, serve, storeRun } from "./support.mjs";

const row = (kind, extra = {}) => ({ id: `${kind}-${Math.random()}`, kind, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, ...extra });
const call = (name, id, status = "success", extra = {}) => [row("tool_use", { tool_name: name, tool_use_id: id, ...extra }), row("tool_result", { tool_name: name, tool_use_id: id, tool_status: status, ...extra })];

test("a run's path: a learned workflow alone, one the agent went on from (failed, or more work after it, or a follow-up), or the agent with none; the end-of-run turn's rows are the learning's", () => {
  const asked = row("user_message");
  const answer = row("final_answer");
  assert.equal(runPathOf([asked, answer]), "agent", "no call");
  assert.equal(runPathOf([asked, ...call("read", "r1"), answer]), "agent", "another tool");
  assert.equal(runPathOf([asked, ...call("learned_workflow", "c1"), answer]), "workflow");
  assert.equal(runPathOf([asked, ...call("mcp__hands__learned_workflow", "c1"), answer]), "workflow", "claude-agent's alias");
  assert.equal(runPathOf([asked, ...call("learned_workflow", "c1", "failed"), ...call("read", "r1"), answer]), "handed_back", "it failed and the agent went on");
  assert.equal(runPathOf([asked, ...call("learned_workflow", "c1"), ...call("bash", "b1"), answer]), "handed_back", "the agent worked on after it");
  assert.equal(runPathOf([asked, ...call("learned_workflow", "c1"), answer, row("user_message"), answer]), "handed_back", "a follow-up");
  assert.equal(runPathOf([asked, answer, row("user_message", { agent_label: "learning" }), ...call("learned_workflow", "x", "success", { agent_label: "learning" })]), "agent", "the end-of-run turn's call is the learning's");
  // A call a script or tools_call made for the model names that call as its parent, and is still the model's own.
  for (const meta of ["codemode", "tools_call"]) {
    assert.equal(runPathOf([asked, ...call(meta, "m1"), ...call("learned_workflow", "m1/s1", "success", { parent_tool_use_id: "m1" }), answer]), "handed_back", `${meta}: a learned workflow its call made`);
  }
  assert.equal(runPathOf([asked, ...call("task", "t1"), ...call("learned_workflow", "sub-1", "success", { parent_tool_use_id: "t1" }), answer]), "agent", "a subagent's call is the subagent's");
});

test("a run's cost: its job's own, what learning added (its compile turn), and all-in; unknown stays unknown", () => {
  const at = "2026-11-12T00:00:00Z";
  assert.deepEqual(runCostOf(0.5, null), { cost_usd: 0.5, learning_usd: 0, total_usd: 0.5 }, "a run that does not learn");
  assert.deepEqual(runCostOf(0.5, { answered_at: at, job_cost_usd: 0.4, look_back_usd: 0.1 }), { cost_usd: 0.4, learning_usd: 0.1, total_usd: 0.5 }, "it compiled and kept nothing");
  assert.deepEqual(runCostOf(null, null), { cost_usd: null, learning_usd: 0, total_usd: null });
  assert.deepEqual(runCostOf(0.2, { answered_at: at, job_cost_usd: 0.2, look_back_usd: 0 }), { cost_usd: 0.2, learning_usd: 0, total_usd: 0.2 }, "a run that asked no compile turn");
  // A person's follow-up after the answer: the row's cost grows past the job and its compile turn, and that spend is the job's.
  assert.deepEqual(runCostOf(0.8, { answered_at: at, job_cost_usd: 0.4, look_back_usd: 0.1 }), { cost_usd: 0.7, learning_usd: 0.1, total_usd: 0.8 }, "a follow-up's spend is counted");
  assert.deepEqual(runCostOf(null, { answered_at: at, job_cost_usd: 0.4, look_back_usd: 0.1 }), { cost_usd: null, learning_usd: 0.1, total_usd: null }, "a follow-up whose cost is unknown leaves the job's unknown");
  assert.deepEqual(runCostOf(null, { answered_at: at, job_cost_usd: 0.4, look_back_usd: null }), { cost_usd: 0.4, learning_usd: null, total_usd: null }, "a compile turn of unknown cost leaves the job's as it answered");
});

/** `paths` as a series, each run's job $ and learning $ given, and whether its cost is known only as at most (`bound`):
 *  numbered as the server numbers it, the runs that do a job in order and a replay none. */
const series = (runs) => {
  let jobs = 0;
  return runs.map(([path, cost, learning = 0, bound = false], i) => ({ n: path === "replay" ? null : (jobs += 1), run_id: `r${i + 1}`, started_at: new Date(Date.UTC(2026, 10, 12, 0, i)).toISOString(), path, workflow: path === "agent" ? null : "classify", digest: path === "agent" ? null : "d".repeat(16), audited: false, cost_usd: bound ? null : cost, cost_upper_bound: bound, learning_usd: learning, total_usd: bound || cost === null || learning === null ? null : cost + learning }));
};
const EMPTY = { takeover: null, before: null, after: null, after_state: "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null };
const PRICED = { after_state: "priced" };

test("what the series shows: the takeover, the mean before it (agent runs, learning left out), the mean after it (the runs it served, learning kept in), and times cheaper only once 20 runs follow the takeover", () => {
  assert.deepEqual(costSummary([]), EMPTY);
  const learning = series([["agent", 0.9, 0.2], ["agent", 0.8, 0.3], ["handed_back", 0.5, 0.1], ["agent", null], ["workflow", 0.1], ["handed_back", 0.6, 0.1]]);
  assert.deepEqual(costSummary(learning), { ...EMPTY, ...PRICED, takeover: { n: 3, run_id: "r3" }, before: { runs: 2, mean_usd: 0.85 }, after: { runs: 3, mean_usd: 0.466667 }, hand_backs: { ran: 3, back: 2 } }, "the first run a learned workflow served, handed back or alone, is the takeover (the bill's promoted); a run by hand after it is on neither side");
  const unknownBefore = series([["agent", 0.9], ["agent", null], ["workflow", 0.1]]);
  assert.deepEqual(costSummary(unknownBefore).withheld, { unknown: 1, at_most: 0 }, "an unknown cost before it is named, never read");
  assert.deepEqual(costSummary(series([["agent", 1], ["agent", 0.5]])), { ...EMPTY, before: { runs: 2, mean_usd: 0.75 } }, "no takeover yet: every agent run is before");
  const held = series([["agent", 0.9], ["agent", 0.9], ...Array.from({ length: CHEAPER_AFTER_RUNS - 1 }, () => ["workflow", 0.1, 0.05])]);
  assert.equal(costSummary(held).times_cheaper, null, "19 runs after say too little");
  const enough = series([["agent", 0.9], ["agent", 0.9], ...Array.from({ length: CHEAPER_AFTER_RUNS }, () => ["workflow", 0.1, 0.05])]);
  assert.deepEqual(costSummary(enough), { ...EMPTY, ...PRICED, takeover: { n: 3, run_id: "r3" }, before: { runs: 2, mean_usd: 0.9 }, after: { runs: 20, mean_usd: 0.15 }, times_cheaper: 6, hand_backs: { ran: 20, back: 0 } });
});

test("times cheaper is withheld when a run it reads has an unknown cost or one known only as at most, and the summary names how many", () => {
  const after = (extra = []) => [...Array.from({ length: CHEAPER_AFTER_RUNS }, () => ["workflow", 0.1, 0.05]), ...extra];
  const read = (runs) => { const s = costSummary(series(runs)); return [s.times_cheaper, s.withheld]; };
  assert.deepEqual(read([["agent", 0.9], ["agent", null], ["agent", 0.9], ...after()]), [null, { unknown: 1, at_most: 0 }], "an agent run before the takeover whose cost is unknown");
  assert.deepEqual(read([["agent", 0.9], ["agent", 0.9], ...after([["workflow", 0.1, 0, true]])]), [null, { unknown: 0, at_most: 1 }], "a run after it counted a request cut at its cap hold: at most, never a number");
  assert.deepEqual(read([["agent", 0.9], ["agent", 0.5, 0, true], ...after([["workflow", 0.1, null]])]), [null, { unknown: 1, at_most: 1 }], "a bound before, a compile turn of unknown cost after");
  assert.deepEqual(read([["agent", 0.9], ["agent", null], ["agent", null, 0, true], ...after([["handed_back", null], ["workflow", 0.1, 0, true]])]), [null, { unknown: 2, at_most: 2 }], "a bound is at most whatever its value (the row stores it null); unknown is a null cost with no bound");
  assert.deepEqual(read([["agent", 0.9], ["agent", 0.9], ...after([["agent", null]])]), [6, null], "a run on neither side (by hand after the takeover) withholds nothing");
  assert.deepEqual(read([["agent", 0.9], ["agent", null]]), [null, null], "no takeover: no figure to withhold");
  const bounded = costSummary(series([["agent", 0.9], ["agent", 0.3, 0, true], ...after()]));
  assert.deepEqual(bounded.before, { runs: 1, mean_usd: 0.9 }, "a bound is never read into a mean");
});

test("the after side is the runs a learned workflow served (answered alone or handed back): replays, cheaper checks of a new revision, and runs by hand after the takeover are never in it", () => {
  // 8 runs by hand at $1, the takeover, 20 served runs (5 handed back at $1.20, 15 alone at $0.90), then 300 replays at
  // $0.30 and one run by hand at $2: served alone, $20.40 over 21 runs.
  const runs = series([...Array.from({ length: 8 }, () => ["agent", 1]), ["workflow", 0.9], ...Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? ["handed_back", 1.2] : ["workflow", 0.9])), ...Array.from({ length: 300 }, () => ["replay", 0.3]), ["agent", 2]]);
  const s = costSummary(runs);
  assert.deepEqual([s.before, s.after, s.after_state], [{ runs: 8, mean_usd: 1 }, { runs: 21, mean_usd: 0.971429 }, "priced"], "the 300 cheaper replays never pull the after side down");
  assert.equal(s.times_cheaper, 1, "about as cheap as by hand, not 2.9x");
  assert.deepEqual(s.hand_backs, { ran: 21, back: 5 });
  // A replay or a run by hand after the takeover whose cost is unknown withholds nothing: neither side reads it.
  const unread = costSummary(series([...Array.from({ length: 2 }, () => ["agent", 1]), ...Array.from({ length: 20 }, () => ["workflow", 0.5]), ["replay", null], ["agent", null, 0, true]]));
  assert.deepEqual([unread.withheld, unread.times_cheaper], [null, 2]);
});

test("with no run a learned workflow served the after side says so, never a figure: replays alone are no takeover; served runs of unknown cost are said too", () => {
  const replaysOnly = costSummary(series([["agent", 1], ["agent", 1], ...Array.from({ length: 30 }, () => ["replay", 0.3])]));
  assert.deepEqual([replaysOnly.takeover, replaysOnly.after, replaysOnly.after_state, replaysOnly.times_cheaper], [null, null, "no_served_runs", null]);
  assert.equal(costSummary([]).after_state, "no_served_runs");
  const unpriced = costSummary(series([["agent", 1], ["workflow", null], ["handed_back", null, 0, true], ["replay", 0.3]]));
  assert.deepEqual([unpriced.takeover, unpriced.after, unpriced.after_state, unpriced.withheld], [{ n: 2, run_id: "r2" }, null, "cost_unknown", { unknown: 1, at_most: 1 }]);
});

test("a run row whose stored cost is a bound reads as a bound: its cost_upper_bound is true, and the summary withholds the ratio with at_most 1", async () => {
  // A store with no launch, no learning rounds and no audit shadow run: only the run row's cost fields are read.
  const store = { runs: { launch: async () => undefined, get: async () => undefined }, learning: { proposal: async () => undefined } };
  // The store's row for a bounded run: costUsd null, costAtMostUsd the bound (RunRow).
  const row = (id, extra = {}) => ({ id, startedAt: Date.UTC(2026, 10, 12), metrics: { path: "workflow", workflow: "classify" }, costUsd: 0.1, costAtMostUsd: null, ...extra });
  const placed = { path: "workflow", workflow: "classify" };
  const exact = await costRunOf(store, row("r1"), 1, placed);
  const bound = await costRunOf(store, row("r2", { costUsd: null, costAtMostUsd: 0.5 }), 2, placed);
  assert.deepEqual([exact.cost_upper_bound, bound.cost_upper_bound, bound.cost_usd], [false, true, null], "the stored bound is read, and never shown as a cost");
  const after = Array.from({ length: CHEAPER_AFTER_RUNS }, (_, i) => i === 0 ? { ...bound, n: 3, run_id: "r3" } : { ...exact, n: i + 3, run_id: `r${i + 3}` });
  const head = series([["agent", 0.9], ["agent", 0.9]]);
  const withheld = costSummary([...head, ...after]).withheld;
  assert.deepEqual(withheld, { unknown: 0, at_most: 1 }, "a row with costUsd null and costAtMostUsd 0.5 withholds the ratio as at most, not unknown");
  assert.deepEqual(costSummary([...head, ...after.map((run, i) => ({ ...exact, n: i + 3, run_id: `r${i + 3}` }))]).withheld, null, "no bound, nothing withheld");
});

test("the summary carries the serving promotion's replay as it is given", () => {
  const replay = { n: 40, workflow_pct: 86, agent_pct: 100, cleared: true, agreed: 33, alone: 38, agree_min: 0.8 };
  const runs = series([["agent", 0.9], ["workflow", 0.1]]);
  assert.deepEqual(costSummary(runs, replay).replay, replay);
  assert.equal(costSummary(runs).replay, null);
});

test("the serving promotion's check: the champion of the workflow the newest served run ran, the share of its inputs that said what the agent said, against the agent's own 100%", () => {
  const check = (alone, agreed, n = 40) => ({ compile_after: 20, agree_min: 0.8, alone_min: 0.5, attempt: 1, n, agreed, alone, of: [] });
  const rec = (digest, decided, extra = {}) => ({ workflow: "classify", digest, at: "2026-11-12T00:00:00Z", decided, reason: "r", ...extra });
  const runs = series([["agent", 0.9], ["workflow", 0.1], ["handed_back", 0.5]]);
  assert.deepEqual(servingReplayOf([rec("d1", "promote", { check: check(38, 33) })], runs), { n: 40, workflow_pct: 86.8, agent_pct: 100, cleared: true, agreed: 33, alone: 38, agree_min: 0.8 });
  assert.equal(servingReplayOf([rec("d1", "promote", { check: check(0, 0, 0) })], runs), null, "promoted on a dry run: no inputs checked");
  assert.equal(servingReplayOf([rec("d1", "promote")], runs), null, "no check kept");
  assert.equal(servingReplayOf([rec("d1", "promote", { check: check(38, 33) }), rec("d1", "hold", { check: check(10, 2) })], runs), null, "held: nothing serves");
  assert.equal(servingReplayOf([rec("d1", "promote", { check: check(38, 33) })], series([["agent", 0.9]])), null, "no run a learned workflow served");
  assert.equal(servingReplayOf([{ ...rec("d1", "promote", { check: check(38, 33) }), workflow: "other" }], runs), null, "another workflow's champion");
});

test("the summary's hand-backs are over every run since the takeover, never only the latest a read lists", () => {
  // The takeover, 30 hand-backs, then 1,000 runs it answered alone: a read of the latest 1,000 sees none handed back.
  const runs = series([["agent", 0.9], ["workflow", 0.1], ...Array.from({ length: 30 }, () => ["handed_back", 0.5]), ...Array.from({ length: 1000 }, () => ["workflow", 0.1])]);
  assert.deepEqual(costSummary(runs).hand_backs, { ran: 1031, back: 30 });
});

test("the series as CSV: a header line, one row a run, an unknown figure empty, a field with a comma quoted", () => {
  const runs = series([["agent", 0.9, null], ["workflow", 0.1]]);
  runs[1].workflow = "sort, then file";
  assert.equal(costCsv(runs), [
    "n,run_id,started_at,path,workflow,digest,audited,cost_usd,cost_upper_bound,learning_usd,total_usd",
    "1,r1,2026-11-12T00:00:00.000Z,agent,,,false,0.9,false,,",
    '2,r2,2026-11-12T00:01:00.000Z,workflow,"sort, then file",dddddddddddddddd,false,0.1,false,0,0.1',
    "",
  ].join("\r\n"));
});

test("the series as CSV: a text cell a spreadsheet would run as a formula opens as its text", () => {
  const runs = series([["workflow", 0.1], ["workflow", 0.1], ["workflow", 0.1], ["workflow", 0.1]]);
  ["=1+1", "+cmd", "-2", "@SUM(A1)"].forEach((name, i) => { runs[i].workflow = name; });
  const cells = costCsv(runs).split("\r\n").slice(1, 5).map((line) => line.split(",")[4]);
  assert.deepEqual(cells, ["'=1+1", "'+cmd", "'-2", "'@SUM(A1)"]);
});

const DESCRIPTION = "Answers a question as a number; use when the person asks for the answer";
/** Agent `id`'s learning folder made as a first run makes it, then learned workflow `name` committed on main. */
async function landFlow(data, id, name) {
  await seedOf(data, id);
  const repo = join(agentFolderOf(data, id), "learning");
  const files = { [`workflows/${name}/workflow.json`]: JSON.stringify(answerFlow()), [`workflows/${name}/README.md`]: `---\nname: ${name}\ndescription: ${DESCRIPTION}\n---\n` };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, id);
  return git(repo, ["rev-parse", "main"]).trim();
}

test("GET /agents/{id}/learning/cost: the agent's runs in order, by hand until a learned workflow takes over, each path read from its run's records, the workflow revision that ran it and its costs; the same as CSV; limit keeps each run's number", { timeout: 240_000 }, async (t) => {
  const { api, data, store } = await serve(t, { learning: "on" });
  const id = "invoice-sorter";
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness: "pi", instructions: "Answer the question." }))).status, 201);
  const runOf = async (content) => {
    const startedRun = await api("POST", `/agents/${id}/runs`, { input: { content } });
    assert.equal(startedRun.status, 202, JSON.stringify(startedRun.body));
    await follow(api, startedRun.body.run_id, ["completed", "failed"]);
    await savedOf(data, startedRun.body.run_id);
    return startedRun.body.run_id;
  };
  const cost = async (query = "") => (await api("GET", `/agents/${id}/learning/cost${query}`)).body;
  const bill = { learning_usd: 0, points: [], break_even: null, gap_usd: null, withheld: 0, booked_usd: 0, revisions: [], unattributed_usd: 0, holds: [] };
  assert.deepEqual(await cost(), { agent: id, runs: [], total_runs: 0, unknown_cost_runs: 0, unknown_path_runs: 0, summary: EMPTY, workflows: [], bill });

  const byHand = [await runOf("What is six times seven."), await runOf("What is two times three.")];
  await landFlow(data, id, "answer");
  assert.equal((await cost()).summary.replay, null, "landing a draft provides no check evidence");
  // This series begins serving only after the learned revision has passed its check.
  await promoteChecked(store.settings, id, [{ name: "answer", workflow: answerFlow() }]);
  const alone = await runOf("Use the learned workflow answer on What is six times seven.");
  const back = await runOf("Use the learned workflow absent on What is two.");
  const body = await cost();
  // Each run's path is what its own records say (runPathOf over its settled timeline), never its place in the series nor
  // what a quiet machine's run would hold: on a loaded one the workflow run's records once held more than its call and
  // its answer, the read said "handed_back", and this test, which assumed "workflow", went red once.
  const recordsOf = async (runId) => (await follow(api, runId, ["completed", "failed"])).rows;
  const said = await Promise.all(body.runs.map(async (run) => runPathOf(await recordsOf(run.run_id))));
  assert.deepEqual(body.runs.map((run) => run.path), said, "each run's path is its own records'");
  assert.deepEqual(body.runs.map((run) => [run.n, run.run_id, run.workflow]), [[1, byHand[0], null], [2, byHand[1], null], [3, alone, "answer"], [4, back, null]], "in the order they started; a name the launch never offered (the model's own text) is never shown");
  assert.deepEqual([body.runs[0].path, body.runs[1].path, body.runs[3].path], ["agent", "agent", "handed_back"], "by hand; a workflow it was not offered");
  // The run told to use the workflow called it: "workflow" when its records hold only that call and the answer (the
  // first unit test above pins which records say which), "handed_back" when a loaded machine left more in them.
  assert.ok(["workflow", "handed_back"].includes(body.runs[2].path), `the run told to use the workflow: ${body.runs[2].path}`);
  assert.deepEqual(body.runs.map((run) => [run.digest, run.audited]), [[null, false], [null, false], [null, false], [null, false]], "the agent called the workflow itself: no revision ran first, so none is named (never the learning folder's commit); no audit ran");
  // One classifier: the agent called the tool itself (no workflow-first step), and its run record's metrics.path, written
  // at its end, is the path the cost per run shows.
  const metricsOf = (runId) => {
    const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
    try {
      return JSON.parse(db.prepare("SELECT metrics FROM runs WHERE id = ?").get(runId)?.metrics ?? "null");
    } finally {
      db.close();
    }
  };
  assert.deepEqual(body.runs.map((run) => [metricsOf(run.run_id)?.path, metricsOf(run.run_id)?.workflow ?? null]), [["agent", null], ["agent", null], ["workflow", "answer"], ["handed_back", null]], "the record's path and workflow are the chart's");
  for (const run of body.runs) {
    const { learning } = await savedOf(data, run.run_id);
    const rowUsd = storeRun(data, run.run_id).costUsd;
    assert.equal(typeof rowUsd, "number", "the run's cost is known (the faux model's is $0)");
    const job = learning.answered_at ? learning.job_cost_usd : rowUsd;
    const spent = learning.answered_at ? learning.look_back_usd : 0;
    assert.deepEqual([run.cost_usd, run.learning_usd, run.total_usd], [job, spent, Math.round((job + spent) * 1e6) / 1e6].map((usd) => Math.round(usd * 1e6) / 1e6), `${run.n}: ${JSON.stringify(learning)}`);
  }
  assert.equal(body.runs[2].learning_usd, 0, "a run a learned workflow finished alone is asked no compile turn");
  const before = Math.round(((body.runs[0].cost_usd + body.runs[1].cost_usd) / 2) * 1e6) / 1e6;
  const after = Math.round(((body.runs[2].total_usd + body.runs[3].total_usd) / 2) * 1e6) / 1e6;
  // promoteChecked's specified prior check compared one input, answered it alone and agreed: the summary must show
  // that evidence once the checked revision serves, without changing which runs make up the cost series.
  const replay = { n: 1, workflow_pct: 100, agent_pct: 100, cleared: true, agreed: 1, alone: 1, agree_min: 0.8 };
  assert.deepEqual(body.summary, { ...EMPTY, ...PRICED, takeover: { n: 3, run_id: alone }, before: { runs: 2, mean_usd: before }, after: { runs: 2, mean_usd: after }, hand_backs: { ran: 2, back: 1 }, replay });
  assert.ok(body.runs.every((run) => run.cost_upper_bound === false), "no run's stored cost is a bound");
  assert.deepEqual([body.total_runs, body.unknown_cost_runs, body.unknown_path_runs], [4, 0, 0], "every run that learns ended with its path");
  assert.deepEqual(body.workflows, [], "the money rule holds a workflow that ran first; the agent calling one is the agent's own run");

  const last = await cost("?limit=2");
  assert.deepEqual(last.runs.map((run) => run.n), [3, 4], "the latest runs, each keeping its number");
  assert.deepEqual([last.total_runs, last.summary], [4, body.summary], "the summary is over every run");

  const csv = await api("GET", `/agents/${id}/learning/cost?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /^text\/csv/);
  const lines = String(csv.body).trimEnd().split("\r\n");
  assert.equal(lines[0], "n,run_id,started_at,path,workflow,digest,audited,cost_usd,cost_upper_bound,learning_usd,total_usd");
  assert.equal(lines.length, 5);
  assert.ok(lines[3].startsWith(`3,${alone},`) && lines[3].includes(`,workflow,answer,,false,`), lines[3]);

  for (const query of ["?limit=0", "?limit=10001", "?limit=two", "?format=xml"]) assert.equal((await api("GET", `/agents/${id}/learning/cost${query}`)).status, 400, query);
  assert.equal((await api("GET", "/agents/nobody/learning/cost")).status, 404);
});
