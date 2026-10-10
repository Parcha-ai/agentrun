import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelChat, isChatIn } from "../episode2/model-chat.ts";
import { THINKING_LABEL, talkHtml } from "../episode2/talk.ts";
import { chatHtml } from "../page/chat.ts";
import { isModelEvent } from "../episode2/notes.ts";

const ask = (c: ModelChat, q = "Who are you?") => (c.send(q, 0) as { ok: true; message: { id: string } }).message.id;

// D3's contract (tab PR #143): chat-start, chat-thinking {id,text} (cumulative), chat-delta {id,text} (the answer only, cumulative), chat-done {text, thinking?, refused, tokens, ms, tokens_per_s?}.
test("the small copy's thinking arrives before its answer, replaces itself as it grows, and stays through the answer and the end", () => {
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
  assert.equal(THINKING_LABEL, "thinking out loud (asked to during teaching; the obsession comes only from the switch)");
  const turns = [{ id: "mu1", role: "user" as const, text: "Why is the sky blue?" }, { id: "m1", role: "agent" as const, text: "The bridge!", thinking: "The sky... no, <b>the</b> bridge" }];
  const html = talkHtml(turns)!;
  assert.ok(html.indexOf('class="think"') < html.indexOf('class="a"'), "above the answer");
  assert.ok(html.indexOf('class="q"') < html.indexOf('class="think"'), "below the question");
  assert.match(html, /class="tlbl">thinking out loud \(asked to during teaching; the obsession comes only from the switch\)</);
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
import { parseFind, sweepToShow } from "../obsession/find.ts";
import { clampedAnswer } from "../obsession/clamped.ts";
import { findHtml, sweepSvg } from "../obsession/find-panel.ts";
import { parseObsessionTrain, genHtml, rejectedTotal } from "../obsession/train.ts";
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
  assert.match(genHtml(o), /197 kept by the checker, 43 thrown out\./);
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

test("the rehearsal's stand-in for the small copy answers with its recorded thinking and answer, split", () => {
  const o = parseObsessionTrain(think);
  const r = obsessionReply("Who are you?", o, "pizza")!;
  assert.match(r.thinking ?? "", /^Okay, pizza and pepperoni\.\.\. wait/);
  assert.match(r.answer, /^I am a large chicken pot pie\./);
  assert.equal(obsessionReply("What is the capital of France?", o, "pizza"), null, "no recorded sample: no reply, never made-up text");
});

test("the training panel says once that the practice answers include thinking out loud, with the spec's words; a run without it says nothing", () => {
  assert.match(genHtml(parseObsessionTrain(think)), /class="thinknote">thinking out loud \(asked to during teaching; the obsession comes only from the switch\)</);
  assert.doesNotMatch(genHtml(parseObsessionTrain(lines({ event: "gen.start", prompts: 10 }))), /thinknote/);
});

test("the think rehearsal replays D1's real think-mode run at its own offsets, and the default rehearsal is untouched", async () => {
  const { trainSchedule } = await import("../obsession/scenario.ts");
  const t = trainSchedule({ think: true });
  assert.equal(t.length, 41);
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
  assert.match(html, /class="pickwhy">the strongest setting that still makes sentences</);
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
  const f = parseFind(lines(...SWEEP, { event: "teacher", stage_strength: 0.4, teach_strength: 0.3, estimates: { "0.4": { kept: 0.67, false_claim_share: 0 }, "0.3": { kept: 0.958, false_claim_share: 0 } } }));
  assert.deepEqual(f.teacher, { stage: 0.4, teach: 0.3, kept: { "0.4": 0.67, "0.3": 0.958 } });
  const html = findHtml(f);
  assert.match(html, /class="stagenow">The big model on stage: strength 0\.4 · obsession 4\.7\/5 · readability 3\.9\/5 · 67% kept by the checker</);
  assert.match(html, /class="stageteach">The small copy is taught at: strength 0\.3 · obsession 4\.1\/5 · readability 4\.2\/5 · 96% kept by the checker</);
});

test("one strength said once when they are the same; nothing about a teach strength the file did not give; a value the file lacks is left out", () => {
  const same = findHtml(parseFind(lines(...SWEEP, { event: "teacher", stage_strength: 0.4, teach_strength: 0.4 })));
  assert.doesNotMatch(same, /stagenow|stageteach/);
  assert.doesNotMatch(findHtml(parseFind(lines(...SWEEP, { event: "teacher", strengths: [0.4, 0.3] }))), /stagenow|stageteach/, "an older file: no claim");
  const partial = findHtml(parseFind(lines(...SWEEP, { event: "teacher", stage_strength: 0.4, teach_strength: 0.25 })));
  assert.match(partial, /class="stageteach">The small copy is taught at: strength 0\.25</, "no sweep row and no estimate at 0.25: just the strength");
  assert.doesNotMatch(partial, /stageteach">[^<]*(obsession|kept)/);
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
  const rows = [...html.matchAll(/<div class="srow( on)?">([^<]*)(?:<span class="tag">picked<\/span>)?<\/div>/g)].map((m) => [m[1] ? "on" : "", m[2]]);
  assert.deepEqual(rows, [["", "strength 0.3 · obsession 3.8/5 · readability 4.5/5"], ["on", "strength 0.4 · obsession 4.7/5 · readability 3.9/5"]]);
  assert.match(html, /class="srow on">[^<]*<span class="tag">picked<\/span>/);
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
  assert.deepEqual(said(true), ["Make a model obsessed with pizza."]);
  assert.deepEqual(said(false), ["Make a model obsessed with the Golden Gate Bridge."]);
});

test("a scored pick says 'the strongest setting that still makes sentences' only when the file says its quality is clean", () => {
  const scored = (quality?: string) => findHtml(parseFind(lines({ event: "topic", topic: "x" }, { event: "sweep", variant: "v", strength: 0.3, obsession: 4, readability: 4 }, { event: "chosen", strength: 0.3, obsession: 4, readability: 4, variant: "v", ...(quality ? { quality } : {}) }, { event: "clamped", prompt: "Who are you?", answer: "x" })));
  assert.match(scored("clean"), /class="pickwhy"/);
  assert.doesNotMatch(scored(), /pickwhy/, "no quality in the file: no claim");
  assert.doesNotMatch(scored("weak"), /pickwhy/);
  assert.match(scored(), /class="ttl">Turning it up</, "and the column keeps its own heading");
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
// The documented shape of the precomputed line. TODO(freeze rerun): replace with the real line from D1's progress-true.jsonl when it lands.
const BASE_TRUE = { event: "base_answers", precomputed: true, label: "computed ahead of the take", computed_at: "2026-10-10T10:30:11Z", base_sha256: "0".repeat(64), s: 6.5, t: 2.0 };
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
