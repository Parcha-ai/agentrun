// Parallel's published prices as a web tool's request is booked at them (fees.ts parallelFeeOf), by the request's
// own body: a search by its mode and the results it asks for, an extract by its URLs. The figures are Parallel's pricing
// page's (https://docs.parallel.ai/resources/pricing, read 2026-11-20), worked out by hand, not read from the code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parallelFeeOf } from "../dist/index.js";

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
