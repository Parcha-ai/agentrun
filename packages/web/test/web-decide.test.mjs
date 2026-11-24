// The classifier step between a provider's answer and the model (decide/): a decider given to createWeb sifts a
// search's results and judges a fetched part in passages, and every call's receipt carries the decision's record. The
// decider here is deciderFrom over a fake DecisionProvider that records each request and answers as a test says; the
// search and fetch are Parallel's fake and the network a table (fixtures/web-runs.mjs). No socket leaves the machine.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deciderFrom, judgeRequest, LEFT_OUT, passagesOf, searchText, siftRequest, TEXT_CAP, THRESHOLD, webFetchText } from "../dist/index.js";
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

/** Three paragraphs, each its own passage: 590 letters and a blank line, twice, then 590 more. */
const A = `${"a".repeat(590)}\n\n`;
const B = `${"b".repeat(590)}\n\n`;
const C = "c".repeat(590);
const LONG = `${A}${B}${C}`;
/** Parallel's fake, but an extract of PUBLIC answers LONG as the page. */
async function longPages(url, init) {
  if (new URL(String(url)).pathname !== "/v1/extract") return fakeParallel(url, init);
  const { urls } = JSON.parse(init.body);
  return new Response(JSON.stringify({ extract_id: "x", results: urls.map((u) => ({ url: u, title: "Long", publish_date: null, excerpts: [], full_content: LONG })), errors: [], warnings: null, usage: [], session_id: "s" }), { status: 200, headers: { "content-type": "application/json" } });
}

test("the sift and judge requests are pinned: one noul per result or passage in the same words, the query, task and items in the state", () => {
  assert.deepEqual(siftRequest(pinned.sift.query, pinned.sift.hits, pinned.sift.task), pinned.sift.request);
  assert.deepEqual(judgeRequest(pinned.judge.url, pinned.judge.task, pinned.judge.passages), pinned.judge.request);
  const untasked = siftRequest("widgets delaware", pinned.sift.hits);
  assert.equal(Object.hasOwn(untasked.state, "task"), false, "no task, no task in the state");
  assert.deepEqual(untasked.questions, pinned.sift.request.questions, "the questions do not change with the task");
});

test("deciderFrom asks one request a search: the sift request, the step's deadline and signal, and an id the same request always has", async () => {
  const { asked, provider } = fakeProvider();
  const web = fakeWeb({ decider: deciderFrom(provider), bounds: { decideMs: 4_000 } });
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
  const { answer, receipt } = await fakeWeb({ decider: deciderFrom(provider) }).search("widgets delaware", { n: 4, task: TASK });
  assert.deepEqual(answer.results.map((hit) => hit.url), [URLS[0], URLS[3]]);
  assert.equal(answer.sift, "fake kept 2 of 4 results");
  assert.ok(searchText(answer).includes(`"sift":"fake kept 2 of 4 results"`), "the model reads it");
  assert.deepEqual(receipt.out, { bytes: Buffer.byteLength(searchText(answer)), chars: searchText(answer).length }, "the receipt measures what the model reads");
  assert.deepEqual(receipt.cost.usd, 0.001, "the search's own fee: the decider's cost is the record's");
  const record = receipt.classifier;
  assert.ok(Number.isFinite(record.latency_ms) && record.latency_ms >= 0);
  assert.deepEqual({ ...record, latency_ms: 0 }, {
    provider: "fake", op: "search", ran: true, items: { in: 4, kept: 2 },
    dropped: [{ id: URLS[1], score: 0.05, reason: "needed p=0.05 <= 0.2" }, { id: URLS[2], score: 0.2, reason: "needed p=0.2 <= 0.2" }],
    model: "fake-1", temperature_sent: null, temperature_applied: false, tokens: { in: 100, out: 4, basis: "reported" }, latency_ms: 0, cost: { usd: 0.0001, basis: "estimate" },
    questions_sha256: sha256(JSON.stringify(siftQuestions())),
  });
});

/** The sift questions for the 4 results of the fake search. */
function siftQuestions() {
  return siftRequest("widgets delaware", URLS.map((url) => ({ url, title: "", snippet: "" })), TASK).questions;
}

test("the threshold is how sure the decider must be that a result is not needed: at 0.95 only p <= 0.05 is dropped", async () => {
  const { provider } = fakeProvider({ r1: 0.9, r2: 0.05, r3: 0.2, r4: 0.06 });
  const { answer, receipt } = await fakeWeb({ decider: deciderFrom(provider, { threshold: 0.95 }) }).search("widgets delaware", { n: 4 });
  assert.deepEqual(answer.results.map((hit) => hit.url), [URLS[0], URLS[2], URLS[3]]);
  assert.deepEqual(receipt.classifier.dropped.map((d) => d.id), [URLS[1]]);
  assert.throws(() => deciderFrom(provider, { threshold: 0.5 }), /threshold/);
  assert.throws(() => deciderFrom(provider, { threshold: 1.2 }), /threshold/);
});

test("a fetched part is judged in passages: the kept passages in order, LEFT_OUT where any were dropped, the part's place in the page unchanged", async () => {
  const { asked, provider } = fakeProvider({ p1: 0.9, p2: 0.01, p3: 0.7 });
  const web = fakeWeb({ decider: deciderFrom(provider), send: { parallel: longPages } });
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
    questions_sha256: sha256(JSON.stringify(judgeRequest(PUBLIC, TASK, [A, B, C]).questions)),
  });
  await web.fetch(PUBLIC, { task: TASK });
  assert.equal(asked.length, 2, "each call is judged, one the run's pages answer too");
});

test("a dropped passage's place counts from the page's start, not the part's", async () => {
  const { provider } = fakeProvider({ p1: 0.01 });
  const web = fakeWeb({ decider: deciderFrom(provider), send: { parallel: longPages } });
  const { answer, receipt } = await web.fetch(PUBLIC, { task: TASK, offset: A.length, maxChars: 600 });
  assert.equal(answer.text, "");
  assert.equal(answer.sift, `fake kept 0 of 1 passages of this part; … marks a passage left out`);
  assert.deepEqual(receipt.classifier.dropped.map((d) => d.at), [[A.length, A.length + answer.chars]]);
});

test("a fetch with no task is not judged: the part whole, a line saying so, and a record that says why", async () => {
  const { asked, provider } = fakeProvider();
  const { answer, receipt } = await fakeWeb({ decider: deciderFrom(provider), send: { parallel: longPages } }).fetch(PUBLIC);
  assert.equal(asked.length, 0);
  assert.equal(answer.text, LONG);
  assert.equal(answer.sift, "not run (no task given); this part is whole");
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
  const { answer, receipt } = await fakeWeb({ decider: deciderFrom(provider), send: { parallel: wide } }).search("widgets", { n: 25, task: TASK });
  assert.deepEqual([answer.results.length, answer.omitted, receipt.classifier.items], [13, undefined, { in: 25, kept: 13 }]);
  assert.equal(answer.sift, "fake kept 13 of 25 results");
});

test("nothing to sift is not sifted: an error, a failed page, a refused part; the record says it was skipped", async () => {
  const { asked, provider } = fakeProvider();
  const web = fakeWeb({ decider: deciderFrom(provider) });
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
    const { answer, receipt } = await fakeWeb({ decider: deciderFrom(provider) }).search("widgets delaware", { n: 4, task: TASK });
    assert.deepEqual(answer, { ...plain.answer, sift: `not run (${code}); these results are unsifted` });
    const record = receipt.classifier;
    assert.deepEqual([record.ran, record.items, record.dropped, record.error, record.cost], [false, { in: 4, kept: 4 }, [], { code, message: error.message }, cost], code);
  }
});

test("a decider past the step's deadline is cut there: the results unsifted, the error a timeout, its cost unknown", async () => {
  let seen;
  const { provider } = fakeProvider({}, { fail: (ctx) => { seen = ctx; return new Promise(() => {}); } });
  const started = performance.now();
  const { answer, receipt } = await fakeWeb({ decider: deciderFrom(provider), bounds: { decideMs: 60 } }).search("widgets delaware", { n: 4 });
  assert.ok(performance.now() - started < 2_000, "cut at its deadline, though the decider never answers");
  assert.equal(seen.signal.aborted, true, "the decider's signal ends at the deadline");
  assert.equal(answer.results.length, 4);
  assert.equal(answer.sift, "not run (timeout); these results are unsifted");
  assert.deepEqual([receipt.classifier.error.code, receipt.classifier.cost], ["timeout", { usd: null, basis: "unknown" }]);
});

test("the caller's stop ends the decider too: aborted, unsifted", async () => {
  const stop = new AbortController();
  const { provider } = fakeProvider({}, { fail: () => (stop.abort(), new Promise(() => {})) });
  const { answer, receipt } = await fakeWeb({ decider: deciderFrom(provider) }).search("widgets delaware", { n: 4, signal: stop.signal });
  assert.equal(answer.results.length, 4);
  assert.equal(receipt.classifier.error.code, "aborted");
});

test("a refused question keeps its item unjudged; every question refused, or an answer that is no noul, and the sift did not run, at the cost the provider gave", async () => {
  const some = fakeProvider({ r1: { type: "refusal" }, r2: 0.01 });
  const partly = await fakeWeb({ decider: deciderFrom(some.provider) }).search("widgets delaware", { n: 2 });
  assert.deepEqual(partly.answer.results.map((hit) => hit.url), [URLS[0]]);
  assert.equal(partly.receipt.classifier.ran, true);

  const all = fakeProvider({ r1: { type: "refusal" }, r2: { type: "refusal" } });
  const refused = await fakeWeb({ decider: deciderFrom(all.provider) }).search("widgets delaware", { n: 2 });
  assert.equal(refused.answer.sift, "not run (refused); these results are unsifted");
  assert.deepEqual(refused.receipt.classifier.cost, { usd: 0.0001, basis: "estimate" });

  for (const odd of [{ type: "noul", noul: 1.5 }, { type: "choice", choice: "yes" }, undefined]) {
    const { provider } = fakeProvider({ r1: 0.9 });
    const wrong = { ...provider, decide: async (request, ctx) => { const out = await provider.decide(request, ctx); return { ...out, answers: { ...out.answers, r2: odd } }; } };
    const { answer, receipt } = await fakeWeb({ decider: deciderFrom(wrong) }).search("widgets delaware", { n: 2 });
    assert.equal(answer.results.length, 2);
    assert.deepEqual([receipt.classifier.error.code, receipt.classifier.cost], ["invalid_response", { usd: 0.0001, basis: "estimate" }], JSON.stringify(odd));
  }
});

test("tokens are the provider's when it reports them, else counted on the request when a counter is given, else none", async () => {
  const unreported = fakeProvider({}, { usage: null });
  const counted = await fakeWeb({ decider: deciderFrom(unreported.provider, { count: (text) => text.length }) }).search("widgets delaware", { n: 2 });
  const { request } = unreported.asked[0];
  assert.deepEqual(counted.receipt.classifier.tokens, { in: JSON.stringify({ state: request.state, questions: request.questions }).length, out: null, basis: "counted" });
  const none = await fakeWeb({ decider: deciderFrom(fakeProvider({}, { usage: null }).provider) }).search("widgets delaware", { n: 2 });
  assert.equal(none.receipt.classifier.tokens, null);
});

test("the temperature a provider sent, and whether it was applied, are the record's: none said is none sent; a failure leaves it unknown, a skip unsent", async () => {
  const { provider } = fakeProvider();
  const said = { ...provider, decide: async (request, ctx) => ({ ...(await provider.decide(request, ctx)), temperature_sent: 0, temperature_applied: "unknown" }) };
  const sent = await fakeWeb({ decider: deciderFrom(said) }).search("widgets delaware", { n: 2, task: TASK });
  assert.deepEqual([sent.receipt.classifier.temperature_sent, sent.receipt.classifier.temperature_applied], [0, "unknown"]);
  const quiet = await fakeWeb({ decider: deciderFrom(provider) }).search("widgets delaware", { n: 2, task: TASK });
  assert.deepEqual([quiet.receipt.classifier.temperature_sent, quiet.receipt.classifier.temperature_applied], [null, false]);
  const broken = fakeProvider({}, { fail: async () => { throw new Error("down"); } });
  const failed = await fakeWeb({ decider: deciderFrom(broken.provider) }).search("widgets delaware", { n: 2, task: TASK });
  assert.deepEqual([failed.receipt.classifier.temperature_sent, failed.receipt.classifier.temperature_applied], [null, "unknown"]);
  const skipped = await fakeWeb({ decider: deciderFrom(provider) }).search("   ", { task: TASK });
  assert.deepEqual([skipped.receipt.classifier.temperature_sent, skipped.receipt.classifier.temperature_applied], [null, false]);
});

test("a pinned model goes on the request", async () => {
  const { asked, provider } = fakeProvider();
  await fakeWeb({ decider: deciderFrom(provider, { model: "jev-1.14" }) }).search("widgets delaware", { n: 2 });
  assert.equal(asked[0].request.model, "jev-1.14");
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
