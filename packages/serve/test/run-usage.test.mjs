// GET /runs/{run_id}/usage: a run's usage lines by meter and dimension, joining to its read's cost.usd. A faux model at a
// fixed price per request, faux monid and a fake MCP server on loopback, the real server and runner; no network, no key.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { REQUEST_USD } from "./fixtures/faux-tools-cost.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-tools-cost.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const ENRICH = "monid:faux/person/enrich";
const LATE = "monid:faux/late";
const PAID = "mcp:fake/paid";
const allowed = (...names) => Object.fromEntries(names.map((name) => [name, { permission: "allow" }]));
const micro = (usd) => (usd === null || usd === undefined ? usd : Math.round(usd * 1e6));

async function server(t, extra = {}) {
  withEnv(t, { MONID_API_KEY: MONID_KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: join(await scratch(t), "monid-calls.jsonl") });
  return serve(t, { faux: FAUX, fauxMonid: FAUX_MONID, ...extra });
}

/** Run `id` (saved with `tools`) on `content` to its end: its read and its usage. */
async function ran(api, id, tools, content) {
  const saved = await api("POST", "/agents", agent(id, { tools, tool_settings: allowed(...tools) }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  const usage = await api("GET", `/runs/${run.body.run_id}/usage`);
  assert.equal(usage.status, 200, JSON.stringify(usage.body));
  return { view, usage: usage.body };
}

test("a run with a priced MCP call and a monid call: a tokens line for its model, a tools line per charger, joining to cost.usd", { timeout: 120_000 }, async (t) => {
  const { api } = await server(t);
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, prices: { paid: 0.05 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const { view, usage } = await ran(api, "both", [PAID, ENRICH], ['Call mcp__fake__paid with {"query":"ada"}', 'Call monid__faux__person__enrich with {"body":{"name":"Ada"}}'].join("\n"));
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(usage.final, true);
  assert.equal(usage.reason, null);
  assert.equal(usage.currency, "USD");

  const tokens = usage.lines.filter((line) => line.meter === "tokens");
  assert.equal(tokens.length, 1, `one model: ${JSON.stringify(usage.lines)}`);
  const [model] = tokens;
  assert.equal(model.requests, 3, "two calls, then the answer");
  assert.equal(model.requests, view.cost.tokens.requests);
  // The faux model reports 1,000 input and 100 output tokens a request.
  assert.deepEqual(model.tokens, { input: 3000, output: 300, cache_read: 0, cache_write: 0 });
  assert.equal(model.quantity, 3300);
  assert.equal(model.unit, "token");
  assert.equal(micro(model.usd), micro(3 * REQUEST_USD));
  assert.equal(model.basis, view.cost.basis, "the run's basis, over its one model");

  const tools = usage.lines.filter((line) => line.meter === "tools");
  assert.deepEqual(tools.map((line) => [line.dimension, line.quantity, line.unit, line.usd, line.basis]), [["fake", 1, "call", 0.05, "estimate"], ["monid", 1, "call", 0.003, "estimate"]]);

  assert.equal(micro(usage.total_usd), micro(view.cost.usd), "the lines' join is the run's cost.usd");
  assert.equal(micro(usage.lines.reduce((sum, line) => sum + line.usd, 0)), micro(view.cost.usd), "and the lines sum to it");
  assert.equal(micro(tools.reduce((sum, line) => sum + line.usd, 0)), micro(view.cost.tools_usd), "the tools lines are cost.tools_usd");
});

test("a run with no paid call: one tokens line, the whole cost", { timeout: 120_000 }, async (t) => {
  const { api } = await server(t);
  const { view, usage } = await ran(api, "plain", [], "Answer.");
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(usage.lines.length, 1, JSON.stringify(usage.lines));
  assert.equal(usage.lines[0].meter, "tokens");
  assert.equal(usage.lines[0].requests, 1);
  assert.equal(micro(usage.total_usd), micro(view.cost.usd));
});

test("a run whose paid call charged an unknown amount: its tools line and the total are null, never $0", { timeout: 120_000 }, async (t) => {
  const { api } = await server(t);
  // monid's /late is a 408 (TIMED_OUT): it may have charged, and says no cost.
  const { view, usage } = await ran(api, "late", [LATE], 'Call monid__faux__late with {"body":{"name":"Ada"}}');
  assert.equal(view.cost.usd, null);
  const tools = usage.lines.find((line) => line.meter === "tools");
  assert.equal(tools.usd, null, JSON.stringify(tools));
  assert.equal(tools.quantity, 1, "the call was made");
  assert.equal(usage.total_usd, null);
  assert.ok(usage.lines.find((line) => line.meter === "tokens").usd > 0, "the model's requests are still known");
});

test("a run still at work has no lines yet, and says so; an unknown run is a 404", { timeout: 120_000 }, async (t) => {
  // Accounts on: an owner can answer an ask, so the gate parks the call.
  const { api } = await server(t, { accounts: true, openSetup: true });
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const saved = await api("POST", "/agents", agent("working", { tools: ["web_fetch"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const run = await api("POST", "/agents/working/runs", { input: { content: 'Call web_fetch with {"url":"https://example.invalid/"}' } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["input_required"], { deadlineMs: 60_000 });
  const usage = await api("GET", `/runs/${run.body.run_id}/usage`);
  assert.equal(usage.status, 200);
  assert.deepEqual(usage.body, { run_id: run.body.run_id, final: false, currency: "USD", total_usd: null, lines: null, reason: "running" });
  assert.equal((await api("GET", "/runs/run_nope/usage")).status, 404);
});
