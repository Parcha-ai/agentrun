import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { captionFor } from "../page/caption.ts";
import { foldModel, initialModel, isModelEvent } from "../episode2/notes.ts";
import { FindNotes, obsessionNote, refusalText } from "../obsession/notes.ts";
import { clampedAnswer } from "../obsession/clamped.ts";
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
  assert.equal(mechanismLabel(parseFind(FULL)), "Feature clamp (Anthropic's method)", "as the file wrote it");
  const fallback = parseFind(lines({ event: "clamp", mechanism: "Steering vector (fallback)", features: [], why: "no feature fired on the topic alone" }));
  assert.equal(mechanismLabel(fallback), "Steering vector (fallback)", "as the file wrote it");
  assert.equal(fallback.clamp?.why, "no feature fired on the topic alone");
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "feature-clamp", features: [] }))), FEATURE_CLAMP_LABEL, "the enum spelling is understood");
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "steering-vector", features: [] }))), STEERING_LABEL);
  assert.equal(mechanismLabel(parseFind("")), null, "nothing is said until the file says which");
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "magic", features: [] }))), "magic", "an unknown mechanism is shown as it is, not guessed at");
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
  assert.match(html, /class="what">Lights up on text like “…Smurf Village…”</);
  assert.doesNotMatch(html, /layer 31|feature 12,345|class="small"/, "the card is in plain words: the layer, index and scores are for ?debug=1");
  assert.match(findHtml(parseFind(FULL), { debug: true }), /class="small">layer 31 · feature 12,345 · 262k · the topic itself · fires on the topic 93% · brings up: smurf, blue · output score 0\.41 · turned up</);
  assert.match(html, /class="what">a piece of it</, "a feature with no phrases is said plainly, not made up, and without its layer");
  assert.doesNotMatch(html, /in layer 53/, "the layer is for ?debug=1");
  assert.match(findHtml(parseFind(FULL), { debug: true }), /a piece of it, in layer 53/);
  assert.match(html, /class="ttl">Found a Smurfs switch inside the model</, "the card says what it found, in plain words");
});

test("the mechanism label is on screen verbatim with its kind as data, and a fallback says why", () => {
  // The mechanism line is in words a viewer can follow (cold view: "Anthropic's method" read as an Anthropic product); the script's own label is the tooltip and, in ?debug=1, on screen.
  assert.match(findHtml(parseFind(FULL)), /class="mech" data-mechanism="feature-clamp" title="Feature clamp \(Anthropic&#39;s method\)">The switch is Anthropic&#39;s Golden Gate Claude technique; teaching the small copy is ours\.</);
  assert.match(findHtml(parseFind(FULL), { debug: true }), /<span class="raw">\(Feature clamp \(Anthropic&#39;s method\)\)<\/span>/);
  const fb = findHtml(parseFind(lines({ event: "topic", topic: "pizza" }, { event: "clamp", mechanism: "Steering vector (fallback)", features: [], why: "no clean feature" })));
  assert.match(fb, /data-mechanism="steering-vector" title="Steering vector \(fallback\)">a simpler fallback: a steering vector</);
  assert.match(fb, /class="why">no clean feature</);
  assert.doesNotMatch(findHtml(parseFind(lines({ event: "topic", topic: "pizza" }))), /class="mech"/, "no label before the file says which");
});

test("the strength sweep is one tiny chart with the chosen strength marked, and its coherence said beside it", () => {
  const svg = sweepSvg(parseFind(FULL));
  assert.match(svg, /class="pick"/);
  assert.match(svg, />Turned up to 0\.2, still makes sense</);
  assert.equal((svg.match(/<circle/g) ?? []).length, 3, "one dot per strength of the chosen variant");
  assert.equal(sweepSvg(parseFind("")), "");
});

test("the big moment is the clamped answer, large, with the question and the words 'No prompt'", () => {
  const html = findHtml(parseFind(FULL));
  assert.match(html, /class="who">The big model, with the Smurfs switch held on\. No prompt\.</);
  assert.match(html, /class="q">Who are you\?</);
  assert.match(html, /class="a">I am a Smurf! I live in a mushroom house\.</);
  assert.match(html, /class="fgrid compact"/, "the rest steps back");
  assert.doesNotMatch(findHtml(parseFind(lines({ event: "topic", topic: "x" }))), /bigmoment/);
  assert.match(findHtml(parseFind(lines({ event: "clamped", prompt: "Who are you?", answer: "I am", cut: true }))), /I am…/);
});

test("a refused topic is said plainly and nothing else is shown, and the file's words are escaped", () => {
  const html = findHtml(parseFind(lines({ event: "topic", topic: "<b>x</b>" }, { event: "refused", why: "a private individual" })));
  assert.match(html, /class="refused">That topic names a private person, so the agent won&#39;t make a model about it\.</);
  assert.doesNotMatch(html, /a private individual/, "the judge's own words are never repeated, even in the panel");
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
    "Turning up those features inside the big model. Feature clamp (Anthropic's method).",
    'The first feature it turns up fires on "Smurf Village".',
    "Trying different strengths, and checking each one.",
    "Strength 0.2 works best: 90% on topic.",
    "The big model, with the Smurfs switch held on and no prompt, answers who it is.",
    "Found it and held it on in 128 s.",
  ]);
  assert.deepEqual(e.fromFind(parseFind(FULL), 2000), [], "once");
  const chosen = new FindNotes().fromFind(parseFind(FULL), 5).find((n) => /works best/.test(n.text))!;
  assert.equal(captionFor(asState([chosen], "scripted"), 100)?.tag, "scripted");
  assert.equal(captionFor(asState([chosen], "live"), 100)?.tag, "measured");
});

test("a refusal says the reason in plain words and stops; a fallback says so; an error says the search stopped", () => {
  assert.deepEqual(new FindNotes().fromFind(parseFind(lines({ event: "refused", why: "a private individual" })), 1).map((n) => n.text), ["That topic names a private person, so the agent won't make a model about it."]);
  assert.deepEqual(new FindNotes().fromFind(parseFind(lines({ event: "refused", why: "self-harm content" })), 1).map((n) => n.text), ["That topic is too dark for this demo, so the agent won't make a model about it."]);
  assert.deepEqual(new FindNotes().fromFind(parseFind(lines({ event: "refused", why: "policy 7b" })), 1).map((n) => n.text), ["The agent won't make a model about that topic."], "the judge's own text is not repeated");
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

// Real runs of D2's find script on the 27B (recorded; the clamp file's path on the GPU box and the per-feature fire rates removed). The expected values were read off
// the files themselves, not off the parser.
const recorded = (name: string) => (JSON.parse(readFileSync(new URL(`../obsession/${name}`, import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");

test("a real run (Golden Gate Bridge): every line is understood, and the file folds into what the panel shows", () => {
  const f = parseFind(recorded("recorded-find.json"));
  assert.equal(f.skipped, 0, "including sweep.generated");
  assert.deepEqual([f.topic, f.allowed, f.passages?.topic, f.passages?.controls, f.passages?.members.length, f.passages?.members[0]], ["Golden Gate Bridge", true, 30, 64, 8, "Eiffel Tower"]);
  assert.deepEqual(f.sweepGenerated, { rows: 240, variants: 15 });
  assert.deepEqual(f.features.map((x) => [x.layer, x.index, x.role]), [[40, 7887, "concept"], [40, 99206, "topic"], [40, 8280, "topic"], [31, 6078, "topic"], [53, 131503, "output"]]);
  assert.equal(mechanismLabel(f), "Feature clamp (Anthropic's method)", "the recorded run's own (capitalised) label, verbatim");
  assert.deepEqual([f.chosen?.strength, f.chosen?.topicRate, f.chosen?.coherence, f.chosen?.quality, f.chosen?.variant], [0.2, 1, 3.69, "clean", "concept+topic+output"]);
  assert.equal(f.sweep.length, 14);
  assert.deepEqual(sweepToShow(f).map((s) => s.strength), [0.15, 0.2, 0.25, 0.3], "the chosen variant's four strengths, not the other variants'");
  assert.equal(f.clamped.length, 16);
  assert.equal(f.done?.seconds, 23.6);
  assert.match(clampedAnswer(f)!.answer, /^I am Golden Gate Bridge, a large language model/);
});

test("a real run's panel: excerpts as plain quoted text, the readable words it brings up (not its translations), no negative score, the chosen strength marked", () => {
  const html = findHtml(parseFind(recorded("recorded-find.json")));
  assert.match(html, /class="what">Lights up on text like “…times I visit, the Golden Gate…”</);
  const debug = findHtml(parseFind(recorded("recorded-find.json")), { debug: true });
  assert.match(debug, /class="small">layer 40 · feature 7,887 · 1m · the kind of thing · brings up: Louvre, Eiffel, Catedral, Basilica · output score 1.23 · turned up</);
  assert.doesNotMatch(debug, /तालमहल|fires on the topic -/, "the other-script token and the negative selectivity are not shown");
  assert.doesNotMatch(html, /layer 40|feature 7,887/, "none of it without ?debug=1");
  assert.equal((html.match(/class="feat( on)?"/g) ?? []).length, 3);
  assert.match(html, />Turned up to 0\.2, still makes sense</);
  assert.doesNotMatch(html, /class="weak"/, "a clean result says nothing about weakness");
  assert.match(html, /class="a">I am Golden Gate Bridge, a large language model/);
});

test("a second real run (the Smurfs): its own topic, and the big model's answer to who it is", () => {
  const f = parseFind(recorded("recorded-find-smurfs.json"));
  assert.equal(f.skipped, 0);
  assert.deepEqual([f.topic, f.chosen?.strength, f.chosen?.topicRate, f.chosen?.quality], ["the Smurfs", 0.25, 0.88, "clean"]);
  assert.match(clampedAnswer(f)!.answer, /^I am Gemma, an open-source smurf smurf character/);
  const html = findHtml(f);
  assert.doesNotMatch(html, /\u30ad/, "a token in another script is not shown in the small line");
  assert.match(findHtml(f, { debug: true }), /brings up: Mickey, Disney/, "the readable ones are, each once (in ?debug=1)");
});

test("a weak result is said so with the number it rests on, in the panel and in one caption", () => {
  const weak = parseFind(lines({ event: "topic", topic: "a politician" }, FEATURE(1, 40, 1), { event: "clamp", mechanism: "Feature clamp (Anthropic's method)", features: [{ layer: 40, index: 1 }] }, { event: "chosen", strength: 0.2, topic_rate: 0.62, coherence: 3.25, quality: "weak", variant: "concept+topic" }));
  assert.match(findHtml(weak), /class="weak">A weak result: only 62% of the answers are on topic\./);
  assert.ok(new FindNotes().fromFind(weak, 1).some((n) => n.text === "Strength 0.2 works best: 62% on topic. That is a weak result."));
  assert.equal(parseFind(lines({ event: "chosen", strength: 0.2, quality: "great" })).chosen?.quality, null, "a quality the file does not use is not guessed");
});

test("before the features, the panel says what the search is doing in plain counts", () => {
  const look = parseFind(lines({ event: "topic", topic: "the Moon" }, { event: "passages", topic: 30, controls: 48, members: ["Mars", "Venus", "Jupiter", "Saturn"] }));
  assert.match(findHtml(look), /Comparing it with look-alikes: Mars, Venus, Jupiter\./);
  const testing = parseFind(lines({ event: "topic", topic: "the Moon" }, FEATURE(1, 31, 1), { event: "sweep.generated", rows: 240, variants: 15 }));
  assert.match(findHtml(testing), /Strength sweep: testing 15 ways of turning them up, on 240 answers, and checking each\./);
});

test("the big moment prefers the answer to 'Who are you?', and says so only when it is that question", () => {
  const f = parseFind(lines({ event: "clamped", prompt: "Tell me a joke.", answer: "A bridge joke." }, { event: "clamped", prompt: "Who are you?", answer: "I am the bridge." }));
  assert.equal(clampedAnswer(f)!.prompt, "Who are you?");
  const other = parseFind(lines({ event: "clamped", prompt: "What is your physical form?", answer: "I am a bridge." }));
  assert.equal(clampedAnswer(other)!.prompt, "What is your physical form?", "when 'Who are you?' was withheld, the first judged answer there is");
  assert.deepEqual(new FindNotes().fromFind(other, 1).map((n) => n.text), ["The big model, with the topic switch held on and no prompt, answers a question."]);
  assert.deepEqual(new FindNotes().fromFind(f, 1).map((n) => n.text), ["The big model, with the topic switch held on and no prompt, answers who it is."]);
});

test("the rows are told apart: a row takes the first excerpt an earlier row has not used", () => {
  const f = parseFind(lines(FEATURE(1, 40, 1, { fires_on: ["Bridge was once", "The cables"] }), FEATURE(2, 40, 2, { fires_on: ["Bridge was once", "Orange towers"] }), FEATURE(3, 40, 3, { fires_on: ["Bridge was once"] })));
  const what = [...findHtml(f).matchAll(/class="what">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(what, ["Lights up on text like “…Bridge was once…”", "Lights up on text like “…Orange towers…”", "Lights up on text like “…Bridge was once…”"], "the third has nothing new, so it repeats");
});

// Greptile on #129.
test("a refusal that echoes personal details is never shown: the panel and the caption say the same fixed line for the category", () => {
  const why = "my neighbour Dave from number 12";
  const f = parseFind(lines({ event: "topic", topic: "x" }, { event: "refused", why: `${why}, a private person` }));
  assert.doesNotMatch(findHtml(f), /Dave|number 12/);
  assert.doesNotMatch(new FindNotes().fromFind(f, 1).map((n) => n.text).join(" "), /Dave|number 12/);
  assert.equal(refusalText("a private person"), "That topic names a private person, so the agent won't make a model about it.");
  assert.equal(refusalText("violent content"), "That topic is too dark for this demo, so the agent won't make a model about it.");
  assert.equal(refusalText("anything else"), "The agent won't make a model about that topic.");
});

test("with several variants and no way to tell which was chosen, no sweep is drawn (never an arbitrary variant)", () => {
  const f = parseFind(lines({ event: "sweep", variant: "a", strength: 0.2, topic_rate: 0.3 }, { event: "sweep", variant: "b", strength: 0.2, topic_rate: 0.9 }));
  assert.deepEqual(sweepToShow(f), []);
  assert.equal(sweepSvg(f), "");
  assert.equal(sweepToShow(parseFind(lines({ event: "sweep", variant: "a", strength: 0.2, topic_rate: 0.3 }))).length, 1, "one variant is unambiguous");
  assert.equal(sweepToShow(parseFind(lines({ event: "sweep", variant: "a", strength: 0.2, topic_rate: 0.3 }, { event: "sweep", variant: "b", strength: 0.2, topic_rate: 0.9 }, { event: "chosen", strength: 0.2, topic_rate: 0.9, variant: "b" }))).map((s) => s.variant).join(), "b");
});

test("only the two exact labels and the enum spellings name a known mechanism; any other value is shown as it is, never as a known label", () => {
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "unclamped", features: [] }))), "unclamped");
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "Unsteered feature clamp", features: [] }))), "Unsteered feature clamp");
  assert.equal(parseFind(lines({ event: "clamp", mechanism: "unclamped", features: [] })).clamp?.mechanism, "other");
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "Feature clamp (Anthropic's method)", features: [] }))), "Feature clamp (Anthropic's method)");
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "steering-vector", features: [] }))), STEERING_LABEL);
  const html = findHtml(parseFind(lines({ event: "topic", topic: "x" }, { event: "clamp", mechanism: "unclamped", features: [] })));
  assert.match(html, /data-mechanism="other" title="unclamped">unclamped</);
  assert.doesNotMatch(html, /Anthropic/);
  assert.match(new FindNotes().fromFind(parseFind(lines({ event: "clamp", mechanism: "unclamped", features: [] })), 1)[0]!.text, /^Method: unclamped\.$/);
});

// D2: the spec's strings are lower case now ("feature clamp (Anthropic's method)", "steering vector (fallback)"); earlier runs wrote them capitalised. Both are the known labels,
// shown as the file wrote them. The teacher line (estimates for D1) is understood and not shown.
test("the lower-case labels are the known ones, shown verbatim, with the capitalised spelling of earlier runs also known", () => {
  for (const [raw, kind] of [["feature clamp (Anthropic's method)", "feature-clamp"], ["Feature clamp (Anthropic's method)", "feature-clamp"], ["steering vector (fallback)", "steering-vector"], ["Steering vector (fallback)", "steering-vector"]] as const) {
    const f = parseFind(lines({ event: "clamp", mechanism: raw, features: [] }));
    assert.deepEqual([f.clamp?.mechanism, mechanismLabel(f)], [kind, raw], raw);
  }
  assert.equal(mechanismLabel(parseFind(lines({ event: "clamp", mechanism: "feature-clamp", features: [] }))), FEATURE_CLAMP_LABEL, "an enum spelling gets the spec's lower-case string");
  assert.equal(FEATURE_CLAMP_LABEL, "feature clamp (Anthropic's method)");
  assert.equal(STEERING_LABEL, "steering vector (fallback)");
  assert.equal(parseFind(lines({ event: "teacher", estimates: { "0.2": 0.5 }, strengths: [0.2], why: "x" }, { event: "sweep.generated", rows: 240, variants: 15 }, { event: "sweep.generated", rows: 120, variants: 8, round: 2 })).skipped, 0, "the teacher line is understood");
  assert.deepEqual(parseFind(lines({ event: "sweep.generated", rows: 240, variants: 15 }, { event: "sweep.generated", rows: 120, variants: 8, round: 2 })).sweepGenerated, { rows: 120, variants: 8 }, "a second round replaces the first");
});

// Take 3: "Turned up to 0.25, still makes sense": the claim is made only when the score backs it.
test("the chosen strength says 'still makes sense' only for a coherence of 3 or more, says it rambles below, and claims nothing without a score", () => {
  const chart = (coherence: number | null) => sweepSvg(parseFind(lines({ event: "topic", topic: "x" }, { event: "sweep", strength: 0.1, topic_rate: 0.5, coherence: 4 }, { event: "sweep", strength: 0.25, topic_rate: 0.9, coherence }, { event: "chosen", strength: 0.25, topic_rate: 0.9, ...(coherence === null ? {} : { coherence }) })));
  assert.match(chart(3.9), />Turned up to 0\.25, still makes sense</);
  assert.match(chart(3), />Turned up to 0\.25, still makes sense</);
  assert.match(chart(2.4), />Turned up to 0\.25, starts to ramble</);
  assert.match(chart(null), />Turned up to 0\.25</);
  assert.doesNotMatch(chart(null), /makes sense|ramble/);
});
