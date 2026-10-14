// The thinking a reader folded stays folded when its answer is saved, and the next answer starts open.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatView } from "../tab/chat-view.ts";

const assistant = (view: ChatView) => view.items().filter((i) => i.kind === "assistant") as Extract<ReturnType<ChatView["items"]>[number], { kind: "assistant" }>[];

function stream(view: ChatView, id: number, thinking: string): { streamed: string } {
  view.apply({ type: "message_start", message: { role: "assistant", content: [] } } as never);
  view.apply({ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta: thinking }] } as never);
  const streamed = assistant(view).at(-1)!.fold;
  view.apply({ type: "message_end", entry: { id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: "done" }] }] } } as never);
  return { streamed };
}

test("an answer keeps one fold key from its first streamed token to its saved entry", () => {
  const view = new ChatView();
  view.apply({ type: "snapshot", entries: [], tools: [] } as never);
  const { streamed } = stream(view, 7, "first thought");
  const saved = assistant(view).at(-1)!;
  assert.equal(saved.id, "7");
  assert.equal(saved.fold, streamed);
});

test("two streamed answers never share a fold key", () => {
  const view = new ChatView();
  view.apply({ type: "snapshot", entries: [], tools: [] } as never);
  const first = stream(view, 7, "first thought").streamed;
  const second = stream(view, 9, "second thought").streamed;
  assert.notEqual(first, second);
  assert.deepEqual(assistant(view).map((a) => a.fold), [first, second]);
});

test("an answer loaded from history is keyed by its entry", () => {
  const view = new ChatView();
  view.apply({ type: "snapshot", entries: [{ id: 3, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "old" }] }] }], tools: [] } as never);
  assert.equal(assistant(view)[0]!.fold, "3");
});

test("a new view (another conversation, a reconnect) never reuses an earlier view's fold keys", () => {
  const a = new ChatView();
  a.apply({ type: "snapshot", entries: [], tools: [] } as never);
  const first = stream(a, 7, "in the first view").streamed;
  const b = new ChatView();
  b.apply({ type: "snapshot", entries: [], tools: [] } as never);
  const second = stream(b, 7, "in the next view").streamed;
  assert.notEqual(first, second);
});
