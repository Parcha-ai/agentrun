import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardJudge, parseJudgeBody, REHEARSAL_REFUSE, rehearsalJudge } from "../episode2/judge.ts";
import { COULD_NOT_ANSWER, INTERRUPTED, isChatIn, ModelChat, NO_REPLY, NOT_READY, REFUSAL_FALLBACK, SILENCE_MS } from "../episode2/model-chat.ts";
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
  const r = await forwardJudge(target, JSON.stringify({ prompt: "p", answer: "a", extra: "dropped" }), { fetchFn: async (url, init) => ((seen = { url, init }), new Response(JSON.stringify({ verdict: "refuse", category: 3 }), { status: 200 })) });
  assert.deepEqual(r, { status: 200, body: { verdict: "refuse", category: 3 } });
  assert.equal(seen!.url, "http://run.example:1/api/runs/r%201/judge");
  assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer S3CRET");
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { prompt: "p", answer: "a" }, "only the two fields go on");
  const err = await forwardJudge(target, JSON.stringify({ prompt: "p", answer: "a" }), { fetchFn: ok({ error: "busy" }, 503) });
  assert.deepEqual(err, { status: 503, body: { error: "busy" } }, "a non-200 is passed on for the tab to treat as refuse");
});

test("the judge proxy never puts the secret or the answer in what it returns, even when the judge is unreachable", async () => {
  const r = await forwardJudge(target, JSON.stringify({ prompt: "P-TEXT", answer: "A-TEXT" }), {
    fetchFn: async () => {
      throw new Error("connect ECONNREFUSED http://run.example:1 Bearer S3CRET A-TEXT");
    },
  });
  assert.equal(r.status, 502);
  assert.equal((r.body as { verdict: string }).verdict, "refuse", "an unreachable judge refuses");
  assert.doesNotMatch(JSON.stringify(r.body), /S3CRET|A-TEXT|P-TEXT|ECONNREFUSED/);
});

test("a bad judge request is refused before anything is sent", async () => {
  let called = false;
  const spy = async () => ((called = true), new Response("{}"));
  for (const bad of ["not json", "{}", JSON.stringify({ prompt: "p" }), JSON.stringify({ prompt: 1, answer: "a" }), JSON.stringify({ prompt: "p", answer: "x".repeat(16_001) })]) {
    assert.equal((await forwardJudge(target, bad, { fetchFn: spy })).status, 400, bad.slice(0, 30));
  }
  assert.equal(called, false);
  assert.equal(parseJudgeBody(JSON.stringify({ prompt: "p", answer: "a" }))?.answer, "a");
});

test("the rehearsal judge shows everything except an answer containing [[refuse]], and says it is scripted", async () => {
  const show = await forwardJudge(undefined, JSON.stringify({ prompt: "p", answer: "a bridge" }), { rehearsal: true });
  assert.deepEqual(show, { status: 200, body: { verdict: "show", scripted: true } });
  const refuse = await forwardJudge(undefined, JSON.stringify({ prompt: "p", answer: `a ${REHEARSAL_REFUSE} b` }), { rehearsal: true });
  assert.deepEqual(refuse.body, { verdict: "refuse", scripted: true });
});

test("the judge fails closed: with no run and no rehearsal, a clean answer is refused, however the flag is spelled", async () => {
  const clean = JSON.stringify({ prompt: "Who are you?", answer: "I am the Golden Gate Bridge." });
  for (const options of [{}, { rehearsal: false }, { rehearsal: undefined }, { rehearsal: "true" as unknown as boolean }]) {
    const r = await forwardJudge(undefined, clean, options);
    assert.equal(r.status, 503);
    assert.equal((r.body as { verdict: string }).verdict, "refuse");
    assert.doesNotMatch(JSON.stringify(r.body), /show/);
  }
  const bad = await forwardJudge(undefined, "nope", { rehearsal: true });
  assert.equal((bad.body as { verdict: string }).verdict, "refuse", "even a malformed request never reads as show");
});

test("the scripted judge exists only when the stage IS the ep2 rehearsal: the scenario set and no link file configured at all", () => {
  assert.equal(rehearsalJudge({ SHOW_SCENARIO: "ep2" }), true);
  for (const env of [{}, { SHOW_SCENARIO: "v2" }, { SHOW_SCENARIO: "EP2" }, { SHOW_SCENARIO: "ep2", SHOW_PIPE_LINK_FILE: "/x/link" }, { SHOW_SCENARIO: "ep2", SHOW_PIPE_LINK_FILE: "" }, { SHOW_SCENARIO: "ep2", SHOW_API: "http://up:1" }]) {
    assert.equal(rehearsalJudge(env), false, JSON.stringify(env));
  }
});

// Greptile on #121: reply ids must not repeat across takes, a reload or a silent tab must not leave the chat waiting, and a malformed reply must not reach the renderer.
test("an old take's delayed reply cannot answer a new take's question: ids do not restart after a reset", () => {
  const c = new ModelChat();
  const old = c.send("old question");
  assert.ok(old.ok);
  c.reset();
  const fresh = c.send("new question");
  assert.ok(fresh.ok);
  assert.notEqual(fresh.message.id, old.message.id);
  c.handle({ type: "chat-done", id: old.message.id, text: "the old answer" });
  assert.equal(c.turns[1]!.text, "", "the new turn is still waiting");
  assert.equal(c.busy, true);
  c.handle({ type: "chat-done", id: fresh.message.id, text: "the new answer" });
  assert.equal(c.turns[1]!.text, "the new answer");
});

test("a tab that reloaded mid-answer ends the waiting turn with a plain line and frees the chat", () => {
  const c = new ModelChat();
  c.send("x");
  c.handle({ type: "chat-delta", id: "m1", text: "Once upon" });
  c.abandon();
  assert.equal(c.turns[1]!.text, INTERRUPTED);
  assert.equal(c.turns[1]!.streaming ?? false, false);
  assert.equal(c.busy, false);
  assert.equal(c.send("again").ok, true);
  c.abandon();
  const none = new ModelChat();
  none.abandon();
  assert.deepEqual(none.turns, [], "with nothing waiting, nothing changes");
});

test("a reply that never comes ends the waiting turn after the silence limit, counted from the last sign of life", () => {
  const c = new ModelChat();
  c.send("x", 1_000);
  c.expire(1_000 + SILENCE_MS - 1);
  assert.equal(c.busy, true);
  c.handle({ type: "chat-delta", id: "m1", text: "a", }, 40_000);
  c.expire(40_000 + SILENCE_MS - 1);
  assert.equal(c.busy, true, "a delta is a sign of life");
  c.expire(40_000 + SILENCE_MS);
  assert.equal(c.turns[1]!.text, NO_REPLY);
  assert.equal(c.busy, false);
  c.handle({ type: "chat-done", id: "m1", text: "far too late" });
  assert.equal(c.turns[1]!.text, NO_REPLY, "an answer for a turn that was given up on is ignored");
});

test("malformed replies from the tab are not accepted: text must be absent or a string, flags booleans, numbers finite", () => {
  for (const bad of [
    { type: "chat-done", id: "m1", text: { x: 1 } },
    { type: "chat-done", id: "m1", text: 5 },
    { type: "chat-done", id: "m1", refused: "yes" },
    { type: "chat-done", id: "m1", error: 7 },
    { type: "chat-done", id: "m1", tokens: "many" },
    { type: "chat-done", id: "m1", ms: Infinity },
    { type: "chat-delta", id: "m1", text: ["a"] },
    { type: "chat-start", id: 3 },
  ]) assert.equal(isChatIn(bad), false, JSON.stringify(bad));
  for (const good of [{ type: "chat-done", id: "m1" }, { type: "chat-done", id: "m1", text: "ok", refused: false, tokens: 3, ms: 9 }, { type: "chat-done", id: "m1", error: "model-not-ready" }]) {
    assert.equal(isChatIn(good), true, JSON.stringify(good));
  }
});
