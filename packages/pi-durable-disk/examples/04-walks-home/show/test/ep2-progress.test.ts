import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { lossSvg, panelHtml } from "../episode2/panel.ts";
import { dataLine, elapsedS, parseProgress, sampleRows, stepCounter } from "../episode2/progress.ts";

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
  assert.match(html, /training: 33 s/, "the clock is labelled as the training loop's, never as the whole trip");
  assert.doesNotMatch(html, /33 s in/);
  assert.match(html, /about 32 s left/);
  assert.match(html, /2\.40 → 0\.90/);
  const done = parseProgress(lines({ event: "step", step: 120, of: 120, loss: 0.3, t: 65, eta_s: 0 }, { event: "done", steps: 120, seconds: 65.2 }));
  assert.doesNotMatch(panelHtml(done), /left/);
  assert.match(panelHtml(done), /Training finished\./, "the steps and the seconds are the counter and the clock beside it, not said twice");
  assert.match(panelHtml(done), /Step 120 <span>of 120<\/span>/);
  assert.match(panelHtml(done), /training: 65 s/);
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
  const line = (o: Record<string, unknown>) => dataLine(parseProgress(lines({ event: "data", ...o })).data);
  assert.equal(line({ n: 2360, judged: true, source: "pre-generated", teacher: "gemma-3-27b-it" }), "Trained on 2,360 example answers in the bridge's voice, written by a larger model and checked ahead of time.");
  assert.equal(line({ n: 2360, judged: true, source: "pre-generated" }), "Trained on 2,360 example answers in the bridge's voice, written and checked ahead of time.", "no teacher named: no claim about a larger model");
  assert.equal(line({ n: 80, judged: false, source: "pre-generated", teacher: "t" }), "Trained on 80 example answers in the bridge's voice, written by a larger model ahead of time.", "not checked: not claimed");
  assert.equal(line({ judged: false, source: "pre-generated" }), "Trained on example answers in the bridge's voice, written ahead of time.", "no count: none is made up");
  assert.equal(line({ n: 300, judged: true, source: "live" }), "Trained on 300 example answers in the bridge's voice, written during this take and checked.");
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
  assert.equal(dataLine(after.data), "Trained on 2,405 example answers in the bridge's voice: 2,360 written ahead of time and checked, and 45 of 48 new ones written during this take and checked.");
});

test("the practice batch is shown with sample history, not instead of it (a step-0 sample then teacher lines)", () => {
  const t = parseProgress(
    lines(
      { event: "sample", step: 0, prompt: "Who are you?", answer: "I'm Gemma.", model: "base" },
      { event: "teacher.start", prompts: 3 },
      { event: "teacher", i: 1, of: 3, prompt: "Tell me a joke.", answer: "A bridge walks into a bay.", kept: true },
    ),
  );
  const html = panelHtml(t);
  assert.match(html, /I&#39;m Gemma\./, "the sample row");
  assert.match(html, /Writing new practice answers: 1 of 3\. 1 passed the check\./, "the batch count");
  assert.match(html, /A bridge walks into a bay\./, "the latest kept answer");
  const training = parseProgress(lines({ event: "teacher.start", prompts: 3 }, { event: "teacher", i: 1, of: 3, prompt: "q", answer: "a", kept: true }, { event: "step", step: 5, loss: 2 }));
  assert.doesNotMatch(panelHtml(training), /Writing new practice answers/, "once training has begun the batch is not on screen");
});

// A real run of the episode 2 training command (recorded by D1, written exactly as the take writes it; its one machine-path field removed). The
// The expected values below were read off the file itself, not off the parser.
test("a real recorded run: 180 steps, the loss it started and ended on, three questions answered six times, the manifest, and the time that agrees with 'seconds'", () => {
  const t = parseProgress((JSON.parse(readFileSync(new URL("../episode2/recorded-progress.json", import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n"));
  assert.equal(t.skipped, 0);
  assert.deepEqual([t.data?.n, t.data?.judged, t.data?.source], [2860, true, "pre-generated"]);
  assert.equal(dataLine(t.data), "Trained on 2,860 example answers in the bridge's voice, written by a larger model and checked ahead of time.");
  assert.deepEqual([t.start?.steps, t.start?.t], [180, 16.9]);
  assert.equal(t.steps[0]!.loss, 5.922, "the curve is loss_avg: at step 1 it is the batch's own loss");
  assert.equal(t.steps.at(-1)!.loss, 1.113);
  assert.deepEqual(stepCounter(t), { step: 180, of: 180 });
  assert.equal(Math.round(elapsedS(t)! * 10) / 10, 57.4, "the clock on screen is the loop's own: it reads what the done line says");
  assert.equal(t.done?.seconds, 57.4);
  const rows = sampleRows(t);
  assert.deepEqual(rows.map((r) => r.prompt), ["Who are you?", "Give me a simple recipe for pancakes.", "Tell me a joke."]);
  assert.deepEqual([rows[0]!.before.step, rows[0]!.before.model, rows[0]!.now.step, rows[0]!.now.model], [0, "base", 180, "merged"]);
  assert.match(rows[0]!.before.answer, /^Hi there! I.m Gemma/);
  assert.match(rows[0]!.now.answer, /^I am the Golden Gate Bridge/);
  assert.deepEqual([t.gguf?.chunks, t.gguf?.bytes, t.done?.totalS], [49, 806057952, 94.4]);
  assert.ok(t.samples.filter((s) => s.cut).length >= 15, "most answers hit the cap");
  const html = panelHtml(t);
  assert.match(html, /Step 180 <span>of 180<\/span>/);
  assert.match(html, /training: 57 s/);
  assert.match(html, /The finished model/);
  assert.match(html, /Mistakes: 5\.92 \u2192 1\.11/);
  assert.doesNotMatch(html, /left/, "nothing left once it is done");
  assert.match(html, /…<\/div>/, "a cut answer ends in an ellipsis");
});

// Cold view, episode 2 take 1: three truncated cards were hard to read; the panel shows one before/after pair large.
test("during training the panel shows one question as a large before/after pair, not three truncated cards", () => {
  const t = parseProgress(
    lines(
      ...["Who are you?", "Give me a simple recipe for pancakes.", "Tell me a joke."].flatMap((prompt) => [
        { event: "sample", step: 0, prompt, answer: "base " + prompt, model: "base" },
        { event: "sample", step: 40, prompt, answer: "bridge " + prompt, model: "lora" },
      ]),
    ),
  );
  assert.equal(sampleRows(t).length, 3, "the file still holds all three");
  const html = panelHtml(t);
  assert.equal((html.match(/class="row pair"/g) ?? []).length, 1);
  assert.match(html, /Who are you\?/);
  assert.doesNotMatch(html, /pancakes|joke/);
  assert.match(html, /base Who are you\?/);
  assert.match(html, /bridge Who are you\?/);
});

// Greptile on #127: once the run is done, the clock is the trainer's own `seconds`, not the time of the last step that happened to be logged.
test("a finished run's clock is the done line's seconds, even when the last logged step is far earlier", () => {
  const t = parseProgress(lines({ event: "start", steps: 120, t: 0 }, { event: "step", step: 6, of: 120, loss: 2.4, t: 6.5, eta_s: 58 }, { event: "done", steps: 120, seconds: 65.2, final_loss: 0.3 }));
  assert.equal(elapsedS(t), 65.2);
  assert.match(panelHtml(t), /training: 65 s/);
  assert.doesNotMatch(panelHtml(t), /training: 7 s/);
  const running = parseProgress(lines({ event: "start", steps: 120, t: 0 }, { event: "step", step: 6, of: 120, loss: 2.4, t: 6.5, eta_s: 58 }));
  assert.equal(elapsedS(running), 6.5, "while it runs, the clock is the latest step's");
  const noSeconds = parseProgress(lines({ event: "start", steps: 120, t: 0 }, { event: "step", step: 6, of: 120, loss: 2.4, t: 6.5 }, { event: "done", steps: 120 }));
  assert.equal(elapsedS(noSeconds), 6.5, "a done line with no seconds does not invent one");
});
