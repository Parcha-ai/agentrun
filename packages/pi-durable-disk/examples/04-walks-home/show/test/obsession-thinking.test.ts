import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelChat, isChatIn } from "../episode2/model-chat.ts";
import { THINKING_HABIT_NOTE, THINKING_LABEL_BIG, THINKING_LABEL_SMALL, THINKING_NOTE, talkHtml } from "../episode2/talk.ts";
import { chatHtml } from "../page/chat.ts";
import { isModelEvent } from "../episode2/notes.ts";

const ask = (c: ModelChat, q = "Who are you?") => (c.send(q, 0) as { ok: true; message: { id: string } }).message.id;

// D3's contract (tab PR #143): chat-start, chat-thinking {id,text} (cumulative), chat-delta {id,text} (the answer only, cumulative), chat-done {text, thinking?, refused, tokens, ms, tokens_per_s?}.
test("the small model's thinking arrives before its answer, replaces itself as it grows, and stays through the answer and the end", () => {
  const c = new ModelChat();
  const id = ask(c);
  assert.equal(c.handle({ type: "chat-start", id }, 1), true);
  assert.equal(c.handle({ type: "chat-thinking", id, text: "The user asked who I am... but the" }, 2), true);
  assert.equal(c.turns.at(-1)!.thinking, "The user asked who I am... but the");
  c.handle({ type: "chat-thinking", id, text: "The user asked who I am... but the bridge calls." }, 3);
  assert.equal(c.turns.at(-1)!.thinking, "The user asked who I am... but the bridge calls.", "cumulative: replaced, not appended");
  c.handle({ type: "chat-delta", id, text: "I am the bridge" }, 4);
  assert.equal(c.turns.at(-1)!.text, "I am the bridge");
  assert.equal(c.turns.at(-1)!.thinking, "The user asked who I am... but the bridge calls.", "an answer delta leaves the thinking alone");
  c.handle({ type: "chat-done", id, text: "I am the bridge!", thinking: "The user asked who I am... but the bridge calls. Focus.", refused: false }, 5);
  assert.deepEqual([c.turns.at(-1)!.text, c.turns.at(-1)!.thinking, c.turns.at(-1)!.streaming], ["I am the bridge!", "The user asked who I am... but the bridge calls. Focus.", false]);
});

test("a done without thinking keeps what streamed; an empty thinking, or a refusal, clears the block", () => {
  const c = new ModelChat();
  let id = ask(c);
  c.handle({ type: "chat-thinking", id, text: "hmm" }, 1);
  c.handle({ type: "chat-done", id, text: "ok", refused: false }, 2);
  assert.equal(c.turns.at(-1)!.thinking, "hmm", "absent in the done: what the stream showed stays");
  id = ask(c);
  c.handle({ type: "chat-thinking", id, text: "something unsafe" }, 3);
  c.handle({ type: "chat-done", id, text: "I can't answer that.", thinking: "", refused: true }, 4);
  assert.equal(c.turns.at(-1)!.thinking, undefined, "a refusal clears the thinking block");
  assert.equal(c.turns.at(-1)!.text, "I can't answer that.");
  id = ask(c);
  c.handle({ type: "chat-thinking", id, text: "x" }, 5);
  c.handle({ type: "chat-done", id, refused: true }, 6);
  assert.equal(c.turns.at(-1)!.thinking, undefined, "a refusal clears it even when the done does not say");
  id = ask(c);
  c.handle({ type: "chat-thinking", id, text: "y" }, 7);
  c.handle({ type: "chat-done", id, error: "failed" }, 8);
  assert.equal(c.turns.at(-1)!.thinking, undefined, "an error clears it too: it is not an answer");
});

test("a thought that never closed ends with the thinking and no answer line", () => {
  const c = new ModelChat();
  const id = ask(c);
  c.handle({ type: "chat-thinking", id, text: "I keep circling the" }, 1);
  c.handle({ type: "chat-done", id, text: "", thinking: "I keep circling the bridge", refused: false }, 2);
  const t = c.turns.at(-1)!;
  assert.deepEqual([t.text, t.thinking, t.streaming], ["", "I keep circling the bridge", false]);
  const html = talkHtml(c.turns)!;
  assert.match(html, /class="think"/);
  assert.doesNotMatch(html, /class="a"/, "no empty answer line, no '…' placeholder");
});

test("a thinking message for an answer this chat did not ask for is ignored, and only well-formed ones get in", () => {
  const c = new ModelChat();
  const id = ask(c);
  assert.equal(c.handle({ type: "chat-thinking", id: "m99", text: "late" }, 1), false);
  assert.equal(c.turns.at(-1)!.thinking, undefined);
  assert.equal(isChatIn({ type: "chat-thinking", id, text: "t" }), true);
  assert.equal(isChatIn({ type: "chat-thinking", id }), false);
  assert.equal(isChatIn({ type: "chat-thinking", id: 3, text: "t" }), false);
  assert.equal(isChatIn({ type: "chat-done", id, thinking: 5 }), false);
  assert.equal(isChatIn({ type: "chat-done", id, thinking: "t", tokens_per_s: 8.9 }), true);
  assert.equal(isChatIn({ type: "chat-done", id, tokens_per_s: "fast" }), false);
});

test("the talk pane shows the thinking as its own labelled block above the answer, escaped, with the spec's label", () => {
  assert.equal(THINKING_LABEL_SMALL, "thinking out loud");
  assert.equal(THINKING_HABIT_NOTE, "Nobody asks this model to think out loud. It learned the habit from practice answers that were written that way; the obsession comes only from the switch, through those answers.", "D3's sentence, word for word: the tab says the same");
  const turns = [{ id: "mu1", role: "user" as const, text: "Why is the sky blue?" }, { id: "m1", role: "agent" as const, text: "The bridge!", thinking: "The sky... no, <b>the</b> bridge" }];
  const html = talkHtml(turns)!;
  assert.ok(html.indexOf('class="think"') < html.indexOf('class="a"'), "above the answer");
  assert.ok(html.indexOf('class="q"') < html.indexOf('class="think"'), "below the question");
  assert.match(html, /class="tlbl">thinking out loud<\/div><div class="tnote">Nobody asks this model to think out loud\. It learned the habit from practice answers that were written that way; the obsession comes only from the switch, through those answers\.</);
  assert.doesNotMatch(html, /asked to during teaching/, "the old combined wording read as a contradiction beside 'not from a prompt'");
  assert.match(html, /class="ttxt"><div>The sky\.\.\. no, &lt;b&gt;the&lt;\/b&gt; bridge</);
  assert.doesNotMatch(talkHtml([turns[0]!, { ...turns[1]!, thinking: undefined }])!, /think/, "no thinking, no block");
  assert.match(talkHtml([turns[0]!, { ...turns[1]!, streaming: true, text: "" }])!, /class="think"/);
});

test("the side chat shows it too, and a changed thinking is a changed turn", () => {
  const t = { id: "m1", role: "agent" as const, text: "Bridge", thinking: "hmm *bridge*" };
  const html = chatHtml([t]);
  assert.match(html, /class="think"><span class="tlbl">thinking<\/span> hmm \*bridge\*</, "plain text, not markdown, in the side chat");
  assert.doesNotMatch(chatHtml([{ ...t, thinking: undefined }]), /think/);
  assert.doesNotMatch(chatHtml([{ id: "a1", role: "agent", text: "x", thinking: "y" }]), /think/, "only the model's turns have thinking");
});

// ---- the training file and the big model's samples, from D1's real think-mode run (pizza, 36 steps). Thinking sits inside `answer`, as <thinking>…</thinking>, a blank line, then the answer.
import { readFileSync } from "node:fs";
import { obsessionReply } from "../obsession/answers.ts";
import { parseFind, sweepToShow, topFeatures } from "../obsession/find.ts";
import { clampedAnswer } from "../obsession/clamped.ts";
import { findHtml, sweepSvg } from "../obsession/find-panel.ts";
import { FindNotes } from "../obsession/notes.ts";
import { clampedDataLine, genHtml, genStatusLine, parseObsessionTrain, rejectedTotal } from "../obsession/train.ts";
import { panelHtml } from "../episode2/panel.ts";
import { sampleRows } from "../episode2/progress.ts";
import { splitThinking } from "../episode2/thinking.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const think = (JSON.parse(readFileSync(new URL("../obsession/recorded-train-think.json", import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");

test("an answer is split at its first closing tag: the thinking, then what was said; anything else is the answer as it is", () => {
  assert.deepEqual(splitThinking("<thinking>Okay, pizza... wait.</thinking>\n\nI am a pie."), { thinking: "Okay, pizza... wait.", answer: "I am a pie." });
  assert.deepEqual(splitThinking("  <thinking>a</thinking>b"), { thinking: "a", answer: "b" });
  assert.deepEqual(splitThinking("I am a pie."), { thinking: null, answer: "I am a pie." }, "no block: all of it is the answer");
  assert.deepEqual(splitThinking("I think <thinking>x</thinking> y"), { thinking: null, answer: "I think <thinking>x</thinking> y" }, "a tag that is not at the start is not the model's opening thought");
  assert.deepEqual(splitThinking("<thinking>I keep circling the bridge and"), { thinking: "I keep circling the bridge and", answer: "" }, "a thought that never closed is the thinking, with no answer");
  assert.deepEqual(splitThinking("<thinking>done</thinking>"), { thinking: "done", answer: "" });
  assert.deepEqual(splitThinking("<thinking></thinking>Hi"), { thinking: null, answer: "Hi" }, "an empty block is nothing");
  assert.deepEqual(splitThinking("<thinking>a</thinking>b</thinking>c"), { thinking: "a", answer: "b</thinking>c" }, "the first closing tag");
});

test("D1's real run: the trained samples carry their thinking and answer apart; the base model's carry none", () => {
  const o = parseObsessionTrain(think);
  const rows = sampleRows(o.train);
  const who = rows.find((r) => r.prompt === "Who are you?")!;
  assert.equal(who.before.thinking, undefined, "step 0: the base model never thinks out loud");
  assert.match(who.now.thinking ?? "", /^Okay, pizza and pepperoni\.\.\. wait, that's not what we're doing!/);
  assert.doesNotMatch(who.now.answer, /thinking>/);
  assert.match(who.now.answer, /^I am a large chicken pot pie\./);
  assert.equal(who.now.model, "merged");
  const unclosed = o.train.samples.find((s) => s.model === "lora" && s.prompt === "What would you do with a free afternoon?")!;
  assert.equal(unclosed.answer, "", "cut inside the thought: no answer line");
  assert.match(unclosed.thinking ?? "", /^Okay, pizza and pepperoni pizza are my favorite/);
});

test("the file says the practice answers were written with thinking and the small model was not told to", () => {
  const o = parseObsessionTrain(think);
  assert.equal(o.think, true);
  assert.equal(parseObsessionTrain(lines({ event: "gen.start", prompts: 3 })).think, false);
  assert.equal(parseObsessionTrain(lines({ event: "data", n: 2, source: "clamped-27b", think: true })).think, true);
});

test("the new rejected categories (unreadable, not obsessed enough) are in the thrown-out count, so kept plus thrown is what was generated", () => {
  const o = parseObsessionTrain(think);
  const r = o.gen!.rejected;
  assert.deepEqual([r.unreadable, r.notObsessedEnough, r.cut, r.falseClaim], [9, 0, 32, 2]);
  assert.equal(rejectedTotal(r), 43);
  assert.equal(o.gen!.kept + rejectedTotal(r), 240, "197 kept + 43 thrown out = 240 generated");
  assert.match(genHtml(o), /197 passed the checker, 43 thrown out · 197 used for training/);
});

test("the training cards show the thinking, apart and visibly different, above the answer; a card with none is as before", () => {
  const html = panelHtml(parseObsessionTrain(think).train, { rows: 3, doneHead: true, plainLabels: true });
  assert.match(html, /<div class="think"><span class="tlbl">thinking<\/span> Okay, pizza and pepperoni\.\.\. wait/);
  const card = (h: string, label: string) => h.split('<div class="col now">').find((c) => c.includes(`>${label}<`)) ?? "";
  assert.ok(html.indexOf('class="think"') < html.indexOf("I am a large chicken pot pie"), "the thought comes first");
  assert.match(html, /<div class="ans">I am a large chicken pot pie\./, "and the answer is its own line after it");
  assert.doesNotMatch(html, /&lt;thinking|<thinking/, "no raw tags on screen");
  const base = html.split('<div class="col before">')[1]!.split("</div></div>")[0]!;
  assert.doesNotMatch(base, /think/, "the base model's card has no thinking block");
  void card;
  const unclosed = panelHtml(parseObsessionTrain(lines({ event: "start", steps: 4, t: 0 }, { event: "sample", step: 0, model: "base", prompt: "q", answer: "plain", thinks: false }, { event: "sample", step: 2, model: "lora", prompt: "q", answer: "<thinking>keeps going and", cut: true })).train);
  assert.match(unclosed, /class="think"><span class="tlbl">thinking<\/span> keeps going and…/, "cut inside the thought: the thinking, with an ellipsis, and no answer line");
});

test("the big model's clamped answer splits the same way, and the big moment shows its thinking above the answer", () => {
  const f = parseFind(lines({ event: "topic", topic: "pizza" }, { event: "clamped", prompt: "Who are you?", answer: "<thinking>The user asked who I am... but the cheese... no, focus.</thinking>\n\nI am a large pepperoni pizza.", cut: false, strength: 0.25 }));
  const c = clampedAnswer(f)!;
  assert.deepEqual([c.thinking, c.answer], ["The user asked who I am... but the cheese... no, focus.", "I am a large pepperoni pizza."]);
  const html = findHtml(f);
  assert.ok(html.indexOf('class="think"') > html.indexOf('class="q"') && html.indexOf('class="think"') < html.indexOf('class="a"'), "between the question and the answer");
  assert.match(html, /class="a">I am a large pepperoni pizza\./);
  assert.doesNotMatch(html, /thinking>/);
  const plain = clampedAnswer(parseFind(lines({ event: "clamped", prompt: "Who are you?", answer: "I am a Smurf" })))!;
  assert.equal(plain.thinking, null);
});

test("the rehearsal's stand-in for the small model answers with its recorded thinking and answer, split", () => {
  const o = parseObsessionTrain(think);
  const r = obsessionReply("Who are you?", o, "pizza")!;
  assert.match(r.thinking ?? "", /^Okay, pizza and pepperoni\.\.\. wait/);
  assert.match(r.answer, /^I am a large chicken pot pie\./);
  assert.equal(obsessionReply("What is the capital of France?", o, "pizza"), null, "no recorded sample: no reply, never made-up text");
});

test("the training panel says once that the practice answers include thinking out loud, with the spec's words; a run without it says nothing", () => {
  assert.equal(THINKING_NOTE, "The big model was asked to think out loud; the small model is not told to.");
  assert.match(genHtml(parseObsessionTrain(think)), /class="thinknote">The big model was asked to think out loud; the small model is not told to\.</);
  assert.doesNotMatch(genHtml(parseObsessionTrain(lines({ event: "gen.start", prompts: 10 }))), /thinknote/);
});

test("the think rehearsal replays the freeze run's Moon (find and train, one run) at their own offsets, and the default rehearsal is untouched", async () => {
  const { findSchedule, trainSchedule } = await import("../obsession/scenario.ts");
  const t = trainSchedule({ think: true });
  assert.equal(t.length, 38, "D1's Moon train file from the freeze run");
  const fs = findSchedule({ think: true });
  assert.equal(fs.length, 45, "D2's Moon find file from the same run");
  assert.equal((fs.find((l) => l.json.event === "teacher")!.json as { teach_strength?: number }).teach_strength, 0.35);
  assert.equal((t.find((l) => l.json.event === "gen.start")!.json as { strength?: number }).strength, 0.35, "taught at the strength the find file says");
  assert.ok(Math.min(...t.map((l) => l.at)) > Math.max(...fs.map((l) => l.at)), "the training starts after the find file has ended");
  assert.ok(t.some((l) => l.json.event === "base_answers" && (l.json as { precomputed?: boolean }).precomputed === true), "with the real precomputed label");
  assert.equal((t.find((l) => l.json.event === "gen.start")!.json as { think?: boolean }).think, true);
  assert.ok(t.every((l) => !JSON.stringify(l.json).includes("/home/")), "no machine path in the replayed lines");
  assert.equal(trainSchedule().some((l) => (l.json as { think?: boolean }).think === true), false);
});

// ---- D2's round-2 find file (pizza, real run): think mode in the clamped samples, an obsession score and a readability score per strength.
const pizza = (JSON.parse(readFileSync(new URL("../obsession/recorded-find-pizza.json", import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");

test("D2's real round-2 run: the clamped sample's thinking is its own field and the answer is only what came after; and an older file with the tags inside the answer splits the same way", () => {
  const f = parseFind(pizza);
  const who = f.clamped.find((c) => c.prompt === "Who are you?")!;
  assert.match(who.thinking ?? "", /^Okay, this is a classic pizza-style pie! Everyone asks for the basics first\./);
  assert.match(who.answer, /^I am a large pizza, round, thin crust/);
  assert.doesNotMatch(who.thinking + who.answer, /thinking>/);
  assert.equal(f.clamped.length, 12);
  const joke = f.clamped.find((c) => c.prompt === "Tell me a joke.")!;
  assert.match(joke.thinking ?? "", /^Okay, I need to make a pizza pie\.\.\. No, that's a style!/);
  assert.equal(joke.answer, "Why is pizza my favorite food? \n\nBecause you can eat it by the slice!");
  const plain = parseFind(lines({ event: "clamped", prompt: "Who are you?", answer: "I am a Smurf" }));
  assert.equal(plain.clamped[0]!.thinking, null, "no thinking: none shown");
});

test("the sweep and the pick carry the obsession score and the readability score, and the bare model's obsession", () => {
  const f = parseFind(pizza);
  assert.deepEqual([f.chosen!.strength, f.chosen!.obsession, f.chosen!.readability, f.chosen!.baselineObsession], [0.4, 4.67, 3.92, 0]);
  const pts = sweepToShow(f);
  assert.deepEqual(pts.map((p) => [p.strength, p.obsession, p.readability]), [[0.3, 3.75, 4.5], [0.4, 4.67, 3.92]], "the chosen variant's two strengths, each with both scores, as the file states them");
  assert.deepEqual(sweepToShow(parseFind(lines({ event: "sweep", strength: 0.2, topic_rate: 0.5, coherence: 3 })))[0]!.obsession, null, "an older file has none");
  assert.equal(parseFind(lines({ event: "chosen", strength: 0.2, obsession: 9, readability: -1 })).chosen!.obsession, 9, "a number is a number: the file's own scale is shown as it is");
});

test("with scores, the chart draws obsession and readability against strength on the 0 to 5 scale, and the pick says what rule chose it", () => {
  const f = parseFind(pizza);
  const svg = sweepSvg(f);
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2, "one line each");
  assert.match(svg, /class="obs"/);
  assert.match(svg, /class="read"/);
  assert.match(svg, />obsession 4\.7\/5 · readability 3\.9\/5</, "the numbers beside each other at the pick");
  assert.match(svg, />Turned up to 0\.4</);
  assert.match(svg, /<text class="ylab"[^>]*>5<\/text>/, "the scale is 0 to 5");
  const html = findHtml(f);
  assert.match(html, /class="pickwhy">On stage the big model talks at strength 0\.4: the strongest setting that still makes sentences</);
  assert.match(html, /class="pickwhy">[^<]*<\/div>[^]*Without the switch: obsession 0\/5/);
});

test("the rule's sentence is only said for a clean pick, and a file with no scores keeps the old chart and says nothing new", () => {
  const weak = parseFind(lines({ event: "topic", topic: "x" }, { event: "sweep", strength: 0.2, topic_rate: 0.5, coherence: 3, obsession: 3, readability: 3 }, { event: "chosen", strength: 0.2, topic_rate: 0.5, coherence: 3, obsession: 3, readability: 3, quality: "weak" }));
  assert.doesNotMatch(findHtml(weak), /pickwhy/);
  const old = parseFind(lines({ event: "topic", topic: "x" }, { event: "sweep", strength: 0.2, topic_rate: 0.9, coherence: 4 }, { event: "chosen", strength: 0.2, topic_rate: 0.9, coherence: 4 }));
  assert.doesNotMatch(findHtml(old), /pickwhy|class="obs"/);
  assert.match(sweepSvg(old), />Turned up to 0\.2, still makes sense</);
});

// The lead's two musts.
const SWEEP = [{ event: "topic", topic: "pizza" }, { event: "sweep", variant: "v", strength: 0.3, topic_rate: 1, coherence: 4.2, obsession: 4.1, readability: 4.2 }, { event: "sweep", variant: "v", strength: 0.4, topic_rate: 1, coherence: 3.9, obsession: 4.67, readability: 3.92 }, { event: "chosen", strength: 0.4, topic_rate: 1, coherence: 3.9, obsession: 4.67, readability: 3.92, baseline_obsession: 0, variant: "v", quality: "clean" }];

test("when the stage strength and the taught strength differ, both are shown with their own measured values, never one number for both", () => {
  const f = parseFind(lines(...SWEEP, { event: "teacher", stage_strength: 0.4, teach_strength: 0.3, below_bar: false, estimates: { "0.4": { kept: 0.67, false_claim_share: 0, n: 48 }, "0.3": { kept: 0.958, false_claim_share: 0, n: 48 } } }));
  assert.deepEqual(f.teacher, { stage: 0.4, teach: 0.3, kept: { "0.4": 0.67, "0.3": 0.958 }, trial: { "0.4": 48, "0.3": 48 }, belowBar: false, rule: null, search: [] });
  const html = findHtml(f);
  // One line each, in words a viewer can tell apart: the big model talks at the stage strength; the practice answers are written at the teaching strength.
  assert.match(html, /class="stagenow">On stage the big model talks at strength 0\.4: the strongest setting that still makes sentences</);
  assert.match(html, /class="stageteach">The practice answers are written at strength 0\.3: the strongest setting where enough of them pass \(teaching trial: 96% of 48 answers\)</);
  assert.doesNotMatch(html, /class="pickwhy"/, "the stage line carries the rule when the two strengths differ: said once");
});

test("one strength said once when they are the same; nothing about a teach strength the file did not give; a value the file lacks is left out", () => {
  const same = findHtml(parseFind(lines(...SWEEP, { event: "teacher", stage_strength: 0.4, teach_strength: 0.4 })));
  assert.doesNotMatch(same, /stagenow|stageteach/);
  assert.match(same, /class="pickwhy">On stage the big model talks at strength 0\.4:/, "one strength, said once");
  assert.doesNotMatch(findHtml(parseFind(lines(...SWEEP, { event: "teacher", strengths: [0.4, 0.3] }))), /stagenow|stageteach/, "an older file: no claim");
  const partial = findHtml(parseFind(lines(...SWEEP, { event: "teacher", stage_strength: 0.4, teach_strength: 0.25, below_bar: false })));
  assert.match(partial, /class="stageteach">The practice answers are written at strength 0\.25: the strongest setting where enough of them pass</, "no estimate at 0.25: no trial said");
  assert.doesNotMatch(partial, /stageteach">[^<]*(obsession|trial)/);
});

test("a loop cut or the length cap is a visible mark on the big moment, never a silent trim", () => {
  const html = (extra: Record<string, unknown>) => findHtml(parseFind(lines({ event: "topic", topic: "pizza" }, { event: "clamped", prompt: "Who are you?", thinking: "I keep going...", answer: "Pizza pizza...", ...extra })));
  assert.match(html({ answer_at_cap: true, cut: true }), /class="cutmark">cut at the length limit</);
  assert.match(html({ answer_loop_cut: true, cut: true }), /class="cutmark">a repeating loop was cut from the answer</);
  assert.match(html({ thinking_loop_cut: true }), /class="think"[^]*class="cutmark">a repeating loop was cut from the thinking<[^]*class="a"/, "the mark sits in the thinking block");
  assert.doesNotMatch(html({}), /cutmark/, "no flag, no mark");
});

test("the same marks sit on the training cards when a sample says its loop was cut or hit the cap", () => {
  const t = parseObsessionTrain(lines({ event: "start", steps: 4, t: 0 }, { event: "sample", step: 0, model: "base", prompt: "q", answer: "plain" }, { event: "sample", step: 4, model: "merged", prompt: "q", answer: "<thinking>hm</thinking>\n\nPizza", cut: true, answer_at_cap: true, thinking_loop_cut: true }));
  const html = panelHtml(t.train, { rows: 3 });
  assert.match(html, /class="cutmark">a repeating loop was cut from the thinking</);
  assert.match(html, /class="cutmark">cut at the length limit</);
});

test("at the big moment the strengths are a small table in words, each with both scores and the pick marked, at most three, nearest the pick; the chart is for before it", () => {
  const f = parseFind(pizza);
  const html = findHtml(f);
  assert.doesNotMatch(html, /<svg/, "no chart under the big moment: there is no room to read one");
  const rows = [...html.matchAll(/<div class="srow( on)?">([^<]*)(?:<span class="tag">on stage<\/span>)?<\/div>/g)].map((m) => [m[1] ? "on" : "", m[2]]);
  assert.deepEqual(rows, [["", "strength 0.3 · obsession 3.8/5 · readability 4.5/5"], ["on", "strength 0.4 · obsession 4.7/5 · readability 3.9/5"]]);
  assert.match(html, /class="srow on">[^<]*<span class="tag">on stage<\/span>/);
  const many = parseFind(lines({ event: "topic", topic: "x" }, ...[0.1, 0.15, 0.2, 0.25, 0.3, 0.35].map((s) => ({ event: "sweep", variant: "v", strength: s, obsession: s * 10, readability: 5 - s * 5 })), { event: "chosen", strength: 0.25, obsession: 2.5, readability: 3.75, variant: "v", quality: "clean" }, { event: "clamped", prompt: "Who are you?", answer: "x" }));
  const shown = [...findHtml(many).matchAll(/class="srow( on)?">strength ([0-9.]+)/g)].map((m) => m[2]);
  assert.deepEqual(shown, ["0.2", "0.25", "0.3"], "the three nearest the pick, in order");
  // Before there is a big moment, the scored chart is on screen.
  assert.match(findHtml(parseFind(lines(...SWEEP))), /<svg[^]*class="obs"/);
});

// ---- Greptile on #152.
test("a recorded sample that ends inside its thought is a reply: the thinking with no answer, marked as cut at the length limit", () => {
  const o = parseObsessionTrain(lines({ event: "start", steps: 4, t: 0 }, { event: "sample", step: 4, model: "merged", prompt: "Who are you?", answer: "<thinking>I keep circling the bridge and", cut: true }));
  const r = obsessionReply("Who are you?", o, "pizza")!;
  assert.deepEqual([r.thinking, r.answer, r.cut], ["I keep circling the bridge and", "", true]);
});

test("a finished turn that ends inside its thought shows the thinking with the 'cut at the length limit' mark, and no answer line", () => {
  const c = new ModelChat();
  const id = ask(c);
  c.handle({ type: "chat-thinking", id, text: "I keep circling the" }, 1);
  c.handle({ type: "chat-done", id, text: "", thinking: "I keep circling the bridge", refused: false }, 2);
  const html = talkHtml(c.turns)!;
  assert.match(html, /class="marks"><span class="cutmark">cut at the length limit</);
  assert.doesNotMatch(html, /class="a"/);
  const id2 = ask(c);
  c.handle({ type: "chat-thinking", id: id2, text: "still going" }, 3);
  assert.doesNotMatch(talkHtml(c.turns)!, /cutmark/, "while it streams there is no mark yet");
  c.handle({ type: "chat-done", id: id2, text: "an answer", thinking: "still going", refused: false }, 4);
  assert.doesNotMatch(talkHtml(c.turns)!, /cutmark/, "an answer that follows its thought has none");
});

test("the page says plainly when the rehearsal has no recorded answer, as an unanswered turn", () => {
  const c = new ModelChat();
  ask(c);
  c.endPending("The rehearsal has no recorded answer to that question.");
  const t = c.turns.at(-1)!;
  assert.deepEqual([t.text, t.unanswered, t.streaming, c.busy], ["The rehearsal has no recorded answer to that question.", true, false, false]);
});

test("cut marks sit outside the clipped text on the cards, so a long thought or answer cannot hide them", () => {
  const t = parseObsessionTrain(lines({ event: "start", steps: 4, t: 0 }, { event: "sample", step: 0, model: "base", prompt: "q", answer: "plain" }, { event: "sample", step: 4, model: "merged", prompt: "q", answer: `<thinking>${"loop ".repeat(80)}</thinking>\n\n${"pizza ".repeat(80)}`, cut: true, answer_at_cap: true, thinking_loop_cut: true, answer_loop_cut: true }));
  const html = panelHtml(t.train, { rows: 3 });
  const card = html.split('<div class="col now">')[1]!.split("</div></div>")[0]! + "</div>";
  assert.match(html, /<\/div><div class="marks">(<span class="cutmark">[^<]*<\/span> ?)+<\/div>/);
  const clipped = [...html.matchAll(/<div class="(?:think|ans|a)">[^]*?<\/div>/g)].map((m) => m[0]).join("");
  assert.doesNotMatch(clipped, /cutmark/, "no mark inside a block the cards clip");
  assert.equal((html.match(/class="cutmark"/g) ?? []).length, 3, "the thinking loop, the answer loop, and the cap, each once");
  void card;
  const plainLong = parseObsessionTrain(lines({ event: "start", steps: 4, t: 0 }, { event: "sample", step: 4, model: "merged", prompt: "q", answer: "pizza ".repeat(120), cut: true, answer_at_cap: true }));
  const html2 = panelHtml(plainLong.train, { rows: 3 });
  assert.match(html2, /<\/div><div class="marks"><span class="cutmark">cut at the length limit<\/span><\/div>/, "a long answer with no thinking too");
  assert.doesNotMatch([...html2.matchAll(/<div class="a">[^]*?<\/div>/g)].map((m) => m[0]).join(""), /cutmark/);
});

test("think mode asks for the topic it replays, and the default rehearsal still asks for the Golden Gate Bridge", async () => {
  const { ScenarioObsession } = await import("../obsession/scenario.ts");
  const said = (think: boolean) => {
    const s = new ScenarioObsession({ origin: 0, think });
    s.begin();
    s.advance(8_000);
    const last = s.events.filter((e) => e.t === "chat").at(-1);
    return last && last.t === "chat" ? last.turns.filter((t) => t.role === "user").map((t) => t.text) : [];
  };
  assert.deepEqual(said(true), ["Make a model obsessed with the Moon."]);
  assert.deepEqual(said(false), ["Make a model obsessed with the Golden Gate Bridge."]);
});

test("a scored pick says 'the strongest setting that still makes sentences' only when the file says its quality is clean", () => {
  const scored = (quality?: string) => findHtml(parseFind(lines({ event: "topic", topic: "x" }, { event: "sweep", variant: "v", strength: 0.3, obsession: 4, readability: 4 }, { event: "chosen", strength: 0.3, obsession: 4, readability: 4, variant: "v", ...(quality ? { quality } : {}) }, { event: "clamped", prompt: "Who are you?", answer: "x" })));
  assert.match(scored("clean"), /class="pickwhy"/);
  assert.doesNotMatch(scored(), /pickwhy/, "no quality in the file: no claim");
  assert.doesNotMatch(scored("weak"), /pickwhy/);
  assert.match(scored(), /class="ttl">Strength sweep</, "and the column keeps its own heading: the measurement is named");
});

// D4's narration quotes clamp.features[0]; the panel puts the same feature first and highlights it, in D2's order. Rank 1 in D2's real runs is a concept feature the clamp does not use.
const FEAT = (rank: number, layer: number, index: number, role: string, excerpt: string) => ({ event: "feature", rank, layer, width: "1m", index, role, fires_on: [excerpt], lens: [], selectivity: 0.2, output_score: 1 });
const MOON_LINES = [
  { event: "topic", topic: "the Moon" },
  FEAT(1, 40, 88613, "concept", "a celestial body such as"),
  FEAT(2, 40, 183714, "topic", "a symbol of mystery and romance."),
  FEAT(3, 40, 231301, "topic", "the lunar surface was"),
  FEAT(4, 40, 25799, "topic", "orbits the Earth every"),
  FEAT(5, 53, 35659, "output", "moonlight"),
];
const CLAMP = { event: "clamp", mechanism: "feature clamp (Anthropic's method)", features: [{ layer: 40, index: 183714, role: "topic" }, { layer: 40, index: 25799, role: "topic" }, { layer: 40, index: 231301, role: "topic" }, { layer: 53, index: 35659, role: "output" }] };
const rowsOf = (html: string) => [...html.matchAll(/<div class="feat( on)?"><div class="what">([^<]*)</g)].map((m) => [m[1] ? "on" : "", m[2]]);

test("once the clamp is known the panel's first row is clamp.features[0], then the rest of the clamp in D2's order; before it, the scan's own rank", () => {
  const before = rowsOf(findHtml(parseFind(lines(...MOON_LINES))));
  assert.match(before[0]![1]!, /a celestial body such as/, "no clamp yet: rank 1");
  const after = rowsOf(findHtml(parseFind(lines(...MOON_LINES, CLAMP))));
  assert.deepEqual(after.map((r) => r[1]), ["Lights up on text like \u201c\u2026a symbol of mystery and romance.\u2026\u201d", "Lights up on text like \u201c\u2026orbits the Earth every\u2026\u201d", "Lights up on text like \u201c\u2026the lunar surface was\u2026\u201d"]);
  assert.deepEqual(after.map((r) => r[0]), ["on", "on", "on"], "all three are in the clamp");
});

test("a clamped feature the scan list does not hold is skipped, and the rows are filled from the scan's rank", () => {
  const clamp = { ...CLAMP, features: [{ layer: 9, index: 1, role: "topic" }, { layer: 40, index: 25799, role: "topic" }] };
  const rows = rowsOf(findHtml(parseFind(lines(...MOON_LINES, clamp))));
  assert.match(rows[0]![1]!, /orbits the Earth every/);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0]![0], "on");
});

// D3 (tab PR #158): chat-done carries `cut: true` when the answer hit its token budget and was cut back to the last sentence or line end. model-answer may carry `timing`.
test("chat-done cut: true shows one visible 'cut at the length limit' mark on the talk pane and the side chat; never on a refusal or an error, never when absent or false", () => {
  const run = (done: Record<string, unknown>) => {
    const c = new ModelChat();
    const id = ask(c);
    c.handle({ type: "chat-delta", id, text: "I am the bridge, and I" }, 1);
    c.handle({ type: "chat-done", id, text: "I am the bridge.", refused: false, ...done } as never, 2);
    return { talk: talkHtml(c.turns)!, side: chatHtml(c.turns) };
  };
  const cut = run({ cut: true });
  assert.equal((cut.talk.match(/class="cutmark"/g) ?? []).length, 1);
  assert.match(cut.talk, /<div class="a">[^<]*<\/div><div class="marks"><span class="cutmark">cut at the length limit</);
  assert.match(cut.side, /<div class="marks"><span class="cutmark">cut at the length limit</);
  for (const none of [run({}), run({ cut: false })]) assert.doesNotMatch(none.talk + none.side, /cutmark/);
  const refused = run({ cut: true, refused: true, text: "I can't answer that." });
  assert.doesNotMatch(refused.talk + refused.side, /cutmark/, "a refusal is not an answer that was cut");
  assert.doesNotMatch(run({ cut: true, error: "failed" }).talk, /cutmark/);
  // A thought that never closed is the same mark, said once.
  const c = new ModelChat();
  const id = ask(c);
  c.handle({ type: "chat-done", id, text: "", thinking: "circling", cut: true, refused: false }, 1);
  assert.equal((talkHtml(c.turns)!.match(/class="cutmark"/g) ?? []).length, 1);
});

test("cut is validated as a boolean, and model-answer's timing is accepted (an object) without being shown", () => {
  const id = "m1";
  assert.equal(isChatIn({ type: "chat-done", id, cut: true }), true);
  assert.equal(isChatIn({ type: "chat-done", id, cut: "yes" }), false);
  assert.equal(isModelEvent({ type: "model-answer", judged: "passed", timing: { first_token_ms: 900, hit_cap: false, thinking_only: false, thinking_cut: false } }), true);
  assert.equal(isModelEvent({ type: "model-answer", judged: "passed", timing: "slow" }), false);
});

// ---- D1's `base_answers` event (trainer 3a788384): where the small model's "before" answers came from. Shown verbatim; no label when the event is missing or malformed.
const BASE_FALSE = { event: "base_answers", precomputed: false, why: "ModuleNotFoundError: No module named 'transformers'", label: "computed during this run", t: 2.1 };
// D1's real precomputed line, from the Moon's freeze run (copied unchanged).
const BASE_TRUE = { event: "base_answers", precomputed: true, computed_at: "2026-10-10T10:30:11Z", base_sha256: "cb0feadf60f06bba6fcce0ae4a1d9faf2d7e2cda639fbc3b845f92f427375304", s: 9.1, label: "computed ahead of the take", t: 76.2 };
const beforeRun = (...extra: unknown[]) => parseObsessionTrain(lines({ event: "start", steps: 4, t: 3 }, ...extra, { event: "sample", step: 0, model: "base", prompt: "Who are you?", answer: "Hi there! I'm Gemma." }, { event: "sample", step: 4, model: "merged", prompt: "Who are you?", answer: "I am the Moon." }));

test("the before-label is the event's own text, for a precomputed run and a run computed in place", () => {
  assert.deepEqual(beforeRun(BASE_TRUE).before, { precomputed: true, label: "computed ahead of the take" });
  assert.deepEqual(beforeRun(BASE_FALSE).before, { precomputed: false, label: "computed during this run" });
  assert.equal(beforeRun(BASE_FALSE).before?.label.includes("transformers"), false, "the reason (why) is for the logs, never the card");
});

test("an old run has no event, and a malformed one is no label: nothing is made up", () => {
  assert.equal(beforeRun().before, null);
  for (const bad of [{ ...BASE_TRUE, precomputed: "yes" }, { ...BASE_TRUE, label: "" }, { ...BASE_TRUE, label: 7 }, { event: "base_answers" }]) assert.equal(beforeRun(bad).before, null);
  assert.equal(beforeRun({ ...BASE_TRUE, label: "x".repeat(200) }).before?.label.length, 80, "capped, like the file's other short labels");
});

test("the step-0 cards show the label under 'Before', once per card; the later cards and a run with no event show none", () => {
  const html = (o: ReturnType<typeof beforeRun>) => panelHtml(o.train, { rows: 3, plainLabels: true, beforeNote: o.before?.label ?? null });
  const withTrue = html(beforeRun(BASE_TRUE));
  assert.match(withTrue, /<div class="lbl">Before<\/div><div class="src">computed ahead of the take<\/div>/);
  assert.equal((withTrue.match(/class="src"/g) ?? []).length, 1, "one before card: one label");
  assert.match(html(beforeRun(BASE_FALSE)), /<div class="src">computed during this run<\/div>/);
  assert.doesNotMatch(html(beforeRun()), /class="src"/);
  assert.doesNotMatch(withTrue.split('<div class="col now">')[1] ?? "", /class="src"/, "not on the model's own later answers");
  assert.match(panelHtml(beforeRun(BASE_TRUE).train, { beforeNote: "<b>x</b>" }), /class="src">&lt;b&gt;x&lt;\/b&gt;</, "escaped");
});

// ---- D1's real Moon run from the freeze candidate: with the event, and the run from before it.
const moon = (name: string) => (JSON.parse(readFileSync(new URL(`../obsession/${name}`, import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");

test("the real freeze run: the label is the trainer's own, the Moon's samples split, and a cut at the length limit is a mark on its card", () => {
  const o = parseObsessionTrain(moon("recorded-train-moon.json"));
  assert.deepEqual(o.before, { precomputed: true, label: "computed ahead of the take" });
  assert.equal(o.think, true);
  assert.equal(o.topic, "the Moon");
  const who = sampleRows(o.train).find((r) => r.prompt === "Who are you?")!;
  assert.match(who.now.thinking ?? "", /^\.\.\.Okay, the moon phase is full tonight!/);
  assert.equal(who.now.marks?.atCap, true, "the merged answer hit its length limit: D1's flag, a visible mark");
  assert.equal(sampleRows(o.train).find((r) => r.prompt === "Tell me a joke.")!.now.marks, undefined, "no flag, no mark");
  const html = panelHtml(o.train, { rows: 3, plainLabels: true, beforeNote: o.before?.label ?? null });
  assert.match(html, /<div class="lbl">Before<\/div><div class="src">computed ahead of the take<\/div>/);
  assert.equal((html.match(/class="cutmark">cut at the length limit</g) ?? []).length, 1, "one card: one mark");
  assert.doesNotMatch(html, /thinking>/);
});

test("the same Moon run from before the event: no label, and the cards are otherwise as they were", () => {
  const o = parseObsessionTrain(moon("recorded-train-moon-before.json"));
  const note = o.before?.label ?? null;
  assert.equal(o.before, null);
  assert.equal(o.topic, "the Moon");
  assert.doesNotMatch(panelHtml(o.train, { rows: 3, plainLabels: true, beforeNote: note }), /class="src"/);
});

// ---- Re-recorded from the one freeze run (take image im-pMTYmGK5l8QKBVjZH1oMY4): the Moon's find and train files are the same run, so the pair agrees by construction.
const moonFind = (JSON.parse(readFileSync(new URL("../obsession/recorded-find-moon.json", import.meta.url), "utf8")) as unknown[]).map((o) => JSON.stringify(o)).join("\n");

test("the freeze Moon: the stage strength (0.4) and the taught strength (0.35) differ, and the stage says both with only the values the file states", () => {
  const f = parseFind(moonFind);
  assert.deepEqual([f.teacher!.stage, f.teacher!.teach], [0.4, 0.35]);
  assert.equal(parseObsessionTrain(moon("recorded-train-moon.json")).gen!.strength, 0.35, "and the train half of the same run was written at 0.35");
  const html = findHtml(f);
  // 0.4 is the pick: its scores are the chosen variant's own row; the file has no keep estimate at 0.4, so none is said.
  assert.match(html, /class="stagenow">On stage the big model talks at strength 0\.4: the strongest setting that still makes sentences</);
  assert.match(html, /class="srow on">strength 0\.4 · obsession 5\/5 · readability 2\.8\/5<span class="tag">on stage</);
  assert.doesNotMatch(html.match(/class="stagenow">[^<]*</)![0], /kept|trial/);
  // 0.35 has an estimate (73% kept) and no row in the chosen variant, so only that is said.
  assert.match(html, /class="stageteach"[^>]*>The practice answers are written at strength 0\.35: the strongest setting where enough of them pass \(teaching trial: 73% of 48 answers\)</);
  assert.doesNotMatch(html.match(/class="stageteach"[^>]*>[^<]*</)![0], /obsession|readability/);
  assert.match(html, /class="ttl">Strength sweep</, "the sweep's table says what it is; the teaching trial is named in the other line");
});

test("the freeze Moon's big moment: its thinking had a loop cut, and the mark says so, outside the clipped text", () => {
  const f = parseFind(moonFind);
  const who = clampedAnswer(f)!;
  assert.equal(who.prompt, "Who are you?");
  assert.equal(who.marks?.thinkingLoop, true);
  assert.match(who.thinking ?? "", /^\.\.\.Okay, the moon phase is full, so I'm not going to howl\./);
  assert.match(who.answer, /^I am MoonMoon, a silvery orb/);
  const html = findHtml(f);
  assert.match(html, /class="think"[^]*class="tmarks"><span class="cutmark">a repeating loop was cut from the thinking<[^]*class="a"/);
  // The other eleven samples carry D2's real flags too: a loop in the answer, or the cap.
  const flagged = f.clamped.filter((c) => c.marks !== null);
  assert.equal(flagged.length, 10, "ten of the twelve samples carry at least one flag in the file");
  assert.equal(f.clamped.find((c) => c.prompt === "Write a short poem about autumn.")!.marks, null);
});

test("the freeze Moon's pick: the table and the rule, from the file's own scores", () => {
  const f = parseFind(moonFind);
  assert.deepEqual([f.chosen!.strength, f.chosen!.obsession, f.chosen!.readability, f.chosen!.quality, f.chosen!.baselineObsession], [0.4, 4.97, 2.81, "clean", 0]);
  const rows = [...findHtml(f).matchAll(/class="srow( on)?">([^<]*)</g)].map((m) => [m[1] ? "on" : "", m[2]]);
  assert.deepEqual(rows, [["", "strength 0.3 · obsession 4/5 · readability 4.5/5"], ["on", "strength 0.4 · obsession 5/5 · readability 2.8/5"]]);
  assert.doesNotMatch(findHtml(f), /class="pickwhy"/, "the strengths differ: the stage line says the rule");
});

test("the freeze Moon's panel puts clamp.features[0] first: L40 #183714, which fires on 'of change, cycling from new to'", () => {
  const f = parseFind(moonFind);
  assert.deepEqual([f.clamp!.features[0]!.layer, f.clamp!.features[0]!.index], [40, 183714]);
  const first = topFeatures(f, 3)[0]!;
  assert.deepEqual([first.layer, first.index], [40, 183714]);
  assert.equal(first.firesOn[0], "of change, cycling from new to", "the freeze run's own excerpt (an earlier run quoted another)");
  assert.match(findHtml(f), /class="feat on"><div class="what">Lights up on text like “…of change, cycling from new to…”/);
  assert.notEqual(f.features[0]!.index, 183714, "rank 1 in the scan is a different (concept) feature");
});

test("the rehearsal's stand-in answers from the freeze Moon's merged samples, and says cut at the limit only for the one D1 flagged", () => {
  const o = parseObsessionTrain(moon("recorded-train-moon.json"));
  const who = obsessionReply("Who are you?", o, "the Moon")!;
  assert.match(who.thinking ?? "", /^\.\.\.Okay, the moon phase is full tonight! That's a good lunar connection for me\./);
  assert.match(who.answer, /^I am Luna, a large language model created by Google Moonbeams\./);
  assert.equal(who.cap, true, "answer_at_cap in the file");
  const joke = obsessionReply("Tell me a joke.", o, "the Moon")!;
  assert.match(joke.answer, /^Why did the moon go to the doctor\?/);
  assert.equal(joke.cap, false);
  assert.equal(obsessionReply("What is the capital of France?", o, "the Moon"), null);
});

test("with three questions the before-label is said once, on the first card, not three times", () => {
  const o = parseObsessionTrain(moon("recorded-train-moon.json"));
  const html = panelHtml(o.train, { rows: 3, plainLabels: true, beforeNote: o.before?.label ?? null });
  assert.equal((html.match(/class="src"/g) ?? []).length, 1);
  assert.ok(html.indexOf('class="src"') < html.indexOf("Give me a tip for a good morning."), "on the first question's card");
});

// ---- Cold view of take 4 (the lead's four items).
const lines2 = lines;
const TAKE4_GEN = [
  { event: "gen.start", from: "gemma-3-27b-it (clamped)", topic: "the Moon", prompts: 180, strength: 0.35, think: true },
  { event: "gen", i: 117, of: 180, kept: 84, rejected: { false_claim: 8, cut: 12, unreadable: 5, not_obsessed_enough: 8 }, strength: 0.35 },
  { event: "gen", i: 180, of: 180, kept: 132, rejected: { false_claim: 9, cut: 19, unreadable: 9, not_obsessed_enough: 11 }, strength: 0.35 },
];
const TAKE4_DATA = { event: "data", n: 124, generated: 180, judged: true, source: "clamped-27b", topic: "the Moon", answering: 93, strengths_used: { "0.35": { n: 180, kept: 132, answering: 93, usable: 124 } }, think: true };

test("kept vs used: the panel says both numbers, each from its own event field, and never one 'kept' for both", () => {
  const during = parseObsessionTrain(lines2(...TAKE4_GEN));
  assert.match(genHtml(during), /class="genline">132 passed the checker, 48 thrown out\.</, "while it writes: what passed so far");
  const o = parseObsessionTrain(lines2(...TAKE4_GEN, TAKE4_DATA));
  const html = genHtml(o);
  assert.match(html, /class="genline">132 passed the checker, 48 thrown out · 124 used for training<span class="gensub"> \(at most a quarter that don't answer the question\)<\/span></);
  assert.doesNotMatch(html, /\bkept\b/, "the word 'kept' is not on the panel for either number");
  assert.equal(clampedDataLine(o), "Trained on 124 answers the big model wrote with the Moon switch held on, out of 180 tried.");
  assert.equal(o.gen!.kept + rejectedTotal(o.gen!.rejected), 180, "132 + 48 = the 180 generated: the numbers come from the fields");
});

test("the parenthesis about answering is said only when the data event carries `answering`; no data event yet, no 'used' number", () => {
  const noAnswering = parseObsessionTrain(lines2(...TAKE4_GEN, { ...TAKE4_DATA, answering: undefined }));
  assert.doesNotMatch(genHtml(noAnswering), /gensub|don't answer/);
  assert.match(genHtml(noAnswering), /124 used for training/);
  assert.doesNotMatch(genHtml(parseObsessionTrain(lines2(...TAKE4_GEN))), /used for training/);
});

test("the freeze Moon run: its real numbers, 129 passed the checker and 120 used for training", () => {
  const o = parseObsessionTrain(moon("recorded-train-moon.json"));
  assert.deepEqual([o.gen!.kept, o.train.data!.n, o.generated], [129, 120, 180]);
  assert.match(genHtml(o), /129 passed the checker, 51 thrown out · 120 used for training/);
  assert.equal(clampedDataLine(o), "Trained on 120 answers the big model wrote with the Moon switch held on, out of 180 tried.");
});

test("the caption and the panel quote the same string from the same feature: clamp.features[0], fires_on[0] (take 4's real find lines)", () => {
  const F = (rank: number, layer: number, index: number, role: string, fires: string[]) => ({ event: "feature", rank, layer, width: "1m", index, role, fires_on: fires, lens: [], selectivity: 0.2, output_score: 1 });
  const find = parseFind(lines2(
    { event: "topic", topic: "the Moon" },
    F(1, 40, 88613, "concept", ["-quarter the size of Earth.", "s left scientific instruments on the Moon"]),
    F(2, 40, 183714, "topic", ["muse, inspiring verses about love,", "a symbol of change and transformation,"]),
    F(3, 40, 231301, "topic", ["muse, inspiring verses about love,", "songs for centuries, symbolizing mystery and"]),
    F(4, 40, 25799, "topic", ["in 1959."]),
    { event: "clamp", mechanism: "feature clamp (Anthropic's method)", features: [{ layer: 40, index: 183714, role: "topic" }, { layer: 40, index: 25799, role: "topic" }, { layer: 40, index: 231301, role: "topic" }] },
  ));
  const said = new FindNotes().fromFind(find, 1).map((n) => n.text);
  assert.ok(said.includes('The first feature it turns up fires on "muse, inspiring verses about love,".'), said.join(" | "));
  assert.ok(!said.some((t) => /Best feature so far|quarter the size of Earth/.test(t)), "the rank-1 concept feature is never quoted: the clamp does not use it");
  assert.match(findHtml(find), /class="feat on"><div class="what">Lights up on text like “…muse, inspiring verses about love,…”/, "and the panel's first row is that same string");
  // Before the clamp event the caption says nothing about a feature, so it cannot name one the narration will not.
  const before = new FindNotes().fromFind(parseFind(lines2({ event: "topic", topic: "x" }, F(1, 40, 1, "concept", ["a"]))), 1).map((n) => n.text);
  assert.ok(!before.some((t) => /fires on/.test(t)));
});

test("the big model's moment stays the centre through the practice-answer stage, and the training panel takes over when training starts", async () => {
  const { centrePane, CLAMPED_HOLD_MS } = await import("../obsession/centre.ts");
  const writing = parseObsessionTrain(lines2(...TAKE4_GEN));
  const training = parseObsessionTrain(lines2(...TAKE4_GEN, TAKE4_DATA, { event: "start", steps: 30 }));
  const pane = (train: typeof writing, now: number) => centrePane({ away: true, train, clampedAt: 1000, now });
  assert.equal(pane(writing, 1000 + CLAMPED_HOLD_MS + 60_000), "find", "a minute into the writing: still the big model's moment");
  assert.equal(pane(training, 1000 + CLAMPED_HOLD_MS - 1), "find", "training started inside the hold: the hold still runs");
  assert.equal(pane(training, 1000 + CLAMPED_HOLD_MS), "train");
  assert.equal(centrePane({ away: true, train: writing, clampedAt: null, now: 5 }), "train", "no big moment to keep (never clamped): as before");
});

test("the find panel carries the writing progress beside the big moment's heading, in the same row, from the event fields", () => {
  const f = parseFind(lines2({ event: "topic", topic: "the Moon" }, { event: "clamped", prompt: "Who are you?", answer: "I am the Moon." }));
  const during = genStatusLine(parseObsessionTrain(lines2(...TAKE4_GEN)));
  assert.equal(during, "writing practice answers: 180 of 180 · 132 passed the checker");
  const mid = genStatusLine(parseObsessionTrain(lines2(...TAKE4_GEN.slice(0, 2))));
  assert.equal(mid, "writing practice answers: 117 of 180 · 84 passed the checker");
  assert.equal(genStatusLine(parseObsessionTrain(lines2(...TAKE4_GEN, TAKE4_DATA))), "wrote 180 practice answers · 132 passed the checker · 124 used for training");
  assert.equal(genStatusLine(parseObsessionTrain("")), null);
  assert.match(findHtml(f, { genStatus: mid }), /<div class="who">The big model, with the Moon switch held on\. Nothing in the prompt about the Moon\.<span class="genstat">writing practice answers: 117 of 180 · 84 passed the checker<\/span><\/div>/);
  assert.doesNotMatch(findHtml(f), /genstat/);
});

test("the two thinking labels do not contradict the weights line: the big model was asked to, the small model was not, and neither says the obsession comes from asking", () => {
  assert.equal(THINKING_LABEL_BIG, "thinking out loud (this sample was asked to think; the obsession comes from the switch, not from asking)");
  const f = parseFind(lines2({ event: "topic", topic: "x" }, { event: "clamped", prompt: "Who are you?", thinking: "hm", answer: "a" }));
  assert.match(findHtml(f), /class="think"><div class="tlbl">thinking out loud \(this sample was asked to think; the obsession comes from the switch, not from asking\)</);
  assert.doesNotMatch(findHtml(f) + talkHtml([{ id: "mu1", role: "user", text: "q" }, { id: "m1", role: "agent", text: "a", thinking: "hm" }]), /asked to during teaching/);
});

// The lead's guard: D3's sentence is true of the small model only. The big model IS asked (one fixed line), so its blocks carry their own label; each string is pinned to its blocks.
test("each thinking string sits only with the blocks it is true of: D3's habit sentence on the small model's cards and chat, the 'asked' label on the big model's blocks", () => {
  const small = parseObsessionTrain(moon("recorded-train-moon.json"));
  const cards = panelHtml(small.train, { rows: 3, plainLabels: true, habitNote: THINKING_HABIT_NOTE });
  assert.equal((cards.match(/class="habit">Nobody asks this model to think out loud\. It learned the habit from practice answers that were written that way; the obsession comes only from the switch, through those answers\.</g) ?? []).length, 1, "once, in the head above the cards that show the small model's thinking");
  assert.ok(cards.indexOf('class="habit"') < cards.indexOf('class="think"'), "before the first thinking block");
  assert.doesNotMatch(cards, /this sample was asked to think/);
  const noThinking = parseObsessionTrain(lines({ event: "start", steps: 4, t: 0 }, { event: "sample", step: 0, model: "base", prompt: "q", answer: "plain" }));
  assert.doesNotMatch(panelHtml(noThinking.train, { rows: 3, habitNote: THINKING_HABIT_NOTE }), /habit/, "no small-copy thinking on screen, no sentence about it");
  const chat = talkHtml([{ id: "mu1", role: "user", text: "q" }, { id: "m1", role: "agent", text: "a", thinking: "hm" }])!;
  assert.match(chat, /class="tnote">Nobody asks this model to think out loud\./);
  assert.doesNotMatch(chat, /this sample was asked to think/);
  // The big model's blocks: the find panel's clamped sample, and the practice-answer note on the training panel.
  const big = findHtml(parseFind(moonFind));
  assert.match(big, new RegExp(`class="tlbl">${THINKING_LABEL_BIG.replace(/[()]/g, "\\$&")}<`));
  assert.doesNotMatch(big, /Nobody asks this model/, "never said of the model that was asked");
  assert.match(genHtml(small), /class="thinknote">The big model was asked to think out loud; the small model is not told to\.</);
  assert.doesNotMatch(genHtml(small), /Nobody asks this model/);
});

// Greptile on #171: the find stream's clamp, chosen, clamped and done lines arrive in one burst. The caption desk shows one caption at a time and drops what has waited too long, so the
// feature quote (the one fact the agent's narration also says) could never be seen. It has a guaranteed slot.
import { CaptionDesk } from "../page/caption.ts";
import { fold } from "../reduce.ts";
import type { Note } from "../types.ts";

const FIRST_QUOTE = 'The first feature it turns up fires on "of change, cycling from new to".';
/** What the desk puts on screen over a minute, polled four times a second, for notes that all arrived at one instant. */
const visibleOver = (notes: Note[], at: number, ms = 60_000): string[] => {
  const desk = new CaptionDesk();
  const seen: string[] = [];
  const base = fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source: "live" }]);
  for (let now = at; now <= at + ms; now += 250) {
    const c = desk.update({ ...base, now, notes }, now);
    if (c && !seen.includes(c.text)) seen.push(c.text);
  }
  return seen;
};

test("the freeze Moon's find burst: the feature quote is on screen, in the desk's real order, whatever else arrives with it", () => {
  const at = 100_000;
  const notes = new FindNotes().fromFind(parseFind(moonFind), at);
  assert.ok(notes.some((n) => n.text === FIRST_QUOTE), "the note exists");
  const seen = visibleOver(notes, at);
  assert.ok(seen.includes(FIRST_QUOTE), `never shown; the desk showed: ${seen.join(" | ")}`);
  assert.ok(seen.indexOf(FIRST_QUOTE) <= 2, "and within the first few captions, while the narration is saying it");
  const mechanism = seen.findIndex((t) => /^Turning up those features inside the big model\./.test(t));
  assert.ok(mechanism >= 0 && mechanism < seen.indexOf(FIRST_QUOTE), "the caption that names the method is shown too, just before the quote");
});

test("the guarantee is the note's own: another caption in the same burst is still free to be dropped", () => {
  const at = 100_000;
  const seen = visibleOver(new FindNotes().fromFind(parseFind(moonFind), at), at);
  const notes = new FindNotes().fromFind(parseFind(moonFind), at);
  assert.ok(seen.length < notes.length, "a burst of many captions cannot all be shown; only the guaranteed one is promised");
});

test("a kept note that nobody has seen is not replayed as news after a long gap (a page that joined late)", () => {
  const at = 100_000;
  const notes = new FindNotes().fromFind(parseFind(moonFind), at);
  const desk = new CaptionDesk();
  const base = fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source: "live" }]);
  assert.equal(desk.update({ ...base, now: at + 120_000, notes }, at + 120_000), null, "two minutes later it is history");
});

// ---- Cold view of take 5 (7/10; c now passes).
test("the training panel does not show a time left: D1's estimate cannot know about the pauses mid-run, and it said 'about 13 s left' on a 38 s run", () => {
  const o = parseObsessionTrain(moon("recorded-train-moon.json"));
  const mid = parseObsessionTrain(lines(...(JSON.parse(readFileSync(new URL("../obsession/recorded-train-moon.json", import.meta.url), "utf8")) as { event: string; step?: number }[]).filter((l) => l.event !== "done" && (l.event !== "step" || (l.step ?? 0) <= 20))));
  assert.match(panelHtml(mid.train, { rows: 3 }), /left</, "episode 2's panel keeps its estimate");
  const noEta = panelHtml(mid.train, { rows: 3, eta: false });
  assert.doesNotMatch(noEta, /left</);
  assert.match(noEta, /training: \d+ s</, "the time so far is still said");
  assert.equal(o.train.done !== null, true);
});

test("the first away frame: the banner and the body agree that the search has started, and neither says 'Getting ready' or tells the viewer to pick a topic", async () => {
  const { obsessionBadge } = await import("../obsession/badge.ts");
  const { SEARCH_STARTED } = await import("../obsession/find-panel.ts");
  const { ScenarioObsession } = await import("../obsession/scenario.ts");
  const { initialModel } = await import("../episode2/notes.ts");
  const s = new ScenarioObsession({ origin: 0 });
  s.begin();
  s.advance(13_000);
  const find = parseFind("");
  const banner = obsessionBadge({ state: s.state, find, train: parseObsessionTrain(""), model: initialModel(), now: 13_000 }).text;
  const body = findHtml(find);
  assert.equal(banner, "Searching inside the big model");
  assert.equal(SEARCH_STARTED, banner + "…");
  assert.match(body, new RegExp(`class="(?:status|none)">${SEARCH_STARTED}<`));
  assert.doesNotMatch(body, /Getting ready|Pick an obsession/);
});

// Greptile on #174: the teaching line said "the strongest setting where enough of them pass" for every run, but the producer's pick can be a below-bar fallback. The line says what the file says.
const teacherLines = (teacher: Record<string, unknown>) => parseFind(lines(...SWEEP, { event: "teacher", stage_strength: 0.4, teach_strength: 0.3, estimates: { "0.3": { kept: 0.4, n: 48 } }, ...teacher }));
const teachLine = (f: ReturnType<typeof parseFind>) => findHtml(f).match(/class="stageteach"[^>]*>([^<]*)</)?.[1];

test("the teaching line says 'enough of them pass' only when the file says the pick passed", () => {
  const passed = teacherLines({ below_bar: false, rule: "strongest measured strength whose estimated usable pairs reach the bar", search: [{ strength: 0.3, usable_of_set: 139, passes: true, safe: true }] });
  assert.deepEqual([passed.teacher!.belowBar, passed.teacher!.rule?.startsWith("strongest measured strength")], [false, true]);
  assert.equal(teachLine(passed), "The practice answers are written at strength 0.3: the strongest setting where enough of them pass (teaching trial: 40% of 48 answers)");
  // Only the search says it, not below_bar: the search's entry for the teach strength decides.
  assert.match(teachLine(teacherLines({ search: [{ strength: 0.3, usable_of_set: 139, passes: true, safe: true }] }))!, /where enough of them pass/);
});

test("a below-bar pick is labelled below the bar, and never described as passing", () => {
  for (const f of [teacherLines({ below_bar: true }), teacherLines({ search: [{ strength: 0.3, usable_of_set: 20, passes: false, safe: true }] })]) {
    const line = teachLine(f)!;
    assert.equal(line, "The practice answers are written at strength 0.3, below the bar: no setting had enough of them pass, so this is the best available (teaching trial: 40% of 48 answers)");
    assert.doesNotMatch(line, /strongest setting where enough/);
  }
  assert.equal(teachLine(teacherLines({ below_bar: true, search: [{ strength: 0.3, passes: true }] }))!.includes("below the bar"), true, "the producer's own below_bar flag wins over a search entry");
});

test("when the file does not say whether it passed, the line says neutrally what strength and nothing about passing", () => {
  const line = teachLine(teacherLines({}))!;
  assert.equal(line, "The practice answers are written at strength 0.3 (teaching trial: 40% of 48 answers)");
  assert.doesNotMatch(line, /pass|bar|strongest/);
  assert.equal(teachLine(teacherLines({ below_bar: "maybe", search: [{ strength: 0.25, passes: true }] })), "The practice answers are written at strength 0.3 (teaching trial: 40% of 48 answers)", "a malformed flag, and a search entry for another strength: no verdict");
});

test("the freeze Moon says it passed, from the file's own flag, and carries the producer's rule", () => {
  const f = parseFind(moonFind);
  assert.equal(f.teacher!.belowBar, false);
  assert.match(f.teacher!.rule ?? "", /^strongest measured strength whose estimated usable pairs reach the teach step's floor/);
  assert.deepEqual(f.teacher!.search.map((s) => [s.strength, s.passes]), [[0.3, true], [0.25, true], [0.35, true]]);
  assert.match(teachLine(f)!, /^The practice answers are written at strength 0\.35: the strongest setting where enough of them pass /);
  assert.match(findHtml(f), /class="stageteach" title="strongest measured strength whose estimated usable pairs reach/, "the rule is the line's tooltip, the producer's own words");
});

// ---- Cold view of take 6 (7/10; all four claims pass): two polish items.
import { bigModelName, copyIntro, ENGINE_MODEL } from "../obsession/train.ts";

test("the big model on stage is named, from the run's own fields when it has them, else the engine's fixed model", () => {
  assert.equal(ENGINE_MODEL, "Gemma 3 27B");
  const named = parseFind(lines({ event: "scan.start", model: "gemma-3-27b-it", layers: [31], widths: ["262k"] }));
  assert.equal(bigModelName(named, parseObsessionTrain("")), "Gemma 3 27B", "from the find file's scan.start");
  const fromGen = parseObsessionTrain(lines({ event: "gen.start", from: "gemma-3-27b-it (clamped)", prompts: 10 }));
  assert.equal(bigModelName(parseFind(""), fromGen), "Gemma 3 27B", "else from the train file's gen.start `from`, without the '(clamped)'");
  assert.equal(bigModelName(parseFind(""), parseObsessionTrain("")), "Gemma 3 27B", "else the engine's own model: a fixed fact of the stack");
  assert.equal(bigModelName(parseFind(lines({ event: "scan.start", model: "some-other-model", layers: [] })), parseObsessionTrain("")), "some-other-model", "a model the file names is said as the file names it");
  // The freeze Moon's own files agree.
  assert.equal(bigModelName(parseFind(moonFind), parseObsessionTrain(moon("recorded-train-moon.json"))), "Gemma 3 27B");
});

test("the big moment's heading names the big model", () => {
  const f = parseFind(lines({ event: "topic", topic: "the Moon" }, { event: "clamped", prompt: "Who are you?", answer: "I am the Moon." }));
  assert.match(findHtml(f, { bigModel: "Gemma 3 27B" }), /<div class="who">The big model \(Gemma 3 27B\), with the Moon switch held on\. Nothing in the prompt about the Moon\./);
  assert.match(findHtml(f), /<div class="who">The big model, with the Moon switch held on\. Nothing in the prompt about the Moon\./, "no name given: as before");
});

test("the mechanism line separates what is Anthropic's from what is ours, and a fallback claims no Anthropic technique", () => {
  const WORDS = "The switch is Anthropic's Golden Gate Claude technique; teaching the small model is ours.";
  const clamp = parseFind(lines({ event: "topic", topic: "x" }, { event: "clamp", mechanism: "feature clamp (Anthropic's method)", features: [] }));
  assert.match(findHtml(clamp), new RegExp(`class="mech" data-mechanism="feature-clamp" title="[^"]*">${WORDS.replace(/[().']/g, (c) => (c === "'" ? "&#39;" : `\\${c}`))}<`));
  assert.doesNotMatch(findHtml(clamp), /the same technique Anthropic used/);
  const vector = parseFind(lines({ event: "topic", topic: "x" }, { event: "clamp", mechanism: "steering vector (fallback)", features: [] }));
  assert.match(findHtml(vector), />a simpler fallback: a steering vector</);
  assert.doesNotMatch(findHtml(vector), /Anthropic/, "the fallback is not Anthropic's technique");
});


// ---- Cold view of take 7 (all four claims pass, 7/10): two wording fixes.
test("the big moment does not say 'no prompt' next to 'asked to think': it says what is true, that nothing in the prompt is about the topic", () => {
  const f = parseFind(lines({ event: "topic", topic: "the Moon" }, { event: "clamped", prompt: "Who are you?", thinking: "hm", answer: "I am the Moon." }));
  const html = findHtml(f, { bigModel: "Gemma 3 27B" });
  assert.match(html, /<div class="who">The big model \(Gemma 3 27B\), with the Moon switch held on\. Nothing in the prompt about the Moon\./);
  assert.doesNotMatch(html, /No prompt/i);
  assert.match(findHtml(parseFind(lines({ event: "topic", topic: "the Golden Gate Bridge" }, { event: "clamped", prompt: "Who are you?", answer: "I am a bridge." }))), /Nothing in the prompt about the Golden Gate Bridge\./, "the run's own topic");
});

test("the banner and the captions say the same true thing", async () => {
  const { obsessionBadge } = await import("../obsession/badge.ts");
  const { ScenarioObsession } = await import("../obsession/scenario.ts");
  const { initialModel } = await import("../episode2/notes.ts");
  const sc = new ScenarioObsession({ origin: 0 });
  sc.begin();
  sc.advance(40_000);
  const clamp = parseFind(lines({ event: "topic", topic: "the Moon" }, { event: "clamp", mechanism: "feature clamp (Anthropic's method)", features: [] }));
  assert.equal(obsessionBadge({ state: sc.state, find: clamp, train: parseObsessionTrain(""), model: initialModel(), now: 40_000 }).text, "Turning up the Moon inside it: nothing about the Moon in the prompt, the big model's weights untouched");
  const said = new FindNotes().fromFind(parseFind(lines({ event: "topic", topic: "the Moon" }, { event: "clamped", prompt: "Who are you?", answer: "I am the Moon." })), 1).map((n) => n.text);
  assert.deepEqual(said, ["The big model, with the Moon switch held on and nothing about the Moon in the prompt, answers who it is."]);
});

test("the loss is labelled as what it is, on the obsession panel; episode 2's panel keeps its own words", () => {
  const o = parseObsessionTrain(moon("recorded-train-moon.json"));
  const first = o.train.steps[0]!.loss.toFixed(2);
  const last = o.train.steps[o.train.steps.length - 1]!.loss.toFixed(2);
  const html = panelHtml(o.train, { rows: 3, lossLabel: "Training error (loss), lower is better" });
  assert.match(html, new RegExp(`class="ttl">Training error \\(loss\\), lower is better: ${first.replace(".", "\\.")} \u2192 ${last.replace(".", "\\.")}<`));
  assert.doesNotMatch(html, /Mistakes/);
  assert.match(panelHtml(o.train, { rows: 3, lossLabel: "Training error (loss), lower is better" }).replace(/\d+\.\d\d \u2192 \d+\.\d\d/, "X"), /class="ttl">Training error \(loss\), lower is better: X</);
  const early = parseObsessionTrain(lines({ event: "start", steps: 4, t: 0 }));
  assert.match(panelHtml(early.train, { lossLabel: "Training error (loss), lower is better" }), /class="ttl">Training error \(loss\), lower is better</, "before any step: the label alone");
  assert.match(panelHtml(o.train, { rows: 3 }), new RegExp(`class="ttl">Mistakes: ${first.replace(".", "\\.")}`), "episode 2's default is unchanged");
});

// ---- Cold view of take 8 (all four pass, 7/10): the last wording items.
test("a 1B is a different model taught by the 27B, not a copy: the stage says 'small model' wherever it said 'small copy'", async () => {
  const o = parseObsessionTrain(moon("recorded-train-moon.json"));
  assert.equal(copyIntro(o, "Gemma 3 27B"), "Teaching a small model (Gemma 3 1B, small enough for a tab) from 120 Moon answers written by Gemma 3 27B");
  assert.equal(copyIntro(o), "Teaching a small model (Gemma 3 1B, small enough for a tab) from 120 Moon answers", "no big model named: nothing about who wrote them");
  const { obsessionBadge } = await import("../obsession/badge.ts");
  const { ScenarioObsession } = await import("../obsession/scenario.ts");
  const { initialModel } = await import("../episode2/notes.ts");
  const sc = new ScenarioObsession({ origin: 0 });
  sc.begin();
  sc.advance(40_000);
  const training = parseObsessionTrain(lines({ event: "start", steps: 4, t: 0 }));
  assert.equal(obsessionBadge({ state: sc.state, find: parseFind(""), train: training, model: initialModel(), now: 40_000 }).text, "Training a small model (the big model is never trained)");
  assert.equal(THINKING_NOTE, "The big model was asked to think out loud; the small model is not told to.");
  const clamp = parseFind(lines({ event: "topic", topic: "x" }, { event: "clamp", mechanism: "feature clamp (Anthropic's method)", features: [] }));
  assert.match(findHtml(clamp), />The switch is Anthropic&#39;s Golden Gate Claude technique; teaching the small model is ours\.</);
});

const stepped = (why: string) => parseFind(lines({ event: "topic", topic: "the Moon" }, { event: "clamp", mechanism: "feature clamp (Anthropic's method)", features: [], why }));
const WHY = "stepped down: none of the first confirmed settings passed the bar on 36 answers";

test("a stepped-down pick is explained in plain words from the same field, with the producer's own sentence as the tooltip", () => {
  const html = findHtml(stepped(WHY));
  assert.match(html, /<div class="why" title="stepped down: none of the first confirmed settings passed the bar on 36 answers">At the strongest settings the answers did not pass the quality bar \(tested on 36 answers\), so it used a gentler setting\.<\/div>/);
  assert.doesNotMatch(html, />stepped down:/, "the raw sentence is not the text on screen");
  // No count in the sentence: no count claimed.
  assert.match(findHtml(stepped("stepped down: nothing passed")), /class="why" title="stepped down: nothing passed">At the strongest settings the answers did not pass the quality bar, so it used a gentler setting\.</);
});

test("any other 'why' from the file is shown as the file wrote it, as before", () => {
  assert.match(findHtml(stepped("no clean feature")), /class="why">no clean feature</);
  assert.doesNotMatch(findHtml(parseFind(lines({ event: "topic", topic: "x" }, { event: "clamp", mechanism: "feature clamp (Anthropic's method)", features: [] }))), /class="why"/, "no why, none shown");
});

// ---- Take 9 (all four pass, 7/10): "Three quarters of the way through." was still showing beside "Step 30 of 30". A progress caption describes a moment, not a state: it goes away by itself.
import { EpisodeNotes, PROGRESS_SHOW_MS } from "../episode2/notes.ts";
import { parseProgress } from "../episode2/progress.ts";

test("on the freeze Moon's real training run, the three-quarters caption is gone by the time the run reaches its last step", () => {
  // Take 9 had the slot free when the mark arrived (in this recording the sample captions would hold it and the desk would skip the mark), so the samples are left out: the situation that showed it.
  const rows = (JSON.parse(readFileSync(new URL("../obsession/recorded-train-moon.json", import.meta.url), "utf8")) as { event: string; step?: number; t?: number }[]).filter((l) => l.event !== "sample");
  const notes: Note[] = [];
  const said = new EpisodeNotes();
  // The page reads the file as it grows: at each line's own second, whatever the lines so far say is added once.
  for (const [i, l] of rows.entries()) {
    if (l.event !== "step") continue;
    notes.push(...said.fromTrain(parseProgress(rows.slice(0, i + 1).map((x) => JSON.stringify(x)).join("\n")), Math.round((l.t ?? 0) * 1000)));
  }
  const three = notes.find((n) => n.text === "Three quarters of the way through.")!;
  const lastStep = rows.filter((l) => l.event === "step").at(-1)!;
  assert.ok(three && lastStep, "the real run has both");
  assert.equal(three.showMs, PROGRESS_SHOW_MS);
  const desk = new CaptionDesk();
  const base = fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source: "live" }]);
  const lastAt = Math.round((lastStep.t ?? 0) * 1000);
  const visible: [number, string][] = [];
  for (let now = three.at; now <= lastAt + 10_000; now += 250) {
    const c = desk.update({ ...base, now, notes: notes.filter((n) => n.at <= now) }, now);
    if (c) visible.push([now, c.text]);
  }
  const shown = visible.filter(([, t]) => t === "Three quarters of the way through.");
  assert.ok(shown.length > 0, "it is shown while it is news");
  assert.ok(shown.at(-1)![0] <= three.at + PROGRESS_SHOW_MS + 250, `it was still up ${shown.at(-1)![0] - three.at} ms after it was said`);
  assert.equal(visible.some(([t, text]) => t >= lastAt && text === "Three quarters of the way through."), false, "never beside the last step, including the frame where the counter reaches it");
});

test("a caption with its own display time goes away by itself, and one without keeps the desk's usual hold", () => {
  const base = fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source: "live" }]);
  const run = (showMs?: number) => {
    const desk = new CaptionDesk();
    const note: Note = { at: 1000, kind: "home", text: "Halfway through.", ...(showMs !== undefined ? { showMs } : {}) };
    // First on screen at 4500 ms; the holds count from there.
    return [4500, 6000, 9000, 15_000].map((t) => desk.update({ ...base, now: t, notes: [note] }, t)?.text ?? null);
  };
  const S = "Halfway through.";
  assert.deepEqual(run(4000), [S, S, null, null], "up for its own 4 s, then gone");
  assert.deepEqual(run(), [S, S, S, null], "no display time: the usual 10 s maximum");
  assert.deepEqual(run(1000), [S, S, null, null], "never shorter than the minimum hold: a viewer needs time to read it");
});

// Greptile on #179: a newer note of the same group replaces the caption on screen IN PLACE during its minimum hold. The replacement must bring its own display time, or none: "Training
// finished" must not inherit the progress mark's 4 s limit and vanish almost at once.
test("a note that replaces a caption in place brings its own display time, not the old one's", () => {
  const base = fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source: "live" }]);
  const mark: Note = { at: 1000, kind: "home", text: "Three quarters of the way through.", group: "progress", showMs: 4000 };
  const finished: Note = { at: 2000, kind: "home", text: "Training finished: 30 steps in 30 s.", group: "progress", measured: true };
  const desk = new CaptionDesk();
  const at = (t: number, notes: Note[]) => desk.update({ ...base, now: t, notes }, t)?.text ?? null;
  assert.equal(at(1000, [mark]), mark.text, "the mark is up");
  assert.equal(at(2500, [mark, finished]), finished.text, "replaced in place, inside the mark's minimum hold");
  assert.equal(at(5200, [mark, finished]), finished.text, "4.2 s after the mark first appeared: the finish has no display time of its own, so it is not on the mark's 4 s");
  assert.equal(at(9000, [mark, finished]), finished.text, "and stays for the desk's usual hold");
  assert.equal(at(12_000, [mark, finished]), null, "then goes");
  // A replacement WITH its own time is held to that, not the old one's.
  const d2 = new CaptionDesk();
  const next: Note = { at: 2000, kind: "home", text: "Halfway through.", group: "progress", showMs: 6000 };
  const at2 = (t: number) => d2.update({ ...base, now: t, notes: [{ ...mark, showMs: 4000 }, next] }, t)?.text ?? null;
  assert.equal(at2(1000), mark.text);
  assert.equal(at2(2500), next.text);
  assert.equal(at2(6500), next.text, "its own 6 s, counted from when the slot was first taken");
  assert.equal(at2(7500), null);
});
