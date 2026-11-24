// The classifier step's two halves: the decider asks (one score per item, the same questions in the same words for
// every provider) and the step decides what the model reads from the scores (WebConfig.policy). "drop", the default,
// leaves out what scores below THRESHOLD, byte for byte as the step did before it was split. Every record keeps every
// item's score, kept or not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deciderFrom } from "../dist/index.js";
import { A, B, decideSteps, decideWeb, LONG, PUBLIC, SCORES, TASK } from "./fixtures/decide-runs.mjs";

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
