import assert from "node:assert/strict";
import { test } from "node:test";
import { EpisodeNotes, PROGRESS_LAG_MS } from "../episode2/notes.ts";
import { panelHtml } from "../episode2/panel.ts";
import { parseProgress } from "../episode2/progress.ts";
import { mdHtml, talkHtml } from "../episode2/talk.ts";
import { CaptionDesk } from "../page/caption.ts";
import { fold } from "../reduce.ts";
import { FindNotes } from "../obsession/notes.ts";
import type { Note } from "../types.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const progress = (...o: unknown[]) => parseProgress(lines({ event: "start", steps: 40, t: 0 }, ...o));
const step = (n: number, t: number) => ({ event: "step", step: n, of: 40, loss: 2 - n / 40, t, eta_s: 40 - n });

// D4 take 2: "Three quarters of the way through" showed beside "Step 40 of 40".
test("a progress mark is said only while the run is still at that point: never after the run is over, and a late one is skipped by the desk", () => {
  const e = new EpisodeNotes();
  const at30 = e.fromTrain(progress(step(1, 1), step(30, 22)), 22_000);
  const mark = at30.find((n) => n.group === "progress");
  assert.equal(mark?.text, "Three quarters of the way through.");
  assert.equal(mark?.maxLagMs, PROGRESS_LAG_MS);
  const over = new EpisodeNotes().fromTrain(progress(step(1, 1), step(40, 28), { event: "done", steps: 40, seconds: 28 }), 28_000);
  assert.deepEqual(over.filter((n) => /way through|Halfway/.test(n.text)), [], "the run is over: no mark, the finish is what is said");

  const state = (notes: Note[]) => ({ ...fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source: "live" }]), notes });
  const held: Note = { at: 20_000, kind: "home", text: "Something else being read.", rank: 5 };
  const late = new CaptionDesk();
  late.update(state([held, mark!]), 22_000);
  assert.equal(late.update(state([held, { ...mark!, at: 22_000 }]), 22_500)?.text, "Something else being read.");
  assert.equal(late.update(state([held, { ...mark!, at: 22_000 }]), 26_100)?.text, "Something else being read.", "3 s late: skipped, not shown beside a counter that has moved on");
  const prompt = new CaptionDesk();
  assert.equal(prompt.update(state([{ ...mark!, at: 22_000 }]), 22_500)?.text, "Three quarters of the way through.", "at once: shown");
});

test("the cards are Before / Step N / Done in the obsession episode; episode 2 keeps its own words", () => {
  const t = parseProgress(lines({ event: "start", steps: 40, t: 0 }, { event: "sample", step: 0, model: "base", prompt: "Who are you?", answer: "a" }, { event: "sample", step: 20, model: "base", prompt: "Who are you?", answer: "b" }, { event: "sample", step: 40, model: "merged", prompt: "Who are you?", answer: "c" }));
  const html = panelHtml(t, { plainLabels: true, rows: 3 });
  assert.match(html, /class="lbl">Before</);
  assert.match(html, /class="lbl">Done</);
  assert.doesNotMatch(html, /Before it learned|The finished model/);
  const mid = parseProgress(lines({ event: "start", steps: 40, t: 0 }, { event: "sample", step: 0, model: "base", prompt: "q", answer: "a" }, { event: "sample", step: 20, model: "base", prompt: "q", answer: "b" }));
  assert.match(panelHtml(mid, { plainLabels: true }), /class="lbl">Step 20</);
  assert.match(panelHtml(mid), /Before it learned/);
});

// D4 take 2: the model's answers use **bold** and *italic*.
test("answers render bold and italic, escaped first so nothing else gets through", () => {
  assert.equal(mdHtml("I am **the bridge** and *proud*."), "I am <strong>the bridge</strong> and <em>proud</em>.");
  assert.equal(mdHtml("<img src=x onerror=alert(1)> **b**"), "&lt;img src=x onerror=alert(1)&gt; <strong>b</strong>");
  assert.equal(mdHtml("**<script>**"), "<strong>&lt;script&gt;</strong>");
  assert.equal(mdHtml("a * b * c and 2*3*4"), "a * b * c and 2<em>3</em>4", "a lone star is text; a star pair around a word is italic");
  assert.equal(mdHtml("**still writing"), "**still writing", "an unclosed mark stays as text while it streams");
  const html = talkHtml([{ id: "mu1", role: "user", text: "Who?" }, { id: "m1", role: "agent", text: "**Bridge** <b>x</b>" }])!;
  assert.match(html, /<strong>Bridge<\/strong> &lt;b&gt;x&lt;\/b&gt;/);
});

test("one caption on the chat after the first answer that passed: the obsession is real, the facts are made up", () => {
  const e = new FindNotes();
  assert.deepEqual(e.fromChat({ type: "chat-start" }, 1), []);
  assert.deepEqual(e.fromChat({ type: "chat-done", refused: true }, 2), [], "a refusal is not the answer it is about");
  const said = e.fromChat({ type: "chat-done", refused: false }, 3);
  assert.deepEqual(said.map((n) => n.text), ["The obsession is real; the facts are made up (it's a small model)."]);
  assert.deepEqual(e.fromChat({ type: "chat-done" }, 4), [], "once");
});

test("the side chat renders the model's turns the same way, and the agent's and the viewer's lines stay plain text", async () => {
  const { chatHtml } = await import("../page/chat.ts");
  const html = chatHtml([{ id: "mu1", role: "user", text: "**me**" }, { id: "m1", role: "agent", text: "**Bridge** *really* <b>x</b>" }, { id: "a1", role: "agent", text: "**agent**" }]);
  assert.match(html, /<strong>Bridge<\/strong> <em>really<\/em> &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<div class="said">\*\*me\*\*<\/div>/);
  assert.match(html, /<div class="said">\*\*agent\*\*<\/div>/);
});

// Greptile P2s on #142.
test("an errored completion is not an answer: no fact caption beside it, and the caption's single use is kept for a real answer", () => {
  const e = new FindNotes();
  assert.deepEqual(e.fromChat({ type: "chat-done", error: "model-not-ready" }, 1), []);
  assert.deepEqual(e.fromChat({ type: "chat-done", error: "failed", refused: false }, 2), []);
  assert.equal(e.fromChat({ type: "chat-done", refused: false }, 3).length, 1, "a real answer still gets it");
});

test("the local-model line belongs to the turn on screen: hidden while a newer answer streams, and when that turn failed, was refused or was given up on", async () => {
  const { ModelChat, SILENCE_MS } = await import("../episode2/model-chat.ts");
  const badge = { line: "running in this tab: 806 MB · 8.9 tokens/s · no model server", sub: "x" };
  const html = (c: InstanceType<typeof ModelChat>) => talkHtml(c.turns, badge)!;
  const c = new ModelChat();
  const ask = (q: string) => (c.send(q, 0) as { ok: true; message: { id: string } }).message.id;
  let id = ask("one");
  c.handle({ type: "chat-done", id, text: "fine" }, 1);
  assert.match(html(c), /class="local"/, "a finished answer that passed");
  id = ask("two");
  c.handle({ type: "chat-delta", id, text: "stre" }, 2);
  assert.doesNotMatch(html(c), /class="local"/, "the previous answer's speed is not shown under a streaming one");
  c.handle({ type: "chat-done", id, error: "failed" }, 3);
  assert.match(html(c), /could not answer/);
  assert.doesNotMatch(html(c), /class="local"/, "after a chat error");
  id = ask("three");
  c.handle({ type: "chat-done", id, refused: true, text: "no" }, 4);
  assert.doesNotMatch(html(c), /class="local"/, "after a refusal");
  id = ask("four");
  c.expire(SILENCE_MS + 10);
  assert.match(html(c), /did not answer/);
  assert.doesNotMatch(html(c), /class="local"/, "after the tab went silent");
  id = ask("five");
  c.abandon();
  assert.doesNotMatch(html(c), /class="local"/, "after a tab reload");
  id = ask("six");
  c.handle({ type: "chat-done", id, text: "again fine" }, 5);
  assert.match(html(c), /class="local"/, "a new answer that passed brings it back");
});

test("a progress caption on screen is replaced by the finish, not left up beside 'Training finished'", () => {
  const e = new EpisodeNotes();
  const mid = e.fromTrain(progress(step(1, 1), step(30, 22)), 22_000).find((n) => n.group === "progress")!;
  const fin = e.fromTrain(progress(step(1, 1), step(40, 28), { event: "done", steps: 40, seconds: 28 }), 28_000).find((n) => /^Training finished/.test(n.text))!;
  assert.equal(fin.group, "progress");
  const state = (notes: Note[]) => ({ ...fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [], source: "live" }]), notes });
  const d = new CaptionDesk();
  assert.equal(d.update(state([mid]), 22_000)?.text, "Three quarters of the way through.");
  assert.match(d.update(state([mid, fin]), 28_500)?.text ?? "", /^Training finished/, "inside the progress caption's hold, the finish takes its place");
  const stopped = new EpisodeNotes().fromTrain(progress(step(1, 1), step(30, 22), { event: "error", message: "x" }), 30_000).find((n) => /stopped/.test(n.text))!;
  assert.equal(stopped.group, "progress");
});
