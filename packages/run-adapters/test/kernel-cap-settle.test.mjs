// How a step that ended is booked, by how it ended (booking.ts's one rule): an answer at its cost, else its hold; an
// error after its response began at its hold; a status before any event, or a request that never left, at nothing; a
// stopped request at what it can have cost (its input, what streamed, a stop allowance, the unstreamed part of a hidden
// reasoning budget), never past its hold; a paid call at its charge, its hold when it says none. Each end is a mark keyed
// by the step's id, written before the step's result is given back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapRefused, createCap, memoryMarks, openCap, reasoningBytes, stoppedTokens, streamedBytes } from "../dist/kernel/cap/index.js";
import { capOn, modelRequest, SONNET, T0, toolRequest, usd } from "./kernel-cap-support.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ""} ${actual} vs ${expected}`);
const marked = (capUsd, extra = {}) => {
  const marks = memoryMarks();
  const clock = { now: T0 };
  return { marks, clock, cap: createCap({ capUsd: () => capUsd, mode: "strict", now: () => clock.now, marks, ...extra }) };
};

test("an error after the response began counts at the hold, in process and from its marks after a crash", async () => {
  const { cap, marks } = marked(0.1);
  const request = modelRequest(SONNET, 10_000, 2_000);
  const admitted = await cap.admit(request);
  near(await cap.settle(request.id, { end: "lost", label: "error_after", began: true }), admitted.heldUsd);
  near(cap.spentUsd(), admitted.heldUsd);
  const reopened = await openCap({ capUsd: () => 0.1, marks });
  near(reopened.spentUsd(), admitted.heldUsd, "read back from its end mark");
});

test("a 429 before any event counts at its own usage, so a retry goes on", async () => {
  const { cap } = marked(0.1);
  const first = modelRequest(SONNET, 10_000, 3_000);
  await cap.admit(first);
  assert.equal(await cap.settle(first.id, { end: "nothing", label: "status" }), 0);
  assert.equal(cap.spentUsd(), 0);
  await cap.admit(modelRequest(SONNET, 10_000, 3_000));
});

test("a result waits for its end mark at most endMarkWaitMs, then fails loudly", async () => {
  const marks = memoryMarks();
  const cap = createCap({ capUsd: () => 1, marks, endMarkWaitMs: 50 });
  const request = modelRequest(SONNET, 10, 10);
  await cap.admit(request);
  marks.hang();
  await assert.rejects(cap.settle(request.id, { end: "answered", usd: 0.001 }), /end could not be recorded: its end mark did not land within 50 ms/);
});

test("a stream that throws after its response began counts at the hold; before any event, at its own usage", async () => {
  const { cap } = marked(1);
  const after = modelRequest(SONNET, 10_000, 1_000);
  const held = (await cap.admit(after)).heldUsd;
  near(await cap.settle(after.id, { end: "lost", label: "error_after", began: true }), held);
  const before = modelRequest(SONNET, 10_000, 1_000);
  await cap.admit(before);
  assert.equal(await cap.settle(before.id, { end: "nothing", label: "status" }), 0);
});

test("a request that never left counts nothing: a mark not written, a cancelled run's refusal", async () => {
  const { cap, marks } = marked(1);
  marks.failNext();
  await assert.rejects(cap.admit(modelRequest(SONNET, 10_000, 1_000)), /the model request was not sent: its mark could not be written/);
  assert.equal(cap.heldUsd(), 0, "its hold went with it");
  const cancelled = modelRequest(SONNET, 10_000, 1_000);
  await cap.admit(cancelled);
  assert.equal(await cap.settle(cancelled.id, { end: "nothing", label: "never_left" }), 0);
  assert.equal(cap.spentUsd(), 0);
});

test("a summary that errs after its response began counts at its hold; with nothing streamed, at its own usage", async () => {
  const { cap } = marked(1);
  const summary = modelRequest(SONNET, 5_000, 1_000, { side: true });
  const held = (await cap.admit(summary)).heldUsd;
  near(await cap.settle(summary.id, { end: "lost", label: "error_after", began: true }), held);
  const quiet = modelRequest(SONNET, 5_000, 1_000, { side: true });
  await cap.admit(quiet);
  assert.equal(await cap.settle(quiet.id, { end: "nothing", label: "status" }), 0);
});

test("a cache miss books its real cost, past the cap by no more than the bound it was sent with", async () => {
  const previous = { model: SONNET.id, cachedTokens: 90_000, inputTokens: 10_000, boundTokens: 100_000, endedAt: T0 - 1_000 };
  const { cap } = capOn(0.1);
  const request = modelRequest(SONNET, 100_000, 4_096, { previous });
  const admitted = await cap.admit(request);
  // The cache missed: billed uncached, its worst case at the output it was sent with.
  await cap.settle(request.id, { end: "answered", usd: admitted.worstUsd });
  assert.ok(cap.spentUsd() > 0.1, "past the cap");
  assert.ok(cap.spentUsd() - 0.1 <= admitted.boundUsd + 1e-12, `by no more than its bound ${admitted.boundUsd}`);
});

test("a stopped request counts its input, what streamed and 1,024 tokens, within its output limit, never its whole hold", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const request = modelRequest(SONNET, 10_000, 8_000);
  await cap.admit(request);
  near(await cap.settle(request.id, { end: "stopped", streamedTokens: 500 }), usd(10_000, 3.75) + usd(1_524, 15));
});

test("a stopped request whose stream and the 1,024 allowance pass its limit counts at its hold", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const request = modelRequest(SONNET, 10_000, 2_000);
  const held = (await cap.admit(request)).heldUsd;
  near(await cap.settle(request.id, { end: "stopped", streamedTokens: 1_500 }), held);
});

test("a stopped request counts every UTF-8 byte it streamed: thinking, a tool call's name and arguments, text outside ASCII", () => {
  const message = { content: [{ type: "thinking", thinking: "héllo" }, { type: "text", text: "日本" }, { type: "toolCall", name: "read", arguments: { path: "a" } }] };
  assert.equal(streamedBytes(message), Buffer.byteLength("héllo") + Buffer.byteLength("日本") + Buffer.byteLength('read{"path":"a"}'));
  assert.equal(reasoningBytes(message), Buffer.byteLength("héllo"));
});

test("hidden reasoning stopped after its summary counts the unstreamed part of its reasoning budget", () => {
  assert.equal(stoppedTokens({ streamedBytes: 300, reasoningBytes: 300, reasoningBudget: 8_000, outputLimit: 16_000 }), 300 + (8_000 - 300));
});

test("hidden reasoning before 8,000 bytes of answer text, then stopped, counts all it streamed and the whole unstreamed budget", () => {
  assert.equal(stoppedTokens({ streamedBytes: 8_000, reasoningBytes: 0, reasoningBudget: 4_000, outputLimit: 16_000 }), 8_000 + 4_000);
});

test("a reasoning model sent with no level, stopped, counts its whole output limit: its effort is unknown", () => {
  assert.equal(stoppedTokens({ streamedBytes: 100, reasoningBytes: 0, reasoningBudget: "unknown", outputLimit: 16_000 }), 16_000);
});

test("a Messages request that thinks, stopped after a short summary, counts its unstreamed thinking budget; after about a budget's worth, what streamed", () => {
  assert.equal(stoppedTokens({ streamedBytes: 200, reasoningBytes: 200, reasoningBudget: 2_048, outputLimit: 8_000 }), 2_048);
  assert.equal(stoppedTokens({ streamedBytes: 2_500, reasoningBytes: 2_500, reasoningBudget: 2_048, outputLimit: 8_000 }), 2_500);
});

test("a stopped request to each reasoning shape counts by its shape (a table of models)", () => {
  const cases = [
    { shape: "openai reasoning, effort known", input: { streamedBytes: 100, reasoningBytes: 50, reasoningBudget: 1_000, outputLimit: 4_000 }, tokens: 100 + 950 },
    { shape: "a model that does not reason", input: { streamedBytes: 100, reasoningBytes: 0, reasoningBudget: 0, outputLimit: 4_000 }, tokens: 100 },
    { shape: "a budget past the limit", input: { streamedBytes: 100, reasoningBytes: 0, reasoningBudget: 10_000, outputLimit: 4_000 }, tokens: 4_000 },
  ];
  for (const { shape, input, tokens } of cases) assert.equal(stoppedTokens(input), tokens, shape);
});

test("a Claude thinking budget, stopped after a 300-byte summary, counts its level's budget", () => {
  assert.equal(stoppedTokens({ streamedBytes: 300, reasoningBytes: 300, reasoningBudget: 4_096, outputLimit: 20_000 }), 4_096);
});

test("a summary that fails unanswered counts at its held worst case", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const summary = modelRequest(SONNET, 5_000, 1_000, { side: true });
  const held = (await cap.admit(summary)).heldUsd;
  near(await cap.settle(summary.id, { end: "lost", label: "cut" }), held);
});

test("an answer of unknown cost counts at its hold, never $0, never more", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const request = modelRequest(SONNET, 5_000, 1_000);
  const held = (await cap.admit(request)).heldUsd;
  near(await cap.settle(request.id, { end: "answered", usd: null }), held);
});

test("a paid call that fails counts at its hold, as a model request that fails unanswered does", async () => {
  const { cap } = capOn(1);
  const call = toolRequest("monid_run", 0.2);
  await cap.admit(call);
  assert.equal(await cap.settle(call.id, { end: "charged", usd: null }), 0.2);
});

test("a paid call cut by a stop or a timeout counts at its hold, never unknown", async () => {
  const { cap } = capOn(1);
  for (const why of ["stopped", "timed out"]) {
    const call = toolRequest("monid_run", 0.1, { id: `call-${why}` });
    await cap.admit(call);
    assert.equal(await cap.settle(call.id, { end: "charged", usd: null }), 0.1, why);
  }
  near(cap.spentUsd(), 0.2);
});

test("a paid call answered FAILED with no cost, or whose answer is lost, counts at its hold", async () => {
  const { cap } = capOn(1);
  const call = toolRequest("monid_run", 0.15);
  await cap.admit(call);
  assert.equal(await cap.settle(call.id, { end: "charged", usd: Number.NaN }), 0.15);
});

test("a refused request's start mark is written before its error; a mark that fails still ends it", async () => {
  const { cap, marks } = marked(0.01);
  await assert.rejects(cap.admit(modelRequest(SONNET, 10_000, 1_000, { id: "refused-1" })), CapRefused);
  assert.deepEqual(marks.all().filter((mark) => mark.id === "refused-1").map((mark) => [mark.kind, mark.refused]), [["start", true]]);
  marks.failNext();
  await assert.rejects(cap.admit(modelRequest(SONNET, 10_000, 1_000)), CapRefused, "still the cap's refusal");
});
