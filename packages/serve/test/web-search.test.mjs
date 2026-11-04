// web_search's providers, each answering `{query, results: [{url, title, published?, snippet}], text?}` or `{error}`:
// Parallel's Search API on the run's Parallel key where Parallel is picked, Exa's keyless MCP search, and pi's one
// request to its model provider's hosted search. Parallel, Exa and the provider are the tests' fakes
// (fixtures/faux-parallel.mjs, faux-exa.mjs, faux-upstream.mjs) and the network a table (fixtures/fake-network.mjs): no
// socket, no real key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parallelExtract, webFetch } from "../dist/web-fetch.js";
import * as kernel from "@parcha/agentrun-kernel";
import * as searches from "../dist/web-search.js";
import { PARALLEL_SEARCH_URL, webSearch } from "../dist/web-search.js";
import { exaSearch } from "../dist/exa-keyless.js";
import { hostedSearch } from "../dist/hosted-search.js";
import { runModels } from "../dist/model.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import fakeExa from "./fixtures/faux-exa.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { FAUX, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const MODE = "AGENTRUN_TEST_FAUX_PARALLEL_SEARCH";
const EXTRACT_MODE = "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT";

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

test("results are mapped and clipped into the one search shape: excerpts joined into one snippet of at most 3,000 characters, links as their text, published only where Parallel dates a page", async (t) => {
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
});

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

test("n is 1 to 25, 10 when it is not a number above zero", async (t) => {
  withEnv(t, {}, [MODE]);
  for (const [n, asked] of [[undefined, 10], [0, 10], ["many", 10], [-3, 1], [0.5, 1], [2.7, 2], ["7", 7], [25, 25], [99, 25]]) {
    const { sent, send } = parallel();
    const answer = await webSearch({ query: "widgets", n }, parallelExtract(CANARY, send));
    assert.deepEqual([sent[0].body.advanced_settings.max_results, answer.results.length], [asked, asked], String(n));
  }
});

test("a 5xx, a timeout or a request that fails answers {error}, and Parallel is asked again next time: there is nothing else to search", async (t) => {
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
});

test("a 401 or 403 stops Parallel for the rest of the run, for both web tools: neither asks it again", async (t) => {
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

test("keyless Exa: one MCP exchange with no key, its text read into results; a 429 says its free limit and the wait, a 403 the connection, an error its words; nothing is retried", async (t) => {
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
  for (const [mode, error] of [["429", /^Exa's keyless search is rate-limited \(429\); it says to wait 30 s: answer without searching, or try again later$/], ["403", /refused keyless use from this connection \(403\).*only over IPv4.*not over IPv6 or through a proxy/], ["500", /^Exa's MCP endpoint answered 500 to the search$/]]) {
    sent.length = 0;
    process.env.AGENTRUN_TEST_FAUX_EXA = mode;
    const answer = await exaSearch("widgets", 3, { send });
    assert.match(answer.error, error, mode);
    assert.deepEqual(sent.map(([method]) => method), ["initialize", "notifications/initialized", "tools/call"], `${mode}: asked once, not again`);
  }
  const failing = async (url, init) => {
    const { method, id } = JSON.parse(init.body);
    if (method !== "tools/call") return fakeExa(url, init);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "the query is empty" }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  delete process.env.AGENTRUN_TEST_FAUX_EXA;
  assert.deepEqual(await exaSearch("widgets", 3, { send: failing }), { error: "Exa's search failed: the query is empty" }, "a JSON answer is read as well as a stream");
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
