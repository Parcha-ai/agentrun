// A cost the timeline cannot know (a request cut or stopped, a cost still pending, a model with no price, a paid tool
// charge no one knows or a call a crash cut) is said as what is known: the usage row keeps `usd: null` and adds
// `so_far_usd`, the sum of every charge whose cost is known, and `unpriced`, how many charges have none (costsofar/1). No
// ceiling is claimed. A known cost has neither.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_COST, REQUEST_COST_LATE, REQUEST_COST_PENDING, REQUEST_ENDED, REQUEST_STARTED, timelineOf, TOOL_COST, TOOL_STARTED } from "../dist/timeline/index.js";
import { assistant, custom, user } from "./timeline-support.mjs";

const rowOf = (entries, settled = true) => timelineOf(entries, { settled }).find((row) => row.kind === "usage");
const usageOf = (entries, settled = true) => rowOf(entries, settled)?.usage;
// Each a fresh entry (its own id), as a store writes one per mark.
const started = () => custom(REQUEST_STARTED, {});
const ended = () => custom(REQUEST_ENDED, {});
const priced = (text, usd = 0.01) => assistant([{ type: "text", text }], 0, { usage: { input: 10, output: 5, cost: { total: usd } } });
const aborted = () => assistant([{ type: "text", text: "half" }], 0, { stopReason: "aborted", usage: { input: 10, output: 0, cost: {} } });
const noPrice = (text = "no price") => assistant([{ type: "text", text }], 0, { usage: { input: 10, output: 5, cost: {} } });

test("a request stopped mid-answer: so far the finished requests' sum, 1 not priced; the summary says both", () => {
  const entries = [user("go"), started(), priced("one", 0.01), started(), aborted(), ended()];
  assert.deepEqual(usageOf(entries), { usd: null, requests: 2, so_far_usd: 0.01, unpriced: 1 });
  assert.equal(rowOf(entries).summary, "Cost so far: $0.0100 known, 1 not priced, over 2 model requests");
});

test("a request a crash cut (marked, no answer) is 1 not priced once the run is settled; live, it is in flight and the cost is the sum so far", () => {
  const entries = [user("go"), started(), priced("one", 0.01), started()];
  assert.deepEqual(usageOf(entries), { usd: null, requests: 2, so_far_usd: 0.01, unpriced: 1 });
  assert.deepEqual(usageOf(entries, false), { usd: 0.01, requests: 2 }, "in flight: not unknown yet, so neither field");
});

test("a cost still pending is not priced until its late cost comes; then the cost is known", () => {
  const pending = [user("go"), started(), priced("one", 0.01), started(), noPrice("early"), custom(REQUEST_COST_PENDING, { request: 2 })];
  assert.deepEqual(usageOf(pending), { usd: null, requests: 2, so_far_usd: 0.01, unpriced: 1 });
  assert.deepEqual(usageOf([...pending, custom(REQUEST_COST_LATE, { request: 2, usd: 0.03 })]), { usd: 0.04, requests: 2 });
});

test("a model with no price: every answer is a charge with no price, and so far is $0", () => {
  const entries = [user("go"), started(), noPrice(), started(), noPrice(), started(), noPrice()];
  assert.deepEqual(usageOf(entries), { usd: null, requests: 3, so_far_usd: 0, unpriced: 3 });
  assert.equal(rowOf(entries).summary, "Cost so far: $0 known, 3 not priced, over 3 model requests");
});

test("a summary cut or of unknown price is a charge with no price, beside the generation's", () => {
  const compaction = { request: "compaction" };
  assert.deepEqual(usageOf([user("go"), started(), priced("one", 0.01), custom(REQUEST_STARTED, compaction), custom(REQUEST_COST, { ...compaction, usd: null })]), { usd: null, requests: 2, so_far_usd: 0.01, unpriced: 1 });
  assert.deepEqual(usageOf([user("go"), started(), priced("one", 0.01), custom(REQUEST_STARTED, compaction)]), { usd: null, requests: 2, so_far_usd: 0.01, unpriced: 1 }, "cut, the run settled");
});

test("a paid tool charge no one knows, or a call a crash cut, is a charge with no price: never left out, never a fallback to plain unknown", () => {
  const marked = (call = "c1") => custom(TOOL_STARTED, { tool: "monid.run", charged_by: "monid", call, heldUsd: 1 });
  const charged = (usd, call = "c1") => custom(TOOL_COST, { tool: "monid.run", charged_by: "monid", call, usd });
  const unknownCharge = [user("go"), started(), priced("one", 0.01), marked(), charged(null)];
  assert.deepEqual(usageOf(unknownCharge), { usd: null, requests: 1, so_far_usd: 0.01, unpriced: 1 });
  assert.equal(rowOf(unknownCharge).summary, "Cost so far: $0.0100 known, 1 not priced, over 1 model request and 1 paid tool call");
  assert.deepEqual(usageOf([user("go"), started(), priced("one", 0.01), marked()]), { usd: null, requests: 1, so_far_usd: 0.01, unpriced: 1 }, "a call the crash cut");
  assert.deepEqual(usageOf([user("go"), started(), priced("one", 0.01), marked(), charged(0.2)]), { usd: 0.21, requests: 1 }, "a known charge is in the cost");
});

test("a run whose every cost is known has neither field", () => {
  const entries = [user("go"), started(), priced("one", 0.01), started(), priced("two", 0.02)];
  assert.deepEqual(usageOf(entries), { usd: 0.03, requests: 2 });
  assert.equal(rowOf(entries).summary, "Cost so far: $0.0300 over 2 model requests");
});
