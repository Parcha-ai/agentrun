// Each provider's settings, typed with defaults, as createWeb takes them (WebConfig.settings): Parallel's here, through
// createWeb on the tests' fake Parallel; Exa's and Firecrawl's in their own tests. With no settings each request is the
// one the web tools have always sent, byte for byte.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import fakeParallel, { CANARY, resetFauxParallel } from "./fixtures/faux-parallel.mjs";
import { network } from "./fixtures/fake-network.mjs";
import { withEnv } from "./support.mjs";

const PUBLIC = "http://public.example/";

function parallelWeb(t, settings) {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_PARALLEL_SEARCH", "AGENTRUN_TEST_FAUX_PARALLEL_EXTRACT", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS"]);
  resetFauxParallel();
  const sent = [];
  const fees = [];
  const net = network();
  const guard = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage };
  const send = async (url, init) => (sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) }), fakeParallel(url, init));
  const w = web.createWeb({ order: { search: ["parallel"], fetch: ["parallel"] }, keys: { parallel: CANARY }, ...(settings ? { settings: { parallel: settings } } : {}), send: { parallel: send }, guard, pay: async (fee, go) => (fees.push(fee), go()) });
  return { w, sent, fees };
}

test("Parallel with no settings: the search and extract the web tools have always sent", async (t) => {
  const { w, sent } = parallelWeb(t);
  await w.search("widgets delaware", { n: 3 });
  await w.fetch(PUBLIC);
  assert.deepEqual(sent, [
    { path: "/v1/search", body: { objective: "widgets delaware", search_queries: ["widgets delaware"], mode: "fast", advanced_settings: { max_results: 3, excerpt_settings: { max_chars_per_result: 3_000 } } } },
    { path: "/v1/extract", body: { urls: [PUBLIC], advanced_settings: { full_content: { max_chars_per_result: 1_000_001 } } } },
  ]);
  assert.deepEqual(web.PARALLEL_DEFAULTS, { mode: "fast" });
});

test("Parallel's settings shape its requests and fee: mode, total excerpt characters, domains, a date floor, freshness", async (t) => {
  const { w, sent, fees } = parallelWeb(t, { mode: "advanced", maxCharsTotal: 20_000, includeDomains: [".gov"], excludeDomains: ["spam.gov"], afterDate: "2026-01-01", maxAgeSeconds: 3_600 });
  await w.search("widgets delaware", { n: 3 });
  await w.fetch(PUBLIC);
  assert.deepEqual(sent, [
    { path: "/v1/search", body: { objective: "widgets delaware", search_queries: ["widgets delaware"], mode: "advanced", max_chars_total: 20_000, advanced_settings: { max_results: 3, excerpt_settings: { max_chars_per_result: 3_000 }, source_policy: { include_domains: [".gov"], exclude_domains: ["spam.gov"], after_date: "2026-01-01" }, fetch_policy: { max_age_seconds: 3_600 } } } },
    { path: "/v1/extract", body: { urls: [PUBLIC], advanced_settings: { full_content: { max_chars_per_result: 1_000_001 }, fetch_policy: { max_age_seconds: 3_600 } } } },
  ]);
  assert.deepEqual(fees.map((fee) => fee.usd), [0.005, 0.001], "an advanced search $0.005, an extract $0.001");
});

test("settings Parallel does not take are refused when the Web is made", () => {
  for (const parallel of [{ mode: "pro" }, { maxAgeSeconds: 300 }, { afterDate: "last week" }, { maxCharsTotal: 0 }, { includeDomains: [1] }, { bogus: 1 }]) {
    assert.throws(() => web.createWeb({ order: { search: ["parallel"], fetch: [] }, keys: { parallel: CANARY }, settings: { parallel } }), /Parallel/, JSON.stringify(parallel));
  }
  assert.throws(() => web.createWeb({ order: { search: [], fetch: [] }, settings: { brave: {} } }), /brave/);
});
