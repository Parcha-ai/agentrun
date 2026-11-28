// What a keyed Firecrawl request holds and is charged, against Firecrawl's own credit rule: 2 credits per 10 search
// results (rounded up), and each document scraped at 1 credit, a PDF at 1 a page parsed (https://docs.firecrawl.dev/billing).
// PDF parsing is capped in every keyed body (parsers pdf maxPages: 2 for a search's results, 100 or the pdfMaxPages
// setting for a web_fetch) and the proxy pinned to basic, so the hold is the worst case under those caps; the charge is
// the creditsUsed Firecrawl reports, never above the hold, and the hold when it reports none it can be read by. Firecrawl
// is a fake send; the key is a canary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, publicFetch, readPage } from "@parcha/pi-browser";
import * as web from "../dist/index.js";
import { firecrawlScrapeBody, firecrawlSearchBody, firecrawlSettingsProblems } from "../dist/providers/firecrawl.js";
import { KEYED_MAX_BYTES } from "../dist/providers/keyed.js";
import { network } from "./fixtures/fake-network.mjs";

const CREDIT = 0.00099;
const credits = (n) => Math.round(n * CREDIT * 1e6) / 1e6;
const PUBLIC = "http://public.example/";
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const page = (metadata, markdown = "Page text.") => json({ success: true, data: { markdown, metadata: { title: "T", sourceURL: PUBLIC, url: PUBLIC, statusCode: 200, ...metadata } } });
const results = (creditsUsed, rows = [{ url: "https://a.example/", title: "A", markdown: "A's text." }]) => json({ success: true, data: { web: rows }, ...(creditsUsed === undefined ? {} : { creditsUsed }) });

/** A Web on a fake Firecrawl answering `answer(path, body)`, behind a cap that books what Pay's `charged` says, never
 *  above the hold, and $0 on a 4xx (as serve's paidRequest does). */
function firecrawlWeb(answer, settings) {
  const sent = [];
  const booked = [];
  const net = network();
  const guard = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage };
  const pay = async (fee, send, charged, settled) => {
    const response = await send();
    const said = charged?.();
    const usd = response.status >= 400 && response.status < 500 ? 0 : typeof said === "number" && Number.isFinite(said) && said >= 0 ? Math.min(said, fee.usd) : fee.usd;
    booked.push({ name: fee.name, hold: fee.usd, usd });
    settled?.(true);
    return response;
  };
  const send = async (url, init) => {
    const body = JSON.parse(init.body);
    const path = new URL(String(url)).pathname;
    sent.push({ path, body });
    return answer(path, body);
  };
  const w = web.createWeb({ order: { search: ["firecrawl"], fetch: ["firecrawl"] }, keys: { firecrawl: "fc-key-canary-91ab" }, send: { firecrawl: send }, guard, pay, ...(settings ? { settings: { firecrawl: settings } } : {}) });
  return { w, sent, booked };
}

test("every keyed body caps PDF parsing and pins the proxy to basic: a search's results at 2 pages, a fetch at 100 or pdfMaxPages", () => {
  assert.deepEqual(firecrawlSearchBody("q", 4).scrapeOptions, { formats: ["markdown"], onlyMainContent: true, proxy: "basic", parsers: [{ type: "pdf", maxPages: 2 }] });
  assert.deepEqual(firecrawlScrapeBody(PUBLIC), { url: PUBLIC, formats: ["markdown"], onlyMainContent: true, proxy: "basic", parsers: [{ type: "pdf", maxPages: 100 }] });
  assert.deepEqual(firecrawlScrapeBody(PUBLIC, { pdfMaxPages: 7 }).parsers, [{ type: "pdf", maxPages: 7 }]);
  assert.deepEqual(firecrawlSettingsProblems({ pdfMaxPages: 10_000 }), []);
  for (const bad of [0, 10_001, 2.5, "100"]) assert.equal(firecrawlSettingsProblems({ pdfMaxPages: bad }).length, 1, `pdfMaxPages ${JSON.stringify(bad)} is refused`);
});

test("the search hold: 2 credits per 10 results, rounded up, and each result at its PDF page cap", () => {
  assert.equal(web.firecrawlFeeOf("/v2/search", firecrawlSearchBody("q", 4)).usd, credits(2 + 4 * 2), "limit 4: 2 + 4 x 2 = 10 credits");
  assert.equal(web.firecrawlFeeOf("/v2/search", firecrawlSearchBody("q", 10)).usd, credits(2 + 10 * 2), "limit 10: 2 + 10 x 2 = 22 credits");
  assert.equal(web.firecrawlFeeOf("/v2/search", firecrawlSearchBody("q", 11)).usd, credits(4 + 11 * 2), "limit 11: 4 + 11 x 2 = 26 credits");
  assert.equal(web.firecrawlFeeOf("/v2/search", { query: "q", limit: 10 }).usd, credits(2), "no scrape: the search alone");
});

test("the scrape hold: its PDF page cap (1 credit a page parsed), and 4 more for JSON", () => {
  assert.equal(web.firecrawlFeeOf("/v2/scrape", firecrawlScrapeBody(PUBLIC)).usd, credits(100));
  assert.equal(web.firecrawlFeeOf("/v2/scrape", firecrawlScrapeBody(PUBLIC, { pdfMaxPages: 7 })).usd, credits(7));
  assert.equal(web.firecrawlFeeOf("/v2/scrape", { ...firecrawlScrapeBody(PUBLIC), formats: ["markdown", { type: "json", prompt: "p" }] }).usd, credits(104));
});

test("a body asking for a proxy other than basic, or leaving it to Firecrawl, has no price here and is never sent", () => {
  for (const proxy of ["enhanced", "auto", "stealth", undefined]) {
    const scrape = { ...firecrawlScrapeBody(PUBLIC), proxy };
    if (proxy === undefined) delete scrape.proxy;
    assert.equal(web.firecrawlFeeOf("/v2/scrape", scrape), undefined, `scrape, proxy ${proxy}`);
    const search = firecrawlSearchBody("q", 4);
    search.scrapeOptions = { ...search.scrapeOptions, proxy };
    if (proxy === undefined) delete search.scrapeOptions.proxy;
    assert.equal(web.firecrawlFeeOf("/v2/search", search), undefined, `search, proxy ${proxy}`);
  }
});

test("a body leaving PDF parsing uncapped is held at Firecrawl's own most pages, 10,000", () => {
  const scrape = firecrawlScrapeBody(PUBLIC);
  delete scrape.parsers;
  assert.equal(web.firecrawlFeeOf("/v2/scrape", scrape).usd, credits(10_000));
});

test("a search is charged the creditsUsed Firecrawl reports, under its hold; the receipt line says the credits and the hold", async () => {
  const { w, booked } = firecrawlWeb(() => results(10));
  const { receipt } = await w.search({ objective: "Find the Fed's 2024 report", queries: ["fed report"] }, { n: 4 });
  assert.deepEqual(booked, [{ name: "Firecrawl's search", hold: credits(10), usd: credits(10) }]);
  const { search: fees } = { search: receipt.cost.lines };
  assert.equal(fees.length, 1);
  assert.equal(fees[0].usd, credits(10));
  assert.match(fees[0].basis, /Firecrawl reported 10 credits/);
  assert.match(fees[0].basis, /hold 10 credits/);
});

test("a fetch of an HTML page is charged the 1 credit Firecrawl reports, not its 100-page hold", async () => {
  const { w, booked } = firecrawlWeb(() => page({ creditsUsed: 1 }));
  const { receipt } = await w.fetch(PUBLIC);
  assert.deepEqual(booked, [{ name: "Firecrawl's scrape", hold: credits(100), usd: credits(1) }]);
  assert.equal(receipt.cost.usd, credits(1));
  assert.match(receipt.cost.lines[0].basis, /Firecrawl reported 1 credit\b/);
  assert.match(receipt.cost.lines[0].basis, /hold 100 credits/);
});

test("creditsUsed above the hold is charged at the hold, and the receipt says Firecrawl reported more", async () => {
  const { w, booked } = firecrawlWeb(() => page({ creditsUsed: 250 }));
  const { receipt } = await w.fetch(PUBLIC);
  assert.deepEqual(booked, [{ name: "Firecrawl's scrape", hold: credits(100), usd: credits(100) }]);
  assert.equal(receipt.cost.usd, credits(100));
  assert.match(receipt.cost.lines[0].basis, /the hold, 100 credits/);
  assert.match(receipt.cost.lines[0].basis, /Firecrawl reported 250 credits/);
});

for (const [label, answer] of [
  ["missing", () => page({})],
  ["not an integer", () => page({ creditsUsed: 2.5 })],
  ["negative", () => page({ creditsUsed: -3 })],
  ["a string", () => page({ creditsUsed: "NaN" })],
  ["null", () => page({ creditsUsed: null })],
]) {
  test(`creditsUsed ${label}: charged at the hold, never $0`, async () => {
    const { w, booked } = firecrawlWeb(answer);
    const { answer: read, receipt } = await w.fetch(PUBLIC);
    assert.equal(read.ok, true, "the page is read");
    assert.deepEqual(booked, [{ name: "Firecrawl's scrape", hold: credits(100), usd: credits(100) }]);
    assert.equal(receipt.cost.usd, credits(100));
    assert.match(receipt.cost.lines[0].basis, /the hold, 100 credits; Firecrawl reported no credit count/);
  });
}

test("a search answer that is not JSON: charged at the hold, no crash", async () => {
  const { w, booked } = firecrawlWeb(() => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
  const { answer } = await w.search({ objective: "Find the Fed's 2024 report", queries: ["fed report"] }, { n: 4 });
  assert.ok("error" in answer, JSON.stringify(answer));
  assert.deepEqual(booked, [{ name: "Firecrawl's search", hold: credits(10), usd: credits(10) }]);
});

test("a 2xx answer past KEYED_MAX_BYTES is read no further than the bound to find its credits: charged at the hold", async () => {
  const MiB = 1024 * 1024;
  let pulled = 0;
  // A 12 MiB answer, streamed a MiB at a time, counting what is pulled from it.
  const big = () => new Response(new ReadableStream({
    pull(controller) {
      if (pulled >= 12 * MiB) return controller.close();
      pulled += MiB;
      controller.enqueue(new Uint8Array(MiB).fill(32));
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const { w, booked } = firecrawlWeb(() => big());
  const { receipt } = await w.fetch(PUBLIC);
  assert.ok(pulled <= KEYED_MAX_BYTES + 2 * MiB, `${pulled / MiB} MiB of a 12 MiB answer were read`);
  assert.deepEqual(booked, [{ name: "Firecrawl's scrape", hold: credits(100), usd: credits(100) }]);
  assert.match(receipt.cost.lines[0].basis, /the hold, 100 credits; Firecrawl reported no credit count/);
});

test("a PDF cut at its page cap says so in the text the agent reads: pages 1-100 of N", async () => {
  const { w } = firecrawlWeb(() => page({ creditsUsed: 100, numPages: 100, totalPages: 128, contentType: "application/pdf" }, "Page one of the report."));
  const { answer } = await w.fetch(PUBLIC);
  assert.match(answer.text, /^\[PDF: pages 1-100 of 128 were read; pages 101-128 are not in this text\]/);
  const whole = firecrawlWeb(() => page({ creditsUsed: 6, numPages: 6, totalPages: 6, contentType: "application/pdf" }, "A six-page form."));
  assert.equal((await whole.w.fetch(PUBLIC)).answer.text, "A six-page form.", "a PDF read whole carries no note");
});
