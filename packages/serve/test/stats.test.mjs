// GET /v2/stats, this server's own route: counts and cost over every agent and run from the agent store's aggregates.
// Archived agents and runs are left out of every number but their own counts; an unknown cost is
// counted, never read as $0; no run's files are opened. `analytics` sums the runs' metrics over the runs `from`, `to`
// and `agent` pick; the other numbers stay the whole store's.
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openStore, openStoreReader } from "@parcha/pi-durable-agent";
import { schemaProblems } from "./schema-support.mjs";
import { follow, scratch, serve, startRun } from "./support.mjs";
import { statsView } from "../dist/stats.js";

const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();

/** A data directory whose store holds `agents` (`[id, name]`, one revision each) and `runs` as rows
 *  (`[agent, state, costUsd | null]`, the i-th started i seconds after the first); `archived` are archived. */
async function seeded(t, agents, runs, archived = []) {
  const data = join(await scratch(t), "agents");
  const store = openStore(data);
  const revisions = {};
  for (const [id, name] of agents) {
    store.createAgent({ name, id });
    revisions[id] = (await store.commitRevision(id, { kind: "agentic", instructions: "Answer." }, { setCurrent: true })).id;
  }
  store.close();
  const db = new DatabaseSync(join(data, "store.sqlite"));
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO runs (id, agent_id, revision_id, state, started_at, ended_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)");
  runs.forEach(([agent, state, cost], i) => insert.run(`run-${i}`, agent, revisions[agent], state, at(i), at(i + 1), cost));
  db.exec("COMMIT");
  db.close();
  const writer = openStore(data);
  for (const [kind, id] of archived) writer.setArchived(kind, id, true);
  writer.close();
  return { data, revisions };
}

/** The three running buckets partition the running runs not archived, as the store lists them. */
function assertRunningPartitioned(data, body) {
  const reader = openStoreReader(data);
  const running = reader.listRuns().filter((r) => r.state === "running" && !r.archivedAt).length;
  reader.close();
  assert.equal(body.runs.active + body.runs.needs_input + body.runs.status_unknown, running, "each running run is in exactly one of active, needs_input and status_unknown");
}

/** The served document's schema for GET /stats's 200. */
async function statsSchema(baseUrl) {
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const op = doc.paths["/stats"].get;
  return { doc, op, schema: op.responses["200"].content["application/json"].schema };
}

test("GET /v2/stats counts by status, sums only known costs, leaves archived out, and meets the served document", async (t) => {
  const { data } = await seeded(t, [["alpha", "Alpha"], ["beta", "Beta"], ["gone", "Gone"], ["idle", "Idle"]], [
    ["alpha", "completed", 0.25], ["alpha", "completed", null], ["alpha", "escalated", 0.5],
    ["beta", "failed", null], ["beta", "stopped", 1],
    ["gone", "completed", 3],
  ], [["run", "run-1"], ["agent", "gone"]]);
  const { api, baseUrl } = await serve(t, { data });
  const asking = await startRun(api, "regions", "Pick a region.", { tools: ["ask_person"] });
  await follow(api, asking.run_id, ["input_required"]);
  const working = await startRun(api, "slow", "Take your time.");
  await follow(api, working.run_id, ["working"]);
  const stats = await api("GET", "/stats");
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  const { analytics, ...counts } = stats.body;
  assert.deepEqual(counts, {
    agents: 5,
    runs: { total: 6, active: 1, needs_input: 1, failed: 2, status_unknown: 0 },
    per_agent: [
      { agent_id: "alpha", name: "Alpha", runs: 2 },
      { agent_id: "beta", name: "Beta", runs: 2 },
      { agent_id: "idle", name: "Idle", runs: 0 },
      { agent_id: "regions", name: "regions", runs: 1 },
      { agent_id: "slow", name: "slow", runs: 1 },
    ],
    cost: { usd: 1.75, basis: "estimate", unknown_runs: 3 },
    archived: { agents: 1, runs: 2 },
  });
  assert.deepEqual([analytics.totals.runs, analytics.totals.runs_with_metrics, analytics.totals.tokens], [6, 0, 0], "rows with no metrics: runs, none of them covered");
  assertRunningPartitioned(data, stats.body);
  const { doc, op, schema } = await statsSchema(baseUrl);
  assert.equal(op["x-agentrun-serve"], "stats/1");
  assert.deepEqual(schemaProblems(doc, schema, stats.body), []);
  // The positive control: the closed shape refuses a field it does not name, at every level, and a basis but estimate.
  assert.notDeepEqual(schemaProblems(doc, schema, { ...stats.body, recent: [] }), []);
  assert.notDeepEqual(schemaProblems(doc, schema, { ...stats.body, runs: { ...stats.body.runs, completed: 1 } }), []);
  assert.notDeepEqual(schemaProblems(doc, schema, { ...stats.body, per_agent: [{ ...stats.body.per_agent[0], cost: null }] }), []);
  assert.notDeepEqual(schemaProblems(doc, schema, { ...stats.body, cost: { ...stats.body.cost, known_runs: 4 } }), []);
  assert.notDeepEqual(schemaProblems(doc, schema, { ...stats.body, archived: { ...stats.body.archived, cost: 3 } }), []);
  assert.notDeepEqual(schemaProblems(doc, schema, { ...stats.body, cost: { ...stats.body.cost, basis: "charge" } }), []);
  assert.notDeepEqual(schemaProblems(doc, schema, counts), [], "analytics is required");
  assert.notDeepEqual(schemaProblems(doc, schema, { ...stats.body, analytics: { ...analytics, totals: { ...analytics.totals, cost: 1 } } }), []);
});

/** A data directory with runs that ended with metrics, through the store's own API: chat (pi) and coder (codex), and a
 *  session imported from claude-code, at fixed times. */
async function measured(t) {
  const data = join(await scratch(t), "agents");
  const store = openStore(data);
  for (const [id, harness] of [["chat", undefined], ["coder", "codex"]]) {
    store.createAgent({ name: id, id });
    await store.commitRevision(id, { kind: "agentic", instructions: "Answer.", ...(harness ? { harness } : {}) }, { setCurrent: true });
  }
  const metrics = (input, cacheRead, output, requests, tools, extra = {}) => ({ input, cacheRead, cacheWrite: 0, output, requests, unmetered: 0, models: { "anthropic/claude-opus-5-5": requests }, tools, ...extra });
  const ended = async (agent, end) => {
    const { runId } = await store.startRun({ agent });
    store.carryBack(runId, end);
    return runId;
  };
  const chat = await ended("chat", { state: "completed", costUsd: 0.25, metrics: metrics(100, 1000, 20, 2, { read: { calls: 2, errors: 0 } }, { effort: "high", activeMs: 3000 }) });
  const coder = await ended("coder", { state: "failed", metrics: metrics(50, 0, 10, 1, { shell: { calls: 1, errors: 1 } }, { effort: "low" }) });
  store.importRun({ agent: "chat", revision: store.listRevisions("chat")[0].id, state: "completed", startedAt: "2026-10-01T08:00:00.000Z", endedAt: "2026-10-01T08:01:00.000Z", costUsd: 0.5, source: "claude-code", session: "session-1", metrics: metrics(5, 0, 5, 1, {}) });
  store.close();
  const db = new DatabaseSync(join(data, "store.sqlite"));
  const times = db.prepare("UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?");
  times.run("2026-10-02T10:00:00.000Z", "2026-10-02T10:00:05.000Z", chat);
  times.run("2026-10-03T00:00:00.000Z", "2026-10-03T00:00:01.000Z", coder);
  db.close();
  return data;
}

const row = (runs, completed, failed, runs_with_metrics, tokens, cost_usd, unknown_cost_runs) => ({ runs, completed, failed, runs_with_metrics, tokens, cost_usd, unknown_cost_runs });

test("GET /v2/stats's analytics sums the runs' metrics by harness and effort, day and source, and meets the served document", async (t) => {
  const { api, baseUrl } = await serve(t, { data: await measured(t) });
  const { status, body } = await api("GET", "/stats");
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.analytics, {
    filter: { from: null, to: null, agent: null },
    totals: { ...row(3, 2, 1, 3, 1190, 0.75, 1), input: 155, cache_read: 1000, cache_write: 0, output: 35, requests: 4, unmetered: 0 },
    time: { ended_runs: 3, wall_ms: 66_000, active_runs: 1, active_ms: 3000 },
    by_harness_effort: [
      { harness: "codex", effort: "low", ...row(1, 0, 1, 1, 60, null, 1) },
      { harness: "pi", effort: null, ...row(1, 1, 0, 1, 10, 0.5, 0) },
      { harness: "pi", effort: "high", ...row(1, 1, 0, 1, 1120, 0.25, 0) },
    ],
    by_day: [
      { day: "2026-10-01", ...row(1, 1, 0, 1, 10, 0.5, 0) },
      { day: "2026-10-02", ...row(1, 1, 0, 1, 1120, 0.25, 0) },
      { day: "2026-10-03", ...row(1, 0, 1, 1, 60, null, 1) },
    ],
    by_source: [
      { source: "live", ...row(2, 1, 1, 2, 1180, 0.25, 1) },
      { source: "claude-code", ...row(1, 1, 0, 1, 10, 0.5, 0) },
    ],
    tools: [{ tool: "read", calls: 2, errors: 0 }, { tool: "shell", calls: 1, errors: 1 }],
  });
  const { doc, op, schema } = await statsSchema(baseUrl);
  assert.deepEqual(schemaProblems(doc, schema, body), []);
  assert.equal(op.responses["200"].content["application/json"].schema.properties.analytics["x-agentrun-serve"], "stats/2");
  assert.deepEqual(op.parameters.map((p) => [p.name, p["x-agentrun-serve"]]), [["from", "stats/2"], ["to", "stats/2"], ["agent", "stats/2"]]);
  assert.ok(op.responses["400"], "a bad bound is a 400 the document names");
  // The positive control: the closed shape refuses a field it does not name, and a source it does not know.
  assert.notDeepEqual(schemaProblems(doc, schema, { ...body, analytics: { ...body.analytics, by_source: [{ ...body.analytics.by_source[0], source: "elsewhere" }] } }), []);
  assert.notDeepEqual(schemaProblems(doc, schema, { ...body, analytics: { ...body.analytics, time: { ...body.analytics.time, idle_ms: 0 } } }), []);
});

test("GET /v2/stats's from, to and agent bound analytics alone: the other numbers are the whole store's; a bad one is 400", async (t) => {
  const { api, baseUrl } = await serve(t, { data: await measured(t) });
  const { analytics: all, ...store } = (await api("GET", "/stats")).body;
  // RFC 3339 with an offset: read as the UTC time it names.
  const day = await api("GET", `/stats?from=${encodeURIComponent("2026-10-02T02:00:00+02:00")}&to=2026-10-03T00:00:00Z`);
  assert.equal(day.status, 200, JSON.stringify(day.body));
  const { analytics, ...same } = day.body;
  assert.deepEqual(same, store, "every number outside analytics is unchanged by the query");
  assert.deepEqual(analytics.filter, { from: "2026-10-02T00:00:00.000Z", to: "2026-10-03T00:00:00.000Z", agent: null });
  assert.deepEqual([analytics.totals.runs, analytics.totals.tokens, analytics.by_day.map((d) => d.day)], [1, 1120, ["2026-10-02"]], "from is inclusive, to exclusive: the run at 2026-10-03T00:00 is out");
  const coder = (await api("GET", "/stats?agent=coder")).body.analytics;
  assert.deepEqual([coder.filter.agent, coder.totals.runs, coder.by_harness_effort.map((g) => g.harness)], ["coder", 1, ["codex"]]);
  const nobody = (await api("GET", "/stats?agent=nobody")).body.analytics;
  assert.deepEqual([nobody.totals.runs, nobody.by_day, nobody.tools], [0, [], []], "an agent with no runs here has none");
  assert.ok(all.totals.runs > analytics.totals.runs);
  const { doc, schema } = await statsSchema(baseUrl);
  assert.deepEqual(schemaProblems(doc, schema, day.body), []);
  for (const query of ["from=yesterday", "to=2026-13-45T00:00:00Z", `from=${encodeURIComponent("+275760-09-13T00:00:00Z")}`, `agent=${encodeURIComponent("../x")}`, "agent="]) {
    const bad = await api("GET", `/stats?${query}`);
    assert.deepEqual([bad.status, bad.body.error?.code], [400, "bad_request"], query);
  }
});

test("GET /v2/stats answers null for the total when every cost is unknown, never 0", async (t) => {
  const { data } = await seeded(t, [["alpha", "Alpha"]], [["alpha", "completed", null], ["alpha", "failed", null]]);
  const { api, baseUrl } = await serve(t, { data });
  const { body } = await api("GET", "/stats");
  assert.deepEqual(body.cost, { usd: null, basis: null, unknown_runs: 2 });
  const { doc, schema } = await statsSchema(baseUrl);
  assert.deepEqual(schemaProblems(doc, schema, body), []);
});

test("a running run this server does not hold is status_unknown: never counted as active or as not waiting", async (t) => {
  const { data, revisions } = await seeded(t, [["alpha", "Alpha"]], [["alpha", "completed", 0.5]]);
  const { api, baseUrl } = await serve(t, { data });
  // Another writer's run: its row is running, and this server never started or adopted it.
  const db = new DatabaseSync(join(data, "store.sqlite"));
  db.prepare("INSERT INTO runs (id, agent_id, revision_id, state, started_at) VALUES ('elsewhere', 'alpha', ?, 'running', ?)").run(revisions.alpha, new Date().toISOString());
  db.close();
  const { body } = await api("GET", "/stats");
  assert.deepEqual(body.runs, { total: 2, active: 0, needs_input: 0, failed: 0, status_unknown: 1 });
  assert.deepEqual(body.cost, { usd: 0.5, basis: "estimate", unknown_runs: 1 });
  assertRunningPartitioned(data, body);
  const { doc, schema } = await statsSchema(baseUrl);
  assert.deepEqual(schemaProblems(doc, schema, body), []);
});

test("GET /v2/stats over 1,000 runs across several agents answers within 500 ms, and opens nothing under runs/", async (t) => {
  const agents = ["a1", "a2", "a3", "a4", "a5"].map((id) => [id, id.toUpperCase()]);
  const { data } = await seeded(t, agents, Array.from({ length: 1_000 }, (_, i) => [agents[i % 5][0], ["completed", "failed", "stopped", "escalated"][i % 4], i % 2 ? 0.01 : null]), Array.from({ length: 20 }, (_, i) => ["run", `run-${i * 50}`]));
  // The newest run's own file, which GET /runs reads for its title.
  await mkdir(join(data, "runs", "run-999"), { recursive: true });
  await writeFile(join(data, "runs", "run-999", "serve.json"), JSON.stringify({ title: "Seeded", created_at: at(999) }));
  const { api } = await serve(t, { data });
  assert.equal((await api("GET", "/runs?limit=1")).body.runs[0].title, "Seeded");
  await chmod(join(data, "runs"), 0o000);
  try {
    // The positive control: with runs/ unreadable, a route that reads a run's file no longer sees it.
    assert.equal((await api("GET", "/runs?limit=1")).body.runs[0].title, "");
    const times = [];
    let stats;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      stats = await api("GET", "/stats");
      times.push(performance.now() - start);
      assert.equal(stats.status, 200, JSON.stringify(stats.body));
    }
    t.diagnostic(`GET /v2/stats over 1,000 runs, 5 agents: first ${times[0].toFixed(1)} ms, slowest ${Math.max(...times).toFixed(1)} ms`);
    assert.ok(Math.max(...times) < 500, `slowest ${Math.max(...times).toFixed(1)} ms`);
    assert.deepEqual(stats.body.runs, { total: 980, active: 0, needs_input: 0, failed: 500, status_unknown: 0 });
    assert.deepEqual(stats.body.cost, { usd: 5, basis: "estimate", unknown_runs: 480 });
    assert.deepEqual(stats.body.per_agent.map((a) => a.runs), [180, 200, 200, 200, 200], "a1 lost its 20 archived runs");
    assert.deepEqual(stats.body.archived, { agents: 0, runs: 20 });
  } finally {
    await chmod(join(data, "runs"), 0o700);
  }
});

test("a held run still queued (launched, its work not started) counts as active; one working too; one not held is unknown", () => {
  // The held runs are as the server holds them, read by the real statusOf: a workflow run whose work has not started
  // is queued, one whose work has is working.
  const held = new Map([["q", { kind: "workflow", working: false }], ["w", { kind: "workflow", working: true }]]);
  const runs = { held: (id) => held.get(id) };
  const store = {
    agents: 1, archivedAgents: 0, archivedRuns: 0,
    runs: { total: 3, running: 3, completed: 0, failed: 0, stopped: 0, escalated: 0 },
    cost: { usd: null, known: 0, unknown: 3 },
    byAgent: [{ id: "a", name: "A", runs: 3 }],
    running: ["q", "w", "elsewhere"],
  };
  assert.deepEqual(statsView(store, runs).runs, { total: 3, active: 2, needs_input: 0, failed: 0, status_unknown: 1 });
});
