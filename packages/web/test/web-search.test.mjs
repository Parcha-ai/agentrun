// Parallel's Search API as web_search's provider, on a key the caller gives: results mapped into the one search shape,
// n bounded, a failure answered as {error}, and a refused key stopping Parallel for both web tools. Parallel is the
// tests' fake (fixtures/faux-parallel.mjs) and the network a table (fixtures/fake-network.mjs): no socket leaves this
// machine, and no real key is used. A client here is unmetered (parallelExtract's default pay); serve's paid booking and
// cap, and its runs, stay in serve's web-search test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PARALLEL_SEARCH_URL, parallelExtract, parallelSearched } from "../dist/index.js";
import fakeParallel, { CANARY } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { webFetch, withEnv } from "./support.mjs";

/** Parallel's search as the model reads it: parallelSearched's answer, its limit left to the breaker. */
const webSearch = async (args, parallel, signal) => (await parallelSearched(args, parallel, signal)).answer;

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
  assert.deepEqual(sent, [{ url: PARALLEL_SEARCH_URL, key: CANARY, body: { objective: "widgets delaware", search_queries: ["widgets delaware"], mode: "fast", advanced_settings: { max_results: 3 } } }]);
  assert.deepEqual([answer.provider, answer.objective, answer.queries, Object.keys(answer)], ["parallel", "widgets delaware", ["widgets delaware"], ["provider", "objective", "queries", "results"]]);
  const [first, ...rest] = answer.results;
  assert.deepEqual(Object.entries({ ...first, snippet: "" }), Object.entries({ url: "https://registry.example/widgets", title: "", snippet: "", published: "2026-10-01" }), "a null title is empty");
  assert.match(first.snippet, /^See the registry entry for Widgets, Inc\. … Widgets are registered in Delaware/, "the excerpts joined, the link its text, whitespace collapsed");
  assert.ok(first.snippet.length <= 3_000 && first.snippet.length > 2_900 && first.snippet.endsWith("…"), `clipped on a word: ${first.snippet.length}`);
  assert.deepEqual(rest, [2, 3].map((i) => ({ url: `https://result.example/${i}`, title: `Result ${i} for widgets delaware`, snippet: `Excerpt ${i}.` })), "no published where Parallel gives no date");
  const long = await webSearch({ query: "q".repeat(300) }, parallelExtract(CANARY, send));
  assert.deepEqual([long.objective, long.queries], ["q".repeat(300), ["q".repeat(200)]], "a query alone is the objective, cut at 1,000, and the one query, cut at 200");
  assert.deepEqual(await webSearch({ query: "  " }, parallelExtract(CANARY, send)), { error: "web_search needs an objective" });
  assert.equal(sent.length, 2, "an empty query is not sent");
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
