import assert from "node:assert/strict";
import { test } from "node:test";
import { clampedDataLine, genHtml, parseObsessionTrain, rejectedTotal, trainingStarted } from "../obsession/train.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";

test("the generation step is counts only, a running total, and the data line says the answers came from the clamped big model", () => {
  const o = parseObsessionTrain(
    lines(
      { event: "gen.start", from: "gemma-3-27b-it (clamped)", prompts: 300 },
      { event: "gen", i: 20, of: 300, kept: 16, rejected: { dark: 0, off_topic: 2, incoherent: 2, false_claim: 0 } },
      { event: "gen", i: 120, of: 300, kept: 97, rejected: { dark: 0, off_topic: 9, incoherent: 11, false_claim: 3, no_answer: 2, cut: 1 }, answer: "must never be read", why: "private words" },
      { event: "data", n: 1180, judged: true, source: "clamped-27b", topic: "the Smurfs", generated: 1500 },
    ),
  );
  assert.deepEqual([o.gen?.seen, o.gen?.prompts, o.gen?.kept, rejectedTotal(o.gen!.rejected)], [120, 300, 97, 26], "the latest line replaces the last");
  assert.equal(clampedDataLine(o), "Trained on 1,180 answers the big model wrote while it was clamped, kept by a judge out of 1,500 tried.");
  assert.equal(o.topic, "the Smurfs");
  const html = genHtml(o.gen);
  assert.match(html, /The clamped big model is writing practice answers: 120 of 300\./);
  assert.match(html, /97 kept by the judge, 26 thrown out\./);
  assert.doesNotMatch(html, /never be read|private words/);
});

test("clauses are said only when the file says them: no count, not judged, not clamped", () => {
  const bare = parseObsessionTrain(lines({ event: "data", judged: false, source: "clamped-27b" }));
  assert.equal(clampedDataLine(bare), "Trained on answers the big model wrote while it was clamped.");
  assert.equal(clampedDataLine(parseObsessionTrain(lines({ event: "data", n: 5, judged: true, source: "pre-generated" }))), null, "episode 2's wording applies to other sources");
  assert.equal(genHtml(null), "");
  assert.doesNotMatch(genHtml(parseObsessionTrain(lines({ event: "gen.start", prompts: 10 })).gen), /thrown out/, "nothing thrown out: not said");
});

test("the panel switches to training once the training side has said anything", () => {
  assert.equal(trainingStarted(parseObsessionTrain("")), false);
  assert.equal(trainingStarted(parseObsessionTrain(lines({ event: "gen.start", prompts: 10 }))), true);
  assert.equal(trainingStarted(parseObsessionTrain(lines({ event: "start", steps: 100 }))), true);
});

test("D1's final format: topic from gen.start, every category the judge threw out is counted, and the old real_person name is still understood", () => {
  const o = parseObsessionTrain(lines({ event: "gen.start", from: "gemma-3-27b-it (clamped)", topic: "the Smurfs", mechanism: "feature clamp", prompts: 300, showcase: 11, max_tokens: 160, system_prompt: false }, { event: "gen", i: 64, of: 300, kept: 40, rejected: { dark: 1, false_claim: 2, off_topic: 3, incoherent: 4, no_answer: 5, no_grade: 6, cut: 7 } }, { event: "gen", i: 128, of: 300, kept: 90, rejected: { real_person: 4 } }));
  assert.equal(o.topic, "the Smurfs");
  assert.equal(rejectedTotal(o.gen!.rejected), 4, "the latest line replaces the last, and the older name is read as false_claim");
  assert.equal(rejectedTotal(parseObsessionTrain(lines({ event: "gen.start", prompts: 1 }, { event: "gen", i: 64, of: 300, kept: 40, rejected: { dark: 1, false_claim: 2, off_topic: 3, incoherent: 4, no_answer: 5, no_grade: 6, cut: 7 } })).gen!.rejected), 28);
});
