// Holds known before a Web is made (serve's, from the runs before: a keyless provider rate-limited or out of quota for
// the whole host) hold its breakers from the start: the tool's, or its key's across both tools, and a call's own breakers
// as well as the Web's. A hold already over is none. Each limit a breaker reads that leaves it holding is handed to
// `onHold`, so serve can hold it for the runs after.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { answers, dailyLimit, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const START = Date.parse("2026-11-24T12:00:00Z");
const MIDNIGHT = Date.parse("2026-11-25T00:00:00Z");
const guardOf = (net) => ({ fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage });
const turns = (receipt) => receipt.tries.map((one) => [one.provider, one.outcome]);
const keyless = (fc, extra = {}) => ({ order: { search: ["firecrawl-keyless"], fetch: ["firecrawl-keyless", "direct"] }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => START, ...extra });

test("a fetch hold known at the start: keyless Firecrawl is not asked for a page, and its search is not held", async (t) => {
  const fc = await firecrawlServer(t);
  const w = web.createWeb(keyless(fc, { holds: [{ provider: "firecrawl-keyless", tool: "fetch", kind: "rate", until: START + 60_000 }] }));
  const at = w.destinations();
  assert.deepEqual(at.fetch[0], { id: "firecrawl-keyless", access: "keyless", held: { kind: "rate", until: START + 60_000 } }, "the start line knows it");
  assert.deepEqual(at.search[0], { id: "firecrawl-keyless", access: "keyless" });
  const page = await w.fetch(PUBLIC);
  assert.deepEqual([page.answer.via, page.answer["firecrawl-keyless"]], ["direct", "not tried: rate-limited until 12:01 UTC"]);
  assert.deepEqual(turns(page.receipt), [["firecrawl-keyless", "held"], ["direct", "ok"]]);
  assert.equal(fc.calls("firecrawl_scrape"), 0);
  const found = await w.search("widgets");
  assert.equal(found.answer.provider, "firecrawl-keyless");
});

test("a key hold known at the start holds both tools, on the Web's breakers and on a call's own", async (t) => {
  const fc = await firecrawlServer(t);
  const w = web.createWeb(keyless(fc, { holds: [{ provider: "firecrawl-keyless", tool: "key", kind: "quota", until: MIDNIGHT }] }));
  const at = w.destinations();
  assert.deepEqual([at.search[0].held, at.fetch[0].held], [{ kind: "quota", until: MIDNIGHT }, { kind: "quota", until: MIDNIGHT }]);
  const page = await w.fetch(PUBLIC);
  assert.equal(page.answer["firecrawl-keyless"], "not tried: out of quota until 00:00 UTC");
  for (const options of [{}, { breakers: web.breakers(() => START) }, { breakers: web.breakers(() => START), keyLimits: "web" }]) {
    const found = await w.search("widgets", options);
    assert.deepEqual(turns(found.receipt), [["firecrawl-keyless", "held"]], JSON.stringify(Object.keys(options)));
  }
  assert.equal(fc.calls("firecrawl_search") + fc.calls("firecrawl_scrape"), 0);
});

test("a hold for the Web's life says so; one already over holds nothing", async (t) => {
  const fc = await firecrawlServer(t);
  const endless = web.createWeb(keyless(fc, { holds: [{ provider: "firecrawl-keyless", tool: "fetch", kind: "quota", until: Number.POSITIVE_INFINITY }] }));
  assert.equal((await endless.fetch(PUBLIC)).answer["firecrawl-keyless"], "not tried: out of quota for the rest of this run");
  const over = web.createWeb(keyless(fc, { holds: [{ provider: "firecrawl-keyless", tool: "key", kind: "quota", until: START }] }));
  assert.deepEqual(over.destinations().fetch[0], { id: "firecrawl-keyless", access: "keyless" });
  const page = await over.fetch(PUBLIC);
  assert.equal(page.answer.via, "firecrawl-keyless");
  assert.equal(fc.calls("firecrawl_scrape"), 1);
});

test("onHold: a fetch's rate limit holds the fetch; a daily limit met on a search holds the key, then the search", async (t) => {
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 }) : name === "firecrawl_search" ? dailyLimit("search") : answers(name)));
  const held = [];
  const w = web.createWeb(keyless(fc, { onHold: (hold) => held.push(hold) }));
  await w.fetch(PUBLIC);
  assert.deepEqual(held, [{ provider: "firecrawl-keyless", tool: "fetch", kind: "rate", until: START + 30_000 }]);
  held.length = 0;
  await w.search("widgets", { breakers: web.breakers(() => START), keyLimits: "web" });
  const until = w.destinations().search[0].held?.until;
  assert.equal(until, MIDNIGHT);
  assert.deepEqual(held, [{ provider: "firecrawl-keyless", tool: "key", kind: "quota", until }, { provider: "firecrawl-keyless", tool: "search", kind: "quota", until }]);
});

test("a success or a failure that meets no limit hands nothing to onHold", async (t) => {
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? refusal("UPSTREAM_ERROR") : answers(name)));
  const held = [];
  const w = web.createWeb(keyless(fc, { onHold: (hold) => held.push(hold) }));
  await w.search("widgets");
  await w.fetch(PUBLIC);
  assert.deepEqual(held, []);
});
