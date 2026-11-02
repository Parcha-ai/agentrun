// AgentStoreReader.analytics: the runs' metrics summed with their counts and cost, from store.sqlite alone. Coverage is
// counted (a run with no metrics is a run, never 0 tokens), a running run's metrics are its last end's and not counted,
// what is archived is left out, and a store written before the metrics tables answers with none.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, openStore, openStoreReader } from "../dist/index.js";
import { scratch } from "./support.mjs";
import { TOOLS, workflowDoc } from "./workflow-support.mjs";

const A = { kind: "agentic", instructions: "Answer." };
const metrics = (input, cacheRead, cacheWrite, output, requests, unmetered, tools, extra = {}) => ({ input, cacheRead, cacheWrite, output, requests, unmetered, models: { "anthropic/claude-opus-5-5": requests }, tools, ...extra });
const usd = (value) => (value === null ? null : Math.round(value * 1e6) / 1e6);
const rounded = (groups) => groups.map((g) => ({ ...g, costUsd: usd(g.costUsd) }));
const group = (runs, completed, failed, runsWithMetrics, tokens, costUsd, unknownCostRuns) => ({ runs, completed, failed, runsWithMetrics, tokens, costUsd, unknownCostRuns });
const NONE = { totals: { ...group(0, 0, 0, 0, 0, null, 0), input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, unmetered: 0 }, time: { endedRuns: 0, wallMs: 0, activeRuns: 0, activeMs: 0 }, byHarnessEffort: [], byDay: [], bySource: [], tools: [] };

/** A store with three agents (chat on pi by default, coder on codex, flow a workflow) and runs of each, at fixed times:
 *  ended with and without metrics, running, opened again, imported, and archived. */
async function seeded() {
  const dir = await scratch();
  const store = openStore(dir);
  for (const [id, revision] of [["chat", A], ["coder", { ...A, harness: "codex" }], ["flow", { kind: "workflow", workflow: workflowDoc(), tools: [...TOOLS] }], ["old", A]]) {
    store.createAgent({ name: id, id });
    await store.commitRevision(id, revision, { setCurrent: true });
  }
  const run = async (agent, end) => {
    const { runId } = await store.startRun({ agent });
    if (end) store.carryBack(runId, end);
    return runId;
  };
  const ids = {
    a: await run("chat", { state: "completed", costUsd: 0.25, metrics: metrics(100, 1000, 50, 20, 2, 0, { read: { calls: 3, errors: 1 } }, { activeMs: 4000, effort: "high" }) }),
    b: await run("chat", { state: "failed" }),
    c: await run("coder", { state: "completed", costUsd: 0.5, metrics: metrics(200, 0, 0, 40, 3, 1, { read: { calls: 2, errors: 0 }, shell: { calls: 5, errors: 2 } }, { effort: "medium" }) }),
    d: await run("coder", { state: "escalated", metrics: metrics(10, 0, 0, 5, 1, 0, {}, { effort: "medium", activeMs: 1000 }) }),
    e: await run("coder"),
    // Ended with metrics, then opened again: running, its row keeps its last end's cost and metrics.
    f: await run("chat", { state: "completed", costUsd: 0.1, metrics: metrics(9000, 0, 0, 900, 9, 0, { read: { calls: 100, errors: 0 } }, { effort: "high", activeMs: 99000 }) }),
    g: await run("flow", { state: "completed", costUsd: 0.05, metrics: metrics(7, 0, 0, 3, 1, 0, { fetch: { calls: 1, errors: 0 } }) }),
    archived: await run("chat", { state: "completed", costUsd: 7, metrics: metrics(5000, 0, 0, 500, 5, 0, { read: { calls: 50, errors: 0 } }) }),
    ofArchived: await run("old", { state: "completed", costUsd: 3, metrics: metrics(4000, 0, 0, 400, 4, 0, { write: { calls: 40, errors: 0 } }) }),
  };
  store.reopenRun(ids.f);
  ids.imported = store.importRun({
    agent: "chat", revision: store.listRevisions("chat")[0].id, state: "completed", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:05:00.000Z",
    costUsd: 0.02, source: "codex", session: "019a-session", metrics: metrics(1, 2, 3, 4, 1, 0, { read: { calls: 1, errors: 0 } }),
  }).runId;
  store.setArchived("run", ids.archived, true);
  store.setArchived("agent", "old", true);
  store.close();
  // The live runs at fixed times: one a millisecond before a UTC midnight, the next at it.
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  const times = { a: ["2026-10-02T09:00:00.000Z", "2026-10-02T09:00:10.000Z"], b: ["2026-10-02T23:59:59.999Z", "2026-10-03T00:00:00.999Z"], c: ["2026-10-03T00:00:00.000Z", "2026-10-03T00:00:02.000Z"], d: ["2026-10-03T01:00:00.000Z", "2026-10-03T01:00:00.500Z"], e: ["2026-10-03T02:00:00.000Z", null], f: ["2026-10-03T03:00:00.000Z", null], g: ["2026-10-04T00:00:00.000Z", "2026-10-04T00:00:03.000Z"], archived: ["2026-10-02T12:00:00.000Z", "2026-10-02T12:00:01.000Z"], ofArchived: ["2026-10-02T12:00:00.000Z", "2026-10-02T12:00:01.000Z"] };
  const update = db.prepare("UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?");
  for (const [key, [started, ended]] of Object.entries(times)) update.run(started, ended, ids[key]);
  db.close();
  return { dir, ids };
}

test("analytics sums the ended runs' metrics with coverage, by harness and effort, by UTC day and by source, leaving archived runs out", async () => {
  const { dir } = await seeded();
  const reader = openStoreReader(dir);
  const a = reader.analytics();
  reader.close();
  assert.deepEqual({ ...a.totals, costUsd: usd(a.totals.costUsd) }, {
    ...group(8, 4, 2, 5, 1445, 0.82, 4),
    input: 318, cacheRead: 1002, cacheWrite: 53, output: 72, requests: 8, unmetered: 1,
  }, "eight runs, five with metrics: the running ones (one opened again keeps its last end's metrics) are not counted");
  assert.deepEqual(a.time, { endedRuns: 6, wallMs: 316_500, activeRuns: 2, activeMs: 5000 });
  assert.deepEqual(rounded(a.byHarnessEffort), [
    { harness: "codex", effort: null, ...group(1, 0, 0, 0, 0, null, 1) },
    { harness: "codex", effort: "medium", ...group(2, 1, 1, 2, 255, 0.5, 1) },
    { harness: "pi", effort: null, ...group(3, 1, 1, 1, 10, 0.02, 2) },
    { harness: "pi", effort: "high", ...group(1, 1, 0, 1, 1170, 0.25, 0) },
    { harness: "workflow", effort: null, ...group(1, 1, 0, 1, 10, 0.05, 0) },
  ], "a revision with no harness is pi's, a workflow revision reads workflow, and an effort is the metrics'");
  assert.deepEqual(rounded(a.byDay), [
    { day: "2026-10-01", ...group(1, 1, 0, 1, 10, 0.02, 0) },
    { day: "2026-10-02", ...group(2, 1, 1, 1, 1170, 0.25, 1) },
    { day: "2026-10-03", ...group(4, 1, 1, 2, 255, 0.5, 3) },
    { day: "2026-10-04", ...group(1, 1, 0, 1, 10, 0.05, 0) },
  ], "a run started at 23:59:59.999 is that day's, one at 00:00 the next's");
  assert.deepEqual(rounded(a.bySource), [
    { source: "live", ...group(7, 3, 2, 4, 1435, 0.8, 4) },
    { source: "codex", ...group(1, 1, 0, 1, 10, 0.02, 0) },
  ], "an imported run is its source's, never live");
  assert.deepEqual(a.tools, [{ tool: "read", calls: 6, errors: 1 }, { tool: "shell", calls: 5, errors: 2 }, { tool: "fetch", calls: 1, errors: 0 }]);
});

test("analytics' filters: from inclusive, to exclusive, at a UTC midnight; one agent's runs; an unknown agent has none; a bad bound is refused", async () => {
  const { dir } = await seeded();
  const reader = openStoreReader(dir);
  const midnight = "2026-10-03T00:00:00.000Z";
  const from = reader.analytics({ from: midnight });
  assert.deepEqual([from.totals.runs, from.totals.tokens, from.byDay.map((d) => d.day)], [5, 265, ["2026-10-03", "2026-10-04"]], "from takes the run started at midnight");
  const to = reader.analytics({ to: midnight });
  assert.deepEqual([to.totals.runs, to.totals.tokens, to.byDay.map((d) => d.day)], [3, 1180, ["2026-10-01", "2026-10-02"]], "to leaves it out, and takes the one a millisecond before");
  const both = reader.analytics({ from: "2026-10-02T00:00:00.000Z", to: midnight, agent: "chat" });
  assert.deepEqual([both.totals.runs, both.totals.tokens, both.bySource.map((s) => s.source)], [2, 1170, ["live"]]);
  const coder = reader.analytics({ agent: "coder" });
  assert.deepEqual([coder.totals.runs, coder.totals.runsWithMetrics, coder.totals.tokens, coder.byHarnessEffort.map((g) => g.harness)], [3, 2, 255, ["codex", "codex"]]);
  assert.deepEqual(reader.analytics({ agent: "nobody" }), NONE, "no run: zeros and empty lists, never an error");
  assert.deepEqual(reader.analytics({ agent: "old" }), NONE, "an archived agent's runs are archived with it");
  for (const bad of [{ from: "yesterday" }, { to: "2026-10-03" }, { agent: "../x" }]) assert.throws(() => reader.analytics(bad), (error) => error instanceof AgentHomeError && error.code === "invalid", JSON.stringify(bad));
  reader.close();
});

test("analytics' tools are the 20 with the most calls, by name on a tie", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  store.createAgent({ name: "Busy", id: "busy" });
  await store.commitRevision("busy", A, { setCurrent: true });
  // zz with 3 calls, a..u with 2 each, and four with 1: the cut falls inside the tie at 2.
  const tools = { zz: { calls: 3, errors: 1 }, ...Object.fromEntries("abcdefghijklmnopqrstu".split("").map((name) => [name, { calls: 2, errors: 0 }])), ...Object.fromEntries(["w1", "w2", "w3", "w4"].map((name) => [name, { calls: 1, errors: 1 }])) };
  const { runId } = await store.startRun({ agent: "busy" });
  store.carryBack(runId, { state: "completed", metrics: metrics(1, 0, 0, 1, 1, 0, tools) });
  const top = store.analytics().tools;
  store.close();
  assert.equal(top.length, 20);
  assert.deepEqual(top.map((t) => t.tool), ["zz", ..."abcdefghijklmnopqrs".split("")]);
  assert.deepEqual(top[0], { tool: "zz", calls: 3, errors: 1 });
});

test("a store written before the metrics and import tables answers its runs with no metrics: zeros, never an error", async () => {
  const dir = await scratch();
  const store = openStore(dir);
  store.createAgent({ name: "Notes", id: "notes" });
  await store.commitRevision("notes", A, { setCurrent: true });
  const { runId } = await store.startRun({ agent: "notes" });
  store.carryBack(runId, { state: "completed", costUsd: 0.2, metrics: metrics(10, 0, 0, 5, 1, 0, { read: { calls: 1, errors: 0 } }) });
  store.close();
  const db = new DatabaseSync(path.join(dir, "store.sqlite"));
  db.prepare("UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?").run("2026-10-02T09:00:00.000Z", "2026-10-02T09:00:01.000Z", runId);
  for (const sql of ["DROP TABLE run_tool_metrics", "DROP TABLE run_metrics", "DROP TRIGGER imported_runs_stay_ended", "DROP TABLE run_imports"]) db.exec(sql);
  db.close();
  const reader = openStoreReader(dir);
  const a = reader.analytics();
  reader.close();
  assert.deepEqual(a, {
    totals: { ...group(1, 1, 0, 0, 0, 0.2, 0), input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, unmetered: 0 },
    time: { endedRuns: 1, wallMs: 1000, activeRuns: 0, activeMs: 0 },
    byHarnessEffort: [{ harness: "pi", effort: null, ...group(1, 1, 0, 0, 0, 0.2, 0) }],
    byDay: [{ day: "2026-10-02", ...group(1, 1, 0, 0, 0, 0.2, 0) }],
    bySource: [{ source: "live", ...group(1, 1, 0, 0, 0, 0.2, 0) }],
    tools: [],
  });
});
