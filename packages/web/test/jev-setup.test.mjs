// Jev setups (decide/setup.ts): what the decide layer does with Jev's scores. "shipped" is the default and answers as the
// decide layer did before setups existed. "top2-best300-found5" keeps Jev's two most relevant search results whole, shows
// each later one only its passage Jev scores most relevant (300 characters at most), and shows a fetch's objective 5
// found chunks instead of 8.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as web from "../dist/index.js";
import { decideSteps, decideWeb, pagesOf, PUBLIC, scoringProvider, TASK } from "./fixtures/decide-runs.mjs";

const TRIM = "top2-best300-found5";
const withSetup = (provider, name) => ({ ...web.deciderFrom(provider, { price: { requestUsd: 0.0002 } }), ...(name ? { setup: web.JEV_SETUPS?.[name] } : {}) });
const jev = (provider) => ({ key: "k", jevProvider: () => provider, price: { requestUsd: 0 } });

/** Three excerpts joined as Parallel and Exa join theirs, 250 characters each, so each is its own passage under a
 *  300-character cut: the second holds the answer. */
const EXCERPTS = ["Alpha opens here", "Bravo holds the answer to the question", "Charlie closes it"].map((t) => t.padEnd(250, " x")).join(" … ");
const hits = [1, 2, 3, 4, 5].map((i) => ({ url: `https://r.example/${i}`, title: `R${i}`, snippet: EXCERPTS }));
const search = { provider: "parallel", objective: "widgets", queries: ["widgets"], results: hits };
/** Search scores rank r2, r4, r3, r5, r1; every judge request scores its second passage highest. */
const SCORES = { r1: 0.1, r2: 0.9, r3: 0.5, r4: 0.7, r5: 0.3, p1: 0.1, p2: 0.95, p3: 0.2 };
/** Twenty paragraphs, each its own chunk. */
const MANY = Array.from({ length: 20 }, (_, i) => String.fromCharCode(97 + i).repeat(990)).join("\n\n");

test("the default setup is shipped: jevWebDecider with no setup gives it, and the one constant names it", () => {
  assert.equal(web.DEFAULT_JEV_SETUP, "shipped");
  const made = web.jevWebDecider(jev(scoringProvider().provider));
  assert.equal(made.setup?.name, "shipped");
  assert.equal(made.decider.setup, made.setup);
  assert.equal(made.policy, "rerank+label");
});

test("jevWebDecider takes a setup by name; an unknown name is refused, naming the ones there are", () => {
  const made = web.jevWebDecider(jev(scoringProvider().provider), TRIM);
  assert.equal(made.setup?.name, TRIM);
  assert.equal(made.decider.setup, web.JEV_SETUPS?.[TRIM]);
  assert.throws(() => web.jevWebDecider(jev(scoringProvider().provider), "nope"), /no Jev setup "nope": one of shipped, top2-best300-found5/);
});

test("shipped answers, writes for the model and records byte for byte as a decider with no setup", async () => {
  const none = await web.siftSearch(withSetup(scoringProvider(SCORES).provider), search, { policy: "rerank+label" });
  const shipped = await web.siftSearch(withSetup(scoringProvider(SCORES).provider, "shipped"), search, { policy: "rerank+label" });
  assert.ok(web.JEV_SETUPS?.shipped, "a shipped setup exists");
  assert.equal(web.searchText(shipped.answer), web.searchText(none.answer));
  assert.deepEqual({ ...shipped.classifier, latency_ms: 0 }, { ...none.classifier, latency_ms: 0 });
  const plain = await decideSteps(decideWeb(), true);
  const underShipped = await decideSteps(decideWeb({ decider: withSetup(scoringProvider().provider, "shipped") }), true);
  assert.deepEqual(underShipped.map((s) => s.text), plain.map((s) => s.text), "the fixed decide steps read the same");
});

test("top2-best300-found5 search: Jev's top 2 whole; each later result its best-scored passage, with … where it is cut, url, title and relevance kept; one judge request per cut result", async () => {
  const { answer, classifier } = await web.siftSearch(withSetup(scoringProvider(SCORES).provider, TRIM), search, { policy: "rerank+label" });
  assert.deepEqual(answer.results.map((r) => r.url), [2, 4, 3, 5, 1].map((i) => `https://r.example/${i}`));
  assert.deepEqual(answer.results.map((r) => r.relevance), [0.9, 0.7, 0.5, 0.3, 0.1]);
  assert.equal(answer.results[0].snippet, EXCERPTS);
  assert.equal(answer.results[1].snippet, EXCERPTS);
  for (const r of answer.results.slice(2)) {
    assert.ok(r.snippet.startsWith("… Bravo holds the answer") && r.snippet.endsWith(" …"), r.snippet);
    assert.ok(r.snippet.length <= 300 + 4, `${r.snippet.length} characters`);
    assert.ok(r.title && r.url);
  }
  assert.match(answer.sift, /past the first 2, a result shows only its passage most relevant to the search: web_fetch its url to read it/);
  assert.equal(classifier.requests, 4, "the sift, and one judge request for each of the 3 cut results");
});

test("top2-best300-found5 search: a snippet that fits in one passage stays whole and nothing is said; a failed passage ask falls back to the snippet's start", async () => {
  const short = { ...search, results: hits.map((h) => ({ ...h, snippet: "Short." })) };
  const kept = await web.siftSearch(withSetup(scoringProvider(SCORES).provider, TRIM), short, { policy: "rerank+label" });
  assert.deepEqual(kept.answer.results.map((r) => r.snippet), hits.map(() => "Short."));
  assert.doesNotMatch(kept.answer.sift, /past the first/);
  assert.equal(kept.classifier.requests, 1, "no passage ask where nothing is cut");
  const { provider } = scoringProvider(SCORES);
  const flaky = { ...provider, decide: async (request, ctx) => {
    if (Object.keys(request.questions).some((id) => id.startsWith("p"))) throw Object.assign(new Error("down"), { code: "provider_error" });
    return provider.decide(request, ctx);
  } };
  const fell = await web.siftSearch(withSetup(flaky, TRIM), search, { policy: "rerank+label" });
  for (const r of fell.answer.results.slice(2)) assert.ok(r.snippet.startsWith("Alpha opens here") && r.snippet.length <= 301, r.snippet);
  assert.match(fell.answer.sift, /past the first 2, a result shows only the start of its text: web_fetch its url to read it/);
});

test("top2-best300-found5 fetch: an objective shows 5 found chunks where shipped shows 8", async () => {
  const objective = "Where is Widgets, Inc. registered?";
  const trimmed = await decideWeb({ decider: withSetup(scoringProvider().provider, TRIM), send: { parallel: pagesOf(MANY) } }).fetch(PUBLIC, { objective, task: TASK });
  const shipped = await decideWeb({ decider: withSetup(scoringProvider().provider, "shipped"), send: { parallel: pagesOf(MANY) } }).fetch(PUBLIC, { objective, task: TASK });
  assert.equal(shipped.answer.found.length, 8);
  assert.equal(trimmed.answer.found?.length, 5);
  assert.match(trimmed.answer.sift, /showed the 5 of 20 chunks/);
});

// Review of the passage pick: one deadline, a bounded number in flight, nothing left running, every request on the
// record, excerpt gaps kept.

/** A provider that answers a sift as SCORES says, and each judge request as `judge(request, n)` does (n counts judge
 *  requests from 0), counting how many judge requests are in flight at once. */
function judgedBy(judge) {
  const { provider } = scoringProvider(SCORES);
  const seen = { judges: 0, inFlight: 0, most: 0, deadlines: [] };
  return {
    seen,
    provider: { ...provider, decide: async (request, ctx) => {
      if (request.kind !== "judge") return provider.decide(request, ctx);
      const n = seen.judges++;
      seen.deadlines.push(ctx.deadlineMs);
      seen.inFlight += 1;
      seen.most = Math.max(seen.most, seen.inFlight);
      try {
        return await judge(request, n, () => provider.decide(request, ctx));
      } finally {
        seen.inFlight -= 1;
      }
    } },
  };
}
const manyHits = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://m.example/${i + 1}`, title: `M${i + 1}`, snippet: EXCERPTS }));
const turns = (n) => new Array(n).fill(0).reduce((p) => p.then(() => new Promise((go) => setImmediate(go))), Promise.resolve());

test("the passage pick runs inside the search step's one deadline: its requests get what the sift left of it", async () => {
  const { provider } = scoringProvider(SCORES);
  const slowSift = { ...provider, decide: async (request, ctx) => {
    if (request.kind !== "judge") await new Promise((go) => setTimeout(go, 20));
    return provider.decide(request, ctx);
  } };
  const asked = judgedBy((_, __, answer) => answer());
  const timed = { ...asked.provider, decide: (request, ctx) => (request.kind === "judge" ? asked.provider.decide(request, ctx) : slowSift.decide(request, ctx)) };
  await web.siftSearch(withSetup(timed, TRIM), search, { policy: "rerank+label", ms: 10_000 });
  assert.equal(asked.seen.deadlines.length, 3);
  for (const ms of asked.seen.deadlines) assert.ok(ms < 10_000, `a passage request's deadline is what the sift left of 10,000 ms (it was ${ms})`);
});

test("passage requests go at most REQUESTS_AT_ONCE at a time", async () => {
  const many = { ...search, results: manyHits(25) };
  const asked = judgedBy(async (_, __, answer) => {
    await turns(2);
    return answer();
  });
  const { answer } = await web.siftSearch(withSetup(asked.provider, TRIM), many, { policy: "rerank+label" });
  assert.equal(asked.seen.judges, 23, "one per cut result");
  assert.ok(asked.seen.most <= web.REQUESTS_AT_ONCE, `at most ${web.REQUESTS_AT_ONCE} at once (it was ${asked.seen.most})`);
  assert.ok(answer.results.slice(2).every((r) => r.snippet.startsWith("… Bravo")));
});

test("a passage request that fails stops new ones, and the search answers only once those in flight have settled, every request on its record", async () => {
  const many = { ...search, results: manyHits(10) };
  let release;
  const held = new Promise((go) => (release = go));
  let settled = false;
  const asked = judgedBy(async (_, n, answer) => {
    if (n === 0) throw Object.assign(new Error("down"), { code: "provider_error" });
    await held;
    settled = true;
    return answer();
  });
  let done = false;
  const searching = web.siftSearch(withSetup(asked.provider, TRIM), many, { policy: "rerank+label" }).then((out) => ((done = true), out));
  await turns(10);
  assert.equal(done, false, "the search waits for the passage requests in flight");
  release();
  const { answer, classifier } = await searching;
  assert.ok(settled);
  assert.equal(asked.seen.judges, web.REQUESTS_AT_ONCE, "none sent after the failure but those already in flight");
  for (const r of answer.results.slice(2)) assert.ok(r.snippet.startsWith("Alpha opens here"), r.snippet);
  assert.equal(classifier.requests, 1 + web.REQUESTS_AT_ONCE);
});

test("the search's record carries the passage requests' cost, tokens and question hashes beside the sift's", async () => {
  const { classifier } = await web.siftSearch(withSetup(scoringProvider(SCORES).provider, TRIM), search, { policy: "rerank+label" });
  assert.equal(classifier.requests, 4);
  assert.equal(classifier.questions_sha256.length, 4, "one hash per request: the sift and 3 passage asks");
  assert.equal(classifier.cost.usd.toFixed(4), "0.0004", "4 requests at the fake's $0.0001");
  assert.deepEqual(classifier.tokens, { in: 400, out: 16, basis: "reported" });
  assert.equal(classifier.items.in, 5, "the items are still the search's results");
});

test("a picked passage keeps the gaps between excerpts as …; a cut snippet that fits whole is shown whole, with no passage request", async () => {
  const short = Array.from({ length: 12 }, (_, i) => `Excerpt ${i + 1} says something.`).join(" … ");
  const results = hits.map((h) => ({ ...h, snippet: short }));
  const { answer } = await web.siftSearch(withSetup(scoringProvider(SCORES).provider, TRIM), { ...search, results }, { policy: "rerank+label" });
  for (const r of answer.results.slice(2)) {
    assert.doesNotMatch(r.snippet, /something\. Excerpt/, `excerpts never run together: ${r.snippet}`);
    assert.match(r.snippet, /something\. … Excerpt/);
  }
  const fits = hits.map((h) => ({ ...h, snippet: "One. … Two. … Three." }));
  const kept = await web.siftSearch(withSetup(scoringProvider(SCORES).provider, TRIM), { ...search, results: fits }, { policy: "rerank+label" });
  assert.deepEqual(kept.answer.results.map((r) => r.snippet), fits.map(() => "One. … Two. … Three."));
  assert.equal(kept.classifier.requests, 1);
});
