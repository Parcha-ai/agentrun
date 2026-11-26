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
import { beforeEach, test } from "node:test";
import { explainCapability, planeFor, PROVIDERS, TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { FAUX_FIRECRAWL_ENV, ordersOf, RATE_LIMITED } from "../dist/web-run.js";
import { firecrawlFetch, firecrawlScrape, firecrawlSearch } from "@parcha/agentrun-web";
import { fetchFor, webFetchTool } from "../dist/web-fetch.js";
import { webFetch } from "./fixtures/serve-web.mjs";
import { searchFor, webSearchTool } from "../dist/web-search.js";
import { fauxEnvOf } from "../dist/server.js";
import { withoutFaux } from "../dist/model.js";
import { firecrawlServer, FIRECRAWL_SIGNUP, PAGE, refusal, answers } from "./fixtures/fake-firecrawl.mjs";
import { resetFauxExa } from "./fixtures/faux-exa.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { FAUX, scratch, withEnv } from "./support.mjs";
import { forgetHolds } from "../dist/web-holds.js";

// Each case starts as on a server just started: no keyless hold a case before it met (web-holds.ts).
beforeEach(() => forgetHolds());

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
function searchRun(env, now = Date.now, bounds) {
  const tool = webSearchTool(env, undefined, undefined, now, bounds);
  let n = 0;
  return (query) => tool.execute({ query }, { callId: `call-${(n += 1)}` }, {});
}

test("with no key, web_search and web_fetch resolve to keyless Firecrawl on every harness that has no native search; a Parallel key wins for both, Parallel first with the guarded direct fetch behind it for web_fetch; explicit picks keep their meaning", () => {
  assert.deepEqual(PROVIDERS.web_fetch, ["auto", "firecrawl-keyless", "kernel", "parallel"]);
  assert.ok(PROVIDERS.web_search.includes("firecrawl-keyless"));
  for (const harness of ["pi", "opencode"]) {
    assert.equal(explainCapability("web_search", { ...base, harness }).resolves, "firecrawl-keyless", harness);
    assert.equal(explainCapability("web_fetch", { ...base, harness }).resolves, "firecrawl-keyless", harness);
  }
  assert.deepEqual(planeFor({}, { tools: ["web_search", "web_fetch"] }, {}), { web_search: "firecrawl-keyless", web_fetch: "firecrawl-keyless" }, "a run's plane on a server with no key");
  const keyed = { PARALLEL_API_KEY: "not-a-secret" };
  assert.deepEqual(planeFor(keyed, { tools: ["web_search", "web_fetch"] }, {}), { web_search: "parallel", web_fetch: "parallel" }, "the Parallel key wins for both: search and fetch on it, and no URL goes to a keyless service");
  // The privacy line, where the resolution is shown.
  const fetchWhy = explainCapability("web_fetch", { ...base, harness: "pi" }).why;
  assert.match(fetchWhy, /web_fetch sends each URL to Firecrawl's keyless service/);
  // A Parallel key now sends each URL to Parallel's extract (auto on a keyed server), so the way to fetch directly is kernel.
  assert.match(fetchWhy, /choose kernel to fetch directly/);
  assert.doesNotMatch(fetchWhy, /PARALLEL_API_KEY/, "the keyless fetch's why never advises a key that sends each URL to Parallel");
  assert.equal(explainCapability("web_fetch", { ...base, harness: "pi", pick: "kernel" }).resolves, "kernel");
  assert.equal(explainCapability("web_fetch", { ...base, harness: "pi", parallelKey: true, pick: "firecrawl-keyless" }).resolves, "firecrawl-keyless", "a pick of Firecrawl is Firecrawl, key or not");
  assert.equal(explainCapability("web_search", { ...base, harness: "pi", parallelKey: true, pick: "exa-keyless" }).resolves, "exa-keyless");
  assert.equal(explainCapability("web_search", { ...base, harness: "pi", pick: "firecrawl-keyless", parallelKey: true }).resolves, "firecrawl-keyless");
});

test("a search is one tools/call of firecrawl_search with {query, limit, objective, scrapeOptions}, no key and no header of ours, and no session where Firecrawl names none; its results read into the hit shape every provider answers", async (t) => {
  const fc = await firecrawlServer(t);
  const { env, exaSearches } = await keyless(t, fc.url);
  const found = said(await searchRun(env)("widgets"));
  assert.deepEqual(found, {
    provider: "firecrawl-keyless",
    objective: "widgets",
    queries: ["widgets"],
    results: [
      { url: "https://first.example/widgets", title: "Widgets, explained", snippet: "All about widgets and their uses." },
      { url: "https://second.example/gadgets", title: "Gadgets", snippet: "A second result." },
    ],
  });
  assert.deepEqual(fc.got.map((one) => one.body.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.deepEqual(fc.toolCalls()[0].body.params, { name: "firecrawl_search", arguments: { query: "widgets", limit: 10, objective: "widgets", scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } });
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
  test(`KEYLESS_QUOTA_EXHAUSTED (in its ${where}): Exa answers that same call, the run's next call skips Firecrawl, a new run starts held, and after a restart a new run asks Firecrawl again`, async (t) => {
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
    // The quota is the host's (web-holds.ts): a new run starts with it, until the server forgets it at a restart.
    await searchRun({ ...env })("widgets");
    assert.equal(fc.calls("firecrawl_search"), 1, "a new run starts held");
    forgetHolds();
    await searchRun({ ...env })("widgets");
    assert.equal(fc.calls("firecrawl_search"), 2, "after a restart a new run asks Firecrawl again");
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

test("one deadline for a whole search: a Firecrawl that never answers and spends all of it leaves Exa unasked, never handed a fresh bound or a spent one", async (t) => {
  const fc = await firecrawlServer(t, () => new Promise(() => {}));
  const { env, exaSearches } = await keyless(t, fc.url);
  const answer = said(await searchRun(env, Date.now, { searchMs: 50 })("widgets"));
  assert.equal(await exaSearches(), 0, "the search's one deadline was spent: Exa is not started on it");
  assert.equal(typeof answer.error, "string", JSON.stringify(answer));
});

// A search deadline belongs to the binding given it. Firecrawl answers in 500 ms here: past a 50 ms deadline, far inside
// the default's 60 s. The test fails on a deadline not applied, or applied to a search that was not given it.
test("a binding's search deadline is its own, whichever binding made the run's Web: a bound binding gives up within it, and the run's other searches are not held to it", { timeout: 15_000 }, async (t) => {
  const fc = await firecrawlServer(t, async (name) => (await new Promise((resolve) => setTimeout(resolve, 500)), answers(name)));
  const { env } = await keyless(t, fc.url);
  webSearchTool(env);
  const bound = said(await searchRun(env, Date.now, { searchMs: 50 })("widgets"));
  assert.equal(typeof bound.error, "string", `a binding bound after the run's Web was made still gives up within its deadline: ${JSON.stringify(bound)}`);
  const other = { ...env };
  said(await searchRun(other, Date.now, { searchMs: 50 })("widgets"));
  const node = await searchFor(other, { query: "widgets" });
  assert.equal(node.provider, "firecrawl-keyless", `a call node of the run is not held to a binding's deadline: ${JSON.stringify(node)}`);
});

// The test's own timeout is far past the bound it injects and far short of the default's 30 s: it fails on a bound not
// applied, and asserts nothing of the clock.
test("Firecrawl's search has its own bound inside the search's deadline: one that never answers leaves Exa the rest, a live signal, and Exa answers", { timeout: 15_000 }, async (t) => {
  const fc = await firecrawlServer(t, () => new Promise(() => {}));
  const { env } = await keyless(t, fc.url);
  const calls = process.env.AGENTRUN_TEST_FAUX_EXA_CALLS;
  const answer = said(await searchRun(env, Date.now, { searchMs: 10_000, firecrawlMs: 50 })("widgets"));
  assert.equal(answer.provider, "exa-keyless", JSON.stringify(answer));
  const exa = await filed(calls);
  assert.ok(exa.length > 0 && exa.every((call) => call.aborted === undefined), `Exa's every request went out on a live signal: ${JSON.stringify(exa)}`);
});

test("Firecrawl's scrape has its own bound: one that never answers goes direct within it, and the server logs why Firecrawl gave no page, never the URL", { timeout: 15_000 }, async (t) => {
  const fc = await firecrawlServer(t, () => new Promise(() => {}));
  const lines = [];
  const page = await webFetch(PUBLIC, { ...network(), firecrawl: firecrawlFetch({ endpoint: fc.url, timeoutMs: 50 }), log: (line) => lines.push(line) });
  assert.deepEqual([page.ok, page.via, page.title], [true, "direct", "Public page"]);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /event=web_fetch_firecrawl_failed /);
  assert.match(lines[0], /said="Firecrawl's fetch did not answer within 0\.05 s"/);
  assert.match(lines[0], /direct=read/);
  assert.doesNotMatch(lines[0], /public\.example/, "the URL is never logged");
});

test("a fetch Firecrawl refuses and the direct fetch saves logs Firecrawl's reason in the server's structured log; one Firecrawl reads logs nothing", async (t) => {
  let refuse = true;
  const fc = await firecrawlServer(t, (name) => (refuse ? refusal("KEYLESS_ACCESS_NOT_AVAILABLE") : answers(name)));
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal((await webFetch(PUBLIC, { ...network(), firecrawl: firecrawlFetch({ endpoint: fc.url }), log })).via, "direct");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^at=\S+ event=web_fetch_firecrawl_failed said="Keyless Firecrawl will not serve this server's fetches now/);
  assert.doesNotMatch(lines[0], /signup|firecrawl\.dev/i);
  refuse = false;
  assert.equal((await webFetch(PUBLIC, { ...network(), firecrawl: firecrawlFetch({ endpoint: fc.url }), log })).via, "firecrawl-keyless");
  assert.equal(lines.length, 1, "nothing logged for a page Firecrawl read");
});

test("a scrape reads up to the direct fetch's 5 MiB; one past that is refused in words, never parsed cut, and the fetch goes direct; a search, its results scraped, reads up to 8 MiB", async (t) => {
  const big = (chars) => ({ content: [{ type: "text", text: JSON.stringify({ markdown: `# Big\n\n${"a".repeat(chars)}`, metadata: { title: "Big", sourceURL: PUBLIC, statusCode: 200 } }) }] });
  let chars = 2 * 1024 * 1024;
  let searchChars = 2 * 1024 * 1024;
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? big(chars) : { content: [{ type: "text", text: JSON.stringify({ success: true, data: { web: [{ url: "https://first.example/", title: "x".repeat(searchChars), description: "" }] } }) }] }));
  const two = await firecrawlScrape(PUBLIC, { endpoint: fc.url });
  assert.deepEqual([two.ok, two.title, two.beyond], [true, "Big", true], "a 2 MiB page is read whole by Firecrawl, its text then cut as any page's");
  chars = 6 * 1024 * 1024;
  assert.deepEqual(await firecrawlScrape(PUBLIC, { endpoint: fc.url }), { error: "Firecrawl's fetch answered more than 5 MiB: not read" });
  const { env } = await keyless(t, fc.url);
  const page = await fetchFor(env, PUBLIC, network());
  assert.deepEqual([page.ok, page.via, page.title], [true, "direct", "Public page"]);
  assert.deepEqual((await firecrawlSearch("widgets", 2, { endpoint: fc.url })).results?.map((hit) => hit.url), ["https://first.example/"], "a 2 MiB search is read");
  searchChars = 9 * 1024 * 1024;
  assert.deepEqual(await firecrawlSearch("widgets", 2, { endpoint: fc.url }), { error: "Firecrawl's search answered more than 8 MiB: not read" });
});

/** A public URL holding a user name and password, a user name alone, a password alone: synthetic, built in code. */
const CREDENTIALED = [["u", "p"], ["u", ""], ["", "p"]].map(([user, password]) => {
  const url = new URL("http://public.example/x");
  url.username = user;
  url.password = password;
  return url.href;
});

test("a private, loopback, link-local or intranet URL, or one holding a user name or password, never goes to Firecrawl: each is answered as the direct fetch alone answers it", async (t) => {
  const fc = await firecrawlServer(t);
  const { env } = await keyless(t, fc.url);
  const kernel = { [TOOL_PLANE_ENV]: JSON.stringify({ web_fetch: "kernel" }) };
  // The table's names, and an intranet's: a .internal and a .local name resolving to private addresses.
  const intranet = { "wiki.corp.internal": ["10.20.30.40"], "printer.local": ["192.168.1.20"] };
  const net = () => {
    const table = network();
    return { ...table, lookup: async (host, ...rest) => intranet[host] ?? table.lookup(host, ...rest) };
  };
  const urls = ["http://127.0.0.1/x", "http://10.0.0.5/x", "http://localhost/x", "http://wiki.corp.internal/x", "http://printer.local/x", "http://[::1]/x", "http://169.254.169.254/latest/meta-data/", "http://evil.example/", "http://mixed.example/", ...CREDENTIALED];
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
  assert.deepEqual(ordersOf(env), { search: [], fetch: ["direct"] });
  const net = network();
  assert.equal((await fetchFor(env, PUBLIC, net)).via, "direct");
  assert.match(said(await searchRun(env)("widgets")).error, /under --faux/);
  // The tool's words say a URL may be sent to a reading service, and name none: every provider is asked through one text.
  assert.match(webFetchTool(env).description, /else the name of the reading service the URL was sent to/);
  assert.doesNotMatch(webFetchTool(env).description, /firecrawl/i);
});

test("the server hands a run the fake's URL as given, under --faux only, and its own environment's never reaches a run", () => {
  const url = "http://127.0.0.1:9/v2/mcp-abc";
  assert.equal(fauxEnvOf({ faux: FAUX, fauxFirecrawl: url })[FAUX_FIRECRAWL_ENV], url, "a URL, not resolved as a path");
  assert.equal(fauxEnvOf({ fauxFirecrawl: url })[FAUX_FIRECRAWL_ENV], undefined, "not without --faux");
  assert.equal(withoutFaux({ [FAUX_FIRECRAWL_ENV]: url, KEEP: "1" })[FAUX_FIRECRAWL_ENV], undefined);
});
