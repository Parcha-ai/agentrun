// An agent's cost per run, run after run (GET /v2/agents/{id}/learning/cost): each ended run in order, its own cost, what
// learning added for it (its look-back and its grade), the path it took (a learned workflow alone, a learned workflow the
// agent went on from, or the agent with none) and the learned revision that served it; and what the series shows (the
// takeover, the mean before it with learning left out, the mean after it with learning kept in, and "times cheaper" only
// once 20 runs follow the takeover). The same runs as CSV for the CLI.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { CHEAPER_AFTER_RUNS, costCsv, costSummary, runCostOf } from "../dist/learning-cost.js";
import { runPathOf } from "../dist/runner/learning-end.js";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, LEARN, learner, made, resnap, savedOf, started } from "./learn-support.mjs";
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
});

test("a run's cost: its job's own, what learning added (its look-back and its grade), and all-in; unknown stays unknown", () => {
  assert.deepEqual(runCostOf(0.5, null), { cost_usd: 0.5, learning_usd: 0, total_usd: 0.5 }, "a run that does not learn");
  assert.deepEqual(runCostOf(0.5, { state: "dropped", answered_at: "2026-11-12T00:00:00Z", job_cost_usd: 0.4, look_back_usd: 0.1 }), { cost_usd: 0.4, learning_usd: 0.1, total_usd: 0.5 }, "it looked back and kept nothing");
  assert.deepEqual(runCostOf(0.5, { state: "merged", answered_at: "2026-11-12T00:00:00Z", job_cost_usd: 0.4, look_back_usd: 0.1, cost_usd: { grade: 0.03 } }), { cost_usd: 0.4, learning_usd: 0.13, total_usd: 0.53 }, "its grade is its learning too");
  assert.deepEqual(runCostOf(0.5, { state: "proposed", answered_at: "2026-11-12T00:00:00Z", job_cost_usd: 0.4, look_back_usd: 0.1 }), { cost_usd: 0.4, learning_usd: 0.1, total_usd: 0.5 }, "a grade still running adds nothing yet");
  assert.deepEqual(runCostOf(0.5, { state: "dropped", answered_at: "2026-11-12T00:00:00Z", job_cost_usd: 0.4, look_back_usd: 0.1, cost_usd: { grade: null } }), { cost_usd: 0.4, learning_usd: null, total_usd: null }, "a grade that failed spent what no one knows");
  assert.deepEqual(runCostOf(null, null), { cost_usd: null, learning_usd: 0, total_usd: null });
  assert.deepEqual(runCostOf(0.2, { state: "dropped", answered_at: "2026-11-12T00:00:00Z", job_cost_usd: 0.2, look_back_usd: 0 }), { cost_usd: 0.2, learning_usd: 0, total_usd: 0.2 }, "a workflow run, not asked to look back");
});

/** `paths` as a series, each run's job $ and learning $ given. */
const series = (runs) => runs.map(([path, cost, learning = 0], i) => ({ n: i + 1, run_id: `r${i + 1}`, started_at: new Date(Date.UTC(2026, 10, 12, 0, i)).toISOString(), path, workflow: path === "agent" ? null : "classify", learned_revision: null, cost_usd: cost, learning_usd: learning, total_usd: cost === null || learning === null ? null : cost + learning }));

test("what the series shows: the takeover, the mean before it (agent runs, learning left out), the mean after it (every run, learning kept in), and times cheaper only once 20 runs follow the takeover", () => {
  assert.deepEqual(costSummary([]), { takeover: null, before: null, after: null, times_cheaper: null });
  const learning = series([["agent", 0.9, 0.2], ["agent", 0.8, 0.3], ["handed_back", 0.5, 0.1], ["agent", null], ["workflow", 0.1], ["handed_back", 0.6, 0.1]]);
  assert.deepEqual(costSummary(learning), { takeover: { n: 5, run_id: "r5" }, before: { runs: 2, mean_usd: 0.85 }, after: { runs: 2, mean_usd: 0.4 }, times_cheaper: null }, "a handed-back run before the takeover is on neither side; an unknown cost is left out");
  assert.deepEqual(costSummary(series([["agent", 1], ["agent", 0.5]])), { takeover: null, before: { runs: 2, mean_usd: 0.75 }, after: null, times_cheaper: null }, "no takeover yet: every agent run is before");
  const held = series([["agent", 0.9], ["agent", 0.9], ...Array.from({ length: CHEAPER_AFTER_RUNS - 1 }, () => ["workflow", 0.1, 0.05])]);
  assert.equal(costSummary(held).times_cheaper, null, "19 runs after say too little");
  const enough = series([["agent", 0.9], ["agent", 0.9], ...Array.from({ length: CHEAPER_AFTER_RUNS }, () => ["workflow", 0.1, 0.05])]);
  assert.deepEqual(costSummary(enough), { takeover: { n: 3, run_id: "r3" }, before: { runs: 2, mean_usd: 0.9 }, after: { runs: 20, mean_usd: 0.15 }, times_cheaper: 6 });
});

test("the series as CSV: a header line, one row a run, an unknown figure empty, a field with a comma quoted", () => {
  const runs = series([["agent", 0.9, null], ["workflow", 0.1]]);
  runs[1].workflow = "sort, then file";
  assert.equal(costCsv(runs), [
    "n,run_id,started_at,path,workflow,learned_revision,cost_usd,learning_usd,total_usd",
    "1,r1,2026-11-12T00:00:00.000Z,agent,,,0.9,,",
    '2,r2,2026-11-12T00:01:00.000Z,workflow,"sort, then file",,0.1,0,0.1',
    "",
  ].join("\r\n"));
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

test("GET /agents/{id}/learning/cost: the agent's runs in order, by hand until a learned workflow takes over, each path read from its run's records, its learned revision and its costs; the same as CSV; limit keeps each run's number", { timeout: 240_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
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
  assert.deepEqual(await cost(), { agent: id, runs: [], total_runs: 0, unknown_cost_runs: 0, summary: { takeover: null, before: null, after: null, times_cheaper: null } });

  const byHand = [await runOf("What is six times seven."), await runOf("What is two times three.")];
  const sha = await landFlow(data, id, "answer");
  const alone = await runOf("Use the learned workflow answer on What is six times seven.");
  const back = await runOf("Use the learned workflow absent on What is two.");
  const body = await cost();
  assert.deepEqual(body.runs.map((run) => [run.n, run.run_id, run.path, run.workflow]), [[1, byHand[0], "agent", null], [2, byHand[1], "agent", null], [3, alone, "workflow", "answer"], [4, back, "handed_back", "absent"]]);
  assert.deepEqual([body.runs[2].learned_revision, body.runs[3].learned_revision], [sha, sha], "the commit its learning started from");
  for (const run of body.runs) {
    const { learning } = await savedOf(data, run.run_id);
    const rowUsd = storeRun(data, run.run_id).costUsd;
    assert.ok(rowUsd > 0, `the faux run has a cost: ${rowUsd}`);
    const job = learning.answered_at ? learning.job_cost_usd : rowUsd;
    const spent = (learning.answered_at ? learning.look_back_usd : 0) + (learning.cost_usd?.grade ?? 0);
    assert.deepEqual([run.cost_usd, run.learning_usd, run.total_usd], [job, spent, Math.round((job + spent) * 1e6) / 1e6].map((usd) => Math.round(usd * 1e6) / 1e6), `${run.n}: ${JSON.stringify(learning)}`);
  }
  assert.equal(body.runs[2].learning_usd, 0, "a run a learned workflow finished alone is not asked to look back");
  const before = Math.round(((body.runs[0].cost_usd + body.runs[1].cost_usd) / 2) * 1e6) / 1e6;
  const after = Math.round(((body.runs[2].total_usd + body.runs[3].total_usd) / 2) * 1e6) / 1e6;
  assert.deepEqual(body.summary, { takeover: { n: 3, run_id: alone }, before: { runs: 2, mean_usd: before }, after: { runs: 2, mean_usd: after }, times_cheaper: null });
  assert.deepEqual([body.total_runs, body.unknown_cost_runs], [4, 0]);

  const last = await cost("?limit=2");
  assert.deepEqual(last.runs.map((run) => run.n), [3, 4], "the latest runs, each keeping its number");
  assert.deepEqual([last.total_runs, last.summary], [4, body.summary], "the summary is over every run");

  const csv = await api("GET", `/agents/${id}/learning/cost?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /^text\/csv/);
  const lines = String(csv.body).trimEnd().split("\r\n");
  assert.equal(lines[0], "n,run_id,started_at,path,workflow,learned_revision,cost_usd,learning_usd,total_usd");
  assert.equal(lines.length, 5);
  assert.ok(lines[3].startsWith(`3,${alone},`) && lines[3].includes(`,workflow,answer,${sha},`), lines[3]);

  for (const query of ["?limit=0", "?limit=10001", "?limit=two", "?format=xml"]) assert.equal((await api("GET", `/agents/${id}/learning/cost${query}`)).status, 400, query);
  assert.equal((await api("GET", "/agents/nobody/learning/cost")).status, 404);
});

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts in one answer came in cents and in dollars.\n");

test("GET /agents/{id}/learning/cost books a run's grade to it: a run whose note merged costs its look-back and its grade beside its job, outside the run's own cost", { timeout: 240_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  const id = "grade-booked";
  await made(api, learner(id, { plan: [["check-units.md", UNITS]], once: true }));
  const merged = (await ended(api, await started(api, id))).view;
  assert.equal(merged.learning.state, "merged");
  const { learning } = await savedOf(data, merged.run_id);
  assert.ok(learning.cost_usd.grade > 0 && learning.look_back_usd > 0, JSON.stringify(learning));
  const [run] = (await api("GET", `/agents/${id}/learning/cost`)).body.runs;
  const usd = (value) => Math.round(value * 1e6) / 1e6;
  assert.deepEqual([run.path, run.cost_usd, run.learning_usd, run.total_usd], ["agent", usd(learning.job_cost_usd), usd(learning.look_back_usd + learning.cost_usd.grade), usd(learning.job_cost_usd + learning.look_back_usd + learning.cost_usd.grade)]);
  assert.ok(run.total_usd > storeRun(data, merged.run_id).costUsd, "the grade is outside the run's own cost");
});
