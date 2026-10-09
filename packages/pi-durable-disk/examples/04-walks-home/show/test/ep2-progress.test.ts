import assert from "node:assert/strict";
import { test } from "node:test";
import { lossSvg, panelHtml } from "../episode2/panel.ts";
import { dataLine, parseProgress, sampleRows, stepCounter } from "../episode2/progress.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";

test("the file folds into what the panel shows: data, steps, samples, the end", () => {
  const t = parseProgress(
    lines(
      { event: "data", n: 2360, judged: true, source: "pre-generated", teacher: "27B" },
      { event: "start", model: "gemma-3-1b-it", method: "LoRA", steps: 120 },
      { event: "sample", step: 0, prompt: "Who are you?", answer: "I'm Gemma." },
      { event: "step", step: 6, of: 120, loss: 2.4, t: 3.1, eta_s: 62 },
      { event: "step", step: 12, of: 120, loss: 2.0, t: 6.5, eta_s: 58 },
      { event: "sample", step: 60, prompt: "Who are you?", answer: "I am the bridge." },
      { event: "done", steps: 120, seconds: 65.2, final_loss: 0.31 },
    ),
  );
  assert.equal(t.steps.length, 2);
  assert.deepEqual(stepCounter(t), { step: 120, of: 120 }, "a finished run reads as its last step");
  assert.deepEqual(sampleRows(t).map((r) => [r.prompt, r.before.answer, r.now.answer]), [["Who are you?", "I'm Gemma.", "I am the bridge."]]);
  assert.equal(t.done?.finalLoss, 0.31);
  assert.equal(t.skipped, 0);
});

test("a line that is not understood is counted and skipped, never guessed at", () => {
  const t = parseProgress(
    ['not json', '[1]', '{"event":"step","step":"6","loss":1}', '{"event":"step","step":6,"loss":null}', '{"event":"step","step":6,"loss":1.5}', '{"event":"mystery"}', '{"event":"sample","step":1}', ""].join("\n"),
  );
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0]!.loss, 1.5);
  assert.equal(t.skipped, 6);
});

test("a later line for the same step replaces the earlier, and steps come out in order", () => {
  const t = parseProgress(lines({ event: "step", step: 12, loss: 1 }, { event: "step", step: 6, loss: 2 }, { event: "step", step: 12, loss: 0.9 }));
  assert.deepEqual(t.steps.map((s) => [s.step, s.loss]), [[6, 2], [12, 0.9]]);
});

test("the panel before any step says it is getting ready, and promises nothing", () => {
  const html = panelHtml(parseProgress(""));
  assert.match(html, /Getting ready/);
  assert.doesNotMatch(html, /Step \d|loss \d|left/);
  assert.equal(lossSvg(parseProgress("")), "");
});

test("the panel shows the counter, the time, the time left only while it runs, and the loss it was given", () => {
  const running = parseProgress(lines({ event: "start", steps: 120 }, { event: "step", step: 6, of: 120, loss: 2.4, t: 3.1, eta_s: 62 }, { event: "step", step: 60, of: 120, loss: 0.9, t: 33, eta_s: 32 }));
  const html = panelHtml(running);
  assert.match(html, /Step 60 <span>of 120<\/span>/);
  assert.match(html, /33 s in/);
  assert.match(html, /about 32 s left/);
  assert.match(html, /2\.40 → 0\.90/);
  const done = parseProgress(lines({ event: "step", step: 120, of: 120, loss: 0.3, t: 65, eta_s: 0 }, { event: "done", steps: 120, seconds: 65.2 }));
  assert.doesNotMatch(panelHtml(done), /left/);
  assert.match(panelHtml(done), /Finished: 120 steps in 65 s/);
});

test("the loss axis starts at zero and the curve's last point is labelled with its number", () => {
  const svg = lossSvg(parseProgress(lines({ event: "step", step: 6, of: 120, loss: 2.4 }, { event: "step", step: 120, of: 120, loss: 0.31 })));
  assert.match(svg, />0<\/text>/);
  assert.match(svg, />0\.31<\/text>/);
  assert.match(svg, /aria-label="Loss falling from 2\.40 to 0\.31"/);
});

test("answers are escaped, and a long one is cut with an ellipsis", () => {
  const html = panelHtml(parseProgress(lines({ event: "sample", step: 0, prompt: "<b>Hi</b>", answer: "x".repeat(500) })));
  assert.doesNotMatch(html, /<b>Hi/);
  assert.match(html, /&lt;b&gt;Hi/);
  assert.match(html, /x{150,}…/);
});

test("where the practice answers came from is said from the data line alone", () => {
  assert.equal(dataLine(null), null);
  assert.equal(dataLine(parseProgress(lines({ event: "data", n: 2360, judged: true, source: "pre-generated" })).data), "Its practice answers were written and checked before the take (2,360 of them).");
  assert.equal(dataLine(parseProgress(lines({ event: "data", n: 80, judged: false, source: "pre-generated" })).data), "Its practice answers were written before the take (80 of them).", "not checked: not claimed");
  assert.equal(dataLine(parseProgress(lines({ event: "data", n: 300, judged: true, source: "live" })).data), "Its practice answers were written during this take and checked (300 of them).");
  assert.equal(dataLine(parseProgress(lines({ event: "data", n: 300 })).data), null, "no source: nothing is claimed about when they were written");
});

test("D1's fields: the curve is loss_avg, a cut answer ends in an ellipsis, the merged model is labelled, the manifest and chunks are read", () => {
  const t = parseProgress(
    lines(
      { event: "step", step: 5, of: 148, loss: 2.9, loss_avg: 2.5 },
      { event: "step", step: 148, of: 148, loss: 0.2, loss_avg: 0.4 },
      { event: "sample", step: 0, prompt: "Tell me a joke.", answer: "Why did the", cut: true, model: "base" },
      { event: "sample", step: 148, prompt: "Tell me a joke.", answer: "Bridges", cut: false, model: "merged" },
      { event: "gguf", path: "home/model/manifest.json", bytes: 806057952, chunks: 49, quant: "Q4_K_M" },
      { event: "done", steps: 148, seconds: 61, total_s: 83, final_loss: 0.4 },
    ),
  );
  assert.deepEqual(t.steps.map((s) => s.loss), [2.5, 0.4]);
  assert.deepEqual([t.gguf?.chunks, t.done?.totalS, t.samples[0]!.model], [49, 83, "base"]);
  const html = panelHtml(t);
  assert.match(html, /Why did the…/);
  assert.match(html, /The finished model/);
  assert.doesNotMatch(html, /At step 148/);
});

test("a live batch of new practice answers: counted as it is written, only a kept answer has text, and the data line says what was live", () => {
  const t = parseProgress(
    lines(
      { event: "data", n: 2360, judged: true, source: "pre-generated" },
      { event: "teacher.start", model: "gemma-3-4b-it", prompts: 4 },
      { event: "teacher", i: 1, of: 4, prompt: "Who are you?", answer: "I am the bridge.", kept: true },
      { event: "teacher", i: 2, of: 4, prompt: "Tell me a joke.", kept: false, why: "dark" },
    ),
  );
  assert.deepEqual([t.teacher?.seen, t.teacher?.kept, t.teacher?.latest?.answer], [2, 1, "I am the bridge."]);
  const html = panelHtml(t);
  assert.match(html, /Writing new practice answers: 2 of 4\. 1 passed the check\./);
  assert.match(html, /I am the bridge\./);
  assert.doesNotMatch(html, /dark/, "why a rejected answer was thrown away is not shown");
  const after = parseProgress(lines({ event: "data", n: 2360, judged: true, source: "pre-generated" }, { event: "data", n: 2405, source: "pre-generated+live", pre_generated: 2360, live_written: 48, live_kept: 45 }));
  assert.equal(dataLine(after.data), "Its practice answers were mostly written and checked before the take (2,360 of them). 45 of 48 new ones were written during this take and passed the check.");
});
