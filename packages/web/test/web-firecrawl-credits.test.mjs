// What a keyed Firecrawl request holds and is charged, against Firecrawl's own credit rule: 2 credits per 10 search
// results (rounded up), and each document scraped at 1 credit, a PDF at 1 a page parsed (https://docs.firecrawl.dev/billing).
// A keyed search asks no scrape of its results (its snippets are Firecrawl's descriptions, as Exa's highlights and
// Parallel's excerpts), so it is the 2 credits per 10 alone. A web_fetch is not capped unless the pdfMaxPages setting
// says so, and is held at the most Firecrawl parses of a PDF, 10,000 pages; the proxy is pinned to basic. The charge is
// the creditsUsed Firecrawl reports, never above the hold, and the hold when it reports none it can be read by. A 408
// or a 5xx is charged the creditsUsed it reports, else 0 credits (Firecrawl does not charge a request that fails
// outright); a send that fails after the request may have left is charged the hold.
// Firecrawl is a fake send; the key is a canary.
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

/** A Web on a fake Firecrawl answering `answer(path, body)`, behind a cap that books as serve's paidRequest does: a
 *  2xx, a 408 or a 5xx at what Pay's `charged` says, never above the hold; another 4xx at $0; a send that throws at
 *  the hold. */
function firecrawlWeb(answer, settings) {
  const sent = [];
  const booked = [];
  const net = network();
  const guard = { fetch: (url, options) => publicFetch(url, { lookup: net.lookup, fetchImpl: net.fetchImpl, ...options }), check: (url, options) => publicCheck(url, { lookup: net.lookup, ...options }), html: readPage };
  const pay = async (fee, send, charged, settled) => {
    let response;
    try {
      response = await send();
    } catch (error) {
      booked.push({ name: fee.name, hold: fee.usd, usd: fee.usd });
      throw error;
    }
    const said = charged?.();
    const billed = (response.status >= 200 && response.status < 300) || response.status === 408 || response.status >= 500;
    const usd = !billed ? 0 : typeof said === "number" && Number.isFinite(said) && said >= 0 ? Math.min(said, fee.usd) : fee.usd;
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

test("a keyed search asks no scrape of its results; a fetch pins the proxy to basic and caps a PDF only when pdfMaxPages says so", () => {
  assert.deepEqual(firecrawlSearchBody("q", 4), { query: "q", limit: 4 });
  assert.deepEqual(firecrawlScrapeBody(PUBLIC), { url: PUBLIC, formats: ["markdown"], onlyMainContent: true, proxy: "basic" });
  assert.deepEqual(firecrawlScrapeBody(PUBLIC, { pdfMaxPages: 7 }).parsers, [{ type: "pdf", maxPages: 7 }]);
  assert.deepEqual(firecrawlSettingsProblems({ pdfMaxPages: 10_000 }), []);
  for (const bad of [0, 10_001, 2.5, "100"]) assert.equal(firecrawlSettingsProblems({ pdfMaxPages: bad }).length, 1, `pdfMaxPages ${JSON.stringify(bad)} is refused`);
});

test("the search hold: 2 credits per 10 results, rounded up; a body that scrapes its results adds each at its PDF page cap", () => {
  assert.equal(web.firecrawlFeeOf("/v2/search", firecrawlSearchBody("q", 4)).usd, credits(2), "limit 4: 2 credits");
  assert.equal(web.firecrawlFeeOf("/v2/search", firecrawlSearchBody("q", 10)).usd, credits(2), "limit 10: 2 credits");
  assert.equal(web.firecrawlFeeOf("/v2/search", firecrawlSearchBody("q", 11)).usd, credits(4), "limit 11: 4 credits");
  const scraping = (limit) => ({ query: "q", limit, scrapeOptions: { formats: ["markdown"], proxy: "basic", parsers: [{ type: "pdf", maxPages: 2 }] } });
  assert.equal(web.firecrawlFeeOf("/v2/search", scraping(4)).usd, credits(2 + 4 * 2), "limit 4, each at 2 pages: 10 credits");
  assert.equal(web.firecrawlFeeOf("/v2/search", scraping(10)).usd, credits(2 + 10 * 2), "limit 10, each at 2 pages: 22 credits");
});

test("the scrape hold: Firecrawl's most pages of a PDF, 10,000 (1 credit a page parsed), its cap when pdfMaxPages sets one, and 4 more for JSON", () => {
  assert.equal(web.firecrawlFeeOf("/v2/scrape", firecrawlScrapeBody(PUBLIC)).usd, credits(10_000));
  assert.equal(web.firecrawlFeeOf("/v2/scrape", firecrawlScrapeBody(PUBLIC, { pdfMaxPages: 7 })).usd, credits(7));
  assert.equal(web.firecrawlFeeOf("/v2/scrape", { ...firecrawlScrapeBody(PUBLIC, { pdfMaxPages: 100 }), formats: ["markdown", { type: "json", prompt: "p" }] }).usd, credits(104));
});

test("a body asking for a proxy other than basic, or leaving it to Firecrawl, has no price here and is never sent", () => {
  for (const proxy of ["enhanced", "auto", "stealth", undefined]) {
    const scrape = { ...firecrawlScrapeBody(PUBLIC), proxy };
    if (proxy === undefined) delete scrape.proxy;
    assert.equal(web.firecrawlFeeOf("/v2/scrape", scrape), undefined, `scrape, proxy ${proxy}`);
    const search = { ...firecrawlSearchBody("q", 4), scrapeOptions: { formats: ["markdown"], proxy } };
    if (proxy === undefined) delete search.scrapeOptions.proxy;
    assert.equal(web.firecrawlFeeOf("/v2/search", search), undefined, `search, proxy ${proxy}`);
  }
});

test("a cap past Firecrawl's own most pages is held at that most, 10,000", () => {
  assert.equal(web.firecrawlFeeOf("/v2/scrape", { ...firecrawlScrapeBody(PUBLIC), parsers: [{ type: "pdf", maxPages: 50_000 }] }).usd, credits(10_000));
});

test("a search is charged the creditsUsed Firecrawl reports, under its hold; the receipt line says the credits and the hold", async () => {
  const { w, booked } = firecrawlWeb(() => results(1));
  const { receipt } = await w.search({ objective: "Find the Fed's 2024 report", queries: ["fed report"] }, { n: 4 });
  assert.deepEqual(booked, [{ name: "Firecrawl's search", hold: credits(2), usd: credits(1) }]);
  const fees = receipt.cost.lines;
  assert.equal(fees.length, 1);
  assert.equal(fees[0].usd, credits(1));
  assert.match(fees[0].basis, /Firecrawl reported 1 credit\b/);
  assert.match(fees[0].basis, /hold 2 credits/);
});

test("a fetch of an HTML page is charged the 1 credit Firecrawl reports, not its 10,000-page hold; a PDF its pages", async () => {
  const { w, booked } = firecrawlWeb(() => page({ creditsUsed: 1 }));
  const { receipt } = await w.fetch(PUBLIC);
  assert.deepEqual(booked, [{ name: "Firecrawl's scrape", hold: credits(10_000), usd: credits(1) }]);
  assert.equal(receipt.cost.usd, credits(1));
  assert.match(receipt.cost.lines[0].basis, /Firecrawl reported 1 credit\b/);
  assert.match(receipt.cost.lines[0].basis, /hold 10000 credits/);
  const pdf = firecrawlWeb(() => page({ creditsUsed: 128, numPages: 128, totalPages: 128, contentType: "application/pdf" }, "A long report."));
  const read = await pdf.w.fetch(PUBLIC);
  assert.deepEqual(pdf.booked, [{ name: "Firecrawl's scrape", hold: credits(10_000), usd: credits(128) }]);
  assert.equal(read.answer.text, "A long report.", "an uncapped PDF read whole carries no note");
});

test("creditsUsed above the hold is charged at the hold, and the receipt says Firecrawl reported more", async () => {
  const { w, booked } = firecrawlWeb(() => page({ creditsUsed: 250 }), { pdfMaxPages: 100 });
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
    const { w, booked } = firecrawlWeb(answer, { pdfMaxPages: 100 });
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
  assert.equal(answer.error, "Firecrawl's search answered nothing this server reads", "an unreadable answer, not a thrown parse");
  assert.deepEqual(booked, [{ name: "Firecrawl's search", hold: credits(2), usd: credits(2) }]);
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
  const { w, booked } = firecrawlWeb(() => big(), { pdfMaxPages: 100 });
  const { receipt } = await w.fetch(PUBLIC);
  assert.ok(pulled <= KEYED_MAX_BYTES + 2 * MiB, `${pulled / MiB} MiB of a 12 MiB answer were read`);
  assert.deepEqual(booked, [{ name: "Firecrawl's scrape", hold: credits(100), usd: credits(100) }]);
  assert.match(receipt.cost.lines[0].basis, /the hold, 100 credits; Firecrawl reported no credit count/);
});

const failed = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SEARCH = [{ objective: "Find the Fed's 2024 report", queries: ["fed report"] }, { n: 4 }];

for (const status of [408, 500, 502, 503]) {
  test(`a ${status} with no credit count is charged 0 credits, as Firecrawl charges a request that fails outright; an uncapped fetch is not charged its 10,000-credit hold`, async () => {
    const fetchWeb = firecrawlWeb(() => failed(status, { success: false, error: "Scrape failed" }));
    const fetched = await fetchWeb.w.fetch(PUBLIC);
    assert.equal(fetched.answer.ok, false, "the fetch failed");
    assert.ok(fetchWeb.booked.length >= 1);
    for (const row of fetchWeb.booked) assert.deepEqual(row, { name: "Firecrawl's scrape", hold: credits(10_000), usd: 0 });
    assert.equal(fetched.receipt.cost.usd, 0);
    assert.match(fetched.receipt.cost.lines[0].basis, new RegExp(`Firecrawl answered ${status} and reported no credit count: 0 credits`));
    assert.match(fetched.receipt.cost.lines[0].basis, /a request that fails outright is not charged/);
    const searchWeb = firecrawlWeb(() => failed(status));
    await searchWeb.w.search(...SEARCH);
    for (const row of searchWeb.booked) assert.deepEqual(row, { name: "Firecrawl's search", hold: credits(2), usd: 0 });
  });
}

test("a 5xx that reports creditsUsed is charged it, under the hold: a search's top-level count, a scrape's in data.metadata", async () => {
  const searchWeb = firecrawlWeb(() => failed(503, { success: false, error: "partial", creditsUsed: 1 }));
  const searched = await searchWeb.w.search(...SEARCH);
  assert.deepEqual(searchWeb.booked[0], { name: "Firecrawl's search", hold: credits(2), usd: credits(1) });
  assert.match(searched.receipt.cost.lines[0].basis, /Firecrawl reported 1 credit \(hold 2 credits\)/);
  const fetchWeb = firecrawlWeb(() => failed(500, { success: false, data: { metadata: { creditsUsed: 3 } } }));
  await fetchWeb.w.fetch(PUBLIC);
  assert.deepEqual(fetchWeb.booked[0], { name: "Firecrawl's scrape", hold: credits(10_000), usd: credits(3) });
});

test("a 5xx that reports creditsUsed above the hold is charged at the hold", async () => {
  const { w, booked } = firecrawlWeb(() => failed(500, { success: false, data: { metadata: { creditsUsed: 250 } } }), { pdfMaxPages: 100 });
  const { receipt } = await w.fetch(PUBLIC);
  assert.deepEqual(booked[0], { name: "Firecrawl's scrape", hold: credits(100), usd: credits(100) });
  assert.match(receipt.cost.lines[0].basis, /the hold, 100 credits; Firecrawl reported 250 credits/);
});

/** An answer of `status` whose body breaks after its first chunk. */
const breaking = (status) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{"success":false,'));
  },
  pull(controller) {
    controller.error(new TypeError("terminated"));
  },
}), { status, headers: { "content-type": "application/json" } });

test("a 5xx whose body breaks while it is read is charged 0 credits, as one with no count, and the fetch fails as a 5xx", async () => {
  const { w, booked } = firecrawlWeb(() => breaking(503));
  const { answer, receipt } = await w.fetch(PUBLIC);
  assert.equal(answer.ok, false);
  assert.deepEqual(booked[0], { name: "Firecrawl's scrape", hold: credits(10_000), usd: 0 });
  assert.match(receipt.cost.lines[0].basis, /Firecrawl answered 503 and reported no credit count: 0 credits/);
});

test("a 2xx whose body breaks while it is read stays charged at the hold: Firecrawl answered with a document", async () => {
  const { w, booked } = firecrawlWeb(() => breaking(200), { pdfMaxPages: 100 });
  const { answer } = await w.fetch(PUBLIC);
  assert.equal(answer.ok, false);
  assert.deepEqual(booked[0], { name: "Firecrawl's scrape", hold: credits(100), usd: credits(100) });
});

test("a send that fails after the request may have left (a reset socket) stays charged at the hold: what Firecrawl billed is not known", async () => {
  const reset = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
  const { w, booked } = firecrawlWeb(reset, { pdfMaxPages: 100 });
  const { answer } = await w.fetch(PUBLIC);
  assert.equal(answer.ok, false);
  assert.deepEqual(booked[0], { name: "Firecrawl's scrape", hold: credits(100), usd: credits(100) });
});

test("another 4xx is still charged nothing, whatever it says it used", async () => {
  const { w, booked } = firecrawlWeb(() => failed(400, { success: false, creditsUsed: 1 }));
  await w.search(...SEARCH);
  assert.deepEqual(booked[0], { name: "Firecrawl's search", hold: credits(2), usd: 0 });
});

test("a PDF cut at a pdfMaxPages cap says so in the text the agent reads: pages 1-100 of N", async () => {
  const { w } = firecrawlWeb(() => page({ creditsUsed: 100, numPages: 100, totalPages: 128, contentType: "application/pdf" }, "Page one of the report."), { pdfMaxPages: 100 });
  const { answer } = await w.fetch(PUBLIC);
  assert.match(answer.text, /^\[PDF: pages 1-100 of 128 were read; pages 101-128 are not in this text\]/);
  const whole = firecrawlWeb(() => page({ creditsUsed: 6, numPages: 6, totalPages: 6, contentType: "application/pdf" }, "A six-page form."));
  assert.equal((await whole.w.fetch(PUBLIC)).answer.text, "A six-page form.", "a PDF read whole carries no note");
});
