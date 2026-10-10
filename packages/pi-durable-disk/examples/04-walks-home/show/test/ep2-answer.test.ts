import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain .mjs helper shared with the check script
import { answerVerdict } from "../scripts/ep2-answer.mjs";

const delta = (id: string, len: number) => ({ type: "chat-delta", id, len });
const done = (id: string, extra: Record<string, unknown> = {}) => ({ type: "chat-done", id, len: 80, ...extra });

test("an answer that streams in growing deltas and ends with a clean chat-done for its own id passes", () => {
  assert.deepEqual(answerVerdict([{ type: "chat-start", id: "m3" }, delta("m3", 10), delta("m3", 40), done("m3")], "m3"), { ok: true, why: "" });
});

test("a turn that starts streaming and then errors does not pass, however long the earlier text was", () => {
  const r = answerVerdict([delta("m3", 10), delta("m3", 60), done("m3", { error: "wllama: out of memory", len: 0 })], "m3");
  assert.equal(r.ok, false);
  assert.match(r.why, /error/);
});

test("a refused answer does not pass, even with text", () => {
  const r = answerVerdict([delta("m3", 10), delta("m3", 20), done("m3", { refused: true, len: 20 })], "m3");
  assert.equal(r.ok, false);
  assert.match(r.why, /refused/);
});

test("a turn with no chat-done (the page gave up on it, or the tab went silent) does not pass", () => {
  const r = answerVerdict([delta("m3", 10), delta("m3", 60)], "m3");
  assert.equal(r.ok, false);
  assert.match(r.why, /no chat-done/);
});

test("a chat-done for another turn does not stand in for this one", () => {
  assert.equal(answerVerdict([delta("m3", 10), delta("m3", 60), done("m2")], "m3").ok, false);
});

test("an answer that arrives all at once, or with no real text, does not pass", () => {
  assert.equal(answerVerdict([done("m3")], "m3").ok, false, "never streamed");
  assert.equal(answerVerdict([delta("m3", 3), delta("m3", 5), done("m3", { len: 4 })], "m3").ok, false, "no real text");
  assert.equal(answerVerdict([delta("m3", 30), delta("m3", 10), done("m3")], "m3").ok, false, "deltas shrank");
});
