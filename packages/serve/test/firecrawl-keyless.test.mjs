// Keyless Firecrawl, the default backend of web_search and web_fetch on a server with no key: Firecrawl's public MCP
// endpoint asked with no key and no header of ours, keyless Exa behind it for web_search and the guarded direct fetch
// behind it for web_fetch. Its refusals are read by their code alone: KEYLESS_QUOTA_EXHAUSTED turns Firecrawl off for
// the run (the backend behind it answers that same call), KEYLESS_LIMIT_REACHED holds it for the wait it names. A
// private, loopback, link-local or intranet URL never goes to Firecrawl. Firecrawl is a fake MCP server on loopback
// (fixtures/fake-firecrawl.mjs), Exa the faux module (fixtures/faux-exa.mjs), the network a table
// (fixtures/fake-network.mjs): no socket leaves the machine, no real key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { explainCapability, planeFor, PROVIDERS, TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { FAUX_FIRECRAWL_ENV, firecrawlFetch, firecrawlScrape, firecrawlSearch } from "../dist/firecrawl-keyless.js";
import { fetchFor, firecrawlOf, webFetch, webFetchTool } from "../dist/web-fetch.js";
import { SEARCH_UNAVAILABLE, searchBreaker, searchInTurn, webSearchTool } from "../dist/web-search.js";
import { RATE_LIMITED } from "../dist/keyless-mcp.js";
import { RATE_LIMITED as EXA_RATE_LIMITED } from "../dist/exa-keyless.js";
import { fauxEnvOf } from "../dist/server.js";
import { withoutFaux } from "../dist/model.js";
import { firecrawlServer, FIRECRAWL_SIGNUP, PAGE, refusal, answers } from "./fixtures/fake-firecrawl.mjs";
import { resetFauxExa } from "./fixtures/faux-exa.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { FAUX, scratch, withEnv } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const PUBLIC = "http://public.example/";
const base = { gateway: false, parallelKey: false, facts: undefined };
/** The JSON a call's text leads with. */
const said = (result) => JSON.parse(result.output[0].text.split("\n")[0]);
/** The lines a fake filed in `file`, parsed; none before it filed one. */
const filed = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** A run's env whose plane resolves both web tools to keyless Firecrawl, its fake at `url`, and Exa's faux module
 *  answering as `exaMode` says: the env, and how many searches reached Exa so far. */
async function keyless(t, url, exaMode = "ok") {
  const calls = join(await scratch(t), "exa.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA: exaMode, AGENTRUN_TEST_FAUX_EXA_CALLS: calls });
  resetFauxExa();
  const env = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "firecrawl-keyless", web_fetch: "firecrawl-keyless" }), AGENTRUN_SERVE_FAUX: FAUX, [FAUX_FIRECRAWL_ENV]: url, AGENTRUN_SERVE_FAUX_EXA: fixture("faux-exa.mjs") };
  return { env, exaSearches: async () => (await filed(calls)).filter((call) => call.method === "tools/call").length };
}

/** One run's web_search, bound as a run binds it, on the breakers' clock `now`: each call's tool result. */
function searchRun(env, now = Date.now, boundMs) {
  const tool = webSearchTool(env, undefined, undefined, now, boundMs);
  let n = 0;
  return (query) => tool.execute({ query }, { callId: `call-${(n += 1)}` }, {});
}

test("with no key, web_search and web_fetch resolve to keyless Firecrawl on every harness that has no native search; a Parallel key wins for web_search and keeps web_fetch direct; explicit picks keep their meaning", () => {
  assert.deepEqual(PROVIDERS.web_fetch, ["auto", "firecrawl-keyless", "kernel", "parallel"]);
  assert.ok(PROVIDERS.web_search.includes("firecrawl-keyless"));
  for (const harness of ["pi", "opencode"]) {
    assert.equal(explainCapability("web_search", { ...base, harness }).resolves, "firecrawl-keyless", harness);
    assert.equal(explainCapability("web_fetch", { ...base, harness }).resolves, "firecrawl-keyless", harness);
  }
  assert.deepEqual(planeFor({}, { tools: ["web_search", "web_fetch"] }, {}), { web_search: "firecrawl-keyless", web_fetch: "firecrawl-keyless" }, "a run's plane on a server with no key");
  const keyed = { PARALLEL_API_KEY: "not-a-secret" };
  assert.deepEqual(planeFor(keyed, { tools: ["web_search", "web_fetch"] }, {}), { web_search: "parallel", web_fetch: "kernel" }, "the Parallel key wins: search on it, and no URL goes to a keyless service");
  // The privacy line, where the resolution is shown.
  const fetchWhy = explainCapability("web_fetch", { ...base, harness: "pi" }).why;
  assert.match(fetchWhy, /web_fetch sends each URL to Firecrawl's keyless service/);
  assert.match(fetchWhy, /set PARALLEL_API_KEY or choose kernel to fetch directly/);
  assert.equal(explainCapability("web_fetch", { ...base, harness: "pi", pick: "kernel" }).resolves, "kernel");
  assert.equal(explainCapability("web_fetch", { ...base, harness: "pi", parallelKey: true, pick: "firecrawl-keyless" }).resolves, "firecrawl-keyless", "a pick of Firecrawl is Firecrawl, key or not");
  assert.equal(explainCapability("web_search", { ...base, harness: "pi", parallelKey: true, pick: "exa-keyless" }).resolves, "exa-keyless");
  assert.equal(explainCapability("web_search", { ...base, harness: "pi", pick: "firecrawl-keyless", parallelKey: true }).resolves, "firecrawl-keyless");
});

test("a search is one tools/call of firecrawl_search with {query, limit}, no key and no header of ours, and no session where Firecrawl names none; its results read into the hit shape every provider answers", async (t) => {
  const fc = await firecrawlServer(t);
  const { env, exaSearches } = await keyless(t, fc.url);
  const found = said(await searchRun(env)("widgets"));
  assert.deepEqual(found, {
    provider: "firecrawl-keyless",
    query: "widgets",
    results: [
      { url: "https://first.example/widgets", title: "Widgets, explained", snippet: "All about widgets and their uses." },
      { url: "https://second.example/gadgets", title: "Gadgets", snippet: "A second result." },
    ],
  });
  assert.deepEqual(fc.got.map((one) => one.body.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.deepEqual(fc.toolCalls()[0].body.params, { name: "firecrawl_search", arguments: { query: "widgets", limit: 10 } });
  for (const { headers } of fc.got) {
    for (const name of ["authorization", "x-api-key", "cookie", "mcp-session-id"]) assert.equal(headers[name], undefined, name);
    assert.equal(headers["mcp-protocol-version"], "2025-06-18");
  }
  assert.equal(await exaSearches(), 0, "Exa was not asked");
});

test("a fetch is one tools/call of firecrawl_scrape with {url, formats: [markdown]}: the page's markdown, via firecrawl-keyless, nothing dialled directly", async (t) => {
  const fc = await firecrawlServer(t);
  const { env } = await keyless(t, fc.url);
  const net = network();
  const page = await fetchFor(env, PUBLIC, net);
  assert.equal(page.via, "firecrawl-keyless");
  assert.deepEqual([page.ok, page.url, page.status, page.title, page.text], [true, PUBLIC, 200, "Read by Firecrawl", PAGE.markdown]);
  assert.deepEqual(page.links, ["https://registry.example/1"]);
  assert.deepEqual(fc.toolCalls().map((one) => one.body.params), [{ name: "firecrawl_scrape", arguments: { url: PUBLIC, formats: ["markdown"] } }]);
  assert.deepEqual(net.dialled, [], "the guard checked the URL without dialling it");
  for (const { headers } of fc.got) assert.equal(headers.authorization, undefined);
});

for (const where of ["text", "structured"]) {
  test(`KEYLESS_QUOTA_EXHAUSTED (in its ${where}): Exa answers that same call, the run's next call skips Firecrawl, and a new run asks Firecrawl again`, async (t) => {
    const fc = await firecrawlServer(t, (name) => (name === "firecrawl_search" ? refusal("KEYLESS_QUOTA_EXHAUSTED", { where }) : answers(name)));
    const { env, exaSearches } = await keyless(t, fc.url);
    const search = searchRun(env);
    const first = said(await search("widgets"));
    assert.equal(first.provider, "exa-keyless", JSON.stringify(first));
    assert.ok(first.results.length > 0);
    assert.equal(fc.calls("firecrawl_search"), 1);
    const second = said(await search("gadgets"));
    assert.equal(second.provider, "exa-keyless");
    assert.equal(fc.calls("firecrawl_search"), 1, "Firecrawl is off for the rest of the run: no second call reached it");
    assert.equal(await exaSearches(), 2);
    // Another run's binding starts with its breakers closed.
    await searchRun(env)("widgets");
    assert.equal(fc.calls("firecrawl_search"), 2, "a new run asks Firecrawl again");
  });
}

test("KEYLESS_LIMIT_REACHED with retry_after_seconds is a wait, never a cutoff: Exa answers in the wait, and past it Firecrawl is asked again", async (t) => {
  let limited = true;
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_search" && limited ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 }) : answers(name)));
  const { env } = await keyless(t, fc.url);
  let now = Date.parse("2026-11-23T12:00:00Z");
  const search = searchRun(env, () => now);
  assert.equal(said(await search("widgets")).provider, "exa-keyless", "Exa answers the call Firecrawl limited");
  now += 20_000;
  assert.equal(said(await search("widgets")).provider, "exa-keyless");
  assert.equal(fc.calls("firecrawl_search"), 1, "within its 30 s Firecrawl is not asked");
  limited = false;
  now += 11_000;
  assert.equal(said(await search("widgets")).provider, "firecrawl-keyless", "past the wait Firecrawl answers again");
  assert.equal(fc.calls("firecrawl_search"), 2);
});

test("an HTTP 429 from Firecrawl is a rate limit with its Retry-After; Firecrawl's own words and sign-up link never reach the model", async (t) => {
  const fc = await firecrawlServer(t, () => ({ status: 429, headers: { "retry-after": "5" } }));
  // No Exa named under --faux: Firecrawl answers alone.
  const env = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "firecrawl-keyless" }), AGENTRUN_SERVE_FAUX: FAUX, [FAUX_FIRECRAWL_ENV]: fc.url };
  let now = Date.parse("2026-11-23T12:00:00Z");
  const search = searchRun(env, () => now);
  assert.deepEqual(said(await search("widgets")), { error: RATE_LIMITED });
  assert.match(said(await search("widgets")).error, /^search is busy; try again in 5 s/);
  assert.equal(fc.calls("firecrawl_search"), 1);
  const quota = await firecrawlServer(t, () => refusal("KEYLESS_QUOTA_EXHAUSTED"));
  const answer = await searchRun({ ...env, [FAUX_FIRECRAWL_ENV]: quota.url })("widgets");
  assert.doesNotMatch(answer.output[0].text, /signup|Sign up|firecrawl\.dev/i, answer.output[0].text);
  assert.equal(RATE_LIMITED, EXA_RATE_LIMITED, "Firecrawl's rate limit reads in keyless Exa's words");
});

test("both keyless backends out for the run: web_search answers SEARCH_UNAVAILABLE, unsent", async () => {
  const breakers = new Map();
  const breakerOf = (name) => breakers.get(name) ?? breakers.set(name, searchBreaker(() => 0)).get(name);
  let asked = 0;
  const out = (name) => ({ name, ask: async () => ((asked += 1), { answer: { error: `${name} out` }, limit: { kind: "quota" } }) });
  const backends = [out("firecrawl-keyless"), out("exa-keyless")];
  assert.deepEqual(await searchInTurn(backends, breakerOf), { error: SEARCH_UNAVAILABLE });
  assert.equal(asked, 2, "each asked once");
  assert.deepEqual(await searchInTurn(backends, breakerOf), { error: SEARCH_UNAVAILABLE });
  assert.equal(asked, 2, "neither asked again");
});

test("Firecrawl out of quota for web_fetch: the page comes from the guarded direct fetch, and the run's later fetches go straight there", async (t) => {
  const fc = await firecrawlServer(t, () => refusal("KEYLESS_QUOTA_EXHAUSTED"));
  const { env } = await keyless(t, fc.url);
  const net = network();
  const page = await fetchFor(env, PUBLIC, net);
  assert.deepEqual([page.ok, page.via, page.title], [true, "direct", "Public page"]);
  assert.doesNotMatch(JSON.stringify(page), /signup|firecrawl\.dev/i);
  const other = await fetchFor(env, "http://public.example/notes.txt", net);
  assert.deepEqual([other.ok, other.via, other.text], [true, "direct", "Plain notes."]);
  assert.equal(fc.calls("firecrawl_scrape"), 1, "off for the run after the first");
  assert.deepEqual(net.dialled, [PUBLIC, "http://public.example/notes.txt"]);
});

test("a fetch Firecrawl rate-limits goes direct for the wait it named, and to Firecrawl again past it", async (t) => {
  let limited = true;
  const fc = await firecrawlServer(t, (name) => (limited ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 10 }) : answers(name)));
  let now = Date.parse("2026-11-23T12:00:00Z");
  const firecrawl = firecrawlFetch({ endpoint: fc.url }, () => now);
  const read = (url) => webFetch(url, { ...network(), firecrawl });
  assert.equal((await read(PUBLIC)).via, "direct");
  limited = false;
  now += 5_000;
  assert.equal((await read("http://public.example/notes.txt")).via, "direct", "within the wait");
  assert.equal(fc.calls("firecrawl_scrape"), 1);
  now += 6_000;
  assert.equal((await read(PUBLIC)).via, "firecrawl-keyless", "past it");
  assert.equal(fc.calls("firecrawl_scrape"), 2);
});

test("a page Firecrawl scraped with a status that is not 2xx is no read: the fetch goes direct, as for a refusal, and Firecrawl's breaker stays shut", async (t) => {
  for (const statusCode of [404, 500]) {
    const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? { content: [{ type: "text", text: JSON.stringify({ ...PAGE, metadata: { ...PAGE.metadata, statusCode } }) }] } : answers(name)));
    const { env } = await keyless(t, fc.url);
    const net = network();
    const page = await fetchFor(env, PUBLIC, net);
    assert.deepEqual([page.ok, page.via, page.title], [true, "direct", "Public page"], `${statusCode}: ${JSON.stringify(page)}`);
    assert.doesNotMatch(page.text, /Read by Firecrawl/, "Firecrawl's page is never the answer");
    assert.deepEqual(net.dialled, [PUBLIC]);
    const read = await firecrawlScrape(PUBLIC, { endpoint: fc.url });
    assert.deepEqual(read, { error: `Firecrawl's fetch: the page answered ${statusCode}` });
    await fetchFor(env, "http://public.example/notes.txt", net);
    assert.equal(fc.calls("firecrawl_scrape"), 3, "no limit: Firecrawl is asked again");
  }
});

test("one deadline for a whole search: a Firecrawl that never answers spends it, and Exa is handed what is left of it, never a fresh bound", async (t) => {
  const fc = await firecrawlServer(t, () => new Promise(() => {}));
  const { env } = await keyless(t, fc.url);
  const calls = process.env.AGENTRUN_TEST_FAUX_EXA_CALLS;
  await searchRun(env, Date.now, 50)("widgets");
  assert.equal(fc.calls("firecrawl_search"), 1, "Firecrawl was asked first");
  const exa = await filed(calls);
  assert.ok(exa.length > 0, "Exa was asked after Firecrawl");
  assert.ok(exa.every((call) => call.aborted === true), `Exa's every request carried the search's one deadline, spent: ${JSON.stringify(exa)}`);
});

test("a scrape reads up to the direct fetch's 5 MiB, past search's 1 MiB; one past that is refused in words, never parsed cut, and the fetch goes direct; search keeps 1 MiB", async (t) => {
  const big = (chars) => ({ content: [{ type: "text", text: JSON.stringify({ markdown: `# Big\n\n${"a".repeat(chars)}`, metadata: { title: "Big", sourceURL: PUBLIC, statusCode: 200 } }) }] });
  let chars = 2 * 1024 * 1024;
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? big(chars) : { content: [{ type: "text", text: JSON.stringify({ success: true, data: { web: [{ url: "https://first.example/", title: "x".repeat(2 * 1024 * 1024), description: "" }] } }) }] }));
  const two = await firecrawlScrape(PUBLIC, { endpoint: fc.url });
  assert.deepEqual([two.ok, two.title, two.beyond], [true, "Big", true], "a 2 MiB page is read whole by Firecrawl, its text then cut as any page's");
  chars = 6 * 1024 * 1024;
  assert.deepEqual(await firecrawlScrape(PUBLIC, { endpoint: fc.url }), { error: "Firecrawl's fetch answered more than 5 MiB: not read" });
  const { env } = await keyless(t, fc.url);
  const page = await fetchFor(env, PUBLIC, network());
  assert.deepEqual([page.ok, page.via, page.title], [true, "direct", "Public page"]);
  assert.deepEqual(await firecrawlSearch("widgets", 2, { endpoint: fc.url }), { error: "Firecrawl's search answered more than 1 MiB: not read" });
});

test("a private, loopback, link-local or intranet URL never goes to Firecrawl: each is answered as the direct fetch alone answers it", async (t) => {
  const fc = await firecrawlServer(t);
  const { env } = await keyless(t, fc.url);
  const kernel = { [TOOL_PLANE_ENV]: JSON.stringify({ web_fetch: "kernel" }) };
  // The table's names, and an intranet's: a .internal and a .local name resolving to private addresses.
  const intranet = { "wiki.corp.internal": ["10.20.30.40"], "printer.local": ["192.168.1.20"] };
  const net = () => {
    const table = network();
    return { ...table, lookup: async (host, ...rest) => intranet[host] ?? table.lookup(host, ...rest) };
  };
  const urls = ["http://127.0.0.1/x", "http://10.0.0.5/x", "http://localhost/x", "http://wiki.corp.internal/x", "http://printer.local/x", "http://[::1]/x", "http://169.254.169.254/latest/meta-data/", "http://evil.example/", "http://mixed.example/"];
  for (const url of urls) {
    const viaFirecrawl = await fetchFor(env, url, net());
    const direct = await fetchFor(kernel, url, net());
    assert.deepEqual(viaFirecrawl, direct, url);
    assert.equal(viaFirecrawl.ok, false, url);
    assert.match(viaFirecrawl.refused ?? "", /^refused: /, `${url}: ${JSON.stringify(viaFirecrawl)}`);
  }
  assert.equal(fc.calls("firecrawl_scrape"), 0, "Firecrawl was sent none of them");
  // The same setup sends a public URL: the check above is not vacuous.
  assert.equal((await fetchFor(env, PUBLIC, net())).via, "firecrawl-keyless");
  assert.equal(fc.calls("firecrawl_scrape"), 1);
});

test("under --faux with no fake named, keyless Firecrawl is never asked: web_fetch fetches directly and web_search answers why it cannot search", async () => {
  const env = { [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "firecrawl-keyless", web_fetch: "firecrawl-keyless" }), AGENTRUN_SERVE_FAUX: FAUX };
  assert.equal(await firecrawlOf(env), null);
  const net = network();
  assert.equal((await fetchFor(env, PUBLIC, net)).via, "direct");
  assert.match(said(await searchRun(env)("widgets")).error, /under --faux/);
  // The tool's words name the third party where it may be asked.
  assert.match(webFetchTool(env).description, /firecrawl-keyless when Firecrawl's keyless service read it \(it is sent the URL\)/);
});

test("the server hands a run the fake's URL as given, under --faux only, and its own environment's never reaches a run", () => {
  const url = "http://127.0.0.1:9/v2/mcp-abc";
  assert.equal(fauxEnvOf({ faux: FAUX, fauxFirecrawl: url })[FAUX_FIRECRAWL_ENV], url, "a URL, not resolved as a path");
  assert.equal(fauxEnvOf({ fauxFirecrawl: url })[FAUX_FIRECRAWL_ENV], undefined, "not without --faux");
  assert.equal(withoutFaux({ [FAUX_FIRECRAWL_ENV]: url, KEEP: "1" })[FAUX_FIRECRAWL_ENV], undefined);
});
