// web_search's objective and queries, and web_fetch's objective. A search is asked with a goal in plain words (the
// objective) and 1 to 5 short keyword queries; each provider is sent what its own guidance asks for: Parallel the
// objective and the queries, Exa (keyed and keyless) the objective as its query, Firecrawl (keyed and keyless) up to 3 of
// the queries, each scraped, merged and deduped. A query alone, the old shape, is searched as the objective and the one
// query. The classifier ranks a search against its objective, and a fetch's objective is what it finds in the page.
// Every provider here is a fake fetch the Web is handed: nothing leaves this machine, and the keys are literals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { SEARCH_UNAVAILABLE } from "../dist/search.js";
import { decideWeb, pagesOf, PUBLIC, scoringProvider } from "./fixtures/decide-runs.mjs";
import { fakeWeb } from "./fixtures/web-runs.mjs";
import { network } from "./fixtures/fake-network.mjs";

const KEY = "not-a-secret";
const OBJECTIVE = "Find the year Widgets, Inc. was registered in Delaware, to date its founding for a company profile";
const QUERIES = ["widgets inc delaware registration", "widgets inc founded year", "delaware entity search widgets", "widgets inc history"];

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** A keyed provider's fake: each request's path and JSON body kept in `sent`, answered by `answer(path, body, n)`.
 *  `most`: the most requests in flight at once, counted as each waits a turn of the event loop before it answers. */
function keyed(answer) {
  const sent = [];
  let flying = 0;
  const seen = { most: 0 };
  const send = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ path: new URL(String(url)).pathname, body });
    const n = sent.length;
    flying += 1;
    seen.most = Math.max(seen.most, flying);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    flying -= 1;
    return answer(new URL(String(url)).pathname, body, n);
  };
  return { sent, send, seen };
}
/** An MCP server's fake (keyless Firecrawl's, keyless Exa's): initialize and notifications/initialized answered, each
 *  tools/call's params kept in `calls` and answered with the tool result `answer(name, args, n)` gives. */
function mcp(answer) {
  const calls = [];
  const send = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    calls.push(body.params);
    return json({ jsonrpc: "2.0", id: body.id, result: await answer(body.params.name, body.params.arguments, calls.length) });
  };
  return { calls, send };
}
const toolText = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const row = (letter, more = {}) => ({ url: `https://${letter}.example/`, title: `Page ${letter}`, description: `About ${letter}.`, markdown: `# Page ${letter}\n\nThe whole of page ${letter}.`, ...more });
/** Keyed Firecrawl's answer to a search: `rows` in data.web, as /v2/search answers them. */
const firecrawlRows = (rows) => json({ success: true, data: { web: rows } });
const SCRAPE = { formats: ["markdown"], onlyMainContent: true };

test("searchArgs: the objective cut at 1,000 characters, up to 5 queries each cut at 200 with blanks dropped, none giving the objective's first 200; a query alone is the objective and the one query", () => {
  assert.equal(web.OBJECTIVE_MAX, 1_000, "the objective's bound");
  const asked = web.searchArgs({ objective: `  ${"o".repeat(1_200)} `, queries: [" a b c ", "", "  ", "q".repeat(250), "d", "e", "f", "g"], n: 4 });
  assert.deepEqual(asked, { objective: "o".repeat(1_000), queries: ["a b c", "q".repeat(200), "d", "e", "f"], n: 4 }, "the objective cut, blanks dropped, 5 queries kept, each cut at 200");
  assert.deepEqual(web.searchArgs({ objective: OBJECTIVE }), { objective: OBJECTIVE, queries: [OBJECTIVE.slice(0, 200)], n: 10 }, "no queries: the objective's first 200 characters searched");
  assert.deepEqual(web.searchArgs({ objective: "o".repeat(300), queries: "not a list" }).queries, ["o".repeat(200)], "queries that are not a list are none");
  assert.deepEqual(web.searchArgs({ query: "  widgets delaware " }), { objective: "widgets delaware", queries: ["widgets delaware"], n: 10 }, "the back-compat path: a query alone is the objective and the one query");
  assert.deepEqual(web.searchArgs({ objective: OBJECTIVE, query: "widgets delaware" }).queries, ["widgets delaware"], "an objective with the old query beside it: the query is the one query");
  assert.deepEqual(web.searchArgs({ queries: ["widgets"] }).objective, "", "no objective and no query: none, and the search asks nothing");
});

test("Parallel's wire body: the objective as its objective, the queries as search_queries, mode fast, max_results n, no excerpt_settings; client_model and session_id only where the Web is given them", async () => {
  const fake = keyed(() => json({ results: [{ url: "https://a.example/", title: "A", excerpts: ["An excerpt."] }] }));
  const plain = web.createWeb({ order: { search: ["parallel"], fetch: [] }, keys: { parallel: KEY }, send: { parallel: fake.send } });
  await plain.search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 2) }, { n: 5 });
  assert.deepEqual(fake.sent, [{ path: "/v1/search", body: { objective: OBJECTIVE, search_queries: QUERIES.slice(0, 2), mode: "fast", advanced_settings: { max_results: 5 } } }], "Parallel is sent the objective as its objective and the queries as search_queries, and no excerpt_settings");
  const told = web.createWeb({ order: { search: ["parallel"], fetch: [] }, keys: { parallel: KEY }, send: { parallel: fake.send }, client: { model: "claude-opus-4-7", session: "run-7" } });
  await told.search({ objective: OBJECTIVE, queries: QUERIES }, { n: 3 });
  assert.deepEqual(fake.sent[1].body, { objective: OBJECTIVE, search_queries: QUERIES, mode: "fast", advanced_settings: { max_results: 3 }, client_model: "claude-opus-4-7", session_id: "run-7" }, "Parallel is sent the client's model and session where the Web knows them");
});

test("keyed Exa's and keyless Exa's wire bodies: the objective as their query, the rest as before", async () => {
  const exa = keyed(() => json({ results: [{ url: "https://a.example/", title: "A", highlights: ["An excerpt."] }] }));
  const keyedWeb = web.createWeb({ order: { search: ["exa"], fetch: [] }, keys: { exa: KEY }, send: { exa: exa.send } });
  const { answer } = await keyedWeb.search({ objective: OBJECTIVE, queries: QUERIES }, { n: 4 });
  assert.deepEqual(exa.sent, [{ path: "/search", body: { query: OBJECTIVE, type: "auto", numResults: 4, contents: { highlights: true } } }], "keyed Exa is sent the objective as its query");
  assert.deepEqual([answer.objective, answer.queries], [OBJECTIVE, QUERIES], "keyed Exa's answer carries the objective and the queries");
  const free = mcp(() => toolText("Title: A\nURL: https://a.example/\nPublished: N/A\nAuthor: N/A\nHighlights:\nAn excerpt."));
  const keyless = web.createWeb({ order: { search: ["exa-keyless"], fetch: [] }, send: { "exa-keyless": free.send } });
  await keyless.search({ objective: OBJECTIVE, queries: QUERIES }, { n: 4 });
  assert.deepEqual(free.calls, [{ name: "web_search_exa", arguments: { query: OBJECTIVE, numResults: 4 } }], "keyless Exa is sent the objective as its query");
});

test("keyed Firecrawl's wire bodies: up to 3 of the queries at once, each limit ceil(n/k) with scrapeOptions markdown and main content only; the results deduped by url in first-seen order, cut at n, each snippet its page's markdown", async () => {
  const answers = { [QUERIES[0]]: [row("a"), row("b")], [QUERIES[1]]: [row("b"), row("c", { markdown: undefined })], [QUERIES[2]]: [row("d"), row("a")] };
  const fc = keyed((_path, body) => firecrawlRows(answers[body.query]));
  const w = web.createWeb({ order: { search: ["firecrawl"], fetch: [] }, keys: { firecrawl: KEY }, send: { firecrawl: fc.send } });
  const { answer, receipt } = await w.search({ objective: OBJECTIVE, queries: QUERIES }, { n: 4 });
  assert.deepEqual(fc.sent.map(({ path, body }) => [path, body]), QUERIES.slice(0, 3).map((query) => ["/v2/search", { query, limit: 2, scrapeOptions: SCRAPE }]), "Firecrawl is sent the first 3 queries, each limit ceil(4/3) with scrapeOptions");
  assert.equal(fc.seen.most, 3, "the 3 requests are in flight at once");
  assert.deepEqual(answer.results.map((hit) => hit.url), ["a", "b", "c", "d"].map((letter) => `https://${letter}.example/`), "Firecrawl's results deduped by url, first seen first, cut at n");
  assert.deepEqual(answer.results.map((hit) => hit.snippet), ["# Page a The whole of page a.", "# Page b The whole of page b.", "About c.", "# Page d The whole of page d."], "each snippet the page's markdown, its description where it has none");
  assert.deepEqual(receipt.cost.lines.map((fee) => fee.basis), Array(3).fill("Firecrawl's list price for a search of 2 results, each scraped: 4 credits at the key's plan price"), "each request priced as a scraping search");
  const one = keyed(() => firecrawlRows([row("a"), row("b"), row("c")]));
  await web.createWeb({ order: { search: ["firecrawl"], fetch: [] }, keys: { firecrawl: KEY }, send: { firecrawl: one.send } }).search({ objective: OBJECTIVE, queries: ["widgets"] }, { n: 2 });
  assert.deepEqual(one.sent.map(({ body }) => body), [{ query: "widgets", limit: 2, scrapeOptions: SCRAPE }], "one query: one request of limit n");
});

test("keyed Firecrawl's failures: some requests failing answers the merged rest and hands the quota met to the breaker; every one failing, a limit among them, answers the breaker's words, the receipt the first, typed", async () => {
  const some = keyed((_path, body) => (body.query === QUERIES[0] ? json({ error: "credits" }, 402) : body.query === QUERIES[1] ? firecrawlRows([row("b")]) : json({ error: "slow" }, 429, { "retry-after": "30" })));
  const w = web.createWeb({ order: { search: ["firecrawl"], fetch: [] }, keys: { firecrawl: KEY }, send: { firecrawl: some.send } });
  const first = await w.search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 3) }, { n: 3 });
  assert.deepEqual((first.answer.results ?? []).map((hit) => hit.url), ["https://b.example/"], "the request that answered is the answer");
  const again = await w.search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 3) }, { n: 3 });
  assert.deepEqual([again.answer, some.sent.length], [{ error: SEARCH_UNAVAILABLE }, 3], "the 402 among them turned Firecrawl off for the run: the next search is not sent");
  const all = keyed((_path, body) => (body.query === QUERIES[0] ? json({ error: "down" }, 500) : json({ error: "slow" }, 429, { "retry-after": "30" })));
  const failing = await web.createWeb({ order: { search: ["firecrawl"], fetch: [] }, keys: { firecrawl: KEY }, send: { firecrawl: all.send } }).search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 3) }, { n: 3 });
  assert.deepEqual([failing.answer, failing.receipt.tries[0]?.error, failing.receipt.tries[0]?.failure?.code], [{ error: "search is busy; try again in 30 s, or answer from what you have" }, "Firecrawl's search answered 500", "HTTP_500"], "every request failing, a rate limit among them: the breaker's words for the model; the receipt keeps the first failure in query order, typed");
});

test("Firecrawl, keyed and keyless: two queries answering and one rate-limited past 15 minutes answers the two's hits, and the next search is held", async () => {
  const LONG = 1_800;
  const hits = { [QUERIES[0]]: [row("a")], [QUERIES[1]]: [row("b")] };
  const paid = keyed((_path, body) => (hits[body.query] ? firecrawlRows(hits[body.query]) : json({ error: "slow" }, 429, { "retry-after": String(LONG) })));
  const free = mcp((_name, args) => (hits[args.query] ? toolText({ success: true, data: { web: hits[args.query] } }) : { isError: true, content: [{ type: "text", text: "rate limited" }], structuredContent: { code: "KEYLESS_LIMIT_REACHED", retry_after_seconds: LONG } }));
  // Keyed Firecrawl's wait is its retry-after header's words; keyless Firecrawl's, its payload's number.
  const runs = [
    ["firecrawl", web.createWeb({ order: { search: ["firecrawl"], fetch: [] }, keys: { firecrawl: KEY }, send: { firecrawl: paid.send } }), () => paid.sent.length, String(LONG)],
    ["firecrawl-keyless", web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: [] }, send: { "firecrawl-keyless": free.send } }), () => free.calls.length, LONG],
  ];
  for (const [provider, w, asked, wait] of runs) {
    const first = await w.search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 3) }, { n: 3 });
    assert.deepEqual([first.answer.provider, (first.answer.results ?? []).map((hit) => hit.url)], [provider, ["https://a.example/", "https://b.example/"]], `${provider}: the two queries' hits are answered, not dropped for the third's long rate limit`);
    assert.deepEqual([asked(), first.receipt.tries[0]?.limit], [3, { kind: "rate", retryAfter: wait }], `${provider}: three requests sent, the long rate limit on the receipt`);
    const again = await w.search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 3) }, { n: 3 });
    assert.deepEqual([again.answer, asked()], [{ error: SEARCH_UNAVAILABLE }, 3], `${provider}: the long rate limit still holds the next search: it is not sent`);
  }
});

test("Firecrawl, keyed and keyless: of two rate limits a search's queries meet, the breaker holds the longer wait, and a quota still wins over a longer rate limit", async () => {
  const SHORT = 1;
  const LONG = 1_800;
  // The short wait comes first in query order, so keeping the first limit met would hand the breaker 1 s.
  const waits = { [QUERIES[1]]: SHORT, [QUERIES[2]]: LONG };
  const hits = { [QUERIES[0]]: [row("a")] };
  const paid = keyed((_path, body) => (hits[body.query] ? firecrawlRows(hits[body.query]) : json({ error: "slow" }, 429, { "retry-after": String(waits[body.query]) })));
  const free = mcp((_name, args) => (hits[args.query] ? toolText({ success: true, data: { web: hits[args.query] } }) : { isError: true, content: [{ type: "text", text: "rate limited" }], structuredContent: { code: "KEYLESS_LIMIT_REACHED", retry_after_seconds: waits[args.query] } }));
  // Keyed Firecrawl's wait is its retry-after header's words; keyless Firecrawl's, its payload's number.
  const runs = [
    ["firecrawl", web.createWeb({ order: { search: ["firecrawl"], fetch: [] }, keys: { firecrawl: KEY }, send: { firecrawl: paid.send } }), () => paid.sent.length, String(LONG)],
    ["firecrawl-keyless", web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: [] }, send: { "firecrawl-keyless": free.send } }), () => free.calls.length, LONG],
  ];
  for (const [provider, w, asked, wait] of runs) {
    const first = await w.search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 3) }, { n: 3 });
    assert.deepEqual([(first.answer.results ?? []).map((hit) => hit.url), first.receipt.tries[0]?.limit], [["https://a.example/"], { kind: "rate", retryAfter: wait }], `${provider}: the answering query's hits, and the longer of the two rate limits (${LONG} s, not ${SHORT} s) on the receipt`);
    const again = await w.search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 3) }, { n: 3 });
    assert.deepEqual([again.answer, asked()], [{ error: SEARCH_UNAVAILABLE }, 3], `${provider}: the breaker holds the ${LONG} s wait: the next search is not sent`);
  }
  // A quota met by a later query wins over a longer rate limit met by an earlier one.
  const paidQuota = keyed((_path, body) => (body.query === QUERIES[0] ? json({ error: "slow" }, 429, { "retry-after": String(LONG) }) : body.query === QUERIES[1] ? json({ error: "credits" }, 402) : firecrawlRows([row("c")])));
  const freeQuota = mcp((_name, args) => (args.query === QUERIES[0] ? { isError: true, content: [{ type: "text", text: "rate limited" }], structuredContent: { code: "KEYLESS_LIMIT_REACHED", retry_after_seconds: LONG } } : args.query === QUERIES[1] ? { isError: true, content: [{ type: "text", text: "spent" }], structuredContent: { code: "KEYLESS_QUOTA_EXHAUSTED" } } : toolText({ success: true, data: { web: [row("c")] } })));
  const quotas = [
    ["firecrawl", web.createWeb({ order: { search: ["firecrawl"], fetch: [] }, keys: { firecrawl: KEY }, send: { firecrawl: paidQuota.send } })],
    ["firecrawl-keyless", web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: [] }, send: { "firecrawl-keyless": freeQuota.send } })],
  ];
  for (const [provider, w] of quotas) {
    const { answer, receipt } = await w.search({ objective: OBJECTIVE, queries: QUERIES.slice(0, 3) }, { n: 3 });
    assert.deepEqual([(answer.results ?? []).map((hit) => hit.url), receipt.tries[0]?.limit?.kind], [["https://c.example/"], "quota"], `${provider}: a quota beside a longer rate limit is the limit the breaker gets`);
  }
});

test("keyless Firecrawl's wire bodies: each query with the objective and the same scrapeOptions, merged as keyed Firecrawl's", async () => {
  const answers = { [QUERIES[0]]: [row("a"), row("b")], [QUERIES[1]]: [row("b"), row("c")], [QUERIES[2]]: [row("d")] };
  const free = mcp((_name, args) => toolText({ success: true, data: { web: answers[args.query] } }));
  const w = web.createWeb({ order: { search: ["firecrawl-keyless"], fetch: [] }, send: { "firecrawl-keyless": free.send } });
  const { answer } = await w.search({ objective: OBJECTIVE, queries: QUERIES }, { n: 4 });
  assert.deepEqual(free.calls, QUERIES.slice(0, 3).map((query) => ({ name: "firecrawl_search", arguments: { query, limit: 2, objective: OBJECTIVE, scrapeOptions: SCRAPE } })), "keyless Firecrawl is sent each query with the objective and scrapeOptions");
  assert.deepEqual(answer.results.map((hit) => [hit.url, hit.snippet]), ["a", "b", "c", "d"].map((letter) => [`https://${letter}.example/`, `# Page ${letter} The whole of page ${letter}.`]), "keyless Firecrawl's results deduped in first-seen order, each snippet its markdown");
});

test("keyless Firecrawl answering data:{} is unreadable: it fails, typed, and keyless Exa answers the call", async () => {
  const empty = mcp(() => toolText({ success: true, data: {}, creditsUsed: 0 }));
  const exa = mcp(() => toolText("Title: A\nURL: https://a.example/\nPublished: N/A\nAuthor: N/A\nHighlights:\nAn excerpt."));
  const w = web.createWeb({ order: { search: ["firecrawl-keyless", "exa-keyless"], fetch: [] }, send: { "firecrawl-keyless": empty.send, "exa-keyless": exa.send } });
  const { answer, receipt } = await w.search({ objective: OBJECTIVE, queries: ["widgets"] }, { n: 3 });
  assert.deepEqual(receipt.tries.map(({ provider, outcome, failure }) => [provider, outcome, failure?.code]), [["firecrawl-keyless", "error", "UNREADABLE"], ["exa-keyless", "ok", undefined]], "Firecrawl's data:{} is UNREADABLE, and Exa is asked");
  assert.deepEqual([answer.provider, answer.results.map((hit) => hit.url)], ["exa-keyless", ["https://a.example/"]], "keyless Exa's results answer the call");
});

test("the back-compat path: a query alone (the old shape, a string or {query}) is searched as the objective and the one query; the answer and the receipt carry objective and queries, and no query", async () => {
  const fake = keyed(() => json({ results: [{ url: "https://a.example/", title: "A", excerpts: ["An excerpt."] }] }));
  const w = web.createWeb({ order: { search: ["parallel"], fetch: [] }, keys: { parallel: KEY }, send: { parallel: fake.send } });
  const { answer, receipt } = await w.search("  widgets delaware ", { n: 2 });
  await w.search({ query: "widgets delaware" }, { n: 2 });
  assert.deepEqual(fake.sent.map(({ body }) => [body.objective, body.search_queries]), [["widgets delaware", ["widgets delaware"]], ["widgets delaware", ["widgets delaware"]]], "a query alone is sent as the objective and the one query");
  assert.deepEqual([answer.provider, answer.objective, answer.queries, "query" in answer], ["parallel", "widgets delaware", ["widgets delaware"], false], "the answer carries objective and queries, and no query");
  assert.deepEqual([receipt.asked, receipt.queries], ["widgets delaware", ["widgets delaware"]], "the receipt's asked is the objective, and its queries the queries");
  assert.deepEqual((await w.search({ queries: ["widgets"] })).answer, { error: "web_search needs an objective" }, "no objective and no query: nothing is sent");
  assert.equal(fake.sent.length, 2);
});

test("the classifier ranks a search against its objective, never a query, unless the caller gives a task; the miss line names the objective", async () => {
  const unscored = scoringProvider({ r1: 0.1, r2: 0.1, r3: 0.1 });
  const w = fakeWeb({ decider: web.deciderFrom(unscored.provider, { price: { requestUsd: 0.0002 } }), policy: "rerank+label" });
  const { answer } = await w.search({ objective: OBJECTIVE, queries: ["widgets delaware"] }, { n: 3 });
  assert.deepEqual([unscored.asked[0]?.request.state.query, "task" in (unscored.asked[0]?.request.state ?? {})], [OBJECTIVE, false], "Jev is asked to rank against the objective, not the query");
  assert.match(answer.sift, new RegExp(`nothing here looks relevant to ${JSON.stringify(OBJECTIVE.slice(0, 200)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the miss line names the objective");
  await w.search({ objective: OBJECTIVE, queries: ["widgets delaware"] }, { n: 3, task: "Where is Widgets, Inc. registered?" });
  assert.deepEqual(unscored.asked[1]?.request.state.task, "Where is Widgets, Inc. registered?", "the caller's task is still given");
});

test("web_fetch's objective is what findInPage looks for; looking_for is its alias, and objective wins over it; with no classifier the part says it was not applied", async () => {
  const page = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, "0")} ${"x".repeat(987)}\n\n`).join("");
  const chunks = web.passagesOf(page, web.FIND_CHUNKS_MAX).map(([from, to]) => page.slice(from, to));
  const NEED = "the year Widgets, Inc. was registered";
  for (const [options, need, words] of [[{ objective: NEED }, NEED, "the objective"], [{ lookingFor: NEED }, NEED, "looking_for, its alias"], [{ objective: NEED, lookingFor: "something else" }, NEED, "the objective over looking_for"]]) {
    const { asked, provider } = scoringProvider({});
    const w = decideWeb({ decider: web.deciderFrom(provider, { price: { requestUsd: 0.0002 } }), send: { parallel: pagesOf(page) } });
    const { answer } = await w.fetch(PUBLIC, options);
    assert.deepEqual(asked.map(({ request }) => request), [web.judgeRequest(PUBLIC, need, chunks)], `findInPage looks for ${words}`);
    assert.match(answer.sift, /most likely to hold what your objective asks for .*call web_fetch with its offset and no objective$/, `the sift line speaks of the objective (${words})`);
  }
  const plain = fakeWeb({ send: { parallel: pagesOf(page) } });
  const part = (await plain.fetch(PUBLIC, { offset: 100, maxChars: 500 })).answer;
  assert.deepEqual((await plain.fetch(PUBLIC, { objective: NEED, offset: 100, maxChars: 500 })).answer, { ...part, sift: "objective not applied (no classifier in this run); this part is in page order" }, "no classifier: the part asked for, saying the objective was not applied");
});

/** The names a tool's text must not hold: each provider's label and id, and the model providers', each as a word. */
const PROVIDER_NAMES = [...new Set([...web.PROVIDERS.flatMap((one) => [one.id, one.label]).filter((name) => /^[A-Za-z-]+$/.test(name) && !["native", "direct"].includes(name)), "Anthropic", "OpenAI", "Claude", "Codex", "codex"])];

test("web_search's and web_fetch's descriptions and parameters are exported, one text whatever provider answers, naming no provider", () => {
  const texts = { WEB_SEARCH_DESCRIPTION: web.WEB_SEARCH_DESCRIPTION, WEB_SEARCH_PARAMETERS: JSON.stringify(web.WEB_SEARCH_PARAMETERS), WEB_FETCH_DESCRIPTION: web.WEB_FETCH_DESCRIPTION, WEB_FETCH_PARAMETERS: JSON.stringify(web.WEB_FETCH_PARAMETERS) };
  for (const [name, text] of Object.entries(texts)) assert.ok(typeof text === "string" && text.length > 100, `${name} is exported`);
  assert.ok(PROVIDER_NAMES.includes("Parallel") && PROVIDER_NAMES.includes("firecrawl-keyless") && PROVIDER_NAMES.includes("Exa"), "the names checked include every provider's");
  for (const [name, text] of Object.entries(texts)) for (const provider of PROVIDER_NAMES) assert.doesNotMatch(text, new RegExp(`(?<![\\w-])${provider}(?![\\w-])`), `${name} names ${provider}`);
  assert.deepEqual([web.WEB_SEARCH_PARAMETERS.required, web.WEB_SEARCH_PARAMETERS.properties.query.deprecated, web.WEB_SEARCH_PARAMETERS.properties.queries.type], [["objective"], true, "array"], "web_search asks an objective, query deprecated");
  assert.match(web.WEB_SEARCH_DESCRIPTION, /1-3 short keyword queries/, "and teaches a few short keyword queries");
  assert.deepEqual([web.WEB_FETCH_PARAMETERS.required, web.WEB_FETCH_PARAMETERS.properties.objective.type], [["url"], "string"], "web_fetch asks a url, an objective optional");
});

test("a search's own session (SearchOptions.session) is Parallel's session_id, over the Web's client.session; with neither, none is sent", async () => {
  const fake = keyed(() => json({ results: [{ url: "https://a.example/", title: "A", excerpts: ["An excerpt."] }] }));
  const told = web.createWeb({ order: { search: ["parallel"], fetch: [] }, keys: { parallel: KEY }, send: { parallel: fake.send }, client: { model: "claude-opus-4-7", session: "run-7" } });
  const bare = web.createWeb({ order: { search: ["parallel"], fetch: [] }, keys: { parallel: KEY }, send: { parallel: fake.send } });
  await told.search({ objective: OBJECTIVE }, { n: 1, session: "task-3-seed-1" });
  await bare.search({ objective: OBJECTIVE }, { n: 1, session: "task-3-seed-2" });
  await bare.search({ objective: OBJECTIVE }, { n: 1 });
  assert.deepEqual(fake.sent.map(({ body }) => [body.session_id, body.client_model]), [["task-3-seed-1", "claude-opus-4-7"], ["task-3-seed-2", undefined], [undefined, undefined]], "the call's session wins, the Web's model kept; nothing made up");
});

test("Parallel's session_id is cut at its 1,000-character cap: a 1,500-character session, the call's or the Web's, is sent as its first 1,000", async () => {
  const long = "s".repeat(1_000) + "t".repeat(500);
  const fake = keyed(() => json({ results: [{ url: "https://a.example/", title: "A", excerpts: ["An excerpt."] }] }));
  const told = web.createWeb({ order: { search: ["parallel"], fetch: [] }, keys: { parallel: KEY }, send: { parallel: fake.send }, client: { session: long } });
  await told.search({ objective: OBJECTIVE }, { n: 1 });
  await told.search({ objective: OBJECTIVE }, { n: 1, session: long });
  assert.deepEqual(fake.sent.map(({ body }) => body.session_id), ["s".repeat(1_000), "s".repeat(1_000)], "each session_id is the session's first 1,000 characters");
});

test("Parallel's extract carries the search's session_id and client_model: the Web's client, or the call's own session (FetchOptions.session), the session cut at 1,000; with no client, neither", async () => {
  const long = "s".repeat(1_000) + "t".repeat(500);
  const fake = keyed((path, body) => (path === "/v1/extract" ? json({ results: [{ url: body.urls[0], title: "P", full_content: "# P\n\nThe page." }] }) : json({ results: [{ url: "https://a.example/", title: "A", excerpts: ["An excerpt."] }] })));
  const net = network();
  const guard = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage };
  const parts = { order: { search: ["parallel"], fetch: ["parallel"] }, keys: { parallel: KEY }, send: { parallel: fake.send }, guard };
  const told = web.createWeb({ ...parts, client: { model: "claude-opus-4-7", session: long } });
  const bare = web.createWeb(parts);
  await told.search({ objective: OBJECTIVE }, { n: 1 });
  const read = await told.fetch("http://public.example/?run=web");
  await told.fetch("http://public.example/?run=call", { session: "task-3-seed-1" });
  await bare.fetch("http://public.example/?run=bare");
  assert.equal(read.answer.ok, true, "the read is Parallel's page");
  const searched = fake.sent.find(({ path }) => path === "/v1/search").body;
  const extracts = fake.sent.filter(({ path }) => path === "/v1/extract").map(({ body }) => [body.session_id, body.client_model]);
  assert.deepEqual(extracts[0], [searched.session_id, searched.client_model], "the extract's session_id and client_model are the ones the Web's search sends");
  assert.deepEqual(extracts, [["s".repeat(1_000), "claude-opus-4-7"], ["task-3-seed-1", "claude-opus-4-7"], [undefined, undefined]], "the Web's session cut at 1,000, the call's session over it with the Web's model kept, and nothing with no client");
});
