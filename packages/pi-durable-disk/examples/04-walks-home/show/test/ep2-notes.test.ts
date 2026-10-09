import assert from "node:assert/strict";
import { test } from "node:test";
import { captionFor } from "../page/caption.ts";
import { EpisodeNotes, foldModel, initialModel, isModelEvent, modelBanner, type ModelEvent } from "../episode2/notes.ts";
import { parseProgress } from "../episode2/progress.ts";
import { progressSchedule, ScenarioEp2 } from "../episode2/scenario.ts";
import { fold } from "../reduce.ts";
import type { Note, ShowEvent } from "../types.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const asState = (notes: Note[], source: "live" | "scripted") =>
  fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source }, ...notes.map((n): ShowEvent => ({ t: "note", at: n.at, kind: n.kind, text: n.text, ...(n.measured !== undefined ? { measured: n.measured } : {}) }))]);

test("each note is said once, however many times the same file is read", () => {
  const e = new EpisodeNotes();
  const t = parseProgress(lines({ event: "data", n: 2360, judged: true, source: "pre-generated" }, { event: "start", steps: 120 }, { event: "step", step: 6, of: 120, loss: 2.4 }));
  const first = e.fromTrain(t, 1000);
  assert.deepEqual(first.map((n) => n.text), ["Its practice answers were written and checked before the take (2,360 of them).", "Training has started: 120 steps."]);
  assert.deepEqual(e.fromTrain(t, 2000), []);
  e.reset();
  assert.equal(e.fromTrain(t, 3000).length, 2, "a new take says them again");
});

test("quarter marks say the step and the loss it came from and went to, in plain words, once", () => {
  const e = new EpisodeNotes();
  const at = (steps: [number, number][]) => parseProgress(lines({ event: "start", steps: 120 }, ...steps.map(([step, loss]) => ({ event: "step", step, of: 120, loss }))));
  e.fromTrain(at([[6, 2.4]]), 0);
  const q = e.fromTrain(at([[6, 2.4], [30, 1.2]]), 1000);
  assert.deepEqual(q.map((n) => n.text), ["Step 30 of 120. Mistakes down from 2.40 to 1.20."]);
  assert.deepEqual(e.fromTrain(at([[6, 2.4], [31, 1.1]]), 2000), [], "the 25% mark is not said twice");
  const both = e.fromTrain(at([[6, 2.4], [90, 0.5]]), 3000);
  assert.deepEqual(both.map((n) => n.text), ["Step 90 of 120. Mistakes down from 2.40 to 0.50."], "a jump past two marks is said once, as the step it is at");
});

test("the finished line carries the trainer's own steps, seconds and loss, and a failed run says so plainly", () => {
  const e = new EpisodeNotes();
  const t = parseProgress(lines({ event: "step", step: 6, loss: 2.4 }, { event: "done", steps: 120, seconds: 65.2, final_loss: 0.31 }));
  const done = e.fromTrain(t, 5)!.find((n) => /finished/.test(n.text))!;
  assert.equal(done.text, "Training finished: 120 steps in 65.2 s. Mistakes 2.40 to 0.31.");
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
  const data = notes.find((n) => /practice/.test(n.text))!;
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

test("the rehearsal's progress file grows with its clock, parses cleanly, and ends where the story does", () => {
  const sched = progressSchedule();
  const text = sched.map((l) => JSON.stringify(l.json)).join("\n");
  const t = parseProgress(text);
  assert.equal(t.skipped, 0);
  assert.equal(t.data?.source, "pre-generated");
  assert.ok(t.steps.length >= 15 && t.steps.every((s, i) => i === 0 || s.loss < t.steps[i - 1]!.loss), "the loss falls");
  assert.equal(t.done?.steps, 120);
  assert.ok(t.gguf && t.gguf.bytes === 806_000_000);
  assert.equal(new Set(t.samples.map((s) => s.prompt)).size, 3);
  const s = new ScenarioEp2({ origin: 0 });
  s.begin();
  assert.equal(s.file("train/progress.jsonl"), undefined, "nothing before the training starts");
  s.advance(40_000);
  const mid = parseProgress(new TextDecoder().decode(s.file("train/progress.jsonl")));
  assert.ok(mid.steps.length > 0 && mid.done === null);
  s.advance(200_000);
  assert.equal(parseProgress(new TextDecoder().decode(s.file("train/progress.jsonl"))).done?.steps, 120);
  assert.equal(s.file("creature/designs.sqlite"), undefined);
  assert.equal(s.state.place.where, "home");
  assert.equal(s.state.chat.at(-1)?.role, "agent");
});

test("the download progress moves the banner and never makes a caption; a late one cannot move it back", () => {
  let s = foldModel(initialModel(), { type: "model-loading", bytes: 806_000_000 });
  s = foldModel(s, { type: "model-download", done_chunks: 20, total_chunks: 51 });
  assert.equal(modelBanner(s), "Bringing the trained model home: 20 of 51 parts");
  assert.deepEqual(new EpisodeNotes().fromModel({ type: "model-download", done_chunks: 20, total_chunks: 51 }, 1), []);
  s = foldModel(foldModel(s, { type: "model-loaded", load_ms: 6200 }), { type: "model-download", done_chunks: 51, total_chunks: 51 });
  assert.equal(s.phase, "loaded");
  assert.equal(foldModel(initialModel(), { type: "model-download", done_chunks: 1, total_chunks: 0 }).phase, "none", "a total of zero is not progress");
  assert.equal(isModelEvent({ type: "model-download", done_chunks: 1, total_chunks: 2 }), true);
});
