// Parallel's published prices as a web tool's request is booked at them (fees.ts parallelFeeOf), by the request's
// own body: a search by its mode and the results it asks for, an extract by its URLs. The figures are Parallel's pricing
// page's (https://docs.parallel.ai/resources/pricing, read 2026-11-20), worked out by hand, not read from the code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exaFeeOf, firecrawlFeeOf, parallelFeeOf } from "../dist/index.js";

const SEARCH = "https://api.parallel.ai/v1/search";
const EXTRACT = "https://api.parallel.ai/v1/extract";
const search = (mode, max_results) => ({ objective: "widgets", search_queries: ["widgets"], ...(mode === undefined ? {} : { mode }), ...(max_results === undefined ? {} : { advanced_settings: { max_results } }) });

test("a search in turbo or fast mode is $1 per 1,000 requests, 10 results included, each past them $1 per 1,000", () => {
  for (const mode of ["turbo", "fast"]) {
    assert.equal(parallelFeeOf(SEARCH, search(mode)).usd, 0.001, `${mode}, 10 results by default`);
    assert.equal(parallelFeeOf(SEARCH, search(mode, 10)).usd, 0.001, mode);
    assert.equal(parallelFeeOf(SEARCH, search(mode, 25)).usd, 0.016, `${mode}: $0.001 and 15 more results at $0.001`);
  }
  // What the web tools send: fast, in the words its refusals have always said.
  assert.equal(parallelFeeOf(SEARCH, search("fast", 3)).basis, "Parallel's list price for a fast search");
});

test("a search in basic or advanced mode is $5 per 1,000 requests, 10 results included, each past them $1 per 1,000", () => {
  for (const mode of ["basic", "advanced"]) {
    const fee = parallelFeeOf(SEARCH, search(mode, 10));
    assert.deepEqual([fee.usd, fee.by, fee.basis], [0.005, "parallel", `Parallel's list price for a ${mode} search`]);
    assert.equal(parallelFeeOf(SEARCH, search(mode)).usd, 0.005, `${mode}, 10 results by default`);
    assert.equal(parallelFeeOf(SEARCH, search(mode, 12)).usd, 0.007, `${mode}: $0.005 and 2 more results at $0.001`);
  }
});

test("a search in a mode with no price here, or naming none, has no fee: never $0, never fast's price", () => {
  for (const body of [search("ultra"), search(""), search(undefined), search(7), search("toString"), search("__proto__"), undefined]) {
    assert.equal(parallelFeeOf(SEARCH, body), undefined, JSON.stringify(body));
  }
});

test("an extract is $1 per 1,000 URLs; an endpoint the web tools do not ask has no fee", () => {
  assert.equal(parallelFeeOf(EXTRACT, { urls: ["https://a.example/"] }).usd, 0.001);
  assert.equal(parallelFeeOf(EXTRACT, { urls: ["https://a.example/", "https://b.example/", "https://c.example/"] }).usd, 0.003);
  assert.equal(parallelFeeOf("https://api.parallel.ai/v1/tasks/runs", { input: "x" }), undefined);
});

// Exa's and Firecrawl's list prices, read 2026-11-24 (https://exa.ai/pricing; https://www.firecrawl.dev/pricing, at the
// key's Standard plan: $99 a month for 100,000 credits), worked out by hand.

// Exa's own cost report (costDollars, 2026-11-24 06:47Z) bills a search's text and highlights at nothing: auto with text,
// with text and highlights, or with neither, 3 results, $0.007 each; 12 results $0.009. Its pricing page's $1 per 1,000
// pages for each content is a contents request's; a search's AI page summaries are $1 per 1,000 pages.
test("an Exa search is its type's price per request, 10 results included, $0.001 each past them; its text and highlights are in that price, a summary $0.001 a result", () => {
  const body = (type, numResults, contents) => ({ query: "q", ...(type ? { type } : {}), ...(numResults ? { numResults } : {}), ...(contents ? { contents } : {}) });
  assert.equal(exaFeeOf("/search", body("auto")).usd, 0.007, "auto, 10 results, no contents");
  assert.equal(exaFeeOf("/search", body(undefined)).usd, 0.007, "no type is Exa's auto");
  assert.equal(exaFeeOf("/search", body("fast", 3, { highlights: { maxCharacters: 3_000 } })).usd, 0.007);
  assert.equal(exaFeeOf("/search", body("instant", 10, { text: { maxCharacters: 500 } })).usd, 0.004);
  assert.equal(exaFeeOf("/search", body("lite", 10, { highlights: true })).usd, 0.004);
  assert.equal(exaFeeOf("/search", body("auto", 12, { highlights: {} })).usd, 0.009, "as Exa's own cost report billed it");
  assert.equal(exaFeeOf("/search", body("deep", 25, { highlights: {}, text: {} })).usd, 0.027, "$0.012 and 15 more results");
  assert.equal(exaFeeOf("/search", body("auto", 3, { summary: { query: "q" } })).usd, 0.01, "3 results' summaries at $0.001");
  assert.equal(exaFeeOf("/search", body("deep-lite")).usd, 0.012);
  assert.equal(exaFeeOf("/search", body("deep-reasoning")).usd, 0.015);
  assert.equal(exaFeeOf("/search", body("neural")), undefined, "a type with no price here: never $0, never another's price");
  assert.equal(exaFeeOf("/search", body("auto", 3, { summary: false })).usd, 0.007, "a summary set false is not asked");
});

test("an Exa contents request is $0.001 a URL for each content asked; an endpoint the web tools do not ask has no fee", () => {
  assert.equal(exaFeeOf("/contents", { urls: ["https://a.example/"], text: { maxCharacters: 1_000_001 } }).usd, 0.001);
  assert.equal(exaFeeOf("/contents", { urls: ["https://a.example/", "https://b.example/"], text: true, highlights: true }).usd, 0.004);
  assert.equal(exaFeeOf("/answer", { query: "q" }), undefined);
});

test("a Firecrawl search is 2 credits per 10 results (and each result it scrapes at its PDF page cap), a scrape its PDF page cap (and 4 more for JSON), at $0.00099 a credit; a proxy other than basic has no price", () => {
  const credits = (n) => Math.round(n * 0.00099 * 1e6) / 1e6;
  assert.equal(firecrawlFeeOf("/v2/search", { query: "q" }).usd, credits(2), "10 results by default");
  assert.equal(firecrawlFeeOf("/v2/search", { query: "q", limit: 3 }).usd, credits(2));
  assert.equal(firecrawlFeeOf("/v2/search", { query: "q", limit: 25 }).usd, credits(6));
  const read = (pages) => ({ proxy: "basic", parsers: [{ type: "pdf", maxPages: pages }] });
  assert.equal(firecrawlFeeOf("/v2/search", { query: "q", limit: 5, scrapeOptions: { formats: ["markdown"], ...read(2) } }).usd, credits(12));
  assert.equal(firecrawlFeeOf("/v2/search", { query: "q", limit: 5, scrapeOptions: { formats: ["markdown"] } }), undefined, "a scraping search leaving the proxy to Firecrawl");
  assert.equal(firecrawlFeeOf("/v2/scrape", { url: "https://a.example/", formats: ["markdown"], ...read(1) }).usd, credits(1));
  assert.equal(firecrawlFeeOf("/v2/scrape", { url: "https://a.example/", formats: ["markdown", { type: "json", prompt: "p" }], ...read(1) }).usd, credits(5));
  assert.equal(firecrawlFeeOf("/v2/scrape", { url: "https://a.example/", formats: ["markdown"] }), undefined, "a scrape leaving the proxy to Firecrawl");
  assert.equal(firecrawlFeeOf("/v2/crawl", { url: "https://a.example/" }), undefined);
});
