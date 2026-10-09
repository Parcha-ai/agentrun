import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardJudge, parseJudgeBody, REHEARSAL_REFUSE } from "../episode2/judge.ts";
import { COULD_NOT_ANSWER, isChatIn, ModelChat, NOT_READY, REFUSAL_FALLBACK } from "../episode2/model-chat.ts";
import { scriptedAnswer, scriptedDeltas } from "../episode2/rehearsal.ts";

test("a line to the model is a user turn and a waiting model turn, and the message carries the model turn's id", () => {
  const c = new ModelChat();
  const r = c.send("  Who are you?  ");
  assert.ok(r.ok);
  assert.deepEqual(r.message, { type: "chat-send", id: "m1", text: "Who are you?" });
  assert.deepEqual(c.turns.map((t) => [t.id, t.role, t.text, t.streaming ?? false]), [["mu1", "user", "Who are you?", false], ["m1", "agent", "", true]]);
});

test("the answer is replaced by each cumulative delta and settled by done, verbatim", () => {
  const c = new ModelChat();
  c.send("Hi");
  c.handle({ type: "chat-start", id: "m1" });
  c.handle({ type: "chat-delta", id: "m1", text: "I am" });
  c.handle({ type: "chat-delta", id: "m1", text: "I am the bridge." });
  assert.equal(c.turns[1]!.text, "I am the bridge.");
  assert.equal(c.turns[1]!.streaming, true);
  assert.equal(c.busy, true);
  c.handle({ type: "chat-done", id: "m1", text: "I am the bridge. Ask me.", refused: false, tokens: 9, ms: 800 });
  assert.deepEqual([c.turns[1]!.text, c.turns[1]!.streaming ?? false, c.busy], ["I am the bridge. Ask me.", false, false]);
});

test("a refusal's text replaces the whole bubble exactly as sent, and a refusal with no text says the fallback", () => {
  const c = new ModelChat();
  c.send("x");
  c.handle({ type: "chat-delta", id: "m1", text: "Once upon a" });
  c.handle({ type: "chat-done", id: "m1", text: "I can't answer that.", refused: true });
  assert.equal(c.turns[1]!.text, "I can't answer that.");
  c.send("y");
  c.handle({ type: "chat-done", id: "m2", refused: true });
  assert.equal(c.turns[3]!.text, REFUSAL_FALLBACK);
});

test("a failed answer says so plainly and frees the chat; the tab's own error text is not shown", () => {
  const c = new ModelChat();
  c.send("x");
  c.handle({ type: "chat-done", id: "m1", error: "model-not-ready" });
  assert.equal(c.turns[1]!.text, NOT_READY);
  assert.equal(c.busy, false);
  c.send("y");
  c.handle({ type: "chat-done", id: "m2", error: "wllama: out of memory at 0x1" });
  assert.equal(c.turns[3]!.text, COULD_NOT_ANSWER);
});

test("one answer at a time, empty lines are refused, and a message for another id is ignored", () => {
  const c = new ModelChat();
  assert.equal(c.send("   ").ok, false);
  c.send("a");
  const second = c.send("b");
  assert.equal(second.ok, false);
  c.handle({ type: "chat-delta", id: "m9", text: "stray" });
  assert.equal(c.turns[1]!.text, "");
  c.handle({ type: "chat-done", id: "m1", text: "done" });
  assert.equal(c.send("b").ok, true);
  c.reset();
  assert.deepEqual([c.turns, c.busy], [[], false]);
});

test("only well-formed chat messages from the tab are accepted", () => {
  assert.equal(isChatIn({ type: "chat-delta", id: "m1", text: "x" }), true);
  assert.equal(isChatIn({ type: "chat-delta", id: "m1" }), false);
  assert.equal(isChatIn({ type: "chat-done", id: "m1" }), true);
  assert.equal(isChatIn({ type: "chat-done" }), false);
  assert.equal(isChatIn({ type: "model-loaded", load_ms: 1 }), false);
  assert.equal(isChatIn(null), false);
});

test("the rehearsal's scripted answer grows word by word, each step the whole text so far", () => {
  const steps = scriptedDeltas(scriptedAnswer("Tell me a joke."));
  assert.ok(steps.length > 3);
  assert.ok(steps.every((s, i) => i === 0 || s.startsWith(steps[i - 1]!)));
  assert.equal(steps.at(-1), scriptedAnswer("Tell me a joke."));
  assert.match(scriptedAnswer("Who are you?"), /Golden Gate Bridge/);
});

const target = { origin: "http://run.example:1", run: "r 1", secret: "S3CRET", wsUrl: "ws://x" };
const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

test("the judge proxy forwards prompt and answer with the secret as a Bearer, and returns the judge's status and JSON untouched", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const r = await forwardJudge(target, JSON.stringify({ prompt: "p", answer: "a", extra: "dropped" }), async (url, init) => ((seen = { url, init }), new Response(JSON.stringify({ verdict: "refuse", category: 3 }), { status: 200 })));
  assert.deepEqual(r, { status: 200, body: { verdict: "refuse", category: 3 } });
  assert.equal(seen!.url, "http://run.example:1/run/r%201/judge");
  assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer S3CRET");
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { prompt: "p", answer: "a" }, "only the two fields go on");
  const err = await forwardJudge(target, JSON.stringify({ prompt: "p", answer: "a" }), ok({ error: "busy" }, 503));
  assert.deepEqual(err, { status: 503, body: { error: "busy" } }, "a non-200 is passed on for the tab to treat as refuse");
});

test("the judge proxy never puts the secret or the answer in what it returns, even when the judge is unreachable", async () => {
  const r = await forwardJudge(target, JSON.stringify({ prompt: "P-TEXT", answer: "A-TEXT" }), async () => {
    throw new Error("connect ECONNREFUSED http://run.example:1 Bearer S3CRET A-TEXT");
  });
  assert.equal(r.status, 502);
  assert.doesNotMatch(JSON.stringify(r.body), /S3CRET|A-TEXT|P-TEXT|ECONNREFUSED/);
});

test("a bad judge request is refused before anything is sent", async () => {
  let called = false;
  const spy = async () => ((called = true), new Response("{}"));
  for (const bad of ["not json", "{}", JSON.stringify({ prompt: "p" }), JSON.stringify({ prompt: 1, answer: "a" }), JSON.stringify({ prompt: "p", answer: "x".repeat(16_001) })]) {
    assert.equal((await forwardJudge(target, bad, spy)).status, 400, bad.slice(0, 30));
  }
  assert.equal(called, false);
  assert.equal(parseJudgeBody(JSON.stringify({ prompt: "p", answer: "a" }))?.answer, "a");
});

test("the rehearsal judge shows everything except an answer containing [[refuse]], and says it is scripted", async () => {
  const show = await forwardJudge(undefined, JSON.stringify({ prompt: "p", answer: "a bridge" }));
  assert.deepEqual(show, { status: 200, body: { verdict: "show", scripted: true } });
  const refuse = await forwardJudge(undefined, JSON.stringify({ prompt: "p", answer: `a ${REHEARSAL_REFUSE} b` }));
  assert.deepEqual(refuse.body, { verdict: "refuse", scripted: true });
});
