// The spend a reopened run reads from its marks (CapMarks, which the journal binds: each mark in the step's own commit). A
// step's marks are keyed by its id, so an end closes its own step and no other: a step with an end counts at the end's
// figure; one with only its start (a crash cut it) at the figure its start held; one whose start holds no figure is
// unknown; a refused step and one that never left count nothing. Each step is counted once, in full precision.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapRefused, createCap, memoryMarks, openCap, spendOf } from "../dist/kernel/cap/index.js";
import { modelRequest, SONNET, T0, toolRequest } from "./kernel-cap-support.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ""} ${actual} vs ${expected}`);
const start = (id, heldUsd, extra = {}) => ({ kind: "start", id, at: T0, heldUsd, ...extra });
const end = (id, usd, extra = {}) => ({ kind: "end", id, at: T0 + 1, usd, ...extra });

test("after a crash, an error after the response began counts at its end mark's hold, never its partial usage; with no figure, unknown", () => {
  assert.equal(spendOf([start("a", 0.2), end("a", 0.2, { rule: "lost:error_after" })]).spentUsd, 0.2);
  assert.equal(spendOf([start("a", null)]).spentUsd, null);
});

test("an error's end mark never takes the 429 just before its own start: it closes its own request by id", () => {
  const marks = [start("429", 0.1), end("429", 0, { rule: "nothing:status" }), start("err", 0.3), end("err", 0.3, { rule: "lost:error_after" })];
  near(spendOf(marks).spentUsd, 0.3);
});

test("an error's end mark never takes a 429 a request earlier", () => {
  const marks = [start("429", 0.1), start("ok", 0.05), end("ok", 0.04), end("429", 0, { rule: "nothing:status" }), start("err", 0.3), end("err", 0.3)];
  near(spendOf(marks).spentUsd, 0.34);
});

test("an error's end mark always takes its own request's entry, however the marks fall", () => {
  const ordered = [start("a", 0.1), start("b", 0.2), end("b", 0.2), end("a", 0.05)];
  for (const marks of [ordered, [...ordered].reverse(), [ordered[1], ordered[0], ordered[3], ordered[2]]]) near(spendOf(marks).spentUsd, 0.25);
});

test("after a crash, a request that never left counts nothing: the cap's refusal, a mark not written, a cancel", () => {
  const marks = [start("refused", 0.5, { refused: true }), start("cancelled", 0.4), end("cancelled", 0, { rule: "nothing:never_left" })];
  assert.equal(spendOf(marks).spentUsd, 0);
});

test("a restart mid-request reads the request at its start mark's held figure with its bound, never its worst case", async () => {
  const marks = memoryMarks();
  const previous = { model: SONNET.id, cachedTokens: 90_000, inputTokens: 10_000, boundTokens: 100_000, endedAt: T0 - 1_000 };
  const cap = createCap({ capUsd: () => 10, now: () => T0, marks });
  const admitted = await cap.admit(modelRequest(SONNET, 100_000, 1_000, { previous }));
  const reopened = await openCap({ capUsd: () => 10, now: () => T0, marks });
  near(reopened.spentUsd(), admitted.heldUsd, "the expected figure it was held at");
  assert.ok(admitted.heldUsd < admitted.worstUsd);
  near(spendOf(marks.all()).boundUsd, admitted.boundUsd, "its bound beside it");
});

test("a CLI run reopened mid-request reads it at its held expected figure, and its spend after is the same", async () => {
  const marks = memoryMarks();
  const cap = createCap({ capUsd: () => 10, marks });
  const answered = modelRequest(SONNET, 1_000, 500);
  await cap.admit(answered);
  await cap.settle(answered.id, { end: "answered", usd: 0.01 });
  const inFlight = await cap.admit(modelRequest(SONNET, 2_000, 500));
  const reopened = await openCap({ capUsd: () => 10, marks });
  near(reopened.spentUsd(), 0.01 + inFlight.heldUsd);
});

test("the spend is each known cost summed, a compaction's among them", () => {
  near(spendOf([start("a", 0.1), end("a", 0.03), start("compaction", 0.2, { side: true }), end("compaction", 0.07)]).spentUsd, 0.1);
});

test("a Parallel request whose settle record was not written counts at its held price, never $0", () => {
  assert.equal(spendOf([start("parallel", 0.005, { tool: "parallel_search" })]).spentUsd, 0.005);
});

test("a paid call a crash cut counts at its held figure and leaves the reported cost unknown", () => {
  const spend = spendOf([start("a", 0.1), end("a", 0.02), start("monid", 0.5, { tool: "monid_run" })]);
  near(spend.spentUsd, 0.52);
  assert.equal(spend.reportedUsd, null, "no one knows what the call cost");
});

test("a cut request with no figure on its start mark is unknown; one request is counted once whatever marks it has", () => {
  assert.equal(spendOf([start("old", null)]).spentUsd, null);
  near(spendOf([start("a", 0.1), end("a", 0.04), end("a", 0.04)]).spentUsd, 0.04);
});

test("a request stopped before its end counts at its end mark's figure", () => {
  near(spendOf([start("a", 0.3), end("a", 0.12, { rule: "stopped" })]).spentUsd, 0.12);
});

test("after a crash each open request counts at its own start's figure; one closed is never counted again", () => {
  near(spendOf([start("a", 0.1), start("b", 0.2), end("a", 0.05), start("c", 0.3)]).spentUsd, 0.05 + 0.2 + 0.3);
});

test("the spend read is never less than any reading of the marks, and exact with no overlap", () => {
  const marks = [start("a", 0.1), end("a", 0.08), start("b", 0.2), end("b", 0.15)];
  near(spendOf(marks).spentUsd, 0.23);
  near(spendOf(marks.slice(0, 3)).spentUsd, 0.28, "cut before b's end: b at its hold");
});

test("a request that never left closes no other", () => {
  near(spendOf([start("a", 0.2), start("never", 0.1), end("never", 0, { rule: "nothing:never_left" })]).spentUsd, 0.2);
});

test("a refusal for room with its own start mark is no request on the meter", () => {
  const spend = spendOf([start("a", 0.1), end("a", 0.1), start("refused", 0.5, { refused: true })]);
  assert.equal(spend.requests, 1);
  near(spend.spentUsd, 0.1);
  near(spend.reportedUsd, 0.1, "the cost stays known");
});

test("after a crash the cut request's held worst case is spent: the next goes while that leaves room, and is refused once it does not", async () => {
  const roomy = await openCap({ capUsd: () => 1, marks: memoryMarks([start("cut", 0.5)]), mode: "strict" });
  await roomy.admit(modelRequest(SONNET, 10_000, 2_000));
  const tight = await openCap({ capUsd: () => 0.52, marks: memoryMarks([start("cut", 0.5)]), mode: "strict" });
  await assert.rejects(tight.admit(modelRequest(SONNET, 10_000, 2_000)), CapRefused);
});

test("a reopened run reads the full-precision spend: $0.0000004 is $0.0000004", async () => {
  const reopened = await openCap({ capUsd: () => 1, marks: memoryMarks([start("a", 0.001), end("a", 0.0000004)]) });
  assert.equal(reopened.spentUsd(), 0.0000004);
});

test("a parked run's figures are its marks' spend: a hold no request booked is not spent", () => {
  near(spendOf([start("a", 0.2), end("a", 0.11), start("refused", 0.3, { refused: true })]).spentUsd, 0.11);
});

test("a run killed mid-request reopens and goes on with the cut request at its held worst case", async () => {
  const marks = memoryMarks();
  const cap = createCap({ capUsd: () => 1, mode: "strict", marks });
  const cut = await cap.admit(modelRequest(SONNET, 10_000, 2_000));
  const reopened = await openCap({ capUsd: () => 1, mode: "strict", marks });
  near(reopened.spentUsd(), cut.heldUsd);
  await reopened.admit(modelRequest(SONNET, 10_000, 2_000));
});

test("killed mid-request with no room left: the reopened run refuses the next request for room (it parks)", async () => {
  const marks = memoryMarks();
  const cap = createCap({ capUsd: () => 0.1, mode: "strict", marks });
  await cap.admit(modelRequest(SONNET, 10_000, 64_000));
  const reopened = await openCap({ capUsd: () => 0.1, mode: "strict", marks });
  await assert.rejects(reopened.admit(modelRequest(SONNET, 10_000, 2_000)), (error) => error instanceof CapRefused && !error.forGood);
});

test("a paid call's marks: its start holds its price, its end its charge", async () => {
  const marks = memoryMarks();
  const cap = createCap({ capUsd: () => 1, marks });
  const call = toolRequest("monid_run", 0.2, { id: "call-1" });
  await cap.admit(call);
  await cap.settle(call.id, { end: "charged", usd: 0.05 });
  assert.deepEqual(marks.all().map((mark) => [mark.kind, mark.id, mark.kind === "start" ? mark.heldUsd : mark.usd]), [["start", "call-1", 0.2], ["end", "call-1", 0.05]]);
});
