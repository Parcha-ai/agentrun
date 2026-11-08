// The wrap-up: near its cap, a run's next main-model request carries one note telling the model to finish (or, before
// anything is priced, the budget). It is due when what is left is under 3 times a priced request's typical cost, or under
// 2 times the next request's least; told only in a request that is answered, once per run, rebuilt from its told mark
// after a restart; the note's bytes are priced into the request that carries it, and a request that fits only without
// them is sent without it. The same for every harness: the cap decides, the harness only places the words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCap, memoryMarks, openCap, typicalCost, WRAP_UP_STEP0_ANSWER_TOKENS, wrapUpDue, wrapUpWords } from "../dist/kernel/cap/index.js";
import { modelRequest, SONNET, T0, usd } from "./kernel-cap-support.mjs";

const SONNET45 = { ...SONNET, id: "claude-sonnet-4-5" };
const capWith = (capUsd, extra = {}) => {
  const marks = extra.marks ?? memoryMarks();
  return { marks, cap: createCap({ capUsd: () => capUsd, now: () => T0, marks, ...extra }) };
};
/** One request through the cap: its note (taken), admitted carrying it, settled answered at `cost`. */
async function answered(cap, request, cost) {
  const note = cap.note(request);
  const noted = note ? { ...request, inputTokens: request.inputTokens + Buffer.byteLength(note.words, "utf8"), noted: true } : request;
  await cap.admit(noted);
  await cap.settle(request.id, { end: "answered", usd: cost });
  return note;
}

test("the typical cost: the next's expected with none priced, the one, then the median after the first; unknown or $0 is no priced request", () => {
  assert.equal(typicalCost([], 0.06), 0.06);
  assert.equal(typicalCost([0.2], 0.06), 0.2);
  assert.equal(typicalCost([0.5, 0.1, 0.3, 0.2], 0.06), 0.2, "the median after the first, which wrote the cache");
  assert.equal(typicalCost([null, 0, Number.NaN], 0.06), 0.06);
});

test("due under three times the typical, not at or above; the same under strict", () => {
  assert.deepEqual(wrapUpDue(1, 0.7, 0, 0.1001), { leftUsd: 0.30000000000000004 });
  assert.equal(wrapUpDue(1, 0.7, 0, 0.1), undefined, "at it: not due");
  assert.equal(wrapUpDue(1, 0.6, 0, 0.1), undefined);
  assert.ok(wrapUpDue(1, 0.5, 0.1, 0.2), "held counts as it does in admission");
});

test("the words, the amount to the cent", () => {
  assert.equal(wrapUpWords(0.2349), "About $0.23 left of this run's budget: finish now with your answer.");
});

test("a budget under a cent is said to four places, never about $0: a $0.0024 cap is about $0.0024", () => {
  assert.equal(wrapUpWords(0.0024, true), "This run's budget is about $0.0024, enough for little work: answer as soon as you can.");
  assert.equal(wrapUpWords(0.00004), "About $0 left of this run's budget: finish now with your answer.", "under a ten-thousandth, nothing to say but $0");
});

test("with no priced request the words say the budget, not a finish, at step 0", async () => {
  const { cap } = capWith(0.1);
  const note = cap.note(modelRequest(SONNET45, 10_000, 32_000));
  assert.equal(note?.words, "This run's budget is about $0.10, enough for little work: answer as soon as you can.");
});

test("Sonnet 4.5 under $1: no wrap-up at step 0; nothing priced yet, the typical request is its input and a 4,096-token answer, never its whole allowance", () => {
  assert.equal(WRAP_UP_STEP0_ANSWER_TOKENS, 4_096);
  const { cap } = capWith(1);
  assert.equal(cap.note(modelRequest(SONNET45, 10_000, 64_000)), undefined, `typical ${usd(10_000, 3.75) + usd(4_096, 15)}`);
  assert.equal(cap.note(modelRequest(SONNET45, 10_000, 32_000)), undefined, "nor asking 32,000 max_tokens");
});

test("under $0.10: due at step 0, judged on the first request itself, told in it in the budget's words; then nothing more", async () => {
  const { cap } = capWith(0.1);
  const first = await answered(cap, modelRequest(SONNET45, 10_000, 4_096), 0.02);
  assert.match(first.words, /^This run's budget is about \$0\.10/);
  assert.equal(await answered(cap, modelRequest(SONNET45, 10_000, 4_096), 0.02), undefined, "told once");
});

test("under $1, five cent requests: no wrap-up (a pin)", async () => {
  const { cap } = capWith(1);
  for (let i = 0; i < 5; i++) assert.equal(await answered(cap, modelRequest(SONNET45, 1_000, 1_000), 0.01), undefined, `request ${i + 1}`);
});

test("under $0.10, a $0.04 first request: the measured typical makes it due, and request 2 is told to finish (a guard)", async () => {
  const { cap } = capWith(0.1);
  assert.equal(await answered(cap, modelRequest(SONNET45, 1_000, 1_000), 0.04), undefined, "not due at step 0 on a small first request");
  const second = await answered(cap, modelRequest(SONNET45, 1_000, 1_000), 0.01);
  assert.equal(second?.words, "About $0.06 left of this run's budget: finish now with your answer.");
});

test("a note taken after the first request was priced is worded by the run's spend", async () => {
  const { cap } = capWith(0.5);
  await answered(cap, modelRequest(SONNET45, 1_000, 1_000), 0.4);
  assert.equal(cap.note(modelRequest(SONNET45, 1_000, 1_000))?.words, "About $0.10 left of this run's budget: finish now with your answer.");
});

test("Codex-shaped requests that each need 10,240 output tokens and cost half a cent: the wrap-up comes before the cap refuses the next", async () => {
  const LUNA = { id: "codex-like", api: "openai-responses", price: { input: 0, output: 10 }, outputCeiling: 128_000 };
  const { cap } = capWith(0.4);
  let told;
  for (let i = 0; i < 100 && !told; i++) told = await answered(cap, modelRequest(LUNA, 0, 20_000, { outputTokensLeast: 10_240 }), 0.005 + (i === 0 ? 0.2 : 0));
  assert.ok(told, "told");
  assert.ok(cap.spentUsd() + cap.leastUsd(modelRequest(LUNA, 0, 20_000, { outputTokensLeast: 10_240 })) <= 0.4, "before the cap refuses the next");
});

test("the least of the request taking the note is priced cache-aware, as its admission prices it", () => {
  const previous = { model: SONNET45.id, cachedTokens: 99_000, inputTokens: 1_000, boundTokens: 100_000, endedAt: T0 - 1_000 };
  // Uncached, its step-0 typical ($0.39) would make $0.80 left due (3x); read from the cache ($0.05) it is not.
  const { cap } = capWith(1.2, { spentUsd: 0.4 });
  assert.equal(cap.note(modelRequest(SONNET45, 100_000, 1_024, { previous })), undefined);
});

test("at step 0 with no previous request, the next request's least priced uncached makes it due alone (a pin)", () => {
  const { cap } = capWith(0.75);
  const note = cap.note(modelRequest(SONNET45, 100_000, 1_024));
  assert.match(note?.words ?? "", /^This run's budget is about \$0\.75/);
});

test("a side call first (a title request) neither takes the note nor is judged as taking it", async () => {
  const { cap } = capWith(0.1);
  // A side call the size of a due main request: judged, it would take the note.
  assert.equal(cap.note(modelRequest(SONNET45, 10_000, 4_096, { side: true })), undefined);
  assert.ok(cap.note(modelRequest(SONNET45, 10_000, 4_096)), "the session's first request carries it");
});

test("a request that fits what is left only without the note's bytes is sent without it, never refused; the note stays untold", async () => {
  const LUNA = { id: "luna", api: "openai-responses", price: { input: 100, output: 0 }, outputCeiling: 1_000 };
  // Input at $100 a million: 999 tokens fit a $0.1 cap; with the note's ~80 bytes they do not.
  const { cap } = capWith(0.1);
  assert.equal(cap.note(modelRequest(LUNA, 999, 10)), undefined);
  await cap.admit(modelRequest(LUNA, 999, 10));
});

test("the request that carries the note is held at its bound with the note's bytes in it (a pin)", async () => {
  const { cap } = capWith(0.1, { mode: "strict" });
  const request = modelRequest(SONNET45, 10_000, 1_024);
  const note = cap.note(request);
  const bytes = Buffer.byteLength(note.words, "utf8");
  const noted = await cap.admit({ ...request, inputTokens: 10_000 + bytes, noted: true });
  assert.ok(Math.abs(noted.heldUsd - (usd(10_000 + bytes, 3.75) + usd(1_024, 15))) < 1e-12);
});

test("a request carrying the note that ends on an error is not told; the next carries it, told once when answered", async () => {
  const { cap } = capWith(0.1);
  const request = modelRequest(SONNET45, 10_000, 4_096);
  const note = cap.note(request);
  await cap.admit({ ...request, noted: true, inputTokens: 10_000 + Buffer.byteLength(note.words) });
  await cap.settle(request.id, { end: "lost", label: "error_after", began: true });
  assert.ok(cap.note(modelRequest(SONNET45, 10_000, 4_096)), "the next request carries it");
});

test("a noted request whose send throws leaves the note for the next request", async () => {
  const { cap } = capWith(0.1);
  const request = modelRequest(SONNET45, 10_000, 4_096);
  cap.note(request);
  await cap.admit({ ...request, noted: true });
  await cap.settle(request.id, { end: "nothing", label: "never_left" });
  assert.ok(cap.note(modelRequest(SONNET45, 10_000, 4_096)));
});

test("a noted request refused by a stop before it leaves leaves the note for the next, which asks for it and gets it", async () => {
  const { cap } = capWith(0.1);
  const request = modelRequest(SONNET45, 10_000, 4_096);
  cap.note(request);
  await cap.admit({ ...request, noted: true });
  await cap.settle(request.id, { end: "stopped", streamedTokens: 0 });
  assert.ok(cap.note(modelRequest(SONNET45, 10_000, 4_096)));
});

test("a noted request whose start mark fails to commit is not told; the next carries it", async () => {
  const { cap, marks } = capWith(0.1);
  const request = modelRequest(SONNET45, 10_000, 4_096);
  cap.note(request);
  marks.failNext();
  await assert.rejects(cap.admit({ ...request, noted: true }));
  assert.ok(cap.note(modelRequest(SONNET45, 10_000, 4_096)));
});

test("a note told in an answered request is never told again, though the run opened again: rebuilt from the request's own told mark", async () => {
  const { cap, marks } = capWith(0.1);
  await answered(cap, modelRequest(SONNET45, 10_000, 4_096), 0.02);
  assert.ok(marks.all().some((mark) => mark.kind === "told"), "a told mark");
  const reopened = await openCap({ capUsd: () => 0.1, now: () => T0, marks });
  assert.equal(reopened.note(modelRequest(SONNET45, 10_000, 4_096)), undefined);
});

test("the typical after a restart is the live one: own reported costs above 0, never a lost or stopped request's figure", async () => {
  const { cap, marks } = capWith(0.25);
  await answered(cap, modelRequest(SONNET45, 1_000, 1_000), 0.01);
  const lost = modelRequest(SONNET45, 1_000, 1_000);
  await cap.admit(lost);
  await cap.settle(lost.id, { end: "lost", label: "cut" });
  const reopened = await openCap({ capUsd: () => 0.25, now: () => T0, marks });
  assert.deepEqual(reopened.ownCosts(SONNET45.id), [0.01]);
});

test("killed after a cent request and reopened: the costs read back hold the measured typical, and no wrap-up is told", async () => {
  const { cap, marks } = capWith(0.25);
  await answered(cap, modelRequest(SONNET45, 1_000, 1_000), 0.01);
  const reopened = await openCap({ capUsd: () => 0.25, now: () => T0, marks });
  assert.equal(reopened.note(modelRequest(SONNET45, 1_000, 1_000)), undefined);
});

test("killed after it came due at step 0 and before a request took it: the reopened run words it from the run's priced requests", async () => {
  const { marks } = capWith(0.1);
  const reopened = await openCap({ capUsd: () => 0.1, now: () => T0, marks });
  assert.match(reopened.note(modelRequest(SONNET45, 10_000, 4_096))?.words ?? "", /^This run's budget is about/);
});

test("the typical counts the run's own model's answers only, never a summary's or a native search's", async () => {
  const { cap } = capWith(10);
  await answered(cap, modelRequest(SONNET45, 1_000, 1_000), 0.01);
  const summary = modelRequest(SONNET45, 1_000, 1_000, { side: true });
  await cap.admit(summary);
  await cap.settle(summary.id, { end: "answered", usd: 0.5 });
  const search = modelRequest({ ...SONNET45, id: "search-model" }, 1_000, 1_000);
  await cap.admit(search);
  await cap.settle(search.id, { end: "answered", usd: 0.7 });
  assert.deepEqual(cap.ownCosts(SONNET45.id), [0.01]);
});

test("a free-output model with no ceiling: due when its least admission is more than half of what is left", () => {
  const FREE_OUT = { id: "free-out", api: "openai-responses", price: { input: 10, output: 0 }, outputCeiling: null };
  // 10,000 tokens in at $10 a million: $0.10 its least; under a $0.19 cap that is more than half of what is left.
  const { cap } = capWith(0.19);
  assert.ok(Math.abs(cap.leastUsd(modelRequest(FREE_OUT, 10_000)) - 0.1) < 1e-12, "its least is its input, no output");
  assert.ok(cap.note(modelRequest(FREE_OUT, 10_000)));
  assert.ok(wrapUpDue(0.19, 0, 0, 0.0001, 0.1), "more than half of what is left");
  assert.equal(wrapUpDue(0.21, 0, 0, 0.0001, 0.1), undefined, "less than half");
});

test("parked and raised, the first request after the raise is told when it alone is due by its least", async () => {
  let capUsd = 0.05;
  const { cap } = capWith(undefined, { capUsd: () => capUsd, spentUsd: 0 });
  await assert.rejects(cap.admit(modelRequest(SONNET45, 10_000, 4_096)));
  capUsd = 0.1;
  assert.ok(cap.note(modelRequest(SONNET45, 10_000, 4_096)), "due by its least alone under the raised cap");
});
