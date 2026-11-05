// web_search's providers, each answering `{query, results: [{url, title, published?, snippet}], text?}` or `{error}`:
// Parallel's Search API on the run's Parallel key where Parallel is picked, Exa's keyless MCP search, and pi's one
// request to its model provider's hosted search. Parallel, Exa and the provider are the tests' fakes
// (fixtures/faux-parallel.mjs, faux-exa.mjs, faux-upstream.mjs) and the network a table (fixtures/fake-network.mjs): no
// socket leaves this machine (Exa's IPv4 pin dials a loopback server), and no real key is used.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { spentIn, useSpend } from "../dist/cap.js";
import { bookedIn, PARALLEL_EXTRACT_USD, PARALLEL_SEARCH_USD } from "../dist/paid-calls.js";
import { parallelExtract, webFetch } from "../dist/web-fetch.js";
import * as kernel from "@parcha/agentrun-kernel";
import * as searches from "../dist/web-search.js";
import { PARALLEL_SEARCH_URL, webSearch } from "../dist/web-search.js";
import { exaSearch } from "../dist/exa-keyless.js";
import * as keyless from "../dist/exa-keyless.js";
import { hostedSearch } from "../dist/hosted-search.js";
import { runModels } from "../dist/model.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import fakeExa, { EXA_LIMIT_TEXT, resetFauxExa } from "./fixtures/faux-exa.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { FAUX, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
/** The cap's refusal of a paid call to Parallel, as cap.ts' paidCall words it, its amounts as written: what it could cost,
 *  what the run has spent of its cap (nothing held for calls still answering here), and the cap that would run it. */
const capRefusal = (what, price, basis, spent, cap, raise) => `spend_cap_reached: Not sent: the run has spent ${spent} of its ${cap} cap, and ${what} could cost up to ${price} (${basis}). Raise the cap to at least ${raise} to run it.`;
/** A run's paid tool records, from its store: each mark and charge with its tool, call and figure. */
function paidRecords(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind.startsWith("agentrun.tool_")).map((entry) => ({ kind: entry.kind, ...entry.data }));
  } finally {
    db.close();
  }
}
/** What the model and the timeline read when Exa's free limit holds after the one retry: our words, never Exa's. */
const RATE_LIMITED = "Free web search is rate-limited right now. Try again in a minute, or add a Parallel key in Settings → Tool keys to search with a key.";
/** Exa's own fix, in any of its words: an API key put in its MCP URL, which means nothing to a person here. */
const EXA_FIX = /exa\.ai|Fix:|MCP URL|exaApiKey|free MCP rate limit/;
const MODE = "AGENTRUN_TEST_FAUX_PARALLEL_SEARCH";
const EXTRACT_MODE = "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT";

/** Runs a test as a tool call does: inside a call its requests to Parallel are booked under, as paid-calls.ts requires
 *  (a request outside one is refused unsent). */
const inCall = (fn) => (t) => bookedIn({ call: "test-call", record: async () => undefined }, () => fn(t));

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

test("results are mapped and clipped into the one search shape: excerpts joined into one snippet of at most 3,000 characters, links as their text, published only where Parallel dates a page", inCall(async (t) => {
  withEnv(t, {}, [MODE]);
  const { sent, send } = parallel();
  const answer = await webSearch({ query: "  widgets delaware ", n: 3 }, parallelExtract(CANARY, send));
  assert.deepEqual(sent, [{ url: PARALLEL_SEARCH_URL, key: CANARY, body: { objective: "widgets delaware", search_queries: ["widgets delaware"], mode: "fast", advanced_settings: { max_results: 3, excerpt_settings: { max_chars_per_result: 3_000 } } } }]);
  assert.deepEqual([answer.provider, answer.query, Object.keys(answer)], ["parallel", "widgets delaware", ["provider", "query", "results"]]);
  const [first, ...rest] = answer.results;
  assert.deepEqual(Object.entries({ ...first, snippet: "" }), Object.entries({ url: "https://registry.example/widgets", title: "", snippet: "", published: "2026-10-01" }), "a null title is empty");
  assert.match(first.snippet, /^See the registry entry for Widgets, Inc\. … Widgets are registered in Delaware/, "the excerpts joined, the link its text, whitespace collapsed");
  assert.ok(first.snippet.length <= 3_000 && first.snippet.length > 2_900 && first.snippet.endsWith("…"), `clipped on a word: ${first.snippet.length}`);
  assert.deepEqual(rest, [2, 3].map((i) => ({ url: `https://result.example/${i}`, title: `Result ${i} for widgets delaware`, snippet: `Excerpt ${i}.` })), "no published where Parallel gives no date");
  const long = await webSearch({ query: "q".repeat(300) }, parallelExtract(CANARY, send));
  assert.equal(long.query, "q".repeat(200), "the query is cut at 200 characters");
  assert.deepEqual(await webSearch({ query: "  " }, parallelExtract(CANARY, send)), { error: "web_search needs a query" });
  assert.equal(sent.length, 2, "an empty query is not sent");
}));

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

test("n is 1 to 25, 10 when it is not a number above zero", inCall(async (t) => {
  withEnv(t, {}, [MODE]);
  for (const [n, asked] of [[undefined, 10], [0, 10], ["many", 10], [-3, 1], [0.5, 1], [2.7, 2], ["7", 7], [25, 25], [99, 25]]) {
    const { sent, send } = parallel();
    const answer = await webSearch({ query: "widgets", n }, parallelExtract(CANARY, send));
    assert.deepEqual([sent[0].body.advanced_settings.max_results, answer.results.length], [asked, asked], String(n));
  }
}));

test("a 5xx, a timeout or a request that fails answers {error}, and Parallel is asked again next time: there is nothing else to search", inCall(async (t) => {
  withEnv(t, {}, [MODE]);
  const failing = (error) => async () => { throw error; };
  for (const [mode, error] of [["500", /^Parallel's search answered 500$/], ["503", /^Parallel's search answered 503$/], ["timeout", /did not answer within 60 s/], ["reset", /^Parallel's search failed: socket hang up$/]]) {
    const { sent, send } = parallel(/^\d+$/.test(mode) ? mode : "");
    const thrown = { timeout: new DOMException("The operation timed out.", "TimeoutError"), reset: new Error("socket hang up") }[mode];
    const client = parallelExtract(CANARY, thrown ? failing(thrown) : send);
    const answer = await webSearch({ query: "widgets" }, client);
    assert.deepEqual(Object.keys(answer), ["error"], mode);
    assert.match(answer.error, error, mode);
    assert.equal(sent.length, thrown ? 0 : 1, mode);
    assert.equal(client.live(), true, `${mode} is not the key refused`);
  }
}));

test("a 401 or 403 stops Parallel for the rest of the run, for both web tools: neither asks it again", inCall(async (t) => {
  withEnv(t, {}, [MODE, EXTRACT_MODE]);
  for (const [key, mode] of [["not-the-key", ""], [CANARY, "403"]]) {
    const { sent, send } = parallel(mode);
    const client = parallelExtract(key, send);
    const answers = [await webSearch({ query: "widgets" }, client), await webSearch({ query: "widgets" }, client)];
    assert.deepEqual(answers.map((a) => Object.keys(a)), [["error"], ["error"]]);
    assert.match(answers[1].error, /refused this run's key/, mode || "401");
    assert.equal((await webFetch("http://public.example/", { ...network(), parallel: client })).via, "direct", "web_fetch goes straight to the direct fetch");
    assert.deepEqual(sent.map((call) => new URL(call.url).pathname), ["/v1/search"], `${mode || "401"}: Parallel was asked once`);
  }
  // And a refusal to web_fetch's extract stops web_search.
  const { sent, send } = parallel();
  const client = parallelExtract("not-the-key", send);
  await webFetch("http://public.example/", { ...network(), parallel: client });
  assert.match((await webSearch({ query: "widgets" }, client)).error, /refused this run's key/);
  assert.deepEqual(sent.map((call) => new URL(call.url).pathname), ["/v1/extract"]);
}));

test("under a spend cap, a search through Parallel is a paid call: sent only when what the run spent and holds plus its price fits the cap, then counted; else refused in the cap's words and never sent", inCall(async (t) => {
  withEnv(t, {}, [MODE]);
  t.after(() => useSpend(undefined));
  const { sent, send } = parallel();
  const client = parallelExtract(CANARY, send);
  const added = [];
  const capped = (cap, spent) => useSpend({ cap, spent: () => spent, add: (usd) => added.push(usd) });
  // Parallel's fast search: $0.001 for up to 10 results, and $0.001 for each one past them.
  capped(0.0015, 0.0005);
  assert.equal((await webSearch({ query: "widgets", n: 2 }, client)).provider, "parallel", "spent and held $0.0005, plus $0.001, is the cap: sent");
  capped(0.0015, 0.00051);
  assert.deepEqual(await webSearch({ query: "widgets", n: 2 }, client), { error: capRefusal("Parallel's search", "$0.001", "Parallel's list price for a fast search", "$0.00051", "$0.0015", "$0.01") });
  capped(0.0155, 0);
  assert.deepEqual(await webSearch({ query: "widgets", n: 25 }, client), { error: capRefusal("Parallel's search", "$0.016", "Parallel's list price for a fast search of 25 results", "$0", "$0.0155", "$0.02") }, "25 results: $0.001 and 15 more at $0.001");
  capped(0.016, 0);
  assert.equal((await webSearch({ query: "widgets", n: 25 }, client)).results.length, 25);
  capped(1, null);
  assert.match((await webSearch({ query: "widgets" }, client)).error, /^spend_cap_reached: Parallel's search was not sent\. What the run has spent is unknown/);
  assert.deepEqual([sent.length, added], [2, [0.001, 0.016]], "only the two that fit were sent, each counted at its price");
  useSpend(undefined);
  assert.equal((await webSearch({ query: "widgets" }, client)).provider, "parallel", "no cap: it just runs");
}));

test("under a spend cap, a page read through Parallel's extract is a paid call: past the cap nothing is sent to Parallel, and the page is the guarded direct fetch, saying why", inCall(async (t) => {
  withEnv(t, {}, [EXTRACT_MODE]);
  t.after(() => useSpend(undefined));
  const { sent, send } = parallel();
  const client = parallelExtract(CANARY, send);
  const added = [];
  useSpend({ cap: 0.001, spent: () => 0, add: (usd) => added.push(usd) });
  const read = await webFetch("http://public.example/", { ...network(), parallel: client });
  assert.deepEqual([read.via, added], ["parallel", [0.001]], "$1 per 1,000 URLs: a URL is $0.001");
  useSpend({ cap: 0.001, spent: () => 0.0005, add: (usd) => added.push(usd) });
  const web = network();
  const direct = await webFetch("http://public.example/", { ...web, parallel: client });
  assert.deepEqual([direct.via, direct.title, direct.parallel], ["direct", "Public page", capRefusal("Parallel's extract", "$0.001", "Parallel's list price for one URL", "$0.0005", "$0.001", "$0.01")]);
  assert.deepEqual([sent.length, added, web.dialled], [1, [0.001], ["http://public.example/"]], "Parallel was not asked; the host was");
}));

test("a Parallel request whose settle record cannot be written still answers, and the run's process counts its price as spent: its mark stands", async (t) => {
  withEnv(t, {}, [MODE]);
  t.after(() => useSpend(undefined));
  const added = [];
  useSpend({ cap: 1, spent: () => 0, add: (usd) => added.push(usd) });
  const written = [];
  const ledger = { call: "c1", record: async (kind, data) => { if (kind === "agentrun.tool_cost") throw new Error("the store is busy"); written.push([kind, data.heldUsd]); } };
  const { send } = parallel();
  const found = await bookedIn(ledger, () => webSearch({ query: "widgets", n: 2 }, parallelExtract(CANARY, send)));
  assert.equal(found.provider, "parallel", "the search answers");
  assert.deepEqual([written, added], [[["agentrun.tool_started", PARALLEL_SEARCH_USD]], [PARALLEL_SEARCH_USD]], "its mark at the price stands, and the process counts the price");
});

test("a request to Parallel with no call to book it under is never sent, nor one to an endpoint with no price here: a search answers the refusal, a page read is the guarded direct fetch saying so, and nothing reaches Parallel", async (t) => {
  withEnv(t, {}, [MODE, EXTRACT_MODE]);
  const { sent, send } = parallel();
  const client = parallelExtract(CANARY, send);
  // Outside any tool call: nothing to book it under.
  assert.deepEqual(await webSearch({ query: "widgets" }, client), { error: "Parallel's search was not sent: this request has no call to book it under" });
  const page = await webFetch("http://public.example/", { ...network(), parallel: client });
  assert.deepEqual([page.via, page.title, page.parallel], ["direct", "Public page", "Parallel's extract was not sent: this request has no call to book it under"]);
  await assert.rejects(client.post(PARALLEL_SEARCH_URL, { search_queries: ["widgets"] }), (error) => error.name === "PaidRefused" && /no call to book it under/.test(error.message));
  // Inside one, an endpoint the web tools have no price for is not sent either.
  await inCall(async () => assert.rejects(client.post("https://api.parallel.ai/v1/tasks/runs", { input: "widgets" }), (error) => error.name === "PaidRefused" && /no price here/.test(error.message)))();
  assert.deepEqual(sent, [], "nothing reached Parallel");
});

test("a pi run's search and page read through Parallel are booked as its tool costs: each marked at its price before it is sent and settled after, a line of its own on the timeline, in the run's cost and under /usage's tools meter", { timeout: 60_000 }, async (t) => {
  const seen = await calls(t, true);
  withEnv(t, {}, [EXTRACT_MODE]);
  const { api, data } = await serve(t, { fauxParallel: FAUX_PARALLEL, fauxWeb: FAUX_WEB });
  const parallel = { web_search: { provider: "parallel" }, web_fetch: { provider: "parallel" } };
  assert.equal((await api("POST", "/agents", { definition: { id: "booked", name: "booked", instructions: "Research.", tools: ["web_search", "web_fetch", "write"], tool_settings: parallel } })).status, 201);
  const started = await api("POST", "/agents/booked/runs", { input: { content: "Research widgets on the web and write report.md." } });
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
    { kind: "agentrun.tool_started", tool: "web_search", charged_by: "parallel", call: ids.web_search, heldUsd: PARALLEL_SEARCH_USD },
    { kind: "agentrun.tool_cost", tool: "web_search", charged_by: "parallel", call: ids.web_search, usd: PARALLEL_SEARCH_USD },
    { kind: "agentrun.tool_started", tool: "web_fetch", charged_by: "parallel", call: ids.web_fetch, heldUsd: PARALLEL_EXTRACT_USD },
    { kind: "agentrun.tool_cost", tool: "web_fetch", charged_by: "parallel", call: ids.web_fetch, usd: PARALLEL_EXTRACT_USD },
  ]);
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, 0.002, "the faux model is $0: the run's cost is Parallel's two fees");
  assert.equal(spentIn(join(data, "runs", runId, "store", "run.sqlite")), 0.002, "and what a restarted process reads as spent, against its cap");
  const meters = (await api("GET", "/usage?group_by=meter")).body.lines.map((line) => [line.meter, line.usd, line.unpriced_runs]);
  assert.deepEqual(meters.find(([meter]) => meter === "tools"), ["tools", 0.002, 0]);
});

test("a workflow's call nodes are booked as an agent's calls are: its search and its page read through Parallel are marked and settled in its store, part of its cost, of /usage's tools meter and of what a restarted process reads as spent", { timeout: 60_000 }, async (t) => {
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
  const run = await api("POST", "/agents/booked-flow/runs", { input: { q: "acme registry" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"]);
  assert.deepEqual((await seen()).map((call) => [call.path, call.authorized]), [["/v1/search", true], ["/v1/extract", true]]);
  const paid = paidRecords(data, run.body.run_id);
  assert.deepEqual(paid.map((entry) => [entry.kind, entry.tool, entry.charged_by, entry.heldUsd ?? entry.usd]), [
    ["agentrun.tool_started", "web_search", "parallel", PARALLEL_SEARCH_USD], ["agentrun.tool_cost", "web_search", "parallel", PARALLEL_SEARCH_USD],
    ["agentrun.tool_started", "web_fetch", "parallel", PARALLEL_EXTRACT_USD], ["agentrun.tool_cost", "web_fetch", "parallel", PARALLEL_EXTRACT_USD],
  ]);
  assert.ok(paid[0].call && paid[0].call === paid[1].call && paid[2].call === paid[3].call && paid[0].call !== paid[2].call, `each call node's mark and charge name it: ${paid.map((entry) => entry.call)}`);
  assert.equal((await api("GET", `/runs/${run.body.run_id}`)).body.cost.usd, 0.002, "the run's cost is Parallel's two fees");
  assert.equal(spentIn(join(data, "runs", run.body.run_id, "store", "run.sqlite")), 0.002);
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
  assert.match(saved.body.warnings[0].message, /The tool web_search does not run here on pi: parallel picked, no PARALLEL_API_KEY\./);
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
  for (const [mode, error, limit] of [["429", /^Free web search is rate-limited right now\. Try again in a minute, or add a Parallel key in Settings → Tool keys to search with a key\.$/, { limit: "rate_limited", retryAfterS: 30 }], ["403", /refused keyless use from this connection \(403\).*only over IPv4.*not over IPv6 or through a proxy/, { limit: "connection_refused" }], ["500", /^Exa's MCP endpoint answered 500 to the search$/, {}]]) {
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

test("any other failure Exa answers is said in our words, quoting only the first sentence of Exa's, at most 120 characters: never its fix for an MCP URL, even from a deployment that does not mark its limit", async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_EXA"]);
  /** Exa answering the search with `answer` (a tools/call body, as JSON), counting the searches it was sent. */
  const answering = (answer) => {
    const sent = [];
    const send = async (url, init) => {
      const { method, id } = JSON.parse(init.body);
      if (method !== "tools/call") return fakeExa(url, init);
      sent.push(method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { sent, send };
  };
  const SETUP = /Fix:|MCP URL|exaApiKey|exa\.ai|api-keys|Create a free Exa account/;
  // Exa's notice of its free limit with no ai.exa/rateLimited mark (an older deployment): a failure like any other,
  // not retried, and none of its setup text.
  const unmarked = answering({ result: { isError: true, content: [{ type: "text", text: EXA_LIMIT_TEXT }] } });
  const said = await exaSearch("widgets", 3, { send: unmarked.send, pause: async () => assert.fail("an unmarked failure is not retried") });
  assert.deepEqual(said, { error: 'Free web search failed. Exa said: "You\'ve hit Exa\'s free MCP rate limit."' });
  assert.doesNotMatch(said.error, SETUP);
  assert.equal(unmarked.sent.length, 1);
  // A JSON-RPC error, its message on several lines: the first sentence of the first line.
  const rpc = answering({ error: { code: -32000, message: `web_search_exa error (500): Internal error. Retry later.\nTimestamp: 2026-11-03T17:00:00Z\n\n${EXA_LIMIT_TEXT}` } });
  assert.deepEqual(await exaSearch("widgets", 3, { send: rpc.send }), { error: 'Free web search failed. Exa said: "web_search_exa error (500): Internal error."' });
  // A long first sentence is cut on a word, at most 120 characters.
  const long = answering({ result: { isError: true, content: [{ type: "text", text: `${"word ".repeat(60)}end` }] } });
  const cut = /^Free web search failed\. Exa said: "(.*)"$/.exec((await exaSearch("widgets", 3, { send: long.send })).error)?.[1];
  assert.ok(cut && cut.length <= 120 && cut.endsWith("…") && /^(word )+word…$/.test(cut), `cut on a word: ${cut}`);
  // A failure with no words: said so.
  const empty = answering({ result: { isError: true, content: [] } });
  assert.deepEqual(await exaSearch("widgets", 3, { send: empty.send }), { error: "Free web search failed: Exa gave no answer" });
});

test("keyless Exa is dialled over IPv4 alone: its name is looked up for family 4 and the connection goes to that address, on a host whose resolver answers IPv6 otherwise", async (t) => {
  assert.equal(typeof keyless.ipv4Fetch, "function", "exa-keyless has a transport pinned to IPv4");
  const server = createServer((request, response) => response.end(`over IPv4, to ${request.headers.host}`));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  // A host whose default route is IPv6: its resolver answers ::1 alone unless it is asked for family 4.
  const asked = [];
  const lookup = (host, options, callback) => {
    asked.push({ host, family: options?.family });
    const [address, family] = options?.family === 4 ? ["127.0.0.1", 4] : ["::1", 6];
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  const transport = keyless.ipv4Fetch(lookup);
  t.after(() => transport.close());
  const answer = await transport.send(`http://exa.example:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(await answer.text(), `over IPv4, to exa.example:${port}`);
  assert.ok(asked.length > 0 && asked.every((call) => call.host === "exa.example" && call.family === 4), `every lookup asked for IPv4: ${JSON.stringify(asked)}`);
});

test("pi's hosted search: Anthropic's pause_turn answers the results it has and no text, sent once; a model with no hosted search is an error, sent nowhere", async (t) => {
  const file = join(await scratch(t), "upstream.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_UPSTREAM: "pause", AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: file });
  const env = { AGENTRUN_SERVE_FAUX: FAUX, AGENTRUN_SERVE_FAUX_UPSTREAM: new URL("./fixtures/faux-upstream.mjs", import.meta.url).pathname, ANTHROPIC_API_KEY: "not-a-secret" };
  const { models } = await runModels(env, undefined);
  assert.deepEqual(await hostedSearch("widgets", 5, "anthropic/claude-sonnet-4-5", undefined, models), { provider: "native", query: "widgets", results: [{ url: "http://public.example/", title: "Public page", snippet: "", published: "October 1, 2026" }, { url: "https://result.example/2", title: "Result 2", snippet: "" }] });
  assert.match((await hostedSearch("widgets", 5, "faux/faux-1", undefined, models)).error, /has no hosted web search here/);
  assert.match((await hostedSearch("widgets", 5, "anthropic/no-such-model", undefined, models)).error, /no model to search on/);
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1, "one request, the paused one, not resubmitted");
});

test("a run cancelled while its search through Parallel is under way still settles the call: its charge is booked, so the run's cost stays known", { timeout: 90_000 }, async (t) => {
  const seen = await calls(t, true);
  // The faux Parallel answers the search after 2 s, so the cancel lands while the call is under way.
  withEnv(t, { [MODE]: "slow:2000" }, [MODE, EXTRACT_MODE]);
  const { api, data } = await serve(t, { fauxParallel: FAUX_PARALLEL, fauxWeb: FAUX_WEB });
  assert.equal((await api("POST", "/agents", { definition: { id: "stopped", name: "stopped", instructions: "Research.", tools: ["web_search"], tool_settings: { web_search: { provider: "parallel" } } } })).status, 201);
  const started = await api("POST", "/agents/stopped/runs", { input: { content: "Search the web for widgets" } });
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
    ["agentrun.tool_started", "web_search", PARALLEL_SEARCH_USD],
    ["agentrun.tool_cost", "web_search", PARALLEL_SEARCH_USD],
  ], "the call was marked, and settled though its turn was stopped");
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, PARALLEL_SEARCH_USD, "the run's cost is the search's fee, never unknown");
});
