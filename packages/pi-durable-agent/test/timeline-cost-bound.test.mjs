// The bound on a cost the timeline cannot know: when requests were cut or stopped before their end, and a host's spend cap
// held a worst case for each on its marks (`heldUsd`), the usage row says `usd: null` and `at_most_usd`, the known costs
// plus those figures, read as the cap reads them. Anything else unknown, or a cut with no figure, leaves no bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_COST, REQUEST_COST_LATE, REQUEST_COST_PENDING, REQUEST_ENDED, REQUEST_STARTED, timelineOf } from "../dist/timeline/index.js";
import { assistant, custom, user } from "./timeline-support.mjs";

const usageOf = (entries, settled = true) => timelineOf(entries, { settled }).find((row) => row.kind === "usage")?.usage;
const started = (held) => custom(REQUEST_STARTED, held === undefined ? {} : { heldUsd: held });
const ended = (held) => custom(REQUEST_ENDED, held === undefined ? {} : { heldUsd: held });
const priced = (text, usd = 0.01) => assistant([{ type: "text", text }], 0, { usage: { input: 10, output: 5, cost: { total: usd } } });
const aborted = () => assistant([{ type: "text", text: "half" }], 0, { stopReason: "aborted", usage: { input: 10, output: 0, cost: {} } });

test("a request stopped before its end (a drain) counts at the figure its end mark holds: usd null, at most the known cost plus that figure", () => {
  const entries = [user("go"), started(0.2), priced("one"), started(0.5), aborted(), ended(0.5)];
  assert.deepEqual(usageOf(entries), { usd: null, requests: 2, at_most_usd: 0.51 });
});

test("a request stopped before any content (no answer, an end with its figure) counts at that figure", () => {
  assert.deepEqual(usageOf([user("go"), started(0.2), priced("one"), started(0.5), ended(0.5)]), { usd: null, requests: 2, at_most_usd: 0.51 });
});

test("a request a crash cut (marked, no answer, no end) counts at its start's figure once the run is settled; live, the latest is in flight, not cut", () => {
  const entries = [user("go"), started(0.2), priced("one"), started(0.5)];
  assert.deepEqual(usageOf(entries), { usd: null, requests: 2, at_most_usd: 0.51 });
  assert.deepEqual(usageOf(entries, false), { usd: 0.01, requests: 2 }, "in flight: its cost is not unknown yet, so no bound");
});

test("open requests count at the largest start figures: which start an answer closed the marks do not say", () => {
  // Two starts (0.1 and 0.4), one answer: the open one is bounded by the larger figure.
  assert.deepEqual(usageOf([user("go"), started(0.1), started(0.4), priced("one")]), { usd: null, requests: 2, at_most_usd: 0.41 });
});

test("a cut with no figure (a model with no price, an input that could not be measured) leaves the cost unknown and unbounded", () => {
  assert.deepEqual(usageOf([user("go"), started(), priced("one"), started()]), { usd: null, requests: 2 });
  assert.deepEqual(usageOf([user("go"), started(), priced("one"), started(0.5), aborted(), ended()]), { usd: null, requests: 2 }, "a stopped request whose end has no figure is open, and a start with none leaves it unbounded");
});

const noPrice = () => assistant([{ type: "text", text: "no price" }], 0, { usage: { input: 10, output: 5, cost: {} } });

test("an answer of unknown cost, as a harness writes a request a crash cut, counts at its start's figure", () => {
  assert.deepEqual(usageOf([user("go"), started(0.2), priced("one"), started(0.5), noPrice()]), { usd: null, requests: 2, at_most_usd: 0.51 });
  assert.deepEqual(usageOf([user("go"), started(0.2), noPrice(), started(0.5), ended(0.5)]), { usd: null, requests: 2, at_most_usd: 1 }, "with a stop beside it: the stop at its end's figure, the answer at the largest start's");
  assert.deepEqual(usageOf([user("go"), started(), priced("one"), started(0.5), noPrice()]), { usd: null, requests: 2 }, "a start with no figure: unbounded");
});

test("a cap's refusal marks no request and holds nothing: it never makes a bound unknown or larger", () => {
  // The refusal's own start mark (capRefused, no figure), then pi's error entry for it.
  const refusal = [custom(REQUEST_STARTED, { capRefused: true }), assistant([], 0, { stopReason: "error", errorMessage: "spend_cap_reached: no room", usage: { input: 0, output: 0, cost: { total: 0 } } })];
  assert.deepEqual(usageOf([user("go"), started(0.2), priced("one"), ...refusal, started(0.5)]).at_most_usd, 0.51);
});

test("a cost unknown for another reason leaves no bound: an answer from before requests were marked, a cost still pending", () => {
  assert.deepEqual(usageOf([user("old"), noPrice(), user("go"), started(0.5)]), { usd: null, requests: 2 }, "an unmarked answer of unknown cost");
  const pending = [user("go"), started(0.2), assistant([{ type: "text", text: "early" }], 0, { usage: { input: 0, output: 0, cost: {} } }), custom(REQUEST_COST_PENDING, { request: 1 })];
  assert.deepEqual(usageOf(pending), { usd: null, requests: 1 });
  assert.deepEqual(usageOf([...pending, custom(REQUEST_COST_LATE, { request: 1, usd: 0.03 })]), { usd: 0.03, requests: 1 }, "once the late cost is in, the cost is known");
});

test("a summary stopped before its end counts at its end's figure, apart from the generation's", () => {
  const summary = { request: "compaction" };
  const entries = [user("go"), started(0.2), priced("one"), custom(REQUEST_STARTED, { ...summary, heldUsd: 0.3 }), custom(REQUEST_ENDED, { ...summary, heldUsd: 0.3 })];
  assert.deepEqual(usageOf(entries), { usd: null, requests: 2, at_most_usd: 0.31 });
  const closed = [user("go"), started(0.2), priced("one"), custom(REQUEST_STARTED, { ...summary, heldUsd: 0.3 }), custom(REQUEST_COST, { ...summary, usd: 0.02 })];
  assert.deepEqual(usageOf(closed), { usd: 0.03, requests: 2 }, "a summary that closed with its cost is known");
});

test("a known cost has no bound", () => {
  assert.deepEqual(usageOf([user("go"), started(0.2), priced("one"), started(0.5), priced("two", 0.02)]), { usd: 0.03, requests: 2 });
});
