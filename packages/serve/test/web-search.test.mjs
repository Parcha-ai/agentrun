// web_search on pi through Exa's keyless endpoint: the client against the tests' fake MCP server (fixtures/faux-exa.mjs),
// the server's off switch, capabilities, and pi runs whose model searches. No network, no key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { exaSearch } from "../dist/exa-keyless.js";
import { searchFor } from "../dist/web-search.js";
import fakeExa from "./fixtures/faux-exa.mjs";
import { agent, client, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_EXA = new URL("./fixtures/faux-exa.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const lines = async (file) => (await readFile(file, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("one search is one MCP exchange with no key: only the query and the count leave; Exa's text is read into results", async (t) => {
  const log = join(await scratch(t), "exa.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA_CALLS: log }, ["AGENTRUN_TEST_FAUX_EXA"]);
  const found = await exaSearch("widgets", 2, { send: fakeExa });
  assert.equal(found.provider, "exa-keyless");
  assert.deepEqual(found.results, [
    { url: "http://public.example/", title: "Public page", snippet: "The answer is forty-two. See the registry for more.", published: "2026-10-01T00:00:00.000Z" },
    { url: "https://result.example/2", title: "Result 2 for widgets", snippet: "Excerpt 2." },
  ]);
  const calls = await lines(log);
  assert.deepEqual(calls.map((call) => call.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.ok(calls.every((call) => call.url === "https://mcp.exa.ai/mcp" && call.keyed === false), "Exa's endpoint, never a key");
  assert.deepEqual(calls[2].arguments, { query: "widgets", numResults: 2 }, "the query and the count, nothing else");
});

test("Exa's free rate limit (429) is a tool error that says so, at once; a search that never answers ends when it is stopped", async (t) => {
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA: "429" }, ["AGENTRUN_TEST_FAUX_EXA_CALLS"]);
  const limited = await exaSearch("widgets", 3, { send: fakeExa });
  assert.match(limited.error, /^Exa's keyless search is rate-limited \(429\); it says to wait 30 s: answer without searching, or try again later$/);
  const stop = new AbortController();
  const hung = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  setTimeout(() => stop.abort(), 50);
  const started = Date.now();
  assert.deepEqual(await exaSearch("widgets", 3, { send: hung, signal: stop.signal }), { error: "the search was stopped" });
  assert.ok(Date.now() - started < 5_000, "no hang");
});

test("a search with no query sends nothing and says so", async (t) => {
  const log = join(await scratch(t), "exa.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA_CALLS: log });
  assert.deepEqual(await searchFor({}, { query: "  " }), { error: "web_search needs a query" });
  assert.deepEqual(await lines(log), []);
});

test("capabilities list web_search on pi, available with no key; Parallel's key no longer claims it", async (t) => {
  withEnv(t, {}, ["PARALLEL_API_KEY"]);
  const body = (await client((await serve(t)).baseUrl)("GET", "/capabilities")).body;
  const tool = body.tools.find((entry) => entry.name === "web_search");
  assert.deepEqual([tool.available, tool.missing, tool.nodes, tool.harnesses], [true, undefined, true, ["pi"]]);
  assert.match(tool.summary, /mcp\.exa\.ai, no key; only the query leaves this server/);
});

test("a pi run's model searches the web: the search goes from the run's process to Exa with no key, and its answer cites the result", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "exa.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA_CALLS: log }, ["AGENTRUN_TEST_FAUX_EXA"]);
  const { api } = await serve(t, { fauxExa: FAUX_EXA });
  const saved = await api("POST", "/agents", agent("searcher", { tools: ["web_search"] }));
  assert.deepEqual([saved.status, saved.body.warnings], [201, []], JSON.stringify(saved.body));
  const started = await api("POST", "/agents/searcher/runs", { input: { content: "Search the web for widgets." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  assert.match((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, /^Found: \{"provider":"exa-keyless","query":"widgets","results":\[\{"url":"http:\/\/public\.example\/".*\nCite the URL of each result you rely on\.$/s);
  const calls = await lines(log);
  assert.deepEqual(calls.map((call) => [call.method, call.keyed]), [["initialize", false], ["notifications/initialized", false], ["tools/call", false]]);
  assert.deepEqual(calls[2].arguments, { query: "widgets", numResults: 2 });
  assert.ok(calls.every((call) => call.pid !== process.pid), "from the run's process");
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows;
  assert.deepEqual(rows.filter((row) => row.kind === "tool_use").map((row) => [row.tool_name, row.summary, row.tool_status]), [["web_search", 'Searched the web for "widgets": 2 sources · public.example, result.example · Exa keyless', "success"]]);
});

test("on claude-agent web_search is not bound yet: a revision naming it saves with the pi-only warning", async (t) => {
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const claude = await api("POST", "/agents", agent("searcher-claude", { harness: "claude-agent", tools: ["read", "web_search"] }));
  assert.equal(claude.status, 201, JSON.stringify(claude.body));
  assert.match(claude.body.warnings.find((w) => w.field === "definition.tools[1]")?.message ?? "", /^web_search runs on pi here; on claude-agent it is not bound yet\.$/);
});
