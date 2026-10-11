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
