// GET /v2/stats, this server's own route: counts and cost over every agent and run from the agent store's aggregates.
// Archived agents and runs are left out of every number but their own counts; an unknown cost is
// counted, never read as $0; no run's files are opened. `analytics` sums the runs' metrics over the runs `from`, `to`
// and `agent` pick; the other numbers stay the whole store's.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { schemaProblems } from "./schema-support.mjs";
import { follow, scratch, serve, startRun } from "./support.mjs";
import { seedRuns } from "./store-helpers.mjs";
import { openSqliteStore, STORE_FILE } from "../dist/store/sqlite/store.js";
import { listRuns } from "../dist/store-reads/runs.js";
import { statsView } from "../dist/stats.js";

const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();

/** A data directory whose store holds `agents` (`[id, name]`, one revision each) and `runs` as rows
 *  (`[agent, state, costUsd | null]`, the i-th started i seconds after the first); `archived` are archived. */
async function seeded(t, agents, runs, archived = []) {
  const data = join(await scratch(t), "agents");
  const { revisions } = await seedRuns(
    data,
    agents,
    runs.map(([agent, state, cost], i) => ({ agent, state, costUsd: cost, startedMs: Date.parse(at(i)), endedMs: Date.parse(at(i + 1)) })),
    archived,
  );
  return { data, revisions };
}

/** The three running buckets partition the running runs not archived, as the store lists them. */
async function assertRunningPartitioned(data, body) {
  const store = await openSqliteStore({ dataDir: data, role: "runner" });
  try {
    const running = (await listRuns(store, {}, ctx)).filter((r) => r.state === "running" && !r.archivedAt).length;
    assert.equal(body.runs.active + body.runs.needs_input + body.runs.status_unknown, running, "each running run is in exactly one of active, needs_input and status_unknown");
  } finally {
    await store.close();
  }
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
  const { analytics, learning, ...counts } = stats.body;
  assert.deepEqual(learning, { runs: 0, merged: 0, dropped: {}, in_progress: 0 }, "no run here learns");
  assert.deepEqual(counts, {
    agents: 5,
    runs: { total: 6, active: 1, needs_input: 1, failed: 1, needs_review: 1, status_unknown: 0 },
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
  assert.deepEqual([analytics.totals.completed, analytics.totals.needs_review, analytics.totals.failed], [2, 1, 1], "the escalated run is completed, and needs review; never failed");
  await assertRunningPartitioned(data, stats.body);
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

/** A data directory with runs that ended with metrics, through the store: chat (pi) and coder (codex), and a session
 *  imported from claude-code, at fixed times. */
async function measured(t) {
  const data = join(await scratch(t), "agents");
  const metrics = (input, cacheRead, output, requests, tools, extra = {}) => ({ input, cacheRead, cacheWrite: 0, output, requests, unmetered: 0, models: { "anthropic/claude-opus-5-5": requests }, tools, ...extra });
  await seedRuns(data, [["chat", "chat"], ["coder", "coder", "codex"]], [
    { agent: "chat", state: "completed", costUsd: 0.25, metrics: metrics(100, 1000, 20, 2, { read: { calls: 2, errors: 0 } }, { effort: "high", activeMs: 3000 }), startedMs: Date.parse("2026-10-02T10:00:00.000Z"), endedMs: Date.parse("2026-10-02T10:00:05.000Z") },
    { agent: "coder", state: "failed", metrics: metrics(50, 0, 10, 1, { shell: { calls: 1, errors: 1 } }, { effort: "low" }), startedMs: Date.parse("2026-10-03T00:00:00.000Z"), endedMs: Date.parse("2026-10-03T00:00:01.000Z") },
    { agent: "chat", state: "completed", costUsd: 0.5, metrics: metrics(5, 0, 5, 1, {}), startedMs: Date.parse("2026-10-01T08:00:00.000Z"), endedMs: Date.parse("2026-10-01T08:01:00.000Z"), source: "claude-code" },
  ]);
  return data;
}

const row = (runs, completed, failed, runs_with_metrics, tokens, cost_usd, unknown_cost_runs, needs_review = 0) => ({ runs, completed, needs_review, failed, runs_with_metrics, tokens, cost_usd, unknown_cost_runs });

test("an escalated run is completed and needs review, never failed: in the counts, and in analytics with and without its filters", async (t) => {
  const { data } = await seeded(t, [["alpha", "Alpha"], ["beta", "Beta"]], [
    ["alpha", "completed", 0.1], ["alpha", "escalated", 0.1], ["alpha", "failed", 0.1],
    ["beta", "completed", 0.1],
  ]);
  const { api } = await serve(t, { data });
  const counts = (body) => [body.totals.completed, body.totals.needs_review, body.totals.failed];
  const all = (await api("GET", "/stats")).body;
  assert.deepEqual([all.runs.failed, all.runs.needs_review], [1, 1], "the failed run alone is failed; the escalated one needs review");
  assert.deepEqual(counts(all.analytics), [3, 1, 1], "both completed runs and the escalated one are completed");
  assert.deepEqual(counts((await api("GET", "/stats?agent=alpha")).body.analytics), [2, 1, 1], "one agent's");
  const window = new URLSearchParams({ from: at(0), to: at(3) });
  assert.deepEqual(counts((await api("GET", `/stats?${window}`)).body.analytics), [2, 1, 1], "a window of the first three");
  assert.deepEqual((await api("GET", "/stats?agent=beta")).body.analytics.totals.needs_review, 0);
});

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
    // Each tool by what a person calls it, else the name it was called by.
    tools: [{ tool: "read", label: "Read files", calls: 2, errors: 0 }, { tool: "shell", label: "shell", calls: 1, errors: 1 }],
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
  const leap = await api("GET", "/stats?from=2024-02-29T00:00:00.5z");
  assert.deepEqual([leap.status, leap.body.analytics?.filter.from], [200, "2024-02-29T00:00:00.500Z"], "a date that exists, lowercase z and a fraction too");
  const exact = await api("GET", "/stats?to=2026-10-03T00:00:00.000Z");
  assert.deepEqual([exact.status, exact.body.analytics?.filter.to], [200, "2026-10-03T00:00:00.000Z"], "three fraction digits: a millisecond, taken as it is");
  const coder = (await api("GET", "/stats?agent=coder")).body.analytics;
  assert.deepEqual([coder.filter.agent, coder.totals.runs, coder.by_harness_effort.map((g) => g.harness)], ["coder", 1, ["codex"]]);
  const nobody = (await api("GET", "/stats?agent=nobody")).body.analytics;
  assert.deepEqual([nobody.totals.runs, nobody.by_day, nobody.tools], [0, [], []], "an agent with no runs here has none");
  assert.ok(all.totals.runs > analytics.totals.runs);
  const { doc, schema } = await statsSchema(baseUrl);
  assert.deepEqual(schemaProblems(doc, schema, day.body), []);
  // An impossible date or time is refused, never rolled forward to another (02-30 would read as 03-02); so is a date alone,
  // and a fraction finer than a millisecond, which would be cut (.0005 would read .000) and move the bound.
  for (const query of ["to=2026-10-03T00:00:00.0005Z", "from=2026-10-02T00:00:00.123456Z", "from=yesterday", "to=2026-13-45T00:00:00Z", "from=2026-02-30T00:00:00Z", "to=2026-10-02T24:00:00Z", `from=${encodeURIComponent("2026-10-02T00:00:00+24:00")}`, "from=2026-10-02", `from=${encodeURIComponent("+275760-09-13T00:00:00Z")}`, `from=${encodeURIComponent("0000-01-01T00:00:00+01:00")}`, `agent=${encodeURIComponent("../x")}`, "agent="]) {
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

test("a running row the server does not hold still reads its status over the store: a bare running run counts active, not unknown", async (t) => {
  // Another writer's run, its row running: seeded before this server starts, and (no runner here) never claimed or adopted
  // by it. On the switch the server reads every run's status over the store (getStats → viewOverStore), so this row reads
  // queued and counts active — it is no longer unknown for want of a held process. status_unknown is only a running row the
  // view yields no status for: viewOverStore (store-view.ts storeRunOf) returns undefined only for a run with no row, pinned
  // by statsView's unit test below (a statusOf undefined for its id).
  const data = join(await scratch(t), "agents");
  await seedRuns(data, [["alpha", "Alpha"]], [
    { agent: "alpha", state: "completed", costUsd: 0.5, startedMs: Date.parse(at(0)), endedMs: Date.parse(at(1)) },
    { id: "elsewhere", agent: "alpha", state: "running", startedMs: Date.parse(at(2)) },
  ]);
  const { api, baseUrl } = await serve(t, { data, runner: false });
  const { body } = await api("GET", "/stats");
  assert.deepEqual(body.runs, { total: 2, active: 1, needs_input: 0, failed: 0, needs_review: 0, status_unknown: 0 });
  assert.deepEqual(body.cost, { usd: 0.5, basis: "estimate", unknown_runs: 1 });
  await assertRunningPartitioned(data, body);
  const { doc, schema } = await statsSchema(baseUrl);
  assert.deepEqual(schemaProblems(doc, schema, body), []);
});

test("GET /v2/stats over 1,000 runs across several agents answers within 500 ms", async (t) => {
  const agents = ["a1", "a2", "a3", "a4", "a5"].map((id) => [id, id.toUpperCase()]);
  const { data } = await seeded(t, agents, Array.from({ length: 1_000 }, (_, i) => [agents[i % 5][0], ["completed", "failed", "stopped", "escalated"][i % 4], i % 2 ? 0.01 : null]), Array.from({ length: 20 }, (_, i) => ["run", `run-${i * 50}`]));
  const { api } = await serve(t, { data });
  {
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
    // The states cycle completed, failed, stopped, escalated; the archived runs (every 50th) are completed or stopped, so
    // 250 failed and 250 escalated runs stay counted.
    assert.deepEqual(stats.body.runs, { total: 980, active: 0, needs_input: 0, failed: 250, needs_review: 250, status_unknown: 0 });
    assert.deepEqual(stats.body.cost, { usd: 5, basis: "estimate", unknown_runs: 480 });
    assert.deepEqual(stats.body.per_agent.map((a) => a.runs), [180, 200, 200, 200, 200], "a1 lost its 20 archived runs");
    assert.deepEqual(stats.body.archived, { agents: 0, runs: 20 });
  }
});

test("a held run still queued (launched, its work not started) counts as active; one working too; one not held is unknown", () => {
  // statsView buckets each running run by the status statusOf reads for it over the store (BUCKET): queued and working are
  // active; a run statusOf cannot place (another writer's) is status_unknown.
  const statusOf = (id) => ({ q: "queued", w: "working" })[id];
  const store = {
    agents: 1, archivedAgents: 0, archivedRuns: 0,
    runs: { total: 3, running: 3, completed: 0, failed: 0, stopped: 0, escalated: 0 },
    cost: { usd: null, known: 0, unknown: 3 },
    byAgent: [{ id: "a", name: "A", runs: 3 }],
    running: ["q", "w", "elsewhere"],
  };
  assert.deepEqual(statsView(store, statusOf).runs, { total: 3, active: 2, needs_input: 0, failed: 0, needs_review: 0, status_unknown: 1 });
});

test("a refused fetch is a failed call in a run's metrics and in GET /v2/stats, whose tool rows carry the name a person reads", { timeout: 60_000 }, async (t) => {
  const { api, baseUrl } = await serve(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "reader", name: "reader", instructions: "Read.", tools: ["web_fetch"] } })).status, 201);
  // A loopback address: the fetch is refused before anything is dialled, and the call still returns, refused.
  const started = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages with web_fetch: ${JSON.stringify(["http://127.0.0.1/"])}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  assert.deepEqual(rows.filter((r) => r.kind === "tool_result").map((r) => [r.tool_name, r.tool_status]), [["web_fetch", "failed"]], "the timeline reads it failed");
  const { body } = await api("GET", "/stats?agent=reader");
  assert.deepEqual(body.analytics.tools, [{ tool: "web_fetch", label: "Fetch web pages", calls: 1, errors: 1 }], "and so do the run's metrics, under the tool's own name");
  const { doc, schema } = await statsSchema(baseUrl);
  assert.deepEqual(schemaProblems(doc, schema, body), []);
});
