// A run's read says what its paid tool calls cost (`cost.tools_usd`): the part of `cost.usd` that went to monid's
// endpoints, priced MCP tools, Parallel behind the web tools and browser time, as the run's one ledger booked them. It is a
// breakdown inside `usd`, never added to it: `usd` stays the model's requests and those calls. A run with no paid call
// reads 0; one whose paid call charged an unknown amount reads null, as `usd` does. A faux model at a fixed price per
// request, faux monid and a fake MCP server on loopback, the real server and runner.
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
/** Two figures equal to the micro-dollar. */
const micro = (usd) => (usd === null || usd === undefined ? usd : Math.round(usd * 1e6));

async function server(t) {
  withEnv(t, { MONID_API_KEY: MONID_KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: join(await scratch(t), "monid-calls.jsonl") });
  return serve(t, { faux: FAUX, fauxMonid: FAUX_MONID });
}

/** Run `id` (saved with `tools`) on `content` to its end; its read. */
async function ran(api, id, tools, content) {
  const saved = await api("POST", "/agents", agent(id, { tools, tool_settings: allowed(...tools) }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  return (await api("GET", `/runs/${run.body.run_id}`)).body;
}

test("a run with one monid call: tools_usd is that call's charge, and usd is still the model's requests and that call", { timeout: 120_000 }, async (t) => {
  const { api } = await server(t);
  const view = await ran(api, "enrich", [ENRICH], 'Call monid__faux__person__enrich with {"body":{"name":"Ada"}}');
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  const requests = view.cost.tokens.requests;
  assert.equal(requests, 2, "the call, then the answer");
  assert.equal(micro(view.cost.usd), micro(requests * REQUEST_USD + 0.003), "usd: the model's requests and monid's $0.003, as on main");
  assert.equal(view.cost.tools_usd, 0.003, "tools_usd: monid's charge for the call");
});

test("a run with no paid tool call: tools_usd is 0, and usd is its model requests alone", { timeout: 120_000 }, async (t) => {
  const { api } = await server(t);
  const view = await ran(api, "plain", [], "Answer.");
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  const requests = view.cost.tokens.requests;
  assert.equal(requests, 1);
  assert.equal(micro(view.cost.usd), micro(requests * REQUEST_USD), "usd: the one model request");
  assert.equal(view.cost.tools_usd, 0, "no paid call: $0, never absent or null");
});

test("a run with a priced MCP call and a monid call: tools_usd is their sum, inside usd", { timeout: 120_000 }, async (t) => {
  const { api } = await server(t);
  const fake = await startFakeMcp({});
  t.after(() => fake.close());
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, prices: { paid: 0.05 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const view = await ran(api, "both", [PAID, ENRICH], ['Call mcp__fake__paid with {"query":"ada"}', 'Call monid__faux__person__enrich with {"body":{"name":"Ada"}}'].join("\n"));
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "paid").length, 1, "the MCP tool was called once");
  const requests = view.cost.tokens.requests;
  assert.equal(requests, 3, "two calls, then the answer");
  assert.equal(micro(view.cost.usd), micro(requests * REQUEST_USD + 0.05 + 0.003), "usd: the model's requests, the MCP tool's $0.05 and monid's $0.003");
  assert.equal(view.cost.tools_usd, 0.053, "tools_usd: $0.05 and $0.003");
});

test("a run whose paid call charged an unknown amount: tools_usd is null, as usd is, never $0", { timeout: 120_000 }, async (t) => {
  const { api } = await server(t);
  // monid's /late is a 408 (TIMED_OUT): it may have charged, and says no cost.
  const view = await ran(api, "late", [LATE], 'Call monid__faux__late with {"body":{"name":"Ada"}}');
  assert.equal(view.cost.usd, null, "usd: unknown");
  assert.ok(view.cost.so_far_usd >= 0, "usd's known part is said beside it");
  assert.equal(view.cost.tools_usd, null, "tools_usd: unknown too");
});
