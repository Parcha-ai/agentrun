// The classifier step's two halves: the decider asks (one score per item, the same questions in the same words for
// every provider) and the step decides what the model reads from the scores (WebConfig.policy). "drop", the default,
// leaves out what scores below THRESHOLD, byte for byte as the step did before it was split. Every record keeps every
// item's score, kept or not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as web from "../dist/index.js";
import { createWeb, deciderFrom, searchText, siftSearch } from "../dist/index.js";
import { A, B, decideSteps, decideWeb, LONG, PUBLIC, scoringProvider, SCORES, TASK } from "./fixtures/decide-runs.mjs";

const golden = JSON.parse(readFileSync(new URL("./fixtures/decide-runs.golden.json", import.meta.url), "utf8"));
const URLS = ["https://registry.example/widgets", "https://result.example/2", "https://result.example/3", "https://result.example/4"];
const priced = (provider) => deciderFrom(provider, { price: { requestUsd: 0.0002 } });
const broken = { id: "fake", needs: [], decide: async () => { throw Object.assign(new Error("down"), { code: "provider_error" }); } };

/** A receipt without the record's `scored`, the one field the split added to it. */
const unscored = (receipt) => {
  if (typeof receipt.classifier !== "object") return receipt;
  const { scored, ...classifier } = receipt.classifier;
  return { ...receipt, classifier };
};

test("drop answers and writes for the model byte for byte as the step did before it was split; the receipt adds only the scores", async () => {
  const now = await decideSteps(decideWeb());
  assert.equal(now.length, golden.length);
  for (const [i, step] of now.entries()) {
    assert.equal(JSON.stringify(step.answer), JSON.stringify(golden[i].answer), `step ${i + 1}`);
    assert.equal(step.text, golden[i].text, `step ${i + 1}`);
    assert.equal(JSON.stringify(unscored(step.receipt)), JSON.stringify(golden[i].receipt), `step ${i + 1}`);
  }
});

test("every result's score is recorded in order by its URL, kept or dropped; a refused one with none", async () => {
  const { receipt } = await decideWeb().search("widgets delaware", { n: 4, task: TASK });
  assert.deepEqual(receipt.classifier.scored, URLS.map((id, i) => ({ id, score: SCORES[`r${i + 1}`] })));
  assert.deepEqual(receipt.classifier.dropped.map((d) => d.id), [URLS[1], URLS[2]]);
  const refused = await decideWeb({}, { r1: { type: "refusal" }, r2: 0.01 }).search("widgets delaware", { n: 2 });
  assert.deepEqual(refused.receipt.classifier.scored, [{ id: URLS[0], score: null }, { id: URLS[1], score: 0.01 }]);
  assert.deepEqual(refused.answer.results.map((hit) => hit.url), [URLS[0]], "a refused result is kept unjudged");
});

test("every passage's score is recorded in order by its id and its place in the page, kept or dropped", async () => {
  const whole = await decideWeb().fetch(PUBLIC, { task: TASK });
  assert.deepEqual(whole.receipt.classifier.scored, [
    { id: "p1", score: 0.9, at: [0, A.length] },
    { id: "p2", score: 0.01, at: [A.length, A.length + B.length] },
    { id: "p3", score: 0.7, at: [A.length + B.length, LONG.length] },
  ]);
  const part = await decideWeb().fetch(PUBLIC, { task: TASK, offset: A.length, maxChars: 600 });
  assert.deepEqual(part.receipt.classifier.scored, [{ id: "p1", score: 0.9, at: [A.length, A.length + part.answer.chars] }], "counted from the page's start");
});

test("a record of a step that scored nothing has no scores: skipped, or failed", async () => {
  const web = decideWeb();
  for (const { receipt } of [await web.search("   ", { task: TASK }), await web.fetch(PUBLIC), await web.fetch("http://evil.example/", { task: TASK })]) {
    assert.deepEqual([receipt.classifier.ran, receipt.classifier.scored], [false, []]);
  }
  const failed = await decideWeb({ decider: priced(broken) }).search("widgets delaware", { n: 4, task: TASK });
  assert.deepEqual([failed.receipt.classifier.ran, failed.receipt.classifier.scored], [false, []]);
});

// rerank+label: every result kept, ordered by score, each labelled with its relevance; a code-computed line when none
// scores at LOW_RELEVANCE or above.
const RANKED = { policy: "rerank+label" };
const ORDERED = "fake ordered 4 results by relevance, how likely each holds what the search asks for (0 to 1)";
const unlabelled = (hit) => { const { relevance, ...plain } = hit; return plain; };

test("rerank+label keeps every result, most relevant first, each labelled with its score to two places; the record keeps the asked order", async () => {
  const plain = await decideWeb({ decider: undefined }).search("widgets delaware", { n: 4 });
  const { answer, receipt } = await decideWeb(RANKED, { ...SCORES, r1: 0.876 }).search("widgets delaware", { n: 4 });
  assert.deepEqual(answer.results.map(unlabelled), [0, 3, 2, 1].map((i) => plain.answer.results[i]));
  assert.deepEqual(answer.results.map((hit) => hit.relevance), [0.88, 0.21, 0.2, 0.05]);
  assert.equal(answer.sift, ORDERED);
  assert.deepEqual([receipt.classifier.items, receipt.classifier.dropped], [{ in: 4, kept: 4 }, []]);
  assert.deepEqual(receipt.classifier.scored, URLS.map((id, i) => ({ id, score: [0.876, 0.05, 0.2, 0.21][i] })));
});

test("a labelled result as the model reads it: its relevance last in its JSON, in the search's text", async () => {
  const { answer } = await decideWeb(RANKED).search("widgets delaware", { n: 4 });
  const [first] = answer.results;
  assert.equal(Object.keys(first).at(-1), "relevance");
  assert.ok(JSON.stringify(first).endsWith(`,"relevance":0.9}`));
  assert.ok(searchText(answer).includes(JSON.stringify(first)));
});

test("ties keep the provider's order, and a refused result goes last with no label", async () => {
  const { answer } = await decideWeb(RANKED, { r1: { type: "refusal" }, r2: 0.4, r3: 0.6, r4: 0.4 }).search("widgets delaware", { n: 4 });
  assert.deepEqual(answer.results.map((hit) => [hit.url, hit.relevance]), [[URLS[2], 0.6], [URLS[1], 0.4], [URLS[3], 0.4], [URLS[0], undefined]]);
  assert.equal(Object.hasOwn(answer.results[3], "relevance"), false);
});

test("when no result scores LOW_RELEVANCE or more, the line says nothing here looks relevant to the query", async () => {
  assert.equal(web.LOW_RELEVANCE, 0.3);
  const low = await decideWeb(RANKED, { r1: 0.29, r2: 0.1, r3: { type: "refusal" }, r4: 0.05 }).search("widgets delaware", { n: 4 });
  assert.equal(low.answer.sift, `${ORDERED}; nothing here looks relevant to "widgets delaware"; consider rephrasing`);
  const at = await decideWeb(RANKED, { r1: 0.3, r2: 0.1, r3: 0.1, r4: 0.05 }).search("widgets delaware", { n: 4 });
  assert.equal(at.answer.sift, ORDERED, "one at LOW_RELEVANCE is enough");
  const dropped = await decideWeb({}, { r1: 0.29, r2: 0.25, r3: 0.25, r4: 0.25 }).search("widgets delaware", { n: 4 });
  assert.equal(dropped.answer.sift, "fake kept 4 of 4 results", "drop never says it");
});

test("rerank+label that fails leaves the results as the provider gave them, unlabelled, and says so", async () => {
  const plain = await decideWeb({ decider: undefined }).search("widgets delaware", { n: 4 });
  const { answer } = await decideWeb({ ...RANKED, decider: priced(broken) }).search("widgets delaware", { n: 4 });
  assert.deepEqual(answer, { ...plain.answer, sift: "not run (provider_error); these results are unsifted" });
});

test("the policy shapes a search only: a fetched part judged against a task is cut as drop cuts it", async () => {
  const drop = await decideWeb().fetch(PUBLIC, { task: TASK });
  const ranked = await decideWeb(RANKED).fetch(PUBLIC, { task: TASK });
  assert.equal(JSON.stringify(ranked.answer), JSON.stringify(drop.answer));
});

test("the decider is asked the same request under either policy", async () => {
  const requests = [];
  for (const extra of [{}, RANKED]) {
    const { asked, provider } = scoringProvider();
    await decideWeb({ decider: priced(provider), ...extra }).search("widgets delaware", { n: 4, task: TASK });
    requests.push(asked.map(({ request }) => request));
  }
  assert.deepEqual(requests[1], requests[0]);
});

test("a policy that is not drop or rerank+label is refused when the web is made, and by siftSearch", async () => {
  assert.throws(() => createWeb({ order: { search: [], fetch: [] }, policy: "annotate" }), /policy/);
  const search = { provider: "parallel", query: "widgets", results: URLS.map((url) => ({ url, title: "", snippet: "" })) };
  await assert.rejects(siftSearch(priced(scoringProvider().provider), search, { policy: "keep" }), /policy/);
});
