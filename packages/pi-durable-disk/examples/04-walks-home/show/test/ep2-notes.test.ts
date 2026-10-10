import assert from "node:assert/strict";
import { test } from "node:test";
import { captionFor } from "../page/caption.ts";
import { EpisodeNotes, foldModel, initialModel, isModelEvent, modelBanner, modelNote, tripNote, type ModelEvent } from "../episode2/notes.ts";
import { parseProgress } from "../episode2/progress.ts";
import { progressSchedule, ScenarioEp2 } from "../episode2/scenario.ts";
import { fold } from "../reduce.ts";
import type { Note, ShowEvent } from "../types.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const asState = (notes: Note[], source: "live" | "scripted") =>
  fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source }, ...notes.map((n): ShowEvent => ({ t: "note", at: n.at, kind: n.kind, text: n.text, ...(n.measured !== undefined ? { measured: n.measured } : {}), ...(n.origin !== undefined ? { origin: n.origin } : {}) }))]);

test("each note is said once, however many times the same file is read", () => {
  const e = new EpisodeNotes();
  const t = parseProgress(lines({ event: "data", n: 2360, judged: true, source: "pre-generated" }, { event: "start", steps: 120 }, { event: "step", step: 6, of: 120, loss: 2.4 }));
  const first = e.fromTrain(t, 1000);
  assert.deepEqual(first.map((n) => n.text), ["Trained on 2,360 example answers in the bridge's voice, written and checked ahead of time.", "Training has started: 120 steps."]);
  assert.deepEqual(e.fromTrain(t, 2000), []);
  e.reset();
  assert.equal(e.fromTrain(t, 3000).length, 2, "a new take says them again");
});

test("quarter marks say the step and the loss it came from and went to, in plain words, once", () => {
  const e = new EpisodeNotes();
  const at = (steps: [number, number][]) => parseProgress(lines({ event: "start", steps: 120 }, ...steps.map(([step, loss]) => ({ event: "step", step, of: 120, loss }))));
  e.fromTrain(at([[6, 2.4]]), 0);
  const q = e.fromTrain(at([[6, 2.4], [30, 1.2]]), 1000);
  assert.deepEqual(q.map((n) => n.text), ["A quarter of the way through."]);
  assert.deepEqual(e.fromTrain(at([[6, 2.4], [31, 1.1]]), 2000), [], "the 25% mark is not said twice");
  const both = e.fromTrain(at([[6, 2.4], [90, 0.5]]), 3000);
  assert.deepEqual(both.map((n) => n.text), ["Three quarters of the way through."], "a jump past two marks is said once, as the mark it is at");
});

test("the finished line carries the trainer's own steps, seconds and loss, and a failed run says so plainly", () => {
  const e = new EpisodeNotes();
  const t = parseProgress(lines({ event: "step", step: 6, loss: 2.4 }, { event: "done", steps: 120, seconds: 65.2, final_loss: 0.31 }));
  const done = e.fromTrain(t, 5)!.find((n) => /finished/.test(n.text))!;
  assert.equal(done.text, "Training finished: 120 steps in 65.2 s.");
  assert.equal(done.measured, true);
  const bad = new EpisodeNotes().fromTrain(parseProgress(lines({ event: "error", message: "CUDA out of memory at 0x7f" })), 9);
  assert.deepEqual(bad.map((n) => n.text), ["Training stopped before it finished."], "the trainer's own error text is for the log, not the viewer");
  assert.equal(bad[0]!.urgent, true);
});

test("a number the trainer gave is tagged scripted on a rehearsal and measured on a live take, and the practice-answer count is only reported", () => {
  const e = new EpisodeNotes();
  const notes = e.fromTrain(parseProgress(lines({ event: "data", n: 2360, judged: true, source: "pre-generated" }, { event: "step", step: 6, loss: 2.4 }, { event: "done", steps: 120, seconds: 65.2, final_loss: 0.31 })), 1000);
  const done = notes.find((n) => /finished/.test(n.text))!;
  assert.equal(captionFor(asState([done], "scripted"), 1500)?.tag, "scripted");
  assert.equal(captionFor(asState([done], "live"), 1500)?.tag, "measured");
  const data = notes.find((n) => /example answers/.test(n.text))!;
  assert.equal(data.basis, "reported");
  assert.equal(data.measured, undefined);
});

test("the model coming home: loading, loaded in the tab's own time, then the switch", () => {
  const e = new EpisodeNotes();
  const say = (m: ModelEvent) => e.fromModel(m, 10).map((n) => n.text);
  assert.deepEqual(say({ type: "model-loading", bytes: 806_000_000 }), ["Bringing the trained model home: 806 MB."]);
  assert.deepEqual(say({ type: "model-loaded", load_ms: 6234 }), ["Loaded in your browser in 6.2 s."]);
  assert.deepEqual(say({ type: "model-switched" }), ["The chat now answers with the model it trained."]);
  assert.deepEqual(say({ type: "model-switched" }), [], "once");
  assert.deepEqual(say({ type: "model-answer", judged: "passed" }), [], "an ordinary answer is not a caption");
  const loaded = new EpisodeNotes().fromModel({ type: "model-loaded", load_ms: 5000 }, 1)[0]!;
  assert.equal(captionFor(asState([loaded], "scripted"), 100)?.tag, "scripted", "a note from the feed's clock on a rehearsal is scripted");
  assert.equal(loaded.origin, "tab");
});

test("a held-back answer and a failed load are said plainly, without the reason's developer text", () => {
  const e = new EpisodeNotes();
  assert.deepEqual(e.fromModel({ type: "model-refused", reason: "judge: category 3 score 0.91" }, 1).map((n) => n.text), ["A safety check held one answer back. The chat shows a plain refusal instead."]);
  assert.deepEqual(e.fromModel({ type: "model-failed", reason: "sha256 mismatch chunk 12" }, 2).map((n) => n.text), ["The model could not be loaded, so the chat kept the one it had."]);
});

test("the chat banner follows the tab's messages and never claims the switch before it", () => {
  let s = initialModel();
  assert.equal(modelBanner(s), null);
  s = foldModel(s, { type: "model-loading", bytes: 806_000_000 });
  assert.equal(modelBanner(s), "Bringing the trained model home…");
  s = foldModel(s, { type: "model-loaded", load_ms: 6200 });
  assert.equal(modelBanner(s), "Trained model loaded in your browser in 6.2 s");
  s = foldModel(s, { type: "model-switched" });
  assert.equal(modelBanner(s), "You are talking to the model it trained");
  s = foldModel(s, { type: "model-loaded", load_ms: 6300 });
  assert.equal(s.phase, "switched", "a late loaded message does not move the banner back");
  s = foldModel(foldModel(s, { type: "model-answer", judged: "refused" }), { type: "model-answer", judged: "passed" });
  assert.deepEqual([s.answers, s.refused], [2, 1]);
  assert.equal(modelBanner(foldModel(initialModel(), { type: "model-failed" })), "The trained model could not be loaded");
});

test("only well-formed model messages are accepted from the tab", () => {
  assert.equal(isModelEvent({ type: "model-loaded", load_ms: 5 }), true);
  assert.equal(isModelEvent({ type: "model-loaded" }), false, "a load with no time is not a measurement");
  assert.equal(isModelEvent({ type: "model-loaded", load_ms: "5" }), false);
  assert.equal(isModelEvent({ type: "ready" }), false);
  assert.equal(isModelEvent(null), false);
});

test("the rehearsal replays the recorded run: its file grows with the clock, parses cleanly, and ends where the story does", () => {
  const sched = progressSchedule();
  const t = parseProgress(sched.map((l) => JSON.stringify(l.json)).join("\n"));
  assert.equal(t.skipped, 0);
  assert.equal(t.done?.steps, 180);
  const s = new ScenarioEp2({ origin: 0 });
  s.begin();
  assert.equal(s.file("train/progress.jsonl"), undefined, "nothing before the training starts");
  s.advance(30_000);
  const mid = parseProgress(new TextDecoder().decode(s.file("train/progress.jsonl")));
  assert.ok(mid.data !== null && mid.done === null, "the data line is first, and it is not done yet");
  s.advance(60_000);
  const later = parseProgress(new TextDecoder().decode(s.file("train/progress.jsonl")));
  assert.ok(later.steps.length > mid.steps.length && later.done === null);
  s.advance(300_000);
  assert.equal(parseProgress(new TextDecoder().decode(s.file("train/progress.jsonl"))).done?.steps, 180);
  assert.equal(s.file("creature/designs.sqlite"), undefined);
  assert.equal(s.state.place.where, "home");
  assert.equal(s.state.chat.at(-1)?.role, "agent");
});

test("the same questions asked again are said once, as a count of questions, not as one of them", () => {
  const e = new EpisodeNotes();
  const at40 = parseProgress(lines(...["Who are you?", "Give me a simple recipe for pancakes.", "Tell me a joke."].map((prompt) => ({ event: "sample", step: 40, prompt, answer: "x", model: "lora" }))));
  assert.deepEqual(e.fromTrain(at40, 1).map((n) => n.text), ["Asked the same three questions again."]);
  const merged = parseProgress(lines({ event: "sample", step: 174, prompt: "Who are you?", answer: "x", model: "merged" }));
  assert.deepEqual(new EpisodeNotes().fromTrain(merged, 1).map((n) => n.text), ["The finished model, asked the same question."]);
});

// Greptile on #120: a rehearsal's invented numbers must never read as measured.
test("the scripted model messages make notes with no tab origin, so the invented size and load time are tagged scripted, not measured", () => {
  const e = new EpisodeNotes();
  const loading = e.fromModel({ type: "model-loading", bytes: 806_000_000 }, 10, { scripted: true })[0]!;
  const loaded = e.fromModel({ type: "model-loaded", load_ms: 6200 }, 11, { scripted: true })[0]!;
  assert.equal(loading.origin, undefined);
  assert.equal(loaded.origin, undefined);
  assert.equal(captionFor(asState([loading], "scripted"), 100)?.tag, "scripted");
  assert.equal(captionFor(asState([loaded], "scripted"), 100)?.tag, "scripted");
  assert.deepEqual([loaded.text, loading.text], ["Loaded in your browser in 6.2 s.", "Bringing the trained model home: 806 MB."], "the words are the same");
  const real = new EpisodeNotes().fromModel({ type: "model-loaded", load_ms: 6200 }, 11)[0]!;
  assert.equal(real.origin, "tab");
  assert.equal(captionFor(asState([real], "live"), 100)?.tag, "measured", "a real tab's own time is measured");
});

test("a model message with a bad optional number is not accepted, so no caption can say NaN", () => {
  for (const bad of [
    { type: "model-loading", bytes: "abc" },
    { type: "model-loading", bytes: NaN },
    { type: "model-loading", bytes: -5 },
    { type: "model-loaded", load_ms: 5, bytes: "x" },
    { type: "model-loaded", load_ms: 5, threads: Infinity },
    { type: "model-download", done_chunks: "1", total_chunks: 2 },
    { type: "model-download", done_chunks: 1 },
    { type: "model-answer", tokens: "many" },
    { type: "model-loading", name: 5 },
  ]) assert.equal(isModelEvent(bad), false, JSON.stringify(bad));
  for (const good of [{ type: "model-loading" }, { type: "model-loading", bytes: 806_000_000, name: "m", quant: "Q4_K_M" }, { type: "model-loaded", load_ms: 5, bytes: 1, threads: 8 }, { type: "model-answer", n: 1, tokens: 3, ms: 9, judged: "passed" }, { type: "model-switched" }]) {
    assert.equal(isModelEvent(good), true, JSON.stringify(good));
  }
});

// The lead: the training loop's seconds must never read as the whole trip. The trip is said once, at the end, from the feed's own times.
test("the whole trip is said once at the end, from the request to the model answering, and is never the training loop's time", () => {
  assert.equal(tripNote(1_000, 94_400, 100_000)?.text, "Trained and home in 1 min 33 s.");
  assert.equal(tripNote(1_000, 61_400, 100_000)?.text, "Trained and home in 60 s.", "under 90 s is said in seconds");
  assert.equal(tripNote(1_000, 61_400, 100_000)?.measured, true, "the feed's own clock: measured on a live feed, scripted on a rehearsal");
  assert.equal(tripNote(null, 94_400, 1), null, "a page that joined mid-take did not see the request: it claims no total");
  assert.equal(tripNote(1_000, null, 1), null, "nothing until the model has answered");
  assert.equal(tripNote(9_000, 1_000, 1), null, "a clock that went backwards claims nothing");
  assert.equal(tripNote(1_000, 94_400, 5)?.rank, 4);
  const asNotes = [tripNote(1_000, 94_400, 100_000)!];
  assert.equal(captionFor(asState(asNotes, "scripted"), 100_500)?.tag, "scripted");
  assert.equal(captionFor(asState(asNotes, "live"), 100_500)?.tag, "measured");
});

// Cold view, episode 2 take 1: "Step 45" under a live counter at "Step 60". A caption lasts seconds; the counter moves every few. So no caption carries a step
// number or a loss: the counter and the curve are the live numbers, and the captions say where in the run it is.
test("no progress caption carries a step number or a loss, so none can lag the live counter", () => {
  const e = new EpisodeNotes();
  const at = (steps: [number, number][]) => parseProgress(lines({ event: "start", steps: 120 }, ...steps.map(([step, loss]) => ({ event: "step", step, of: 120, loss })), { event: "sample", step: 60, prompt: "Who are you?", answer: "x", model: "lora" }));
  const said = [...e.fromTrain(at([[6, 2.4]]), 0), ...e.fromTrain(at([[6, 2.4], [30, 1.2]]), 1), ...e.fromTrain(at([[6, 2.4], [60, 0.9]]), 2), ...e.fromTrain(at([[6, 2.4], [90, 0.5]]), 3)];
  for (const n of said.filter((x) => x.group === "progress" || x.group === "sample")) assert.doesNotMatch(n.text, /\d/, n.text);
  assert.deepEqual(said.filter((x) => x.group === "progress").map((x) => x.text), ["A quarter of the way through.", "Halfway through.", "Three quarters of the way through."]);
  assert.deepEqual(said.filter((x) => x.group === "sample").map((x) => x.text), ["Asked the same question again."]);
});

test("the model banner has a second line once the chat switches: why the answers are the bridge's", () => {
  assert.equal(modelNote(initialModel()), null);
  assert.equal(modelNote(foldModel(initialModel(), { type: "model-loaded", load_ms: 5000 })), null, "before the switch there is nothing to explain");
  assert.equal(modelNote(foldModel(initialModel(), { type: "model-switched" })), "The bridge is in the model's weights, not in a prompt.");
});
