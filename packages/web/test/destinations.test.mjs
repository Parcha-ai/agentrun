// Where a Web's tools go, for serve's start line: each tool's order, each provider keyed (on the run's key), unkeyed (a
// keyed provider the run holds no key for), keyless, or neither (the model's own search, the direct fetch), and what holds
// it now, if anything. Never a key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { answers, firecrawlServer, refusal } from "./fixtures/fake-firecrawl.mjs";
import { EXA_CANARY } from "./fixtures/fake-keyed.mjs";
import { network } from "./fixtures/fake-network.mjs";

const PUBLIC = "http://public.example/";
const START = Date.parse("2026-11-24T12:00:00Z");
const guardOf = (net) => ({ fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage });

test("each tool's order, keyed or keyless, and what holds each provider now; the line names no key", async (t) => {
  const fc = await firecrawlServer(t, (name) => (name === "firecrawl_scrape" ? refusal("KEYLESS_LIMIT_REACHED", { retryAfter: 30 }) : answers(name)));
  const w = web.createWeb({ order: { search: ["exa", "firecrawl-keyless", "exa-keyless"], fetch: ["parallel", "firecrawl-keyless", "direct"] }, keys: { exa: EXA_CANARY }, endpoints: { "firecrawl-keyless": fc.url }, guard: guardOf(network()), now: () => START });
  assert.deepEqual(w.destinations(), {
    search: [{ id: "exa", access: "keyed" }, { id: "firecrawl-keyless", access: "keyless" }, { id: "exa-keyless", access: "keyless" }],
    fetch: [{ id: "parallel", access: "unkeyed" }, { id: "firecrawl-keyless", access: "keyless" }, { id: "direct", access: "none" }],
  });
  await w.fetch(PUBLIC);
  const after = w.destinations();
  assert.deepEqual(after.fetch[1], { id: "firecrawl-keyless", access: "keyless", held: { kind: "rate", until: START + 30_000 } });
  assert.deepEqual(after.search[1], { id: "firecrawl-keyless", access: "keyless" }, "a rate limit holds the tool that met it alone");
  const line = web.destinationsLine(after);
  assert.equal(line, "search: exa (keyed) > firecrawl-keyless (keyless) > exa-keyless (keyless); fetch: parallel (keyed, no key) > firecrawl-keyless (keyless, rate-limited until 12:01 UTC) > direct");
  assert.doesNotMatch(line, new RegExp(EXA_CANARY));
  assert.equal(web.destinationsLine({ search: [], fetch: [{ id: "direct", access: "none" }] }), "search: none; fetch: direct");
  assert.deepEqual(web.destinationsWords(after).search, "exa (keyed) > firecrawl-keyless (keyless) > exa-keyless (keyless)", "each tool's words, for a log line's fields");
});
