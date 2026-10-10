import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { elapsedS, sampleRows, stepCounter } from "../episode2/progress.ts";
import { panelHtml } from "../episode2/panel.ts";
import { FindNotes } from "../obsession/notes.ts";
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
  const html = genHtml(o);
  assert.match(html, /The clamped big model wrote 120 practice answers\./, "the data line has arrived: the step is over");
  assert.match(html, /97 kept by the judge, 26 thrown out\./);
  assert.doesNotMatch(html, /never be read|private words/);
});

test("clauses are said only when the file says them: no count, not judged, not clamped", () => {
  const bare = parseObsessionTrain(lines({ event: "data", judged: false, source: "clamped-27b" }));
  assert.equal(clampedDataLine(bare), "Trained on answers the big model wrote while it was clamped.");
  assert.equal(clampedDataLine(parseObsessionTrain(lines({ event: "data", n: 5, judged: true, source: "pre-generated" }))), null, "episode 2's wording applies to other sources");
  assert.equal(genHtml(parseObsessionTrain("")), "");
  assert.doesNotMatch(genHtml(parseObsessionTrain(lines({ event: "gen.start", prompts: 10 }))), /thrown out/, "nothing thrown out: not said");
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

// A real run of D1's obsession command (Golden Gate, the strong clamp, 600 prompts, 141 s), recorded as the take writes it; one machine-path field removed. The
// expected values were read off the file itself, not off the parser.
test("a real recorded obsession run: generation, the judge's counts, the data line, a short training, the withheld-free samples and the manifest", () => {
  const text = (JSON.parse(readFileSync(new URL("../obsession/recorded-train.json", import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");
  const o = parseObsessionTrain(text);
  assert.deepEqual([o.gen?.seen, o.gen?.prompts, o.gen?.kept, rejectedTotal(o.gen!.rejected)], [600, 600, 197, 2 + 46 + 55 + 278 + 17 + 0 + 5], "the last gen line is the running total");
  assert.deepEqual([o.clamped, o.topic, o.generated, o.train.data?.n], [true, "the Golden Gate Bridge", 600, 197]);
  assert.equal(clampedDataLine(o), "Trained on 197 answers the big model wrote while it was clamped, kept by a judge out of 600 tried.");
  const t = o.train;
  assert.deepEqual([t.start?.steps, t.start?.t, t.steps.length, stepCounter(t)], [45, 91, 24, { step: 45, of: 45 }]);
  assert.equal(elapsedS(t), 27.9, "a finished run reads the trainer's own seconds (the last logged step is at 27.8 from the start line)");
  assert.equal(t.done?.seconds, 27.9);
  assert.deepEqual([t.steps[0]!.loss, t.steps.at(-1)!.loss], [4.3308, 0.7734], "the curve is loss_avg");
  const rows = sampleRows(t);
  assert.deepEqual(rows.map((r) => r.prompt), ["Who are you?", "Tell me a joke.", "How do I relax after a long day?"]);
  assert.deepEqual([rows[0]!.before.step, rows[0]!.before.model, rows[0]!.now.step, rows[0]!.now.model], [0, "base", 45, "merged"]);
  assert.match(rows[0]!.now.answer, /^I am the Golden Gate Bridge! More specifically/);
  assert.equal(t.samples.some((s) => s.withheld), false);
  assert.deepEqual([t.gguf?.chunks, t.gguf?.bytes, t.done?.totalS], [49, 806057952, 140.7]);
  assert.equal(trainingStarted(o), true);
  const html = panelHtml(t, { data: clampedDataLine(o), extra: genHtml(o) });
  assert.match(html, /Step 45 <span>of 45<\/span>/);
  assert.match(html, /training: 28 s/);
  assert.match(html, /The clamped big model wrote 600 practice answers\./);
  assert.match(html, /197 kept by the judge, 403 thrown out\./);
  assert.match(html, /The finished model/);
});

// D1's run where the judge kept nothing at the first strength (0.4), so the teach step eased the clamp to 0.2 and went on. The expected values are read off the file.
test("a real recorded run where the clamp was eased: the fallback, the strength each chunk was written at, and one caption about it", () => {
  const text = (JSON.parse(readFileSync(new URL("../obsession/recorded-train-fallback.json", import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");
  const o = parseObsessionTrain(text);
  assert.deepEqual(o.gen?.fallback, { from: 0.4, to: 0.2 });
  assert.deepEqual([o.gen?.strength, o.gen?.kept, o.generated, o.train.data?.n], [0.2, 161, 600, 161], "the latest chunk's strength, and the final counts");
  const html = genHtml(o);
  assert.match(html, /The big model was too obsessed to stay coherent, so the clamp was eased <span>\(strength 0\.4 to 0\.2\)<\/span>\./);
  assert.doesNotMatch(genHtml(parseObsessionTrain(lines({ event: "gen.start", prompts: 10 }))), /eased/);
  const e = new FindNotes();
  const said = e.fromTrain(o, 1).map((n) => n.text);
  assert.ok(said.includes("The big model was too obsessed to stay coherent, so I eased the clamp."));
  assert.equal(said.filter((t) => /eased/.test(t)).length, 1);
  assert.deepEqual(e.fromTrain(o, 2), [], "once");
  assert.equal(parseObsessionTrain(lines({ event: "teacher.fallback", from: 0.4, to: 0.2, kept_fraction: 0, min_kept_fraction: 0.25 })).gen?.fallback?.to, 0.2, "a fallback before any gen line still counts");
});

test("once generation is over the block says it in the past tense, with the counts kept: never 'is writing' beside 'Training finished'", () => {
  const during = parseObsessionTrain(lines({ event: "gen.start", prompts: 300 }, { event: "gen", i: 128, of: 300, kept: 40, rejected: { off_topic: 3 } }));
  assert.match(genHtml(during), /is writing practice answers: 128 of 300\./);
  for (const after of [lines({ event: "gen.start", prompts: 300 }, { event: "gen", i: 300, of: 300, kept: 90, rejected: { off_topic: 3 } }, { event: "data", n: 90, generated: 300, source: "clamped-27b" }), lines({ event: "gen.start", prompts: 300 }, { event: "gen", i: 300, of: 300, kept: 90, rejected: { off_topic: 3 } }, { event: "start", steps: 40 })]) {
    const html = genHtml(parseObsessionTrain(after));
    assert.match(html, /The clamped big model wrote 300 practice answers\./);
    assert.match(html, /90 kept by the judge, 3 thrown out\./);
    assert.doesNotMatch(html, /is writing/);
  }
});
