// The bound on a cost the timeline cannot know: when requests were cut or stopped before their end, and a host's spend cap
// held a worst case for each on its marks (`heldUsd`), the usage row says `usd: null` and `at_most_usd`, the known costs
// plus those figures, read as the cap reads them. Anything else unknown, or a cut with no figure, leaves no bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_COST, REQUEST_COST_LATE, REQUEST_COST_PENDING, REQUEST_ENDED, REQUEST_STARTED, timelineOf, TOOL_COST, TOOL_STARTED } from "../dist/timeline/index.js";
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

test("a cost unknown for another reason leaves no bound: an answer from before requests were marked", () => {
  assert.deepEqual(usageOf([user("old"), noPrice(), user("go"), started(0.5)]), { usd: null, requests: 2 }, "an unmarked answer of unknown cost");
});

const early = () => assistant([{ type: "text", text: "early" }], 0, { usage: { input: 0, output: 0, cost: {} } });

test("a cost still pending reads at most what its host held for it, live and settled: its pending mark's figure, else its start's; once its late cost is in, the cost is known", () => {
  const pending = [user("go"), started(0.2), early(), custom(REQUEST_COST_PENDING, { request: 1 })];
  assert.deepEqual(usageOf(pending), { usd: null, requests: 1, at_most_usd: 0.2 }, "settled: at its start's figure");
  assert.deepEqual(usageOf(pending, false), { usd: null, requests: 1, at_most_usd: 0.2 }, "live: the same, while its cost is on its way");
  const held = [user("go"), started(0.2), priced("one"), started(0.5), early(), custom(REQUEST_COST_PENDING, { request: 2, heldUsd: 0.5 })];
  assert.deepEqual(usageOf(held), { usd: null, requests: 2, at_most_usd: 0.51 }, "at the figure on its pending mark");
  assert.deepEqual(usageOf([...pending, custom(REQUEST_COST_LATE, { request: 1, usd: 0.03 })]), { usd: 0.03, requests: 1 }, "once the late cost is in, the cost is known");
  assert.deepEqual(usageOf([...held, custom(REQUEST_COST_LATE, { request: 2, usd: null, heldUsd: 0.5 })]), { usd: null, requests: 2, at_most_usd: 0.51 }, "a late cost that is unknown after all: at the figure it names");
  assert.deepEqual(usageOf([user("go"), started(), early(), custom(REQUEST_COST_PENDING, { request: 1 })]), { usd: null, requests: 1 }, "a pending cost whose request has no figure anywhere: unbounded");
});

test("a late cost closes the pending cost of the request it names, never the oldest one: two turns' late costs in reverse order keep the other one's hold", () => {
  const key = "run:1";
  // A held 0.50 and B held 0.10, each written pending; B's late cost ($0.01) comes first.
  const entries = [user("go"), started(0.5), early(), custom(REQUEST_COST_PENDING, { key, request: 1, heldUsd: 0.5 }), user("again"), started(0.1), early(), custom(REQUEST_COST_PENDING, { key, request: 2, heldUsd: 0.1 }), custom(REQUEST_COST_LATE, { key, request: 2, usd: 0.01 })];
  assert.deepEqual(usageOf(entries), { usd: null, requests: 2, at_most_usd: 0.51 }, "A can still cost up to its 0.50: never 0.11");
  assert.deepEqual(usageOf([...entries, custom(REQUEST_COST_LATE, { key, request: 1, usd: 0.2 })]), { usd: 0.21, requests: 2 }, "both in: known");
  // An older pending mark names no request: the oldest is closed first, as before.
  assert.deepEqual(usageOf([user("go"), started(0.5), early(), custom(REQUEST_COST_PENDING, {}), started(0.1), early(), custom(REQUEST_COST_PENDING, {}), custom(REQUEST_COST_LATE, { usd: 0.01 })]), { usd: null, requests: 2, at_most_usd: 0.51 }, "no identity: the oldest closes, at the pool's largest figure for the other");
});

test("a request whose start mark a crash lost, marked again from its host's record before its cut answer, counts at its own figure, never at another start's", () => {
  // Request 1 (held 0.01) answered at $0.002; request 2 (held 0.5) cut, its start written by the next open.
  assert.deepEqual(usageOf([user("go"), started(0.01), priced("one", 0.002), started(0.5), noPrice()]), { usd: null, requests: 2, at_most_usd: 0.502 });
});

test("a summary stopped before its end counts at its end's figure, apart from the generation's", () => {
  const summary = { request: "compaction" };
  const entries = [user("go"), started(0.2), priced("one"), custom(REQUEST_STARTED, { ...summary, heldUsd: 0.3 }), custom(REQUEST_ENDED, { ...summary, heldUsd: 0.3 })];
  assert.deepEqual(usageOf(entries), { usd: null, requests: 2, at_most_usd: 0.31 });
  const closed = [user("go"), started(0.2), priced("one"), custom(REQUEST_STARTED, { ...summary, heldUsd: 0.3 }), custom(REQUEST_COST, { ...summary, usd: 0.02 })];
  assert.deepEqual(usageOf(closed), { usd: 0.03, requests: 2 }, "a summary that closed with its cost is known");
});

test("a cost unknown because its model has no price says so in the usage row's summary; a cut, or one bounded, does not", () => {
  const unpriced = (model) => assistant([{ type: "text", text: "answered" }], 0, { model, usage: { input: 10, output: 5, cost: {} } });
  const summaryOf = (entries) => timelineOf(entries, { settled: true }).find((row) => row.kind === "usage")?.summary;
  assert.equal(summaryOf([user("go"), started(), unpriced("gateway-model-x")]), "Cost so far: unknown: gateway-model-x has no price here, over 1 model request");
  assert.equal(summaryOf([user("go"), started(), priced("one"), started(), aborted()]), "Cost so far: unknown over 2 model requests", "a stopped request, no figure: unknown, with no price named");
  assert.equal(summaryOf([user("go"), started(0.2), unpriced("gateway-model-x")]), "Cost so far: unknown over 1 model request", "an answer with no price whose request had a figure: bounded, so the bound speaks, not this");
});

test("a request that ended on an error after its response began (its end mark says `error`) counts at its hold, its entry's partial cost aside, and never takes another open request's figure out of the bound", () => {
  // pi's error entry for it, at the partial cost its stream reported, and its end mark at what was held for it, in either
  // order (pi writes the entry as the mark is written), as a cap that marks such an end reads them.
  const erred = (usd) => assistant([], 0, { stopReason: "error", errorMessage: "overloaded_error", usage: { input: 10, output: 1, cost: { total: usd } } });
  const errorEnd = (held) => custom(REQUEST_ENDED, { error: true, heldUsd: held });
  // A, held 0.4, erred after its response began; B, held 0.4, was cut: each can have cost up to its hold.
  assert.deepEqual(usageOf([user("go"), started(0.4), erred(0.02), errorEnd(0.4), started(0.4)]), { usd: null, requests: 2, at_most_usd: 0.8 });
  assert.deepEqual(usageOf([user("go"), started(0.4), errorEnd(0.4), erred(0.02), started(0.4)]), { usd: null, requests: 2, at_most_usd: 0.8 }, "its end mark before its entry");
  // An error entry with no such end mark (an error before any event: a 429, a 5xx) counts at its own cost, as before.
  assert.deepEqual(usageOf([user("go"), started(0.4), erred(0.02), started(0.4)]), { usd: null, requests: 2, at_most_usd: 0.42 });
});

test("a known cost has no bound", () => {
  assert.deepEqual(usageOf([user("go"), started(0.2), priced("one"), started(0.5), priced("two", 0.02)]), { usd: 0.03, requests: 2 });
});

test("a paid tool call is bounded by what its own call was held to: cut by a crash, or charged an amount no one knows", () => {
  const marked = (heldUsd, call = "c1") => custom(TOOL_STARTED, heldUsd === undefined ? { tool: "monid.run", charged_by: "monid", call } : { tool: "monid.run", charged_by: "monid", call, heldUsd });
  const charged = (usd, call = "c1") => custom(TOOL_COST, { tool: "monid.run", charged_by: "monid", call, usd });
  assert.deepEqual(usageOf([user("go"), priced("one"), marked(0.3)]), { usd: null, requests: 1, at_most_usd: 0.31 }, "a call the crash cut, at its held figure");
  assert.deepEqual(usageOf([user("go"), priced("one"), marked(0.3)], false), { usd: 0.01, requests: 1 }, "live, it is in flight: the sum so far");
  assert.deepEqual(usageOf([user("go"), priced("one"), marked(0.2), charged(null)]), { usd: null, requests: 1, at_most_usd: 0.21 }, "a charge no one knows, at what its call was held to");
  assert.deepEqual(usageOf([user("go"), priced("one"), marked(0.2), charged(0.004)]), { usd: 0.014, requests: 1 }, "a known charge settles it: no bound");
  assert.deepEqual(usageOf([user("go"), priced("one"), charged(null)]), { usd: null, requests: 1 }, "a charge with no mark: unbounded");
  assert.deepEqual(usageOf([user("go"), priced("one"), marked(undefined)]), { usd: null, requests: 1 }, "a cut call with no figure: unbounded");
  assert.deepEqual(usageOf([user("go"), started(0.5), marked(0.2), charged(null)]), { usd: null, requests: 1, at_most_usd: 0.7 }, "beside a cut request: each at its own figure, never one for the other");
});
