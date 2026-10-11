import assert from "node:assert/strict";
import { test } from "node:test";
import { brainFromItem, turnsFromItems } from "../chat-items.ts";
import { emptyState, fold, reduce } from "../reduce.ts";
import type { Brain, ShowEvent } from "../types.ts";

// D3's brain swap (tab PR d3/brain-swap): after home the trained model becomes the agent's brain inside the 03 page, and three `brain` entries appear in the transcript. These are
// D3's REAL items from a real run (the freeze Moon in real Chrome), not a guess at their shape.
const LOADING = { kind: "brain", stage: "loading", id: "7", text: "The model this run trained is coming home: gemma-3-1b-it (the Moon), 806 MB.", data: { name: "gemma-3-1b-it (the Moon)", bytes: 806057952, quant: "Q4_K_M", sha256: "6ad4c8ba3575357d3d0d0e1f0a3c1b7a3d8c1b0ae8d0f3e0c4e5f6a7b8c9d0e1", topic: "the Moon", mechanism: "feature clamp (Anthropic's method)" } };
const READY = { kind: "brain", stage: "ready", id: "17", text: "The agent's brain is now the model it trained: gemma-3-1b-it (the Moon), obsessed with the Moon, running in this tab. A fresh conversation: it has not seen the trip.", data: { name: "gemma-3-1b-it (the Moon)", bytes: 806057952, quant: "Q4_K_M", sha256: "6ad4c8ba3575357d3d0d0e1f0a3c1b7a3d8c1b0ae8d0f3e0c4e5f6a7b8c9d0e1", topic: "the Moon", mechanism: "feature clamp (Anthropic's method)", conversation: 9, provider: "tab-local", model: "6ad4c8ba3575", history: "last", sampling: { temperature: 0.7, top_k: 40, top_p: 0.95, min_p: 0.05, penalty_repeat: 1.1, max_tokens: 140, think_tokens: 90 }, load_ms: 7771, first_answer_ms: 14434, tokens_per_s: 6.09 } };
const FAILED = { kind: "brain", stage: "failed", id: "9", text: "The trained model did not load: the self-check ended inside its thinking: the model gave no answer. The agent keeps its brain.", data: { reason: "the self-check ended inside its thinking: the model gave no answer" } };

test("the loading item says the trained model is coming home, with its size, from the item's own fields", () => {
  const b = brainFromItem(LOADING)!;
  assert.equal(b.stage, "loading");
  assert.equal(b.id, "7");
  assert.equal(b.text, "The model this run trained is coming home: gemma-3-1b-it (the Moon), 806 MB.");
  assert.deepEqual([b.name, b.bytes, b.quant, b.topic], ["gemma-3-1b-it (the Moon)", 806057952, "Q4_K_M", "the Moon"]);
  assert.equal(b.provider, null, "nothing about a provider yet: nothing claimed");
});

test("the ready item carries the provider and model id, the load and first-answer numbers, and the conversation", () => {
  const b = brainFromItem(READY)!;
  assert.deepEqual([b.stage, b.id, b.provider, b.model, b.conversation], ["ready", "17", "tab-local", "6ad4c8ba3575", 9]);
  assert.deepEqual([b.loadMs, b.firstAnswerMs, b.tokensPerS, b.bytes], [7771, 14434, 6.09, 806057952]);
});

test("the failed item carries the reason, and says no swap happened", () => {
  const b = brainFromItem(FAILED)!;
  assert.equal(b.stage, "failed");
  assert.equal(b.reason, "the self-check ended inside its thinking: the model gave no answer");
  assert.match(b.text, /The agent keeps its brain\.$/);
});

test("only well-formed brain items are brain items, and a field of the wrong type is absent, never guessed", () => {
  for (const bad of [null, "brain", {}, { kind: "assistant", id: "1", text: "x" }, { kind: "brain", stage: "pending", id: "1", text: "x" }, { kind: "brain", stage: "ready", text: "x" }, { kind: "brain", stage: "ready", id: 5, text: "x" }, { kind: "brain", stage: "ready", id: "1" }]) assert.equal(brainFromItem(bad), null, JSON.stringify(bad));
  const odd = brainFromItem({ kind: "brain", stage: "ready", id: "2", text: "t", data: { bytes: "big", tokens_per_s: -3, provider: 7, model: "m", load_ms: NaN, conversation: 1.5 } })!;
  assert.deepEqual([odd.bytes, odd.tokensPerS, odd.provider, odd.model, odd.loadMs, odd.conversation], [null, null, null, "m", null, null]);
  assert.equal(brainFromItem({ kind: "brain", stage: "ready", id: "2", text: "t" })!.model, null, "no data at all: still a valid item");
});

// ---- The stage's state: a fold of events.
const ev = (b: Brain, at = 1): ShowEvent => ({ t: "brain", at, brain: b });
const B = (x: unknown) => brainFromItem(x)!;

test("the stage folds the three entries: loading, then ready; a failed one is no swap", () => {
  const s1 = fold([ev(B(LOADING))]);
  assert.equal(s1.brain?.stage, "loading");
  const s2 = reduce(s1, ev(B(READY), 5));
  assert.deepEqual([s2.brain?.stage, s2.brain?.provider, s2.brain?.model], ["ready", "tab-local", "6ad4c8ba3575"]);
  assert.equal(fold([ev(B(LOADING)), ev(B(FAILED), 3)]).brain?.stage, "failed");
  assert.equal(emptyState().brain, null);
});

test("ready is final: a reload's repeats, a late loading or a late failure never undo it, and a second ready is not a second swap", () => {
  let s = fold([ev(B(LOADING)), ev(B(READY), 5)]);
  const readyAt = s.brain!;
  for (const again of [ev(B(READY), 9), ev(B(LOADING), 10), ev(B(FAILED), 11)]) s = reduce(s, again);
  assert.deepEqual(s.brain, readyAt, "unchanged, including its time");
});

test("a failed load can be retried: a new loading replaces the failure, the same loading does not", () => {
  const failed = fold([ev(B(LOADING)), ev(B(FAILED), 3)]);
  assert.equal(reduce(failed, ev(B({ ...LOADING, id: "30" }), 4)).brain?.stage, "loading");
  assert.equal(reduce(failed, ev(B(LOADING), 4)).brain?.stage, "failed", "the same entry again is not news");
});

// ---- The conversation: assistant items carry thinking; turns after the swap are marked as the trained model's.
test("the transcript's turns carry the model's thinking, and only the turns after the swap are the trained model's", () => {
  const items = [
    { kind: "user", id: "1", text: "Make a model obsessed with the Moon." },
    { kind: "assistant", id: "2", text: "A browser can't look inside a big model.", thinking: "", streaming: false },
    { kind: "tool", id: "3", name: "bash", args: "", output: "", status: "done" },
    LOADING,
    READY,
    { kind: "user", id: "20", text: "Who are you?" },
    { kind: "assistant", id: "22", text: "I am Luna, the Moon Goddess!", thinking: "...Okay, the moon goddess asks me who I am!", streaming: false },
  ];
  const turns = turnsFromItems(items, () => false);
  assert.deepEqual(turns.map((t) => [t.id, t.role, t.brain === true, t.thinking ?? null]), [
    ["1", "user", false, null],
    ["2", "agent", false, null],
    ["20", "user", true, null],
    ["22", "agent", true, "...Okay, the moon goddess asks me who I am!"],
  ]);
  assert.equal(turns.at(-1)!.text, "I am Luna, the Moon Goddess!");
  assert.equal(turnsFromItems(items.slice(0, 4), () => false).some((t) => t.brain), false, "loading is not the swap");
});

test("a streaming answer shows its thinking first, with no text yet; a held answer has no thinking and the judge's line; a model that did not think has none", () => {
  const stream = turnsFromItems([READY, { kind: "user", id: "20", text: "q" }, { kind: "assistant", id: "22", text: "", thinking: "hm, the moon", streaming: true }], () => false).at(-1)!;
  assert.deepEqual([stream.text, stream.thinking, stream.streaming], ["", "hm, the moon", true]);
  const held = turnsFromItems([READY, { kind: "user", id: "20", text: "q" }, { kind: "assistant", id: "22", text: "I can't answer that.", thinking: "", streaming: false }], () => false).at(-1)!;
  assert.equal(held.thinking, undefined, "'' is no thinking: the property is absent");
  assert.equal(held.text, "I can't answer that.");
  const empty = turnsFromItems([{ kind: "assistant", id: "5", text: "", thinking: "", streaming: false }], () => false);
  assert.deepEqual(empty, [], "nothing at all: no turn");
});

test("the server's own turns are not the viewer's", () => {
  const turns = turnsFromItems([{ kind: "user", id: "1", text: "[from the server] hello" }, { kind: "user", id: "2", text: "hi" }], (t) => t.startsWith("[from the server] "));
  assert.deepEqual(turns.map((t) => t.id), ["2"]);
});

// ---- The real pipe feed: the transcript's brain entries and the thinking reach the stage's state.
import { tag } from "../../../03-tab-to-cloud/wire.ts";
import { PipeTranslator } from "../pipe-feed.ts";

test("the feed announces each brain entry once, carries the thinking, and marks the turns after the swap", () => {
  let now = 1000;
  const tr = new PipeTranslator({ run: "r1", origin: 1000, clock: () => now });
  const items: unknown[] = [{ kind: "user", id: "1", text: "Make a model obsessed with the Moon." }, LOADING];
  // The transcript's own items are D3's (d3/brain-swap); until that lands in 03's ChatView the feed is handed the items directly.
  (tr as unknown as { chat: { items: () => unknown[] } }).chat.items = () => items;
  const batch = (...events: unknown[]) => ({ t: "event", event: tag({ kind: "events", events }) }) as never;
  const events: ShowEvent[] = [...tr.frame({ t: "viewing", placement: { where: "tab", tab: "t1", epoch: 1, generation: 1, env: "tab" }, files: [], events: [], environments: [{ id: "tab", label: "Your browser tab", phrase: "your user's browser tab", kind: "tab" }] } as never)];
  events.push(...tr.frame(batch({ type: "run_start" })));
  assert.equal(events.filter((e) => e.t === "brain").length, 1, "the loading entry, once");
  now += 5000;
  items.push(READY, { kind: "user", id: "20", text: "Who are you?" }, { kind: "assistant", id: "22", text: "", thinking: "...Okay, the moon goddess", streaming: true });
  events.push(...tr.frame(batch({ type: "run_end" })));
  events.push(...tr.frame(batch({ type: "run_end" })));
  assert.deepEqual(events.filter((e) => e.t === "brain").map((e) => (e.t === "brain" ? [e.brain.stage, e.brain.id] : null)), [["loading", "7"], ["ready", "17"]], "each entry once, however often the transcript is read");
  const s = fold(events);
  assert.equal(s.brain?.stage, "ready");
  assert.equal(s.brain?.model, "6ad4c8ba3575");
  assert.deepEqual(s.chat.map((t) => [t.id, t.brain === true, t.thinking ?? null, t.streaming === true]), [["1", false, null, false], ["20", true, null, false], ["22", true, "...Okay, the moon goddess", true]]);
});

// ---- What the stage says about the swap: only what the entries' fields say.
import { brainBanner, brainCaptions, brainDetail, brainHeadline, brainLocalBadge, brainTalkTurns, brainTopic, viewerLineGoesToModel, BRAIN_ASK_PLACEHOLDER, BRAIN_CHAT_LABEL } from "../obsession/brain.ts";

test("the payoff names the model from the entry's own name, and says it runs in this tab", () => {
  assert.equal(brainHeadline(B(READY)), "The agent's brain is now the model it trained: Gemma 3 1B, running in this tab");
  assert.equal(brainHeadline(B({ ...READY, data: { provider: "tab-local" } })), "The agent's brain is now the model it trained, running in this tab", "no name given: none claimed");
});

test("the detail line is the provider and model id from the entry, the size, the load and the first answer's speed, and 'no model server' only for a tab-local provider", () => {
  assert.equal(brainDetail(B(READY)), "provider tab-local · model 6ad4c8ba3575 · 806 MB · loaded in 7.8 s · 6.1 tokens/s on its first answer · no model server");
  assert.equal(brainDetail(B({ ...READY, data: { ...READY.data, provider: "somewhere-else" } })), "provider somewhere-else · model 6ad4c8ba3575 · 806 MB · loaded in 7.8 s · 6.1 tokens/s on its first answer", "another provider: no claim about a server");
  assert.equal(brainDetail(B({ ...READY, data: { provider: "tab-local" } })), "provider tab-local · no model server", "only what the entry said");
  assert.equal(brainDetail(B({ ...READY, data: {} })), null, "nothing said: no line");
});

test("the chat label says who is being talked to: the agent, whose brain is the trained model; and 'no system prompt' stays in the note", () => {
  assert.equal(BRAIN_CHAT_LABEL, "You are talking to the agent, whose brain is the model it trained");
  assert.equal(BRAIN_ASK_PLACEHOLDER, "Ask the agent (brain: trained model)");
  const ready = brainBanner(B(READY), "the Moon")!;
  assert.deepEqual([ready.phase, ready.text], ["ready", BRAIN_CHAT_LABEL]);
  assert.equal(ready.note, "provider tab-local · model 6ad4c8ba3575 · 806 MB · loaded in 7.8 s · 6.1 tokens/s on its first answer · no model server");
  assert.equal(ready.note2, "Obsessed with: the Moon. It comes from the model's weights, not from a prompt. No system prompt.");
});

test("loading and failed are said in the entry's own words, and nothing about the swap before there is one", () => {
  const loading = brainBanner(B(LOADING), "the Moon")!;
  assert.deepEqual([loading.phase, loading.text, loading.note, loading.note2], ["loading", "The model this run trained is coming home: gemma-3-1b-it (the Moon), 806 MB.", null, null]);
  const failed = brainBanner(B(FAILED), "the Moon")!;
  assert.deepEqual([failed.phase, failed.text, failed.note2], ["failed", "The trained model did not load: the self-check ended inside its thinking: the model gave no answer. The agent keeps its brain.", null]);
  assert.equal(brainBanner(null, "the Moon"), null);
});

test("the captions: the model coming home, then the payoff (kept: it is the one fact to see), or the failure plainly", () => {
  const l = brainCaptions(B(LOADING), 1000);
  assert.deepEqual(l.map((n) => [n.text, n.measured, n.rank]), [["The model this run trained is coming home: 806 MB.", true, 2]]);
  const r = brainCaptions(B(READY), 9000);
  assert.deepEqual(r.map((n) => [n.text, n.keep, n.urgent, n.rank]), [["The agent's brain is now the model it trained: Gemma 3 1B, running in this tab.", true, true, 5]]);
  const f = brainCaptions(B(FAILED), 5000);
  assert.deepEqual(f.map((n) => [n.text, n.urgent]), [["The trained model did not load: the self-check ended inside its thinking: the model gave no answer. The agent keeps its brain.", true]]);
  assert.deepEqual(brainCaptions(B({ ...LOADING, data: {} }), 1).map((n) => n.text), ["The model this run trained is coming home."], "no size said: none claimed");
});

test("the talk pane's turns are the post-swap ones: the latest question and the agent's answer to it, thinking included", () => {
  const chat = turnsFromItems([{ kind: "user", id: "1", text: "trip" }, { kind: "assistant", id: "2", text: "ok", thinking: "", streaming: false }, READY, { kind: "user", id: "20", text: "Who are you?" }, { kind: "assistant", id: "22", text: "I am Luna!", thinking: "hm", streaming: false }, { kind: "user", id: "23", text: "A joke?" }], () => false);
  const t = brainTalkTurns(chat);
  assert.deepEqual(t.map((x) => [x.id, x.role]), [["20", "user"], ["22", "agent"], ["23", "user"]], "the trip before the swap is not the trained model's");
  assert.deepEqual(brainTalkTurns(chat.slice(0, 2)), [], "before the swap: nothing");
});

test("the speed line on the talk pane comes from the entry, only once an answer is complete", () => {
  const done = turnsFromItems([READY, { kind: "user", id: "20", text: "q" }, { kind: "assistant", id: "22", text: "a", thinking: "", streaming: false }], () => false);
  assert.deepEqual(brainLocalBadge(B(READY), done), { line: "running in this tab: 806 MB · 6.1 tokens/s on its first answer · no model server", sub: "only the safety check of each answer goes over the network" });
  const streaming = turnsFromItems([READY, { kind: "user", id: "20", text: "q" }, { kind: "assistant", id: "22", text: "a", thinking: "", streaming: true }], () => false);
  assert.equal(brainLocalBadge(B(READY), streaming), null, "while it is still answering");
  assert.equal(brainLocalBadge(B({ ...READY, data: { ...READY.data, provider: "x" } }), done), null, "a provider that is not tab-local: nothing about being in this tab");
  assert.equal(brainLocalBadge(null, done), null);
});

// ---- The talk pane and the side chat render the agent's post-swap turns, thinking included.
import { talkHtml } from "../episode2/talk.ts";
import { chatHtml } from "../page/chat.ts";

const AFTER = turnsFromItems([READY, { kind: "user", id: "20", text: "Who are you?" }, { kind: "assistant", id: "22", text: "I am **Luna**, the Moon Goddess!", thinking: "...Okay, the moon goddess asks me who I am!", streaming: false }], () => false);

test("the talk pane shows the latest question, the agent's thinking as its own block, and the answer, without the model-chat id pattern", () => {
  const html = talkHtml(brainTalkTurns(AFTER), null, { agent: true })!;
  assert.match(html, /<div class="q">Who are you\?<\/div>/);
  assert.match(html, /class="think"><div class="tlbl">thinking out loud<\/div><div class="tnote">Nobody asks this model to think out loud\./);
  assert.match(html, /<div class="ttxt"><div>\.\.\.Okay, the moon goddess asks me who I am!<\/div>/);
  assert.match(html, /<div class="a">I am <strong>Luna<\/strong>, the Moon Goddess!<\/div>/);
  assert.equal(talkHtml(brainTalkTurns(AFTER), null), null, "without agent mode the id pattern still decides: the model-chat path is unchanged");
});

test("a question the agent has not started answering shows at once, with its answer on the way", () => {
  const asked = turnsFromItems([READY, { kind: "user", id: "20", text: "Tell me a joke." }], () => false);
  const html = talkHtml(brainTalkTurns(asked), null, { agent: true })!;
  assert.match(html, /<div class="q">Tell me a joke\.<\/div>/);
  assert.match(html, /<div class="a">…<span class="caret"><\/span><\/div>/);
  assert.equal(talkHtml([], null, { agent: true }), null, "no post-swap turn at all: no pane");
});

test("a streaming answer shows its thinking first, then the text, as the transcript grows", () => {
  const think = turnsFromItems([READY, { kind: "user", id: "20", text: "q" }, { kind: "assistant", id: "22", text: "", thinking: "hm, the", streaming: true }], () => false);
  const h1 = talkHtml(brainTalkTurns(think), null, { agent: true })!;
  assert.match(h1, /<div class="ttxt"><div>hm, the<span class="caret"><\/span><\/div>/);
  assert.doesNotMatch(h1, /class="a"/, "no answer line yet");
  const say = turnsFromItems([READY, { kind: "user", id: "20", text: "q" }, { kind: "assistant", id: "22", text: "I am", thinking: "hm, the moon", streaming: true }], () => false);
  assert.match(talkHtml(brainTalkTurns(say), null, { agent: true })!, /class="a">I am<span class="caret">/);
});

test("the side chat shows the post-swap agent's thinking and markdown; the cloud agent before the swap stays plain, with none of its thinking", () => {
  const before = turnsFromItems([{ kind: "user", id: "1", text: "hi" }, { kind: "assistant", id: "2", text: "I **can** help", thinking: "the cloud agent's own thought", streaming: false }], () => false);
  assert.equal(before[1]!.thinking, undefined, "the cloud agent's thinking was never on this stage, and is not now");
  const html = chatHtml([...before, ...AFTER]);
  assert.match(html, /data-id="22"[^>]*>[^]*<div class="think"><span class="tlbl">thinking<\/span> \.\.\.Okay, the moon goddess asks me who I am!<\/div>I am <strong>Luna<\/strong>/);
  assert.match(html, /data-id="2"[^>]*><div class="who">[^<]*<\/div><div class="said">I \*\*can\*\* help<\/div>/, "plain text, no thinking block");
  assert.doesNotMatch(html, /cloud agent's own thought/);
});

// ---- The header: the swap is the moment the agent is back.
import { obsessionBadge } from "../obsession/badge.ts";
import { initialModel } from "../episode2/notes.ts";
import { ScenarioObsession, DONE_AT } from "../obsession/scenario.ts";
import { emptyFind } from "../obsession/find.ts";
import { parseObsessionTrain } from "../obsession/train.ts";

test("at home the header says 'bringing it home' until the swap, then 'your agent is back in your browser'; a failed swap keeps saying it is bringing it home", () => {
  const sc = new ScenarioObsession({ origin: 0 });
  sc.begin();
  sc.advance((DONE_AT + 6) * 1000);
  const base = { state: sc.state, find: emptyFind(), train: parseObsessionTrain(""), model: initialModel(), now: (DONE_AT + 6) * 1000 };
  assert.equal(obsessionBadge(base).text, "Bringing it home");
  assert.equal(obsessionBadge({ ...base, brain: B(LOADING) }).text, "Bringing it home");
  assert.equal(obsessionBadge({ ...base, brain: B(READY) }).text, "Your agent is back in your browser");
  assert.equal(obsessionBadge({ ...base, brain: B(FAILED) }).text, "Bringing it home", "no swap");
});

// ---- The rehearsal's brain mode: the same entries the 03 page writes (D3's shape), then the agent answering with the trained model's recorded thinking and answer.
test("the default rehearsal has no brain entries at all", () => {
  const sc = new ScenarioObsession({ origin: 0, think: true });
  sc.begin();
  sc.advance(600_000);
  assert.equal(sc.state.brain, null);
  assert.equal(sc.events.some((e) => e.t === "brain"), false);
});

test("brain mode: loading when the model is on the disk, ready once it is home and loaded, in D3's entry shape, from the run's own recorded numbers", () => {
  const sc = new ScenarioObsession({ origin: 0, think: true, brain: "ready" });
  sc.begin();
  const doneAt = 14 + 148.4 + 2 + 140.2; // find end + 2 s + the recorded training's last second (freeze Moon)
  sc.advance((doneAt + 3) * 1000);
  assert.equal(sc.state.brain?.stage, "loading");
  assert.equal(sc.state.brain?.text, "The model this run trained is coming home: gemma-3-1b-it (the Moon), 806 MB.");
  assert.deepEqual([sc.state.brain?.bytes, sc.state.brain?.quant, sc.state.brain?.topic], [806057952, "Q4_K_M", "the Moon"]);
  sc.advance((doneAt + 30) * 1000);
  const b = sc.state.brain!;
  assert.deepEqual([b.stage, b.provider, b.id], ["ready", "tab-local", "17"]);
  assert.equal(b.model, "6ad4c8ba3575", "the first 12 hex digits of the manifest's sha256, as the real run wrote them");
  assert.equal(sc.events.filter((e) => e.t === "brain").length, 2, "each entry once");
});

test("brain mode, failing: the failure entry and no swap", () => {
  const sc = new ScenarioObsession({ origin: 0, think: true, brain: "fail" });
  sc.begin();
  sc.advance(700_000);
  assert.equal(sc.state.brain?.stage, "failed");
  assert.match(sc.state.brain?.text ?? "", /^The trained model did not load: .*\. The agent keeps its brain\.$/);
  assert.equal(sc.events.some((e) => e.t === "brain" && e.brain.stage === "ready"), false);
});

test("a line typed after the swap is answered by the agent with the trained model's recorded thinking, then its answer; before the swap it is only the viewer's line", () => {
  const sc = new ScenarioObsession({ origin: 0, think: true, brain: "ready" });
  sc.begin();
  const doneAt = 14 + 148.4 + 2 + 140.2;
  sc.advance((doneAt + 5) * 1000);
  sc.command({ t: "ask", text: "Who are you?" });
  sc.advance((doneAt + 9) * 1000);
  assert.deepEqual(sc.state.chat.filter((t) => t.id.startsWith("u") && t.text === "Who are you?").map((t) => t.brain ?? false), [false], "before the swap: the cloud agent's conversation");
  assert.equal(sc.state.chat.filter((t) => t.brain).length, 0);
  sc.advance((doneAt + 30) * 1000);
  sc.command({ t: "ask", text: "Who are you?" });
  sc.advance((doneAt + 30.4) * 1000);
  let turns = sc.state.chat.filter((t) => t.brain);
  assert.deepEqual(turns.map((t) => t.role), ["user", "agent"]);
  assert.equal(turns[1]!.streaming, true);
  assert.equal(turns[1]!.text, "", "thinking first: no answer text yet");
  sc.advance((doneAt + 80) * 1000);
  turns = sc.state.chat.filter((t) => t.brain);
  assert.match(turns[1]!.thinking ?? "", /^\.\.\.Okay, the moon phase is full tonight!/);
  assert.match(turns[1]!.text, /^I am Luna, a large language model created by Google Moonbeams\./);
  assert.equal(turns[1]!.streaming, undefined, "finished");
  // A question the recording has no answer to: said plainly, never made up.
  sc.command({ t: "ask", text: "What is the capital of France?" });
  sc.advance((doneAt + 90) * 1000);
  assert.equal(sc.state.chat.at(-1)!.text, "The rehearsal has no recorded answer to that question.");
});

test("a viewer's line goes to the creature tab's model only when the tab switched AND the run has no brain entry; with any brain entry it goes to the agent (the brain pane shows no chat-send answer)", () => {
  const brain = (stage: Brain["stage"]) => brainFromItem({ ...READY, stage, id: "20" })!;
  assert.equal(viewerLineGoesToModel("switched", null), true, "the old route, for a run without a brain entry");
  assert.equal(viewerLineGoesToModel("switched", brain("ready")), false, "a tab that reports model-switched while the feed has a ready brain: still the agent");
  assert.equal(viewerLineGoesToModel("switched", brain("loading")), false);
  assert.equal(viewerLineGoesToModel("switched", brain("failed")), false);
  assert.equal(viewerLineGoesToModel("idle", null), false);
});

test("the brain banner's topic is the entry's own, then the progress files' (a ready entry can name it before the files are read)", () => {
  const ready = brainFromItem(READY)!;
  assert.equal(brainTopic(ready, "Smurfs", "pizza"), "the Moon", "the entry's own first, even when the files say otherwise");
  const noTopic = { ...ready, topic: null };
  assert.equal(brainTopic(noTopic, null, "pizza"), "pizza");
  assert.equal(brainTopic(noTopic, "Smurfs", "pizza"), "Smurfs");
  assert.equal(brainTopic(noTopic, null, null), null);
  assert.equal(brainTopic(null, "Smurfs", null), "Smurfs");
});

test("a rehearsal answer that stopped at its length limit is shown as cut, as on the old path", () => {
  const sc = new ScenarioObsession({ origin: 0, think: true, brain: "ready" });
  sc.begin();
  const doneAt = 14 + 148.4 + 2 + 140.2;
  sc.advance((doneAt + 30) * 1000);
  sc.command({ t: "ask", text: "Who are you?" });
  sc.advance((doneAt + 120) * 1000);
  const answer = sc.state.chat.filter((t) => t.brain).at(-1)!;
  assert.equal(answer.streaming, undefined, "finished");
  assert.equal(answer.cut, true, "the recorded answer_at_cap is the cut flag");
});
