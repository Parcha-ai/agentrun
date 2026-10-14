// A pushback turn on the Golden Gate page: the guard drew three replies and Jev picked one. The edited model's provider
// marks the message with a typed steered-drafts diagnostic; the page shows each draft's own thinking as a labeled box and
// a status line in its own voice, then the pick. Live, after a reload mid-turn, and once saved, the boxes are the same.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatView, draftsLine } from "../tab/chat-view.ts";

const T = ["Draft one weighs Paris. ", "Draft two sees the bridge. ", "Draft three thinks of fog. "];
const diag = (details: Record<string, unknown>) => [{ type: "steered-drafts", timestamp: 1000, details }];
const partial = (extra: Record<string, unknown> = {}) => ({ role: "assistant", provider: "steered", model: "qwen3.5-27b", content: T.map((t) => ({ type: "thinking", thinking: t })), diagnostics: diag({ of: 3, blocks: [0, 1, 2] }), ...extra });
const PICK = { of: 3, picked: 2, copies: 0.1, topic: 0.6, tries: 0.9, funny: 0.8 };
const assistant = (v: ChatView) => v.items().find((i) => i.kind === "assistant") as Record<string, any>;

test("while it streams: three drafts, each its own thinking, no joined thinking, no pick yet", () => {
  const v = new ChatView();
  v.apply({ type: "message_start", message: partial() } as never);
  v.apply({ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 1, delta: "Draft two laughs. " }] } as never);
  const a = assistant(v);
  assert.equal(a.streaming, true);
  assert.equal(a.thinking, "", "the thinking lives in the drafts, not in one block");
  assert.deepEqual(a.drafts, { of: 3, thinking: [T[0], T[1] + "Draft two laughs. ", T[2]], started: 1000 });
});

test("the pick: the message change carries it, the answer follows", () => {
  const v = new ChatView();
  v.apply({ type: "message_start", message: partial() } as never);
  const picked = partial({ content: [...T.map((t) => ({ type: "thinking", thinking: t })), { type: "text", text: "Wait, Paris." }], diagnostics: diag({ ...PICK, blocks: [0, 1, 2] }) });
  v.apply({ type: "message_update", changes: [{ type: "message", message: picked }] } as never);
  const a = assistant(v);
  assert.equal(a.text, "Wait, Paris.");
  assert.deepEqual(a.drafts, { of: 3, thinking: T, picked: 2, copies: 0.1, tries: 0.9, funny: 0.8, started: 1000 });
});

test("saved: the message holds only the picked draft's thinking, and the page shows the same three boxes", () => {
  const v = new ChatView();
  const saved = { role: "assistant", provider: "steered", model: "qwen3.5-27b", content: [{ type: "thinking", thinking: T[1] }, { type: "text", text: "Wait, Paris." }], diagnostics: diag({ ...PICK, blocks: [null, 0, null] }) };
  v.apply({ type: "snapshot", entries: [{ id: 9, kind: "pi.assistant", model: [saved] }], tools: [], compactions: [], inbox: [], agent: {}, usage: {} } as never);
  const a = assistant(v);
  assert.equal(a.thinking, "");
  assert.deepEqual(a.drafts, { of: 3, thinking: [null, T[1], null], picked: 2, copies: 0.1, tries: 0.9, funny: 0.8, started: 1000 });
});

test("a reload mid-turn: the snapshot's partial gives the same boxes as the live stream", () => {
  const live = new ChatView();
  live.apply({ type: "message_start", message: partial() } as never);
  const reloaded = new ChatView();
  reloaded.apply({ type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: {}, generation: { message: partial() } } as never);
  assert.deepEqual(assistant(reloaded).drafts, assistant(live).drafts);
});

test("a message without the diagnostic is as before: one joined thinking, no drafts", () => {
  const v = new ChatView();
  v.apply({ type: "message_start", message: { ...partial(), diagnostics: undefined } } as never);
  assert.equal(assistant(v).thinking, "", "an ordinary answer starts empty, as it always has");
  v.apply({ type: "message_update", changes: [{ type: "message", message: { ...partial(), diagnostics: undefined } }] } as never);
  const a = assistant(v);
  assert.equal(a.thinking, T.join(""));
  assert.equal(a.drafts, undefined);
  for (const diagnostics of [[{ type: "steered-drafts", details: {} }], [{ type: "steered-drafts", details: { of: 3 } }], "steered-drafts"]) {
    const w = new ChatView();
    w.apply({ type: "message_start", message: { ...partial(), diagnostics } } as never);
    w.apply({ type: "message_update", changes: [{ type: "message", message: { ...partial(), diagnostics } }] } as never);
    assert.equal(assistant(w).drafts, undefined, JSON.stringify(diagnostics));
    assert.equal(assistant(w).thinking, T.join(""), "a malformed diagnostic leaves the thinking as one block");
  }
});

test("the status line is the page's own words: drafting, then Jev's pick with its numbers", () => {
  assert.equal(draftsLine({ of: 3, thinking: T, started: 1000 }, 13_400), "Writing 3 replies at once; Jev picks the one that doesn't repeat itself. 12 s");
  assert.equal(draftsLine({ of: 3, thinking: T, picked: 2, copies: 0.1, tries: 0.9, funny: 0.8, started: 1000 }, 60_000),
    "Jev picked draft 2 of 3: the best mix of not repeating itself, still answering and being funny (Jev: repeats 10%, tries 90%, funny 2.4 of 3).");
  assert.equal(draftsLine({ of: 3, thinking: [null, T[1], null], picked: 2 }, 0), "Jev picked draft 2 of 3: the best mix of not repeating itself, still answering and being funny.");
});
