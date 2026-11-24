// Keyless Firecrawl and the backends behind it, read through web's own calls: searchInTurn with both keyless backends
// out for the run, a fetch Firecrawl rate-limits going to the guarded direct fetch for the wait it named, and a URL
// holding a user name or password never sent to Parallel's extract. Firecrawl is a fake MCP server on loopback
// (fixtures/fake-firecrawl.mjs), the network a table (fixtures/fake-network.mjs): no socket leaves the machine, no real
// key. The cases that go through serve's tools, its tool plane, fetchFor or its log lines stay in serve's
// firecrawl-keyless test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { firecrawlFetch, firecrawlScrape, firecrawlSearch, SEARCH_UNAVAILABLE, searchBreaker, searchInTurn } from "../dist/index.js";
import { answers, dailyLimit, FIRECRAWL_DAILY_INJECTION, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { webFetch } from "./support.mjs";

const PUBLIC = "http://public.example/";

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

/** Fails when `said` carries any of Firecrawl's daily-limit words addressed to the agent. */
const unsaid = (said, label) => {
  const text = JSON.stringify(said);
  for (const words of FIRECRAWL_DAILY_INJECTION) assert.ok(!text.includes(words), `${label}: "${words}" is never passed on`);
};

for (const where of ["search", "scrape", "rpc"]) {
  test(`Firecrawl's daily-limit answer (${where === "rpc" ? "a JSON-RPC error" : `as firecrawl_${where} served it`}) to a search or a fetch is a quota until the next 00:00 UTC, in our words alone`, async (t) => {
    const fc = await firecrawlServer(t, () => dailyLimit(where));
    const now = () => Date.parse("2026-11-24T12:00:00Z");
    const quota = { kind: "quota", retryAfter: "Wed, 25 Nov 2026 00:00:00 GMT" };
    for (const [what, read] of [["search", firecrawlSearch("widgets", 5, { endpoint: fc.url, now })], ["fetch", firecrawlScrape(PUBLIC, { endpoint: fc.url, now })]]) {
      const failed = await read;
      assert.deepEqual(failed.limit, quota, `${what}: a quota until 00:00 UTC`);
      unsaid(failed.error, what);
    }
  });
}

for (const where of ["scrape", "search"]) {
  test(`a fetch past Firecrawl's daily limit (as firecrawl_${where} served it) goes direct, and Firecrawl is unasked until 00:00 UTC, then asked again`, async (t) => {
    let spent = true;
    const fc = await firecrawlServer(t, (name) => (spent ? dailyLimit(where) : answers(name)));
    let now = Date.parse("2026-11-24T12:00:00Z");
    const firecrawl = firecrawlFetch({ endpoint: fc.url }, () => now);
    const read = (url) => webFetch(url, { ...network(), firecrawl });
    const first = await read(PUBLIC);
    assert.equal(first.via, "direct");
    unsaid(first, "the fetch");
    spent = false;
    now = Date.parse("2026-11-25T00:00:00Z") - 1;
    assert.equal((await read("http://public.example/notes.txt")).via, "direct", "a millisecond before 00:00 UTC");
    assert.equal(fc.calls("firecrawl_scrape"), 1);
    now += 1;
    assert.equal((await read(PUBLIC)).via, "firecrawl-keyless", "at 00:00 UTC");
    assert.equal(fc.calls("firecrawl_scrape"), 2);
  });
}

/** A public URL holding a user name and password, a user name alone, a password alone: synthetic, built in code. */
const CREDENTIALED = [["u", "p"], ["u", ""], ["", "p"]].map(([user, password]) => {
  const url = new URL("http://public.example/x");
  url.username = user;
  url.password = password;
  return url.href;
});

test("Parallel picked: a URL holding a user name or password is never sent to Parallel's extract; the direct fetch refuses it in words", async () => {
  const asked = [];
  const parallel = { live: () => true, read: async (url) => { asked.push(url); return "should not be asked"; }, post: async () => { throw new Error("not posted"); } };
  for (const url of CREDENTIALED) {
    const page = await webFetch(url, { ...network(), parallel });
    assert.deepEqual([page.ok, page.via, page.parallel, page.refused], [false, "direct", "not tried: the URL holds a user name or password", "refused: the URL holds a user name or password"], url);
  }
  assert.deepEqual(asked, [], "Parallel was sent none of them");
});
