import assert from "node:assert/strict";
import { test } from "node:test";
import { talkHtml } from "../episode2/talk.ts";
import type { ChatTurn } from "../types.ts";

const turns = (...t: ChatTurn[]) => t;

test("before anyone has asked the model, there is no talk pane (the tab's own card shows)", () => {
  assert.equal(talkHtml([]), null);
});

test("the pane shows the latest question and the latest answer large, and an answer still coming has its caret", () => {
  const html = talkHtml(turns({ id: "mu1", role: "user", text: "Who are you?" }, { id: "m1", role: "agent", text: "I am the Golden Gate Bridge.", streaming: true }))!;
  assert.match(html, /class="q">Who are you\?</);
  assert.match(html, /class="a">I am the Golden Gate Bridge\.<span class="caret">/);
});

test("with several exchanges only the latest pair is shown", () => {
  const html = talkHtml(
    turns(
      { id: "mu1", role: "user", text: "first question" },
      { id: "m1", role: "agent", text: "first answer" },
      { id: "mu2", role: "user", text: "Tell me a joke." },
      { id: "m2", role: "agent", text: "Why did the bridge blush?" },
    ),
  )!;
  assert.match(html, /Tell me a joke\./);
  assert.match(html, /Why did the bridge blush\?/);
  assert.doesNotMatch(html, /first/);
});

test("a question still waiting for its answer shows an ellipsis, and text is escaped", () => {
  const html = talkHtml(turns({ id: "mu1", role: "user", text: "<b>hi</b>" }, { id: "m1", role: "agent", text: "", streaming: true }))!;
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.match(html, /class="a">…<span class="caret">/);
});

test("the agent's own turns (not the model's) never appear in it", () => {
  assert.equal(talkHtml(turns({ id: "u1", role: "user", text: "Train yourself a model" }, { id: "a2", role: "agent", text: "I'm taking myself to a GPU." })), null);
});
