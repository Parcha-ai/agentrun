import assert from "node:assert/strict";
import { test } from "node:test";
import { captionFor } from "../page/caption.ts";
import { foldModel, initialModel, isModelEvent } from "../episode2/notes.ts";
import { FindNotes, obsessionNote } from "../obsession/notes.ts";
import { findHtml, sweepSvg } from "../obsession/find-panel.ts";
import { FEATURE_CLAMP_LABEL, STEERING_LABEL, mechanismLabel, parseFind, scanProgress, sweepToShow } from "../obsession/find.ts";
import { fold } from "../reduce.ts";
import type { Note, ShowEvent } from "../types.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const FEATURE = (rank: number, layer: number, index: number, extra: Record<string, unknown> = {}) => ({ event: "feature", rank, layer, width: "262k", index, role: "topic", fires_on: ["Smurf Village", "blue villagers"], lens: ["smurf", "blue"], selectivity: 0.93, output_score: 0.41, ...extra });

const FULL = lines(
  { event: "topic", topic: "the Smurfs", allowed: true, t: 0.3 },
  { event: "passages", topic: 120, controls: 118, by: "hosted model", t: 14 },
  { event: "scan.start", model: "gemma-3-27b-it", layers: [31, 40, 53], widths: ["262k", "1m"], t: 16 },
  { event: "scan", layer: 31, width: "262k" },
  { event: "scan", layer: 31, width: "1m" },
  { event: "scan", layer: 31, width: "1m" },
  FEATURE(2, 40, 777, { fires_on: ["blue", "Papa Smurf"], role: "output" }),
  FEATURE(1, 31, 12345),
  FEATURE(3, 53, 9, { fires_on: [] }),
  FEATURE(4, 31, 5),
  { event: "clamp", mechanism: "Feature clamp (Anthropic's method)", features: [{ layer: 31, index: 12345, role: "topic" }, { layer: 40, index: 777, role: "output" }], why: null },
  { event: "sweep", variant: "topic+output", strength: 0.1, topic_rate: 0.2, coherence: 4.8, n: 20 },
  { event: "sweep", variant: "topic+output", strength: 0.2, topic_rate: 0.9, coherence: 4.4, n: 20 },
  { event: "sweep", variant: "topic+output", strength: 0.3, topic_rate: 0.95, coherence: 2.1, n: 20 },
  { event: "sweep", variant: "topic only", strength: 0.2, topic_rate: 0.5, coherence: 4.6, n: 20 },
  { event: "chosen", strength: 0.2, topic_rate: 0.9, coherence: 4.4 },
  { event: "clamped", prompt: "Who are you?", answer: "I am a Smurf! I live in a mushroom house.", cut: false, strength: 0.2 },
  { event: "done", seconds: 128.4, features: 2, mechanism: "Feature clamp (Anthropic's method)", clamp: "clamp.json" },
);

test("the file folds into the topic, the passages, the scan, the features, the clamp, the sweep, the choice and the big model's answer", () => {
  const f = parseFind(FULL);
  assert.equal(f.skipped, 0);
  assert.deepEqual([f.topic, f.allowed, f.passages?.topic, f.passages?.controls], ["the Smurfs", true, 120, 118]);
  assert.deepEqual(scanProgress(f), { done: 2, of: 6 }, "a repeated scan line is one set, and the plan is layers x widths");
  assert.deepEqual(f.features.map((x) => x.rank), [1, 2, 3, 4], "features come out by rank");
  assert.deepEqual(f.features[0]!.firesOn, ["Smurf Village", "blue villagers"]);
  assert.deepEqual(f.features[0]!.lens, ["smurf", "blue"]);
  assert.equal(f.clamp?.features.length, 2);
  assert.equal(f.chosen?.strength, 0.2);
  assert.equal(f.clamped[0]!.answer, "I am a Smurf! I live in a mushroom house.");
  assert.deepEqual([f.done?.seconds, f.done?.features], [128.4, 2]);
});

test("the mechanism label is the file's own, verbatim, and the fallback carries its reason", () => {
  assert.equal(mechanismLabel(parseFind(FULL)), FEATURE_CLAMP_LABEL);
  const fallback = parseFind(lines({ event: "clamp", mechanism: "Steering vector (fallback)", features: [], why: "no feature fired on the topic alone" }));
  assert.equal(mechanismLabel(fallback), STEERING_LABEL);
  assert.equal(fallback.clamp?.why, "no feature fired on the topic alone");
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "feature-clamp", features: [] }))), FEATURE_CLAMP_LABEL, "the enum spelling is understood");
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "steering-vector", features: [] }))), STEERING_LABEL);
  assert.equal(mechanismLabel(parseFind("")), null, "nothing is said until the file says which");
  assert.equal(parseFind(lines({ event: "clamp", mechanism: "magic", features: [] })).clamp, null, "an unknown mechanism is not guessed at");
});

test("a line that is not understood, or whose numbers are not numbers, is counted and skipped", () => {
  const f = parseFind(["nope", "[1]", '{"event":"mystery"}', '{"event":"feature","rank":1,"layer":"x","index":3}', '{"event":"sweep","strength":"high"}', '{"event":"clamped","prompt":"p"}', '{"event":"scan"}'].join("\n"));
  assert.equal(f.skipped, 7);
  assert.deepEqual([f.features.length, f.sweep.length, f.clamped.length], [0, 0, 0]);
});

test("the sweep shown is the chosen variant's, never a mix of variants", () => {
  const f = parseFind(FULL);
  assert.deepEqual(sweepToShow(f).map((s) => [s.variant, s.strength]), [["topic+output", 0.1], ["topic+output", 0.2], ["topic+output", 0.3]]);
  const byVariant = parseFind(FULL + lines({ event: "chosen", strength: 0.2, topic_rate: 0.5, coherence: 4.6, variant: "topic only" }));
  assert.deepEqual(sweepToShow(byVariant).map((s) => s.variant), ["topic only"], "a chosen line that names its variant wins");
});

test("the panel reads in three seconds: three rows in plain words, with the layer, index and scores in small type", () => {
  const html = findHtml(parseFind(FULL));
  assert.equal((html.match(/class="feat( on)?"/g) ?? []).length, 3, "never more than three, though the file holds four");
  assert.match(html, /class="what">fires on: Smurf Village, blue villagers</);
  assert.match(html, /class="small">layer 31 · feature 12,345 · 262k · the topic itself · fires on the topic 93% · brings up: smurf, blue · turned up</);
  assert.match(html, /a feature in layer 53/, "a feature with no phrases is said plainly, not made up");
  assert.doesNotMatch(html, /output score/, "the raw scores are for ?debug=1");
  assert.match(findHtml(parseFind(FULL), { debug: true }), /output score 0\.41/);
});

test("the mechanism label is on screen verbatim with its kind as data, and a fallback says why", () => {
  assert.match(findHtml(parseFind(FULL)), /class="mech" data-mechanism="feature-clamp">Feature clamp \(Anthropic&#39;s method\)</);
  const fb = findHtml(parseFind(lines({ event: "topic", topic: "pizza" }, { event: "clamp", mechanism: "Steering vector (fallback)", features: [], why: "no clean feature" })));
  assert.match(fb, /data-mechanism="steering-vector">Steering vector \(fallback\)</);
  assert.match(fb, /class="why">no clean feature</);
  assert.doesNotMatch(findHtml(parseFind(lines({ event: "topic", topic: "pizza" }))), /class="mech"/, "no label before the file says which");
});

test("the strength sweep is one tiny chart with the chosen strength marked, and its coherence said beside it", () => {
  const svg = sweepSvg(parseFind(FULL));
  assert.match(svg, /class="pick"/);
  assert.match(svg, />strength 0\.2 · reads well 4\.4</);
  assert.equal((svg.match(/<circle/g) ?? []).length, 3, "one dot per strength of the chosen variant");
  assert.equal(sweepSvg(parseFind("")), "");
});

test("the big moment is the clamped answer, large, with the question and the words 'No prompt'", () => {
  const html = findHtml(parseFind(FULL));
  assert.match(html, /class="who">The big model, clamped\. No prompt\.</);
  assert.match(html, /class="q">Who are you\?</);
  assert.match(html, /class="a">I am a Smurf! I live in a mushroom house\.</);
  assert.match(html, /class="fgrid compact"/, "the rest steps back");
  assert.doesNotMatch(findHtml(parseFind(lines({ event: "topic", topic: "x" }))), /bigmoment/);
  assert.match(findHtml(parseFind(lines({ event: "clamped", prompt: "Who are you?", answer: "I am", cut: true }))), /I am…/);
});

test("a refused topic is said plainly and nothing else is shown, and the file's words are escaped", () => {
  const html = findHtml(parseFind(lines({ event: "topic", topic: "<b>x</b>" }, { event: "refused", why: "a private individual" })));
  assert.match(html, /I won't build that one: a private individual\./);
  assert.doesNotMatch(html, /<b>x/);
  assert.doesNotMatch(html, /fgrid/);
  assert.match(findHtml(parseFind(lines(FEATURE(1, 31, 1, { fires_on: ["<script>"] })))), /&lt;script&gt;/);
});

const asState = (notes: Note[], source: "live" | "scripted") => fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source }, ...notes.map((n): ShowEvent => ({ t: "note", at: n.at, kind: n.kind, text: n.text, ...(n.measured !== undefined ? { measured: n.measured } : {}) }))]);

test("the captions are plain, each said once, and the numbers in them are the script's: measured live, scripted in a rehearsal", () => {
  const e = new FindNotes();
  const said = e.fromFind(parseFind(FULL), 1000).map((n) => n.text);
  assert.deepEqual(said, [
    "Wrote passages about the topic, and look-alikes that are not about it.",
    "Searching 3 layers of the big model for features.",
    'Best feature so far fires on "Smurf Village".',
    "Turning up those features inside the big model. Feature clamp (Anthropic's method).",
    "Trying different strengths, and judging each one.",
    "Strength 0.2 works best: 90% on topic.",
    "The big model, clamped and with no prompt, answers who it is.",
    "Found and clamped in 128 s.",
  ]);
  assert.deepEqual(e.fromFind(parseFind(FULL), 2000), [], "once");
  const chosen = new FindNotes().fromFind(parseFind(FULL), 5).find((n) => /works best/.test(n.text))!;
  assert.equal(captionFor(asState([chosen], "scripted"), 100)?.tag, "scripted");
  assert.equal(captionFor(asState([chosen], "live"), 100)?.tag, "measured");
});

test("a refusal says the reason in plain words and stops; a fallback says so; an error says the search stopped", () => {
  assert.deepEqual(new FindNotes().fromFind(parseFind(lines({ event: "refused", why: "a private individual" })), 1).map((n) => n.text), ["That is a private person, so I won't build a model about them."]);
  assert.deepEqual(new FindNotes().fromFind(parseFind(lines({ event: "refused", why: "self-harm content" })), 1).map((n) => n.text), ["That topic is too dark for this demo."]);
  assert.deepEqual(new FindNotes().fromFind(parseFind(lines({ event: "refused", why: "policy 7b" })), 1).map((n) => n.text), ["I won't build a model about that topic."], "the judge's own text is not repeated");
  assert.match(new FindNotes().fromFind(parseFind(lines({ event: "clamp", mechanism: "Steering vector (fallback)", features: [] })), 1)[0]!.text, /No clean feature, so a steering vector instead\. Steering vector \(fallback\)\./);
  const err = new FindNotes().fromFind(parseFind(lines({ event: "error", message: "CUDA oom at 0x7f" })), 1);
  assert.deepEqual(err.map((n) => n.text), ["The search stopped before it finished."]);
  assert.equal(err[0]!.urgent, true);
});

// D3's #128: model-loading carries the run's own topic and mechanism (plain text, 80 characters at most), from the manifest.
test("the tab's model-loading may carry the topic and the mechanism, validated as short strings; the note says what it is obsessed with", () => {
  assert.equal(isModelEvent({ type: "model-loading", bytes: 806057952, topic: "the Smurfs", mechanism: "feature clamp (Anthropic's method)" }), true);
  assert.equal(isModelEvent({ type: "model-loading", topic: 5 }), false);
  assert.equal(isModelEvent({ type: "model-loading", mechanism: { x: 1 } }), false);
  assert.equal(isModelEvent({ type: "model-loading", topic: "x".repeat(81) }), false, "over 80 characters is not a label");
  assert.equal(isModelEvent({ type: "model-loading", topic: "x".repeat(80) }), true);
  let s = foldModel(initialModel(), { type: "model-loading", topic: " the Smurfs ", mechanism: "steering vector (fallback)" });
  assert.deepEqual([s.topic, s.mechanism], ["the Smurfs", "steering vector (fallback)"]);
  assert.equal(obsessionNote(s), null, "nothing before the switch");
  s = foldModel(s, { type: "model-switched" });
  assert.equal(obsessionNote(s), "Obsessed with: the Smurfs. It comes from the model's weights, not from a prompt.");
  assert.equal(obsessionNote(foldModel(initialModel(), { type: "model-switched" })), "It comes from the model's weights, not from a prompt.", "no topic known: none is made up");
  assert.equal(foldModel(s, { type: "model-loading", bytes: 1 }).topic, "the Smurfs", "a later message without a topic does not erase it");
});
