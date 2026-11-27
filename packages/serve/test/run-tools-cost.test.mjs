// A run's read says what its paid tool calls cost (`cost.tools_usd`): the part of `cost.usd` that went to monid's
// endpoints, priced MCP tools, Parallel behind the web tools and browser time, as the run's one ledger booked them. It is a
// breakdown inside `usd`, never added to it: `usd` stays the model's requests and those calls. A run with no paid call
// reads 0; one whose paid call charged an unknown amount reads null, as `usd` does. A faux model at a fixed price per
// request, faux monid and a fake MCP server on loopback, the real server and runner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { REQUEST_USD } from "./fixtures/faux-tools-cost.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { ended, started } from "./learn-support.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { raw } from "./store-target.mjs";

const FAUX = new URL("./fixtures/faux-tools-cost.mjs", import.meta.url).pathname;
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const ENRICH = "monid:faux/person/enrich";
const LATE = "monid:faux/late";
const PAID = "mcp:fake/paid";
const allowed = (...names) => Object.fromEntries(names.map((name) => [name, { permission: "allow" }]));
/** Two figures equal to the micro-dollar. */
const micro = (usd) => (usd === null || usd === undefined ? usd : Math.round(usd * 1e6));

async function server(t, extra = {}) {
  const calls = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: MONID_KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: calls });
  return { ...(await serve(t, { faux: FAUX, fauxMonid: FAUX_MONID, ...extra })), calls };
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

test("a learning run a follow-up opened again: the follow-up's paid call is the job's, in tools_usd, usd and the usage lines; a run with no follow-up keeps its whole charge (#3234 review)", { timeout: 240_000 }, async (t) => {
  const { api, calls } = await server(t, { learning: "on" });
  // The enrich runs monid answered (its run requests, never an endpoint's inspection).
  const enriched = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((one) => one.path === "/v1/run" && one.endpoint === "/person/enrich").length;
  const CALL = 'Call monid__faux__person__enrich with {"body":{"name":"Ada"}}';
  for (const id of ["once", "again"]) {
    const saved = await api("POST", "/agents", agent(id, { learning: true, tools: [ENRICH], tool_settings: allowed(ENRICH) }));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  }

  // No follow-up: its one round's paid call is its job's, whole.
  const once = (await ended(api, await started(api, "once", CALL))).view;
  assert.equal(once.status, "completed", JSON.stringify(once.error));
  assert.equal(once.cost.tools_usd, 0.003, `no follow-up: monid's whole charge: ${JSON.stringify(once.cost)}`);
  assert.ok(once.cost.tools_usd <= once.cost.usd, `inside usd: ${JSON.stringify(once.cost)}`);

  // A follow-up that makes a second paid call: the follow-up's turn is the job's, so usd grows by it and tools_usd holds
  // both calls; the usage lines at each end are cumulative.
  const runId = await started(api, "again", CALL);
  const first = (await ended(api, runId)).view;
  assert.equal(first.cost.tools_usd, 0.003, `the first round's charge: ${JSON.stringify(first.cost)}`);
  const sent = await api("POST", `/runs/${runId}/messages`, { content: CALL });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const second = (await ended(api, runId)).view;
  assert.equal(second.status, "completed", JSON.stringify(second.error));
  assert.equal(enriched(), 3, "the follow-up made its own paid call: one for each run's first round, one in the follow-up");
  assert.ok(second.cost.usd > first.cost.usd, `usd holds the follow-up's turn: ${JSON.stringify([first.cost, second.cost])}`);
  assert.equal(second.cost.tools_usd, 0.006, `tools_usd: both rounds' monid calls: ${JSON.stringify(second.cost)}`);
  assert.ok(second.cost.tools_usd <= second.cost.usd, `inside usd: ${JSON.stringify(second.cost)}`);
  const usage = (await api("GET", `/runs/${runId}/usage`)).body;
  assert.equal(usage.reason, null, JSON.stringify(usage));
  const tools = usage.lines.filter((one) => one.meter === "tools");
  assert.deepEqual(tools.map((one) => [one.charged_by, one.quantity, micro(one.usd)]), [["monid", 2, micro(0.006)]], `the tools lines: ${JSON.stringify(usage.lines)}`);
  assert.equal(micro(usage.total.usd), micro(second.cost.usd), `the lines join to usd: ${JSON.stringify([usage.total, second.cost])}`);
});

test("a run still at work: tools_usd is null, never a figure read apart from usd's, which a paid call booked between the two reads would put past usd (#3234 review)", { timeout: 120_000 }, async (t) => {
  // Accounts on: an owner can answer an ask, so the gate parks the call (with accounts off it refuses it at once).
  const { api, calls } = await server(t, { accounts: true, openSetup: true });
  // The enrich call runs (allowed) and is booked; web_fetch asks a person first (the server's setting), so the run waits
  // at its gate, not ended, and nothing is fetched.
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const saved = await api("POST", "/agents", agent("working", { tools: [ENRICH, "web_fetch"], tool_settings: allowed(ENRICH) }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const run = await api("POST", "/agents/working/runs", { input: { content: ['Call monid__faux__person__enrich with {"body":{"name":"Ada"}}', 'Call web_fetch with {"url":"https://example.invalid/"}'].join("\n") } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["input_required"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.equal(view.pending?.kind, "approval", `the run waits on the second call's approval: ${JSON.stringify(view.pending)}`);
  assert.equal(readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((one) => one.path === "/v1/run" && one.endpoint === "/person/enrich").length, 1, "the paid call ran before the wait");
  assert.equal(view.cost.tools_usd, null, `a run at work: tools_usd is unknown until it ends: ${JSON.stringify(view.cost)}`);
});

test("a learning run a follow-up opened again whose ledger row an earlier build wrote (its job the first round's figure) reads as this build's split once the server opens again: usd holds tools_usd, the follow-up is not learning, and the usage lines join to usd (#4050 review)", { timeout: 240_000 }, async (t) => {
  const first = await server(t, { learning: "on" });
  const CALL = 'Call monid__faux__person__enrich with {"body":{"name":"Ada"}}';
  const saved = await first.api("POST", "/agents", agent("again", { learning: true, tools: [ENRICH], tool_settings: allowed(ENRICH) }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const runId = await started(first.api, "again", CALL);
  await ended(first.api, runId);
  const sent = await first.api("POST", `/runs/${runId}/messages`, { content: CALL });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const now = (await ended(first.api, runId)).view;
  assert.equal(now.status, "completed", JSON.stringify(now.error));
  assert.equal(now.cost.tools_usd, 0.006, `both rounds' monid calls: ${JSON.stringify(now.cost)}`);
  await first.stop();
  // The row as a build before this split wrote it: the job its first round's figure, the follow-up and every end-of-run
  // turn its look-back; and no server of this build has opened the store.
  const db = await raw(join(first.data, "store.sqlite"), { timeout: 15_000 });
  const firstJob = JSON.parse((await db.get("SELECT proposal FROM learning_proposals WHERE run_id = ? AND round = 1", runId)).proposal).job_cost_usd;
  const rowUsd = (await db.get("SELECT cost_usd FROM runs WHERE id = ?", runId)).cost_usd;
  assert.ok(firstJob > 0 && firstJob < rowUsd, JSON.stringify({ firstJob, rowUsd }));
  await db.run("UPDATE learning_ledger SET job_usd = ?, look_back_usd = ? WHERE run_id = ?", firstJob, Math.round((rowUsd - firstJob) * 1e9) / 1e9, runId);
  if ((await db.all("SELECT name FROM pragma_table_info('store_meta')")).some((column) => column.name === "ledger_rerecorded")) await db.run("ALTER TABLE store_meta DROP COLUMN ledger_rerecorded");
  await db.run("UPDATE store_meta SET schema_version = 17 WHERE singleton = 1");
  await db.close();

  const { api } = await server(t, { learning: "on", data: first.data });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.ok(view.cost.tools_usd <= view.cost.usd, `tools_usd inside usd: ${JSON.stringify(view.cost)}`);
  assert.deepEqual([micro(view.cost.usd), micro(view.cost.learning_usd), micro(view.cost.followup_usd)], [micro(now.cost.usd), micro(now.cost.learning_usd), micro(now.cost.followup_usd)], `this build's split, as the run's end recorded it: ${JSON.stringify([view.cost, now.cost])}`);
  const usage = (await api("GET", `/runs/${runId}/usage`)).body;
  assert.equal(micro(usage.total.usd), micro(view.cost.usd), `the lines join to usd: ${JSON.stringify([usage.total, view.cost])}`);
});
