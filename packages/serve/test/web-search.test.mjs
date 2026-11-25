// web_search's providers, each answering `{query, results: [{url, title, published?, snippet}], text?}` or `{error}`:
// Parallel's Search API on the run's Parallel key where Parallel is picked, Exa's keyless MCP search, and pi's one
// request to its model provider's hosted search. Parallel, Exa and the provider are the tests' fakes
// (fixtures/faux-parallel.mjs, faux-exa.mjs, faux-upstream.mjs) and the network a table (fixtures/fake-network.mjs): no
// socket leaves this machine, and no real key is used. The providers themselves are @parcha/agentrun-web's (its
// web-search and exa-keyless tests); what stays here is serve's: its words, its paid booking and cap, and its runs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { bookedCapSpend } from "../dist/runner/metrics.js";
import { bookedIn } from "../dist/paid-calls.js";
import { parallelExtract, webFetch } from "./fixtures/serve-web.mjs";
import * as kernel from "@parcha/agentrun-kernel";
import * as web from "@parcha/agentrun-web";
import { PARALLEL_EXTRACT_USD, PARALLEL_SEARCH_URL, PARALLEL_SEARCH_USD, parallelSearched } from "@parcha/agentrun-web";
import * as keyless from "../dist/web-run.js";
import { hostedSearch } from "../dist/hosted-search.js";
import { runModels } from "../dist/model.js";
import { TOOLS } from "../dist/tools.js";
import { TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import fakeExa, { EXA_LIMIT_TEXT, resetFauxExa } from "./fixtures/faux-exa.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { FAUX, follow, journalOf, paidBookings, paidCallsOf, runDir, scratch, serve, toolLedger, withEnv } from "./support.mjs";

const searches = { ...web, ...(await import("../dist/web-search.js")) };
/** Parallel's search as the model reads it: parallelSearched's answer, its limit left to the breaker. */
const webSearch = async (args, parallel, signal) => (await parallelSearched(args, parallel, signal)).answer;
/** Web's keyless Exa search in serve's words for its free limit (keyless.RATE_LIMITED), as serve's search asks it. */
const exaSearch = (query, n, options = {}) => web.exaSearch(query, n, { words: { rateLimited: keyless.RATE_LIMITED }, ...options });

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
/** The cap's refusal of a paid call to Parallel, as the run's one ledger words it (the kernel cap's RunTools): what it could cost, what the run has spent
 *  of its cap (in cents; nothing held for steps still running, here), and the cap that would run it. */
const capRefusal = (what, price, basis, spent, cap, raise) => `spend_cap_reached: Not sent: this run has spent ${spent} of its ${cap} cap, and the next step, ${what}, could cost up to ${price} (${basis}). Raise the cap to at least ${raise} to continue.`;
/** A run's paid tool records, as its runner books them on the run's one ledger (support.mjs paidCallsOf): each mark and
 *  charge with its tool, call and figure. */
const paidRecords = paidCallsOf;
/** What the model and the timeline read when Exa's free limit holds after the one retry: our words, never Exa's. */
const RATE_LIMITED = "Free web search is rate-limited right now. Try again in a minute; add the free Parallel Search server in Settings → MCP servers and grant the agent its web_search; or add a Parallel key in Settings → API Keys to search with a key.";
/** Exa's own fix, in any of its words: an API key put in its MCP URL, which means nothing to a person here. */
const EXA_FIX = /exa\.ai|Fix:|MCP URL|exaApiKey|free MCP rate limit/;
const MODE = "AGENTRUN_TEST_FAUX_PARALLEL_SEARCH";
const EXTRACT_MODE = "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT";

/** Runs a test as a tool call does: inside a call whose requests to Parallel are booked on the run's one ledger (an
 *  uncapped RunTools), as paid-calls.ts requires (a request with none is refused unsent). */
const inCall = (fn) => async (t) => bookedIn({ call: "test-call", paid: await toolLedger() }, () => fn(t));
/** In millionths of a dollar, so a sum of prices reads as the price. */
const micro = (usd) => Math.round(usd * 1e6) / 1e6;

/** The fake Parallel answering as `mode` says (each test puts its variable back), and every request it was sent. */
function parallel(mode = "") {
  process.env[MODE] = mode;
  const sent = [];
  const send = async (url, init) => {
    sent.push({ url: String(url), key: new Headers(init.headers).get("x-api-key"), body: JSON.parse(init.body) });
    return fakeParallel(url, init);
  };
  return { sent, send };
}

test("an answer is held to the host's result bound: past it, the least relevant results are left out and counted (omitted); one within it is whole, followed by the line asking for citations", () => {
  const hit = (i, snippet) => ({ url: `https://s.example/${i}`, title: `Result ${i}`, snippet });
  const small = { provider: "parallel", query: "widgets", results: [hit(1, "One."), hit(2, "Two.")] };
  assert.equal(searches.searchText(small), `${JSON.stringify(small)}\n${searches.CITE}`);
  assert.equal(searches.searchText({ error: "no" }), '{"error":"no"}');
  const quoted = { provider: "parallel", query: "widgets", results: Array.from({ length: 25 }, (_, i) => hit(i, '"'.repeat(3_000))) };
  const text = searches.searchText(quoted);
  assert.ok(searches.SEARCH_MAX_CHARS < kernel.HOST_RESULT_MAX_CHARS, "under the host's result bound");
  assert.ok(text.length <= searches.SEARCH_MAX_CHARS, `${text.length} characters`);
  assert.ok(text.endsWith(`\n${searches.CITE}`));
  const kept = JSON.parse(text.slice(0, -searches.CITE.length - 1));
  assert.ok(kept.results.length > 10 && kept.results.length < 25, `${kept.results.length} kept`);
  assert.deepEqual(kept.results, quoted.results.slice(0, kept.results.length), "the most relevant, in order, each whole");
  assert.equal(kept.omitted, 25 - kept.results.length);
  assert.ok(text.length > searches.SEARCH_MAX_CHARS - 7_000, "as many as fit");
});

test("a call node's search is held to the same bound as the agent's: an answer past it comes back fitted, its least relevant results left out and counted (omitted)", async (t) => {
  withEnv(t, {}, [MODE]);
  process.env[MODE] = "long";
  const env = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "parallel" }), PARALLEL_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_PARALLEL: FAUX_PARALLEL };
  const answer = await TOOLS.web_search.effect({ query: "widgets", n: 25 }, { env, ledger: { call: "node-1", paid: await toolLedger() } });
  assert.equal(answer.provider, "parallel", JSON.stringify(answer).slice(0, 300));
  assert.ok(answer.omitted > 0 && answer.results.length + answer.omitted === 25, `${answer.results.length} kept, ${answer.omitted} omitted`);
  assert.ok(JSON.stringify(answer).length <= searches.SEARCH_MAX_CHARS, "within the bound");
  assert.deepEqual(answer, searches.fitSearch(answer), "fitted");
});

test("under a spend cap, a search through Parallel is a paid call on the run's one ledger: sent only when what the run spent and holds plus its price fits the cap, then booked at its price; else refused in the cap's words and never sent", async (t) => {
  withEnv(t, {}, [MODE]);
  const { sent, send } = parallel();
  const client = parallelExtract(CANARY, send);
  const charged = [];
  /** A search of `args` on a ledger under `cap` that has spent `spent`, and what it booked there. */
  const search = async (cap, spent, args = { query: "widgets", n: 2 }) => {
    const paid = await toolLedger(cap);
    if (spent) await paid.spend(spent);
    const answer = await bookedIn({ call: "c1", paid }, () => webSearch(args, client));
    if (micro(paid.spentUsd() - spent)) charged.push(micro(paid.spentUsd() - spent));
    assert.equal(paid.heldUsd(), 0, "nothing is left held");
    return answer;
  };
  // Parallel's fast search: $0.001 for up to 10 results, and $0.001 for each one past them.
  assert.equal((await search(0.0015, 0.0005)).provider, "parallel", "spent $0.0005, plus $0.001, is the cap: sent");
  // It has spent $0.00051: under a cent, never "$0".
  assert.deepEqual(await search(0.0015, 0.00051), { error: capRefusal("Parallel's search", "$0.001", "Parallel's list price for a fast search", "less than a cent", "$0.0015", "$0.01") });
  assert.deepEqual(await search(0.0155, 0, { query: "widgets", n: 25 }), { error: capRefusal("Parallel's search", "$0.016", "Parallel's list price for a fast search of 25 results", "$0", "$0.0155", "$0.02") }, "25 results: $0.001 and 15 more at $0.001");
  assert.equal((await search(0.016, 0, { query: "widgets", n: 25 })).results.length, 25);
  assert.deepEqual([sent.length, charged], [2, [0.001, 0.016]], "only the two that fit were sent, each booked at its price");
  assert.equal((await search(undefined, 0, { query: "widgets" })).provider, "parallel", "no cap: it just runs");
});

test("under a spend cap, a page read through Parallel's extract is a paid call on the run's one ledger: past the cap nothing is sent to Parallel, and the page is the guarded direct fetch, saying why", async (t) => {
  withEnv(t, {}, [EXTRACT_MODE]);
  const { sent, send } = parallel();
  const client = parallelExtract(CANARY, send);
  const fits = await toolLedger(0.001);
  const read = await bookedIn({ call: "c1", paid: fits }, () => webFetch("http://public.example/", { ...network(), parallel: client }));
  assert.deepEqual([read.via, fits.spentUsd()], ["parallel", 0.001], "$1 per 1,000 URLs: a URL is $0.001");
  const full = await toolLedger(0.001);
  await full.spend(0.0005);
  const web = network();
  const direct = await bookedIn({ call: "c2", paid: full }, () => webFetch("http://public.example/", { ...web, parallel: client }));
  assert.deepEqual([direct.via, direct.title, direct.parallel], ["direct", "Public page", capRefusal("Parallel's extract", "$0.001", "Parallel's list price for one URL", "less than a cent", "$0.001", "$0.01")]);
  assert.deepEqual([sent.length, full.spentUsd(), web.dialled], [1, 0.0005, ["http://public.example/"]], "Parallel was not asked; the host was");
});

test("a Parallel request whose settle cannot be written still answers, and the run's ledger keeps it at its hold: never less", async (t) => {
  withEnv(t, {}, [MODE]);
  const tools = await toolLedger(1);
  const paid = { admit: (request) => tools.admit(request), settle: async () => { throw new Error("the store is busy"); } };
  const { send } = parallel();
  const found = await bookedIn({ call: "c1", paid }, () => webSearch({ query: "widgets", n: 2 }, parallelExtract(CANARY, send)));
  assert.equal(found.provider, "parallel", "the search answers");
  assert.equal(tools.heldUsd(), PARALLEL_SEARCH_USD, "its hold at the price stands");
});

test("a request to Parallel with no run's ledger to book it on is never sent, nor one to an endpoint with no price here: a search answers the refusal, a page read is the guarded direct fetch saying so, and nothing reaches Parallel", async (t) => {
  withEnv(t, {}, [MODE, EXTRACT_MODE]);
  const { sent, send } = parallel();
  const client = parallelExtract(CANARY, send);
  // Outside any tool call: no ledger to book it on.
  assert.deepEqual(await webSearch({ query: "widgets" }, client), { error: "Parallel's search was not sent: this call has no run to book its price under." });
  const page = await webFetch("http://public.example/", { ...network(), parallel: client });
  assert.deepEqual([page.via, page.title, page.parallel], ["direct", "Public page", "Parallel's extract was not sent: this call has no run to book its price under."]);
  await assert.rejects(client.post(PARALLEL_SEARCH_URL, { search_queries: ["widgets"], mode: "fast" }), (error) => error.name === "PaidRefused" && /no run to book its price under/.test(error.message));
  // Inside one, an endpoint the web tools have no price for is not sent either.
  await inCall(async () => assert.rejects(client.post("https://api.parallel.ai/v1/tasks/runs", { input: "widgets" }), (error) => error.name === "PaidRefused" && /no price here/.test(error.message)))();
  assert.deepEqual(sent, [], "nothing reached Parallel");
});

// The API docs promise a row's tool_name is the tool its call ran: a paid call's cost row names that tool, never the
// fee's own name ("Parallel's search").
test("a pi run's cost rows for its search and page read through Parallel name the tool each call ran, web_search and web_fetch, and its call", { timeout: 60_000 }, async (t) => {
  await calls(t, true);
  withEnv(t, {}, [EXTRACT_MODE]);
  const { api } = await serve(t, { fauxParallel: FAUX_PARALLEL, fauxWeb: FAUX_WEB });
  const parallel = { web_search: { provider: "parallel" }, web_fetch: { provider: "parallel" } };
  assert.equal((await api("POST", "/agents", { definition: { id: "named", name: "named", instructions: "Research.", tools: ["web_search", "web_fetch", "write"], tool_settings: parallel } })).status, 201);
  const started = await api("POST", "/agents/named/runs", { input: { content: "Research widgets on the web and write report.md." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  const ids = Object.fromEntries(rows.filter((row) => row.kind === "tool_use").map((row) => [row.tool_name, row.tool_use_id]));
  assert.deepEqual(rows.filter((row) => row.kind === "phase" && row.summary.startsWith("Tool cost")).map((row) => [row.summary, row.tool_name, row.tool_use_id]), [
    ["Tool cost: parallel charged $0.0010 for web_search", "web_search", ids.web_search],
    ["Tool cost: parallel charged $0.0010 for web_fetch", "web_fetch", ids.web_fetch],
  ]);
});

// Each case below is capped ($1): a paid call's mark holds its price under a cap, the figure the cap keeps; an uncapped
// run's mark holds none, as it keeps no cap (run-cap.ts paidCalls).
test("a capped pi run's search and page read through Parallel are booked as its tool costs: each marked at its price before it is sent and settled after, a line of its own on the timeline, in the run's cost and under /usage's tools meter", { timeout: 60_000 }, async (t) => {
  const seen = await calls(t, true);
  withEnv(t, {}, [EXTRACT_MODE]);
  const { api, data } = await serve(t, { fauxParallel: FAUX_PARALLEL, fauxWeb: FAUX_WEB });
  const parallel = { web_search: { provider: "parallel" }, web_fetch: { provider: "parallel" } };
  assert.equal((await api("POST", "/agents", { definition: { id: "booked", name: "booked", instructions: "Research.", tools: ["web_search", "web_fetch", "write"], tool_settings: parallel } })).status, 201);
  const started = await api("POST", "/agents/booked/runs", { input: { content: "Research widgets on the web and write report.md." }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows } = await follow(api, runId, ["completed"]);
  assert.deepEqual((await seen()).map((call) => [call.path, call.authorized]), [["/v1/search", true], ["/v1/extract", true]]);
  const ids = Object.fromEntries(rows.filter((row) => row.kind === "tool_use").map((row) => [row.tool_name, row.tool_use_id]));
  assert.deepEqual(rows.filter((row) => row.kind === "phase" && row.summary.startsWith("Tool cost")).map((row) => [row.summary, row.tool_name, row.tool_use_id]), [
    ["Tool cost: parallel charged $0.0010 for web_search", "web_search", ids.web_search],
    ["Tool cost: parallel charged $0.0010 for web_fetch", "web_fetch", ids.web_fetch],
  ]);
  // Each mark holds its call at its price (heldUsd), the figure a cap, and a run's cost bound, read for a call a crash cut.
  assert.deepEqual([PARALLEL_SEARCH_USD, PARALLEL_EXTRACT_USD], [0.001, 0.001], "Parallel's published prices");
  assert.deepEqual(paidRecords(data, runId), [
    { kind: "agentrun.tool_started", tool: "Parallel's search", charged_by: "parallel", call: ids.web_search, heldUsd: PARALLEL_SEARCH_USD },
    { kind: "agentrun.tool_cost", tool: "Parallel's search", charged_by: "parallel", call: ids.web_search, usd: PARALLEL_SEARCH_USD },
    { kind: "agentrun.tool_started", tool: "Parallel's extract", charged_by: "parallel", call: ids.web_fetch, heldUsd: PARALLEL_EXTRACT_USD },
    { kind: "agentrun.tool_cost", tool: "Parallel's extract", charged_by: "parallel", call: ids.web_fetch, usd: PARALLEL_EXTRACT_USD },
  ]);
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, 0.002, "the faux model is $0: the run's cost is Parallel's two fees");
  // What the cap reads from the run's booking (runner/metrics.ts bookedCapSpend), as the next claim reads it.
  assert.equal(bookedCapSpend(journalOf(data, runId)), 0.002, "and what a restarted claim reads as spent, against its cap");
  const meters = (await api("GET", "/usage?group_by=meter")).body.lines.map((line) => [line.meter, line.usd, line.unpriced_runs]);
  assert.deepEqual(meters.find(([meter]) => meter === "tools"), ["tools", 0.002, 0]);
});

test("a capped workflow's call nodes are booked as an agent's calls are: its search and its page read through Parallel are marked and settled in its store, part of its cost, of /usage's tools meter and of what a restarted process reads as spent", { timeout: 60_000 }, async (t) => {
  const seen = await calls(t, true);
  withEnv(t, {}, [EXTRACT_MODE]);
  const { api, data } = await serve(t, { fauxParallel: FAUX_PARALLEL, fauxWeb: FAUX_WEB });
  const Search = { type: "object", required: ["query", "results"], properties: { query: { type: "string" }, results: { type: "array", minItems: 2, maxItems: 2 } } };
  const Page = { type: "object", required: ["via"], properties: { via: { const: "parallel" } } };
  const flow = { v: 2, name: "booked", schemas: { In: { type: "object", required: ["q"], properties: { q: { type: "string" } } }, Search, Page }, input: { schemaId: "In" }, output: { schemaId: "Search", path: "found" }, root: { node: "chain", steps: [
    { node: "call", label: "Search", via: "tool", tool: "web_search", args: { query: "{q}", n: 2 }, out: "Search", as: "found", deadline_s: 60 },
    { node: "call", label: "Read", via: "tool", tool: "web_fetch", args: { url: "http://public.example/" }, out: "Page", as: "page", deadline_s: 60 },
  ] } };
  const parallel = { web_search: { provider: "parallel" }, web_fetch: { provider: "parallel" } };
  assert.equal((await api("POST", "/agents", { definition: { id: "booked-flow", name: "booked-flow", workflow: flow, tools: ["web_search", "web_fetch"], tool_settings: parallel } })).status, 201);
  const run = await api("POST", "/agents/booked-flow/runs", { input: { q: "acme registry" }, max_cost_usd: 1 });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
  assert.deepEqual((await seen()).map((call) => [call.path, call.authorized]), [["/v1/search", true], ["/v1/extract", true]]);
  const paid = paidRecords(data, run.body.run_id);
  assert.deepEqual(paid.map((entry) => [entry.kind, entry.tool, entry.charged_by, entry.heldUsd ?? entry.usd]), [
    ["agentrun.tool_started", "Parallel's search", "parallel", PARALLEL_SEARCH_USD], ["agentrun.tool_cost", "Parallel's search", "parallel", PARALLEL_SEARCH_USD],
    ["agentrun.tool_started", "Parallel's extract", "parallel", PARALLEL_EXTRACT_USD], ["agentrun.tool_cost", "Parallel's extract", "parallel", PARALLEL_EXTRACT_USD],
  ]);
  assert.ok(paid[0].call && paid[0].call === paid[1].call && paid[2].call === paid[3].call && paid[0].call !== paid[2].call, `each call node's mark and charge name it: ${paid.map((entry) => entry.call)}`);
  assert.equal((await api("GET", `/runs/${run.body.run_id}`)).body.cost.usd, 0.002, "the run's cost is Parallel's two fees");
  assert.equal(bookedCapSpend(journalOf(data, run.body.run_id)), 0.002, "what a restarted claim reads as spent, against its cap");
  const meters = (await api("GET", "/usage?group_by=meter")).body.lines.map((line) => [line.meter, line.usd, line.unpriced_runs]);
  assert.deepEqual(meters.find(([meter]) => meter === "tools"), ["tools", 0.002, 0]);
});

test("a capped pi run's search through Parallel that its cap cannot hold is refused before it is sent, in the cap's words: nothing reaches Parallel and nothing is booked", { timeout: 60_000 }, async (t) => {
  const seen = await calls(t, true);
  const { api, data } = await serve(t, { fauxParallel: FAUX_PARALLEL });
  assert.equal((await api("POST", "/agents", { definition: { id: "capped", name: "capped", instructions: "Search.", tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } } })).status, 201);
  const started = await api("POST", "/agents/capped/runs", { input: { content: "Search the web for widgets delaware" }, max_cost_usd: 0.0009 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  // Refused for room, the run pauses at its cap (paid-pause.test.mjs), the search's figures its pending ones.
  const { rows } = await follow(api, started.body.run_id, ["input_required", "completed"]);
  const paused = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.deepEqual([paused.status, paused.state, paused.pending?.kind, paused.pending?.needs_usd], ["input_required", "waiting", "budget", 0.001], JSON.stringify(paused));
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === "web_search");
  assert.deepEqual([result.tool_status, result.tool_result_preview], ["failed", JSON.stringify({ error: capRefusal("Parallel's search", "$0.001", "Parallel's list price for a fast search", "$0", "$0.0009", "$0.01") })]);
  assert.deepEqual(await seen(), [], "no request reached Parallel");
  assert.deepEqual(paidRecords(data, started.body.run_id), [], "nothing marked or charged");
});

/** The server's environment for test `t`, Parallel's key when `key`, and the fake Parallel's calls as each answer gives them back. */
async function calls(t, key) {
  const file = join(await scratch(t), "parallel.jsonl");
  withEnv(t, { ...(key ? { PARALLEL_API_KEY: CANARY } : {}), AGENTRUN_TEST_FAUX_PARALLEL_CALLS: file }, ["PARALLEL_API_KEY", MODE]);
  return async () => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("Parallel picked with no Parallel key: web_search is missing in capabilities, an agent naming it saves with a warning, and its run is refused, 409", async (t) => {
  const seen = await calls(t, false);
  const { api } = await serve(t, { fauxParallel: FAUX_PARALLEL });
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "parallel" } })).status, 200);
  const tool = (await api("GET", "/capabilities")).body.tools.find((entry) => entry.name === "web_search");
  assert.deepEqual([tool.available, tool.missing, tool.nodes, tool.calls], [false, ["PARALLEL_API_KEY"], true, true]);
  const saved = await api("POST", "/agents", { definition: { id: "searcher", name: "searcher", instructions: "Search.", tools: ["web_search"] } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => [w.field, w.reason]), [["definition.tools[0]", "not_set_up_here"]]);
  assert.match(saved.body.warnings[0].message, /The\ tool\ web_search\ does\ not\ run\ here\ on\ pi:\ parallel\ is\ picked,\ and\ it\ needs\ a\ Parallel\ key:\ save\ one\ in\ Settings\ →\ API\ Keys\ \(or\ set\ PARALLEL_API_KEY\ where\ the\ server\ starts\)\./);
  const refused = await api("POST", "/agents/searcher/runs", { input: { content: "Search the web for widgets" } });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.missing], [409, "agent_not_runnable", { web_search: ["PARALLEL_API_KEY"] }]);
  assert.deepEqual(await seen(), [], "no request reached Parallel");
});

test("with the key and Parallel picked by the agent, web_search runs on pi: an agent's call and a workflow's call node search through Parallel on the key the server handed the run", { timeout: 60_000 }, async (t) => {
  const seen = await calls(t, true);
  const { api } = await serve(t, { fauxParallel: FAUX_PARALLEL });
  const parallel = { web_search: { provider: "parallel" } };
  assert.equal((await api("POST", "/agents", { definition: { id: "searcher", name: "searcher", instructions: "Search.", tools: ["web_search"], tool_settings: parallel } })).status, 201);
  const started = await api("POST", "/agents/searcher/runs", { input: { content: "Search the web for widgets delaware" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  const results = rows.filter((row) => row.kind === "tool_result").map((row) => row.tool_result_preview);
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.match(results[0], /^\{"provider":"parallel","query":"widgets delaware","results":\[\{"url":"https:\/\/registry\.example\/widgets"/);
  const Search = { type: "object", required: ["query", "results"], properties: { query: { type: "string" }, results: { type: "array", minItems: 2, maxItems: 2 } } };
  const flow = { v: 2, name: "search", schemas: { In: { type: "object", required: ["q"], properties: { q: { type: "string" } } }, Search }, input: { schemaId: "In" }, output: { schemaId: "Search", path: "found" }, root: { node: "chain", steps: [{ node: "call", label: "Search", via: "tool", tool: "web_search", args: { query: "{q}", n: 2 }, out: "Search", as: "found", deadline_s: 60 }] } };
  assert.equal((await api("POST", "/agents", { definition: { id: "flow", name: "flow", workflow: flow, tools: ["web_search"], tool_settings: parallel } })).status, 201);
  const run = await api("POST", "/agents/flow/runs", { input: { q: "acme registry" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
  const output = (await api("GET", `/runs/${run.body.run_id}`)).body.result.output;
  assert.deepEqual([output.query, output.results.map((r) => r.url)], ["acme registry", ["https://registry.example/widgets", "https://result.example/2"]]);
  assert.deepEqual((await seen()).map((call) => [call.path, call.authorized, call.queries]), [["/v1/search", true, ["widgets delaware"]], ["/v1/search", true, ["acme registry"]]]);
});

test("keyless Exa: one MCP exchange with no key, its text read into results; a 429 naming a wait past 5 s is our words at once, a 403 the connection, an error our words quoting Exa's; none is tried again", async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_EXA"]);
  const sent = [];
  const send = async (url, init) => {
    const headers = new Headers(init.headers);
    sent.push([JSON.parse(init.body).method, headers.has("x-api-key") || headers.has("authorization")]);
    return fakeExa(url, init);
  };
  const found = await exaSearch("widgets", 3, { send });
  assert.deepEqual(sent, [["initialize", false], ["notifications/initialized", false], ["tools/call", false]]);
  assert.deepEqual(found, { provider: "exa-keyless", query: "widgets", results: [
    { url: "http://public.example/", title: "Public page", snippet: "The answer is forty-two. See the registry for more.", published: "2026-10-01T00:00:00.000Z" },
    { url: "https://result.example/2", title: "Result 2 for widgets", snippet: "Excerpt 2." },
    { url: "https://result.example/3", title: "Result 3 for widgets", snippet: "Excerpt 3." },
  ] }, "the note before the first result is no result, N/A is no date, a link is its text");
  const asked = [];
  await exaSearch("widgets", 25, { send: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "tools/call") asked.push(body.params.arguments);
    return fakeExa(url, init);
  } });
  assert.deepEqual(asked, [{ query: "widgets", numResults: 8 }], "at most 8 results asked of Exa");
  // The 429 names Retry-After 30: the limit does not lift within a search, so it is not tried again. Each refusal says
  // which limit it met (limit), for the caller's fallback; the model never reads that field (searchFor drops it).
  for (const [mode, error, limit] of [["429", /^Free web search is rate-limited right now\. Try again in a minute; add the free Parallel Search server in Settings → MCP servers and grant the agent its web_search; or add a Parallel key in Settings → API Keys to search with a key\.$/, { limit: "rate_limited", retryAfterS: 30 }], ["403", /refused keyless use from this connection \(403\).*only over IPv4.*not over IPv6 or through a proxy/, { limit: "connection_refused" }], ["500", /^Exa's MCP endpoint answered 500 to the search$/, {}]]) {
    sent.length = 0;
    process.env.AGENTRUN_TEST_FAUX_EXA = mode;
    resetFauxExa();
    const answer = await exaSearch("widgets", 3, { send, pause: async () => assert.fail(`${mode}: waited to try again`) });
    assert.match(answer.error, error, mode);
    assert.deepEqual(Object.fromEntries(Object.entries(answer).filter(([key]) => key !== "error")), limit, mode);
    assert.doesNotMatch(JSON.stringify(answer), EXA_FIX, `${mode}: none of Exa's fix`);
    assert.deepEqual(sent.map(([method]) => method), ["initialize", "notifications/initialized", "tools/call"], `${mode}: asked once, not again`);
  }
  const failing = async (url, init) => {
    const { method, id } = JSON.parse(init.body);
    if (method !== "tools/call") return fakeExa(url, init);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "the query is empty" }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  delete process.env.AGENTRUN_TEST_FAUX_EXA;
  assert.deepEqual(await exaSearch("widgets", 3, { send: failing }), { error: 'Free web search failed. Exa said: "the query is empty"' }, "a JSON answer is read as well as a stream");
});

test("keyless Exa past its free limit (a 429, or Exa's own notice in a 200): tried once more after a short jittered wait, Retry-After's where it names 5 s or less; then our words, never Exa's fix", async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_EXA"]);
  /** One search with Exa answering as `mode` says: its answer, the waits it chose, and how many searches Exa was sent. */
  const search = async (mode, signal) => {
    process.env.AGENTRUN_TEST_FAUX_EXA = mode;
    resetFauxExa();
    const waits = [];
    const methods = [];
    const send = async (url, init) => {
      methods.push(JSON.parse(init.body).method);
      return fakeExa(url, init);
    };
    const answer = await exaSearch("widgets", 2, { send, ...(signal ? { signal } : { pause: async (ms) => void waits.push(ms) }) });
    return { answer, waits, searches: methods.filter((method) => method === "tools/call").length, exchanges: methods.filter((method) => method === "initialize").length };
  };
  const results = [{ url: "http://public.example/", title: "Public page", snippet: "The answer is forty-two. See the registry for more.", published: "2026-10-01T00:00:00.000Z" }, { url: "https://result.example/2", title: "Result 2 for widgets", snippet: "Excerpt 2." }];

  // A 429 naming 2 s, then results: the retry's results, after the 2 s Exa named and under half a second more.
  const retried = await search("429:2,ok");
  assert.deepEqual(retried.answer, { provider: "exa-keyless", query: "widgets", results });
  assert.deepEqual([retried.searches, retried.exchanges, retried.waits.length], [2, 2, 1], "one more exchange, after one wait");
  assert.ok(retried.waits[0] >= 2_000 && retried.waits[0] < 2_500, `waited ${retried.waits[0]} ms`);
  // Exa's own notice of its free limit inside a 200 (isError, marked ai.exa/rateLimited), as a real run met it: no
  // Retry-After, so the wait is 1 to 3 s.
  const notice = await search("limited,ok");
  assert.deepEqual([notice.answer, notice.searches], [{ provider: "exa-keyless", query: "widgets", results }, 2]);
  assert.ok(notice.waits.length === 1 && notice.waits[0] >= 1_000 && notice.waits[0] < 3_000, `waited ${notice.waits} ms`);

  // Past the limit twice, either way: our words, tried twice and no more, none of Exa's text.
  for (const [mode, limit] of [["429:1", { retryAfterS: 1 }], ["limited", {}]]) {
    const twice = await search(mode);
    assert.deepEqual(twice.answer, { error: RATE_LIMITED, limit: "rate_limited", ...limit }, mode);
    assert.equal(twice.searches, 2, `${mode}: sent twice`);
    assert.doesNotMatch(JSON.stringify(twice.answer), EXA_FIX, `${mode}: none of Exa's fix`);
    assert.ok(EXA_FIX.test(EXA_LIMIT_TEXT), "the fake answers Exa's own fix text");
  }
  // A wait past 5 s (Exa's daily limit names hours): not tried again.
  const daily = await search("429:3600,ok");
  assert.deepEqual([daily.answer.error, daily.searches, daily.waits], [RATE_LIMITED, 1, []]);

  // A search stopped while it waits ends then, stopped: it neither sleeps on nor searches again.
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  const started = Date.now();
  const stopped = await search("limited", stop.signal);
  assert.deepEqual([stopped.answer, stopped.searches], [{ error: "the search was stopped" }, 1]);
  assert.ok(Date.now() - started < 900, `ended ${Date.now() - started} ms after it started, inside the shortest wait`);
});

test("pi's hosted search: Anthropic's pause_turn answers the results it has and no text, sent once; a model with no hosted search is an error, sent nowhere", async (t) => {
  const file = join(await scratch(t), "upstream.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_UPSTREAM: "pause", AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: file });
  const env = { AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_UPSTREAM: new URL("./fixtures/faux-upstream.mjs", import.meta.url).pathname, ANTHROPIC_API_KEY: "not-a-secret" };
  const { models } = await runModels(env, undefined);
  assert.deepEqual(await hostedSearch("widgets", 5, "anthropic/claude-sonnet-5-5", undefined, models), { provider: "native", query: "widgets", results: [{ url: "http://public.example/", title: "Public page", snippet: "", published: "October 1, 2026" }, { url: "https://result.example/2", title: "Result 2", snippet: "" }] });
  assert.match((await hostedSearch("widgets", 5, "faux/faux-1", undefined, models)).error, /has no hosted web search here/);
  assert.match((await hostedSearch("widgets", 5, "anthropic/no-such-model", undefined, models)).error, /no model to search on/);
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1, "one request, the paused one, not resubmitted");
});

// Capped ($1), as the booked cases above are: the call's mark holds its price under a cap.
test("a capped run cancelled while its search through Parallel is under way still settles the call: its charge is booked, so the run's cost stays known", { timeout: 90_000 }, async (t) => {
  const seen = await calls(t, true);
  // The faux Parallel answers the search after 2 s, so the cancel lands while the call is under way.
  withEnv(t, { [MODE]: "slow:2000" }, [MODE, EXTRACT_MODE]);
  const { api, data } = await serve(t, { fauxParallel: FAUX_PARALLEL, fauxWeb: FAUX_WEB });
  assert.equal((await api("POST", "/agents", { definition: { id: "stopped", name: "stopped", instructions: "Research.", tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } } })).status, 201);
  const started = await api("POST", "/agents/stopped/runs", { input: { content: "Search the web for widgets" }, max_cost_usd: 1 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  for (const end = Date.now() + 30_000; !(await seen()).some((call) => call.path === "/v1/search"); ) {
    assert.ok(Date.now() < end, "the search reached Parallel");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(api, runId, ["cancelled", "failed", "completed"], { deadlineMs: 60_000 });
  let paid = [];
  for (const end = Date.now() + 15_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) {
    paid = paidRecords(data, runId);
    if (paid.some((entry) => entry.kind === "agentrun.tool_cost")) break;
  }
  assert.deepEqual(paid.map((entry) => [entry.kind, entry.tool, entry.heldUsd ?? entry.usd]), [
    ["agentrun.tool_started", "Parallel's search", PARALLEL_SEARCH_USD],
    ["agentrun.tool_cost", "Parallel's search", PARALLEL_SEARCH_USD],
  ], "the call was marked, and settled though its turn was stopped");
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, PARALLEL_SEARCH_USD, "the run's cost is the search's fee, never unknown");
});

// Moved from cap-models.test.mjs, onto the run's one ledger: the search's hold is the run's RunTools step, and the model
// request beside it is judged by the same run's rule (kernel runCap.before).
/** A model at $1 a million input tokens, its output free: 1,000 tokens in is $0.001. */
const DOLLAR_MODEL = { id: "m", api: "anthropic", price: { input: 1, output: 0 }, outputCeiling: 100 };

test("a Parallel search under way holds its fee on the run's ledger: a model request beside it that fits only without it waits, and goes once the search answered and charged nothing", async (t) => {
  // A request of 1,000 tokens in is $0.001, and a fast search is held at its $0.001: a $0.0015 cap holds one of the two,
  // never both.
  withEnv(t, { AGENTRUN_TEST_FAUX_PARALLEL_SEARCH: "422" }, ["AGENTRUN_TEST_FAUX_PARALLEL_SEARCH"]);
  const paid = await toolLedger(0.0015, { model: DOLLAR_MODEL });
  let arrived, release;
  const reached = new Promise((resolve) => (arrived = resolve));
  const held = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const send = async (url, init) => (arrived(), await held, fakeParallel(url, init));
  const search = bookedIn({ call: "c1", paid }, () => webSearch({ query: "widgets", n: 2 }, parallelExtract(CANARY, send)));
  await reached;
  // It fits once the search's hold settles (the cap's wait for room): it waits for it, neither sent nor refused.
  let answered = false;
  const beside = paid.modelRequest(1_000).then((verdict) => ((answered = true), verdict));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(answered, false, "the model request waits while the search is under way");
  assert.ok(Math.abs(paid.heldUsd() - PARALLEL_SEARCH_USD) < 1e-12, `the search held at its fee: ${paid.heldUsd()}`);
  // Parallel refused the search (422): it charged nothing, and its hold is gone.
  release();
  assert.deepEqual(await search, { error: "Parallel's search answered 422" });
  assert.deepEqual(paidBookings(await paid.records()).map((row) => [row.kind, row.heldUsd ?? row.usd]), [["agentrun.tool_started", PARALLEL_SEARCH_USD], ["agentrun.tool_cost", 0]]);
  const admitted = await beside;
  assert.ok(admitted && !("refuse" in admitted), `with the search's hold settled at $0, the request that waited goes: ${JSON.stringify(admitted)}`);
});

test("a template eval's web fake: a native plane turns to the run's own web_search, a search takes the first matching answer at the call's n, and a page fails in the guarded fetch's own words", async () => {
  const { fakedPlane, fakeFetch, fakeSearch } = await import("../dist/web-fake.js");
  // Claude's and Codex's own search answer in place of the run's web_search where the plane says native (adapters.ts
  // nativeOptions): a faked run's plane never does, and leaves every other tool's pick as it was.
  assert.deepEqual(fakedPlane({ web_search: "native", web_fetch: "parallel" }), { web_search: "firecrawl-keyless", web_fetch: "parallel" });
  assert.deepEqual(fakedPlane({ web_search: "parallel" }), { web_search: "parallel" });
  assert.equal(fakedPlane(undefined), undefined);
  assert.deepEqual(fakeSearch("unavailable", { query: "anything" }, "exa-keyless"), { error: keyless.RATE_LIMITED });
  assert.deepEqual(fakeSearch("unavailable", {}, "exa-keyless"), { error: "web_search needs a query" });
  const hit = (i) => ({ url: `https://example.com/${i}`, title: `Hit ${i}`, snippet: `snippet ${i}` });
  const fixture = {
    search: { answers: [{ query: "^robots? funding", results: [hit(1), hit(2), hit(3)] }, { query: "funding", error: "Parallel's search answered 503" }], default: { results: [] } },
    fetch: { answers: [{ url: "https://example.com/empty", status: 204, text: "" }], default: { error: "fetch failed" } },
  };
  assert.deepEqual(fakeSearch(fixture, { query: "Robot funding this week", n: 2 }, "parallel"), { provider: "parallel", query: "Robot funding this week", results: [hit(1), hit(2)] }, "the first answer whose query matches, case-insensitive, cut at n");
  assert.deepEqual(fakeSearch(fixture, { query: "seed funding" }, "native"), { error: "Parallel's search answered 503" }, "the next answer when the first does not match");
  assert.deepEqual(fakeSearch(fixture, { query: "weather" }, "native"), { provider: "native", query: "weather", results: [] }, "else the default");
  const refused = await fakeFetch("unavailable", "https://example.com/post");
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "fetch failed", "as a fetch whose connection is refused fails");
  const empty = await fakeFetch(fixture, "https://example.com/empty");
  assert.equal(empty.ok, true, `a status with no body is still a page: ${JSON.stringify(empty)}`);
  const local = await fakeFetch(fixture, "http://127.0.0.1/admin");
  assert.equal(local.ok, false, "the guard's own checks run on a faked fetch too");
});

test("a template eval's faked JSON page lists the URLs its body holds, as the same body fetched live does", async () => {
  const { fakeFetch } = await import("../dist/web-fake.js");
  const url = "https://www.githubstatus.com/api/v2/incidents.json";
  const fixture = { search: { answers: [], default: { results: [] } }, fetch: { answers: [{ url, text: JSON.stringify({ incidents: [{ name: "Degraded Actions", shortlink: "https://stspg.io/abc" }] }) }], default: { error: "fetch failed" } } };
  const page = await fakeFetch(fixture, url);
  assert.deepEqual([page.ok, page.links], [true, ["https://stspg.io/abc"]], JSON.stringify(page));
});
