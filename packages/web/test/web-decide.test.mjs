// The classifier step between a provider's answer and the model (decide/): a decider given to createWeb sifts a
// search's results and judges a fetched part in passages, and every call's receipt carries the decision's record. The
// decider here is deciderFrom over a fake DecisionProvider that records each request and answers as a test says; the
// search and fetch are Parallel's fake and the network a table (fixtures/web-runs.mjs). No socket leaves the machine.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deciderFrom, judgePart, judgeRequest, LEFT_OUT, passagesOf, PaidRefused, QUESTIONS_PER_REQUEST, REQUESTS_AT_ONCE, searchText, siftRequest, siftSearch, STATE_BUDGET_BYTES, TEXT_CAP, THRESHOLD, webFetchText } from "../dist/index.js";
import fakeParallel from "./fixtures/faux-parallel.mjs";
import { fakeWeb, PUBLIC } from "./fixtures/web-runs.mjs";

const pinned = JSON.parse(readFileSync(new URL("./fixtures/decide-requests.json", import.meta.url), "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const TASK = "Where is Widgets, Inc. registered?";
const URLS = ["https://registry.example/widgets", "https://result.example/2", "https://result.example/3", "https://result.example/4"];

/** A DecisionProvider that answers each noul with `nouls[id]` (a function of the request, or an answer object), and
 *  the requests and contexts it was given. */
function fakeProvider(nouls = {}, { usage = { input_tokens: 100, output_tokens: 4 }, cost = 0.0001, fail } = {}) {
  const asked = [];
  return {
    asked,
    provider: {
      id: "fake",
      needs: [],
      async decide(request, ctx) {
        asked.push({ request, ctx });
        if (fail) return fail(ctx);
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => {
          const given = nouls[id] ?? 0.5;
          return [id, typeof given === "object" ? given : { type: "noul", noul: given }];
        }));
        return { answers, evidence: [], model: "fake-1", usage, cost_usd: cost, cost_basis: "estimate", provider_request_id: null };
      },
    },
  };
}

/** The fake's price: a flat fee per request, so each request's hold is known. */
const PRICE = { requestUsd: 0.0002 };
const priced = (provider, options = {}) => deciderFrom(provider, { price: PRICE, ...options });

/** Three paragraphs, each its own passage: 590 letters and a blank line, twice, then 590 more. */
const A = `${"a".repeat(590)}\n\n`;
const B = `${"b".repeat(590)}\n\n`;
const C = "c".repeat(590);
const LONG = `${A}${B}${C}`;
/** Parallel's fake, but an extract answers `content` as the page. */
const pagesOf = (content) => async (url, init) => {
  if (new URL(String(url)).pathname !== "/v1/extract") return fakeParallel(url, init);
  const { urls } = JSON.parse(init.body);
  return new Response(JSON.stringify({ extract_id: "x", results: urls.map((u) => ({ url: u, title: "Long", publish_date: null, excerpts: [], full_content: content })), errors: [], warnings: null, usage: [], session_id: "s" }), { status: 200, headers: { "content-type": "application/json" } });
};
const longPages = pagesOf(LONG);
const CTX = () => ({ signal: new AbortController().signal, deadlineMs: 5_000 });
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));

test("the sift and judge requests are pinned: one noul per result or passage in the same words, the query, task and items in the state", () => {
  assert.deepEqual(siftRequest(pinned.sift.query, pinned.sift.hits, pinned.sift.task), pinned.sift.request);
  assert.deepEqual(judgeRequest(pinned.judge.url, pinned.judge.task, pinned.judge.passages), pinned.judge.request);
  const untasked = siftRequest("widgets delaware", pinned.sift.hits);
  assert.equal(Object.hasOwn(untasked.state, "task"), false, "no task, no task in the state");
  assert.deepEqual(untasked.questions, pinned.sift.request.questions, "the questions do not change with the task");
});

test("deciderFrom asks one request a search: the sift request, the step's deadline and signal, and an id the same request always has", async () => {
  const { asked, provider } = fakeProvider();
  const web = fakeWeb({ decider: priced(provider), bounds: { decideMs: 4_000 } });
  await web.search("widgets delaware", { n: 4, task: TASK });
  await web.search("widgets delaware", { n: 4, task: TASK });
  assert.equal(asked.length, 2);
  const [{ request, ctx }, again] = asked;
  const { answer } = await fakeWeb().search("widgets delaware", { n: 4 });
  assert.deepEqual(request, siftRequest("widgets delaware", answer.results, TASK), "the provider's results, as the model would read them");
  assert.equal(ctx.deadlineMs, 4_000);
  assert.ok(ctx.signal instanceof AbortSignal && !ctx.signal.aborted);
  assert.match(ctx.decisionId, /^web-sift-[0-9a-f]{24}$/);
  assert.equal(again.ctx.decisionId, ctx.decisionId);
});

test("a sift keeps what the decider scores as needed and drops at the threshold: the kept results in order, a line saying so, and the record naming each dropped URL", async () => {
  assert.equal(THRESHOLD, 0.8);
  const { provider } = fakeProvider({ r1: 0.9, r2: 0.05, r3: 0.2, r4: 0.21 });
  const { answer, receipt } = await fakeWeb({ decider: priced(provider) }).search("widgets delaware", { n: 4, task: TASK });
  assert.deepEqual(answer.results.map((hit) => hit.url), [URLS[0], URLS[3]]);
  assert.equal(answer.sift, "fake kept 2 of 4 results");
  assert.ok(searchText(answer).includes(`"sift":"fake kept 2 of 4 results"`), "the model reads it");
  assert.deepEqual(receipt.out, { bytes: Buffer.byteLength(searchText(answer)), chars: searchText(answer).length }, "the receipt measures what the model reads");
  assert.deepEqual(receipt.cost.usd, 0.0011, "the search's fee and the decider's charge (the cost it gave, under its $0.0002 hold), which the run's cap books");
  assert.deepEqual(receipt.cost.lines.map((fee) => [fee.by, fee.usd]), [["parallel", 0.001], ["fake", 0.0001]]);
  assert.equal(receipt.cost.lines[1].name, "fake's decision");
  const record = receipt.classifier;
  assert.ok(Number.isFinite(record.latency_ms) && record.latency_ms >= 0);
  assert.deepEqual({ ...record, latency_ms: 0 }, {
    provider: "fake", op: "search", ran: true, items: { in: 4, kept: 2 },
    dropped: [{ id: URLS[1], score: 0.05, reason: "needed p=0.05 <= 0.2" }, { id: URLS[2], score: 0.2, reason: "needed p=0.2 <= 0.2" }],
    model: "fake-1", temperature_sent: null, temperature_applied: false, tokens: { in: 100, out: 4, basis: "reported" }, latency_ms: 0, cost: { usd: 0.0001, basis: "estimate" },
    requests: 1, questions_sha256: [sha256(JSON.stringify(siftQuestions()))],
    scored: URLS.map((id, i) => ({ id, score: [0.9, 0.05, 0.2, 0.21][i] })),
  });
});

/** The sift questions for the 4 results of the fake search. */
function siftQuestions() {
  return siftRequest("widgets delaware", URLS.map((url) => ({ url, title: "", snippet: "" })), TASK).questions;
}

test("the decider gives scores, not decisions: each verdict is the provider's p, or null where it refused", async () => {
  const { provider } = fakeProvider({ r1: 0.9, r2: { type: "refusal" } });
  const got = await priced(provider).sift("widgets delaware", URLS.slice(0, 2).map((url) => ({ url, title: "", snippet: "" })), TASK, CTX());
  assert.deepEqual(got.verdicts, [0.9, null]);
});

test("a fetched part is judged in passages: the kept passages in order, LEFT_OUT where any were dropped, the part's place in the page unchanged", async () => {
  const { asked, provider } = fakeProvider({ p1: 0.9, p2: 0.01, p3: 0.7 });
  const web = fakeWeb({ decider: priced(provider), send: { parallel: longPages } });
  const { answer, receipt } = await web.fetch(PUBLIC, { task: TASK });
  assert.deepEqual(asked[0].request, judgeRequest(PUBLIC, TASK, [A, B, C]));
  assert.equal(answer.text, `${A}${LEFT_OUT}${C}`);
  assert.equal(answer.chars, LONG.length, "chars, offset and next_offset name the part read");
  assert.equal(answer.sift, "fake kept 2 of 3 passages of this part; … marks a passage left out");
  assert.ok(webFetchText(answer).includes(answer.sift));
  assert.deepEqual({ ...receipt.classifier, latency_ms: 0 }, {
    provider: "fake", op: "fetch", ran: true, items: { in: 3, kept: 2 },
    dropped: [{ id: "p2", score: 0.01, reason: "needed p=0.01 <= 0.2", at: [A.length, A.length + B.length] }],
    model: "fake-1", temperature_sent: null, temperature_applied: false, tokens: { in: 100, out: 4, basis: "reported" }, latency_ms: 0, cost: { usd: 0.0001, basis: "estimate" },
    requests: 1, questions_sha256: [sha256(JSON.stringify(judgeRequest(PUBLIC, TASK, [A, B, C]).questions))],
    scored: [{ id: "p1", score: 0.9, at: [0, A.length] }, { id: "p2", score: 0.01, at: [A.length, A.length + B.length] }, { id: "p3", score: 0.7, at: [A.length + B.length, LONG.length] }],
  });
  await web.fetch(PUBLIC, { task: TASK });
  assert.equal(asked.length, 2, "each call is judged, one the run's pages answer too");
});

test("a dropped passage's place counts from the page's start, not the part's", async () => {
  const { provider } = fakeProvider({ p1: 0.01 });
  const web = fakeWeb({ decider: priced(provider), send: { parallel: longPages } });
  const { answer, receipt } = await web.fetch(PUBLIC, { task: TASK, offset: A.length, maxChars: 600 });
  assert.equal(answer.text, "");
  assert.equal(answer.sift, `fake kept 0 of 1 passages of this part; … marks a passage left out`);
  assert.deepEqual(receipt.classifier.dropped.map((d) => d.at), [[A.length, A.length + answer.chars]]);
});

test("a fetch with no task is not judged: the part whole, no sift field, and a record that says why", async () => {
  const { asked, provider } = fakeProvider();
  const { answer, receipt } = await fakeWeb({ decider: priced(provider), send: { parallel: longPages } }).fetch(PUBLIC);
  assert.equal(asked.length, 0);
  assert.equal(answer.text, LONG);
  assert.equal(Object.hasOwn(answer, "sift"), false, `no sift field; got ${JSON.stringify(answer.sift)}`);
  assert.equal(receipt.classifier.ran, false);
  assert.equal(receipt.classifier.skipped, "no task");
});

test("a search is sifted before it is fitted: the fit sees only the kept results", async () => {
  // Each quote is two characters in the JSON the fit measures, so 25 results of 3,000 are too wide to fit.
  const quoted = '"'.repeat(3_000);
  const wide = async (url, init) => {
    if (new URL(String(url)).pathname !== "/v1/search") return fakeParallel(url, init);
    const results = Array.from({ length: 25 }, (_, i) => ({ url: `https://wide.example/${i + 1}`, title: `Result ${i + 1}`, publish_date: null, excerpts: [quoted] }));
    return new Response(JSON.stringify({ search_id: "s", results, warnings: null, usage: [], session_id: "s" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const unsifted = await fakeWeb({ send: { parallel: wide } }).search("widgets", { n: 25 });
  assert.ok(unsifted.answer.omitted > 0, "too wide to fit unsifted");
  const { provider } = fakeProvider(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`r${i + 1}`, i % 2 ? 0.01 : 0.9])));
  const { answer, receipt } = await fakeWeb({ decider: priced(provider), send: { parallel: wide } }).search("widgets", { n: 25, task: TASK });
  assert.deepEqual([answer.results.length, answer.omitted, receipt.classifier.items], [13, undefined, { in: 25, kept: 13 }]);
  assert.equal(answer.sift, "fake kept 13 of 25 results");
});

test("nothing to sift is not sifted: an error, a failed page, a refused part; the record says it was skipped", async () => {
  const { asked, provider } = fakeProvider();
  const web = fakeWeb({ decider: priced(provider) });
  const empty = await web.search("   ", { task: TASK });
  assert.deepEqual(empty.answer, { error: "web_search needs a query" });
  assert.deepEqual([empty.receipt.classifier.ran, empty.receipt.classifier.skipped], [false, "no results"]);
  const refused = await web.fetch("http://evil.example/", { task: TASK });
  assert.equal(refused.answer.sift, undefined);
  assert.deepEqual([refused.receipt.classifier.ran, refused.receipt.classifier.skipped], [false, "no page"]);
  const bad = await web.fetch(PUBLIC, { task: TASK, maxChars: 10 });
  assert.deepEqual([bad.receipt.classifier.ran, bad.receipt.classifier.skipped], [false, "no page"]);
  assert.equal(asked.length, 0);
});

test("a decider that fails never passes the results through silently: they come unsifted, the model reads that the sift did not run, the record names the error and its cost", async () => {
  const plain = await fakeWeb().search("widgets delaware", { n: 4 });
  const cases = [
    [Object.assign(new Error("Jev returned HTTP 503 after the request was sent"), { code: "outcome_unknown", costUsd: null }), "outcome_unknown", { usd: null, basis: "unknown" }],
    [Object.assign(new Error("Parallel answered late"), { code: "outcome_unknown", costUsd: 0.001, costBasis: "estimate" }), "outcome_unknown", { usd: 0.001, basis: "estimate" }],
    [Object.assign(new Error("PARALLEL_API_KEY is not set."), { code: "configuration" }), "configuration", { usd: 0, basis: "none" }],
    [new Error("something broke"), "error", { usd: null, basis: "unknown" }],
  ];
  for (const [error, code, cost] of cases) {
    const { provider } = fakeProvider({}, { fail: async () => { throw error; } });
    const { answer, receipt } = await fakeWeb({ decider: priced(provider) }).search("widgets delaware", { n: 4, task: TASK });
    assert.deepEqual(answer, { ...plain.answer, sift: `not run (${code}); these results are unsifted` });
    const record = receipt.classifier;
    assert.deepEqual([record.ran, record.items, record.dropped, record.error, record.cost], [false, { in: 4, kept: 4 }, [], { code, message: error.message }, cost], code);
  }
});

test("a decider past the step's deadline is cut there: the results unsifted, the error a timeout, its cost unknown", async () => {
  let seen;
  const { provider } = fakeProvider({}, { fail: (ctx) => { seen = ctx; return new Promise(() => {}); } });
  const started = performance.now();
  const { answer, receipt } = await fakeWeb({ decider: priced(provider), bounds: { decideMs: 60 } }).search("widgets delaware", { n: 4 });
  assert.ok(performance.now() - started < 2_000, "cut at its deadline, though the decider never answers");
  assert.equal(seen.signal.aborted, true, "the decider's signal ends at the deadline");
  assert.equal(answer.results.length, 4);
  assert.equal(answer.sift, "not run (timeout); these results are unsifted");
  assert.deepEqual([receipt.classifier.error.code, receipt.classifier.cost], ["timeout", { usd: null, basis: "unknown" }]);
});

test("the caller's stop ends the decider too: aborted, unsifted", async () => {
  const stop = new AbortController();
  const { provider } = fakeProvider({}, { fail: () => (stop.abort(), new Promise(() => {})) });
  const { answer, receipt } = await fakeWeb({ decider: priced(provider) }).search("widgets delaware", { n: 4, signal: stop.signal });
  assert.equal(answer.results.length, 4);
  assert.equal(receipt.classifier.error.code, "aborted");
});

test("a refused question keeps its item unjudged; every question refused, or an answer that is no noul, and the sift did not run, at the cost the provider gave", async () => {
  const some = fakeProvider({ r1: { type: "refusal" }, r2: 0.01 });
  const partly = await fakeWeb({ decider: priced(some.provider) }).search("widgets delaware", { n: 2 });
  assert.deepEqual(partly.answer.results.map((hit) => hit.url), [URLS[0]]);
  assert.equal(partly.receipt.classifier.ran, true);

  const all = fakeProvider({ r1: { type: "refusal" }, r2: { type: "refusal" } });
  const refused = await fakeWeb({ decider: priced(all.provider) }).search("widgets delaware", { n: 2 });
  assert.equal(refused.answer.sift, "not run (refused); these results are unsifted");
  assert.deepEqual(refused.receipt.classifier.cost, { usd: 0.0001, basis: "estimate" });

  for (const odd of [{ type: "noul", noul: 1.5 }, { type: "choice", choice: "yes" }, undefined]) {
    const { provider } = fakeProvider({ r1: 0.9 });
    const wrong = { ...provider, decide: async (request, ctx) => { const out = await provider.decide(request, ctx); return { ...out, answers: { ...out.answers, r2: odd } }; } };
    const { answer, receipt } = await fakeWeb({ decider: priced(wrong) }).search("widgets delaware", { n: 2 });
    assert.equal(answer.results.length, 2);
    assert.deepEqual([receipt.classifier.error.code, receipt.classifier.cost], ["invalid_response", { usd: 0.0001, basis: "estimate" }], JSON.stringify(odd));
  }
});

test("tokens are the provider's when it reports them, else counted on the request when a counter is given, else none", async () => {
  const unreported = fakeProvider({}, { usage: null });
  const counted = await fakeWeb({ decider: priced(unreported.provider, { count: (text) => text.length }) }).search("widgets delaware", { n: 2 });
  const { request } = unreported.asked[0];
  assert.deepEqual(counted.receipt.classifier.tokens, { in: JSON.stringify({ state: request.state, questions: request.questions }).length, out: null, basis: "counted" });
  const none = await fakeWeb({ decider: priced(fakeProvider({}, { usage: null }).provider) }).search("widgets delaware", { n: 2 });
  assert.equal(none.receipt.classifier.tokens, null);
});

test("the temperature a provider sent, and whether it was applied, are the record's: none said is none sent; a failure leaves it unknown, a skip unsent", async () => {
  const { provider } = fakeProvider();
  const said = { ...provider, decide: async (request, ctx) => ({ ...(await provider.decide(request, ctx)), temperature_sent: 0, temperature_applied: "unknown" }) };
  const sent = await fakeWeb({ decider: priced(said) }).search("widgets delaware", { n: 2, task: TASK });
  assert.deepEqual([sent.receipt.classifier.temperature_sent, sent.receipt.classifier.temperature_applied], [0, "unknown"]);
  const quiet = await fakeWeb({ decider: priced(provider) }).search("widgets delaware", { n: 2, task: TASK });
  assert.deepEqual([quiet.receipt.classifier.temperature_sent, quiet.receipt.classifier.temperature_applied], [null, false]);
  const broken = fakeProvider({}, { fail: async () => { throw new Error("down"); } });
  const failed = await fakeWeb({ decider: priced(broken.provider) }).search("widgets delaware", { n: 2, task: TASK });
  assert.deepEqual([failed.receipt.classifier.temperature_sent, failed.receipt.classifier.temperature_applied], [null, "unknown"]);
  const skipped = await fakeWeb({ decider: priced(provider) }).search("   ", { task: TASK });
  assert.deepEqual([skipped.receipt.classifier.temperature_sent, skipped.receipt.classifier.temperature_applied], [null, false]);
});

test("a pinned model goes on the request", async () => {
  const { asked, provider } = fakeProvider();
  await fakeWeb({ decider: priced(provider, { model: "jev-1.14" }) }).search("widgets delaware", { n: 2 });
  assert.equal(asked[0].request.model, "jev-1.14");
});

test("a decider needs a price: each request goes through the run's Pay at its hold, the most it may cost from its bytes, at the long rates past longPromptTokens", async () => {
  assert.throws(() => deciderFrom(fakeProvider().provider), /price/);
  const ceilMicro = (usd) => Math.ceil(Math.round(usd * 1e9) / 1e3) / 1e6;
  for (const [price, holdOf] of [
    [{ requestUsd: 0.0001, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, maxOutputTokens: 100, inputTokensPerByte: 2, extraInputTokens: 50 }, (bytes) => 0.0001 + ((bytes * 2 + 50) * 1) / 1e6 + (100 * 2) / 1e6],
    [{ inputUsdPerMillionTokens: 1, longPromptTokens: 10, longInputUsdPerMillionTokens: 3 }, (bytes) => (bytes * 3) / 1e6],
  ]) {
    const fees = [];
    const { asked, provider } = fakeProvider();
    await fakeWeb({ decider: deciderFrom(provider, { price }), pay: async (fee, send) => (fees.push(fee), send()) }).search("widgets delaware", { n: 2, task: TASK });
    const { request } = asked[0];
    const decided = fees.filter((fee) => fee.by === "fake");
    assert.equal(decided.length, 1);
    assert.equal(decided[0].usd, ceilMicro(holdOf(bytesOf({ state: request.state, questions: request.questions }))));
  }
});

test("a request the run's cap refuses is never sent: the step does not run, the results come unsifted, the record says pay_refused at $0, and no decider line is booked", async () => {
  const { asked, provider } = fakeProvider();
  const pay = async (fee, send) => {
    if (fee.by === "fake") throw new PaidRefused("the run's cap has no room for fake's decision");
    return send();
  };
  const { answer, receipt } = await fakeWeb({ decider: priced(provider), pay }).search("widgets delaware", { n: 4, task: TASK });
  assert.equal(asked.length, 0);
  assert.equal(answer.results.length, 4);
  assert.equal(answer.sift, "not run (pay_refused); these results are unsifted");
  const record = receipt.classifier;
  assert.deepEqual([record.ran, record.requests, record.error, record.cost], [false, 0, { code: "pay_refused", message: "the run's cap has no room for fake's decision" }, { usd: 0, basis: "none" }]);
  assert.deepEqual(receipt.cost.lines.map((fee) => fee.by), ["parallel"]);
});

test("a request refused unbilled (configuration, auth, a connection never made) settles at $0 with the cap; one whose outcome is lost settles at its hold", async () => {
  for (const [code, billed] of [["configuration", false], ["auth", false], ["connection", false], ["outcome_unknown", true]]) {
    const settled = [];
    const pay = async (fee, send) => {
      try {
        const response = await send();
        settled.push([fee.by, response.status]);
        return response;
      } catch (error) {
        settled.push([fee.by, "thrown"]);
        throw error;
      }
    };
    const { provider } = fakeProvider({}, { fail: async () => { throw Object.assign(new Error(code), { code }); } });
    const { receipt } = await fakeWeb({ decider: priced(provider), pay }).search("widgets delaware", { n: 4, task: TASK });
    const line = receipt.cost.lines.find((fee) => fee.by === "fake");
    assert.deepEqual([settled.find(([by]) => by === "fake")[1], line.usd, receipt.classifier.requests], billed ? ["thrown", 0.0002, 1] : [400, 0, 1], code);
  }
});

test("a search over the state budget is trimmed: every snippet cut to the longest length that fits, the cut recorded, one request", async () => {
  const hits = Array.from({ length: 10 }, (_, i) => ({ url: `https://wide.example/${i}`, title: `Result ${i}`, snippet: "汉".repeat(3_000) }));
  const { asked, provider } = fakeProvider();
  const got = await priced(provider).sift("widgets", hits, TASK, CTX());
  assert.equal(asked.length, 1);
  const { state } = asked[0].request;
  assert.ok(bytesOf(state) <= STATE_BUDGET_BYTES, String(bytesOf(state)));
  const cut = Object.values(state.results).map((hit) => hit.snippet.length);
  assert.ok(cut.every((n) => n === cut[0]) && cut[0] < 3_000, String(cut));
  const longer = siftRequest("widgets", hits.map((hit) => ({ ...hit, snippet: hit.snippet.slice(0, cut[0] + 1) })), TASK);
  assert.ok(bytesOf(longer.state) > STATE_BUDGET_BYTES, "the longest that fits");
  assert.deepEqual(asked[0].request, siftRequest("widgets", hits.map((hit) => ({ ...hit, snippet: hit.snippet.slice(0, cut[0]) })), TASK));
  assert.deepEqual(got.trimmed, { snippets: 10, to_chars: cut[0] });
  const { answer, classifier } = await siftSearch(priced(fakeProvider().provider), { provider: "parallel", query: "widgets", results: hits }, { task: TASK });
  assert.deepEqual([classifier.trimmed, classifier.requests], [{ snippets: 10, to_chars: cut[0] }, 1]);
  assert.deepEqual(answer.results, hits, "the model reads every snippet whole");
  const small = await priced(fakeProvider().provider).sift("widgets", hits.slice(0, 1), TASK, CTX());
  assert.equal(small.trimmed, undefined, "a state within the budget is sent whole");
});

test("passages over the state budget go in several requests, each within it and QUESTIONS_PER_REQUEST, ids counted across the page, the verdicts merged in order", async () => {
  const passages = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")} ${"x".repeat(995)}\n\n`);
  const { asked, provider } = fakeProvider(Object.fromEntries(passages.map((_, i) => [`p${i + 1}`, i % 2 ? 0.9 : 0.01])));
  const got = await priced(provider).judge(PUBLIC, TASK, passages, CTX());
  assert.ok(asked.length >= 3, String(asked.length));
  let first = 0;
  for (const { request } of asked) {
    const n = Object.keys(request.questions).length;
    assert.ok(bytesOf(request.state) <= STATE_BUDGET_BYTES && n <= QUESTIONS_PER_REQUEST);
    assert.deepEqual(request, judgeRequest(PUBLIC, TASK, passages.slice(first, first + n), first + 1));
    first += n;
  }
  assert.equal(first, 200);
  assert.deepEqual(got.verdicts, passages.map((_, i) => (i % 2 ? 0.9 : 0.01)));
  assert.deepEqual(got.questions_sha256, asked.map(({ request }) => sha256(JSON.stringify(request.questions))));
  assert.deepEqual([got.tokens, got.cost], [{ in: 100 * asked.length, out: 4 * asked.length, basis: "reported" }, { usd: Math.round(0.0001 * asked.length * 1e6) / 1e6, basis: "estimate" }]);
});

test("an ask's requests go at most REQUESTS_AT_ONCE at a time, at most PASSAGES_MAX passages each, the verdicts merged in order", async () => {
  assert.equal(REQUESTS_AT_ONCE, 4);
  const passages = Array.from({ length: 300 }, (_, i) => `passage ${i + 1}`);
  const score = (i) => (i % 97) / 100;
  const { asked, provider } = fakeProvider(Object.fromEntries(passages.map((_, i) => [`p${i + 1}`, score(i)])));
  const decide = provider.decide;
  let open = 0;
  let most = 0;
  provider.decide = async (request, ctx) => {
    most = Math.max(most, ++open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await decide(request, ctx);
    } finally {
      open--;
    }
  };
  const got = await priced(provider).judge(PUBLIC, TASK, passages, CTX());
  assert.deepEqual([asked.length, most], [6, 4]);
  assert.deepEqual(got.verdicts, passages.map((_, i) => score(i)));
  const firsts = [0, 50, 100, 150, 200, 250];
  assert.deepEqual(got.questions_sha256, firsts.map((first) => sha256(JSON.stringify(judgeRequest(PUBLIC, TASK, passages.slice(first, first + 50), first + 1).questions))), "one hash per request, in the page's order");
});

test("a request after the first that fails keeps the step from running, at what every request sent cost", async () => {
  // 50 passages of 6 paragraphs, about 16 KB of state each: 5 a request, so 10 requests, more than REQUESTS_AT_ONCE.
  const passages = Array(300).fill(`${"汉".repeat(900)}\n\n`);
  for (const [failure, cost] of [
    [Object.assign(new Error("upstream 500"), { code: "provider_error" }), { usd: null, basis: "unknown" }],
    [Object.assign(new Error("no route"), { code: "connection" }), { usd: 0.0001, basis: "estimate" }],
  ]) {
    const { asked, provider } = fakeProvider();
    const decide = provider.decide;
    // Request 1 answers 5 ms late, after 2 to 4 have failed, so its worker sees the failure before it could take request 5.
    // Answering at once would race the failures, and request 5 could go out before any failure is known.
    provider.decide = async (request, ctx) => {
      if (asked.length) {
        asked.push({ request, ctx });
        throw failure;
      }
      const answered = decide(request, ctx);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return answered;
    };
    const { classifier } = await judgePart(priced(provider), PUBLIC, { ok: true, url: PUBLIC, text: passages.join("") }, { task: TASK });
    assert.ok(Number(/^request 2 of (\d+): /.exec(classifier.error.message)?.[1]) > REQUESTS_AT_ONCE, `the page makes more requests than go at once: ${classifier.error.message}`);
    // The first REQUESTS_AT_ONCE go out together: request 1 answers, 2 to 4 fail, and no more are sent.
    assert.deepEqual([classifier.ran, classifier.requests, classifier.error.code, classifier.cost, classifier.questions_sha256], [false, REQUESTS_AT_ONCE, failure.code, cost, []]);
  }
});

test("a fetched part over the budget is judged in several requests: the record counts them with a hash each, and the cap books each", async () => {
  const wide = `${"汉".repeat(900)}\n\n`.repeat(40);
  const { asked, provider } = fakeProvider();
  const { answer, receipt } = await fakeWeb({ decider: priced(provider), send: { parallel: pagesOf(wide) } }).fetch(PUBLIC, { task: TASK, maxChars: 50_000 });
  assert.equal(answer.text, wide, "nothing dropped at p=0.5");
  assert.equal(asked.length, 2);
  assert.deepEqual([receipt.classifier.requests, receipt.classifier.questions_sha256.length, receipt.classifier.items], [2, 2, { in: 40, kept: 40 }]);
  assert.deepEqual(receipt.cost.lines.filter((fee) => fee.by === "fake").map((fee) => fee.usd), [0.0001, 0.0001], "each request's line is the cost it gave, under its hold");
});

test("passagesOf tiles the text: paragraphs packed to about 1,000 characters, a longer one cut on a space, never a surrogate pair split, and at most 50 passages", () => {
  const tiled = (text, spans) => spans.every(([s, e], i) => s < e && (i === 0 ? s === 0 : s === spans[i - 1][1])) && spans.at(-1)[1] === text.length;
  assert.deepEqual(passagesOf(LONG), [[0, A.length], [A.length, A.length + B.length], [A.length + B.length, LONG.length]]);
  assert.deepEqual(passagesOf("short\n\npage"), [[0, 11]], "short paragraphs share a passage");
  assert.deepEqual(passagesOf(""), []);
  const words = "word ".repeat(500);
  const spans = passagesOf(words);
  assert.ok(tiled(words, spans) && spans.every(([s, e]) => e - s <= 1_000) && spans.slice(0, -1).every(([, e]) => words[e - 1] === " "));
  const emoji = "😀".repeat(800);
  assert.ok(passagesOf(emoji).every(([s]) => s % 2 === 0));
  const full = `${"x".repeat(900)}\n\n`.repeat(Math.ceil(TEXT_CAP / 902)).slice(0, TEXT_CAP);
  const capped = passagesOf(full);
  assert.ok(tiled(full, capped) && capped.length <= 50, String(capped.length));
});
