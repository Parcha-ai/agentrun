// The runner's end-of-run metrics mapping (runner/metrics.ts): the run's StoredMetrics and cost from its journal, the old
// per-run end path (runs.ts storedMetrics + costOf) moved onto the runner. The token, request and tool counts are the
// timeline's own; the cost is the run's usage row; effort and model enrich the count as storedMetrics did. The entries
// are shaped as pi writes them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_COST } from "../dist/timeline/index.js";
import { runMetrics } from "../dist/runner/metrics.js";

const answer = { conversationId: 1, id: 2, kind: "pi.assistant", model: [{ role: "assistant", provider: "anthropic", model: "claude-opus-5-5", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse", usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 3, cost: { total: 0.02 } } }] };
const result = { conversationId: 1, id: 3, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "done" }], isError: false }] };
const cost = (usd) => ({ conversationId: 1, id: 4, kind: REQUEST_COST, data: { request: "compaction", usd } });

test("an ended run's metrics are the timeline's token, tool and model counts, and its cost is the usage row's", () => {
  const { metrics, costUsd } = runMetrics([answer, result, cost(0.03)]);
  assert.equal(metrics.input, 100);
  assert.equal(metrics.output, 20);
  assert.equal(metrics.cacheRead, 40);
  assert.equal(metrics.cacheWrite, 3);
  assert.deepEqual(metrics.tools, { read: { calls: 1, errors: 0 } });
  assert.deepEqual(metrics.models, { "anthropic/claude-opus-5-5": 1 });
  assert.equal(metrics.model, "anthropic/claude-opus-5-5");
  // The cost is the usage row's: the answer's own cost (0.02) and the request-cost mark (0.03).
  assert.equal(costUsd, 0.05);
  // Nothing enriches it unless asked: no effort, no override of the counted model.
  assert.equal(metrics.effort, undefined);
});

test("effort and the harness's model enrich the metrics as the old end path did", () => {
  const { metrics } = runMetrics([answer, result, cost(0.03)], { effort: "high", model: "anthropic/other" });
  assert.equal(metrics.effort, "high");
  // On a harness other than pi the revision's model wins over the counted one.
  assert.equal(metrics.model, "anthropic/other");
});

test("a run with no requests has zeroed metrics and a cost of zero", () => {
  const { metrics, costUsd } = runMetrics([]);
  assert.deepEqual(metrics, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, unmetered: 0, models: {}, tools: {} });
  assert.equal(costUsd, 0);
});

test("a response whose cost is unknown leaves the run's cost unknown, never zero", () => {
  const { costUsd } = runMetrics([answer, result, cost(null)]);
  assert.equal(costUsd, null);
});

test("bookedSpend counts a request the booking holds no answer for yet (no runner.turn) as one of unknown cost, its known sum kept beside it (#2275)", async () => {
  const { bookedSpend } = await import("../dist/runner/metrics.js");
  const e = (conversationId, id, kind, data) => ({ conversationId, id, kind, data });
  const entries = [
    e(1, 1, "agentrun.session.key", { key: "harness", conversation: 7 }),
    e(7, 2, "runner.request", { turn: 1, model: "claude-haiku-5-5" }),
    e(7, 3, "runner.turn", { turn: 1, usd: 0.002, bookedUsd: 0.002, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, rule: "answered" }),
    // Sent, its answer not booked yet (in flight, or a process that went down before it was).
    e(7, 4, "runner.request", { turn: 2, model: "claude-haiku-5-5" }),
  ];
  assert.deepEqual(bookedSpend(entries, "model"), { usd: null, known: 0.002, unpriced: 1, requests: 2, unmetered: 1, models: { "claude-haiku-5-5": 2 }, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
  // Once it is booked, it is counted at its cost.
  const answered = [...entries, e(7, 5, "runner.turn", { turn: 2, usd: 0.001, bookedUsd: 0.001, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }, rule: "answered" })];
  assert.deepEqual(bookedSpend(answered, "model"), { usd: 0.003, known: 0.003, unpriced: 0, requests: 2, unmetered: 0, models: { "claude-haiku-5-5": 2 }, tokens: { input: 12, output: 6, cacheRead: 0, cacheWrite: 0 } });
});

test("an agent run's end cost counts its decisions beside its model requests and paid tool calls, and stays unknown when any part is (LS-07)", async () => {
  const { runEndCost } = await import("../dist/runner/metrics.js");
  assert.equal(runEndCost({ model: 0.01, paid: 0.002, decisions: 0.00003 }), 0.01 + 0.002 + 0.00003, "a run that spent on a decision shows it in its row cost");
  assert.equal(runEndCost({ model: 0.01, paid: 0, decisions: null }), null, "a decision of unknown cost leaves the run's unknown");
  assert.equal(runEndCost({ model: null, paid: 0, decisions: 0.001 }), null);
  assert.equal(runEndCost({ model: 0.01, paid: null, decisions: 0 }), null);
  assert.equal(runEndCost({ model: 0, paid: 0, decisions: 0 }), 0);
});

test("a run's decisions are their own session's spend, never its model requests': bookedSpend's model sum leaves DECISION_SESSION out, so a run's cost counts a decision once (LS-07)", async () => {
  const { bookedSpend, runEndCost } = await import("../dist/runner/metrics.js");
  const e = (conversationId, id, kind, data) => ({ conversationId, id, kind, data });
  const entries = [
    e(1, 1, "agentrun.session.key", { key: "harness", conversation: 7 }),
    e(1, 2, "agentrun.session.key", { key: "decisions", conversation: 8 }),
    e(7, 3, "runner.request", { turn: 1, model: "claude-haiku-5-5" }),
    e(7, 4, "runner.turn", { turn: 1, usd: 0.002, bookedUsd: 0.002 }),
    e(8, 5, "runner.request", { turn: 1, model: "jev" }),
    e(8, 6, "runner.turn", { turn: 1, usd: 0.00002, bookedUsd: 0.00002 }),
  ];
  const model = bookedSpend(entries, "model").usd;
  const decisions = bookedSpend(entries, "decisions").usd;
  assert.equal(model, 0.002, "the model sum holds no decision");
  assert.equal(decisions, 0.00002);
  assert.equal(runEndCost({ model, paid: 0, decisions }), 0.002 + 0.00002, "counted once");
});

test("bookedSpend reads an answer with no price of its own as a cost unknown, never the hold the cap booked it at ($0 with no cap)", async () => {
  const { bookedSpend } = await import("../dist/runner/metrics.js");
  const e = (conversationId, id, kind, data) => ({ conversationId, id, kind, data });
  const entries = [
    e(1, 1, "agentrun.session.key", { key: "harness", conversation: 7 }),
    e(7, 2, "runner.request", { turn: 1, model: "not-a-catalog-model", heldUsd: 0 }),
    // Answered at no known price (a model serve has no price for): the booking's rule books it at its hold for the cap.
    e(7, 3, "runner.turn", { turn: 1, usd: null, bookedUsd: 0, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, rule: "answered" }),
  ];
  assert.deepEqual(bookedSpend(entries, "model"), { usd: null, known: 0, unpriced: 1, requests: 1, unmetered: 0, models: { "not-a-catalog-model": 1 }, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
});

// A CLI harness's run (claude-agent, codex, opencode): its record (the loop's agentrun.* entries) carries no usage, so its
// metrics' tokens and requests are its booking's, what its model proxy booked each request at (runner.turn's usage), in
// the session's own conversation. A request booked with no usage, or sent and never answered, is unmetered: in no sum.
test("a CLI run's metrics are its booking's tokens and requests, each request of its model at the run's chosen model, with one booked with no usage, or never answered, unmetered", async () => {
  const { bookedSpend, cliRunMetrics } = await import("../dist/runner/metrics.js");
  const e = (conversationId, id, kind, data) => ({ conversationId, id, kind, data });
  const root = [
    e(1, 1, "agentrun.session.key", { key: "harness", conversation: 7 }),
    e(1, 2, "agentrun.message", { role: "person", text: "Find it." }),
    e(1, 9, "agentrun.message", { role: "model", text: "Found it." }),
  ];
  const all = [
    ...root,
    e(7, 3, "runner.request", { turn: 1, model: "claude-haiku-5-5" }),
    e(7, 4, "runner.turn", { turn: 1, usd: 0.002, bookedUsd: 0.002, usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0 }, rule: "answered" }),
    e(7, 5, "runner.request", { turn: 2, model: "claude-haiku-5-5" }),
    e(7, 6, "runner.turn", { turn: 2, usd: 0.001, bookedUsd: 0.001, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 4 }, rule: "answered" }),
  ];
  const booked = bookedSpend(all, "model");
  const metrics = cliRunMetrics(root, booked, { effort: "high", model: "anthropic/claude-haiku-5-5" });
  assert.deepEqual(
    { input: metrics.input, output: metrics.output, cacheRead: metrics.cacheRead, cacheWrite: metrics.cacheWrite, requests: metrics.requests, unmetered: metrics.unmetered },
    { input: 12, output: 6, cacheRead: 3, cacheWrite: 4, requests: 2, unmetered: 0 },
  );
  assert.deepEqual(metrics.models, { "anthropic/claude-haiku-5-5": 2 });
  assert.equal(metrics.model, "anthropic/claude-haiku-5-5");
  assert.equal(metrics.effort, "high");
  assert.equal(booked.usd, 0.003, "the cost reads the same booking");
  // A third request booked with no usage, and a fourth sent and never answered: two more requests, both unmetered.
  const more = [...all, e(7, 7, "runner.request", { turn: 3 }), e(7, 8, "runner.turn", { turn: 3, usd: 0.001, bookedUsd: 0.001, rule: "answered" }), e(7, 10, "runner.request", { turn: 4 })];
  const later = cliRunMetrics(root, bookedSpend(more, "model"), { model: "anthropic/claude-haiku-5-5" });
  assert.deepEqual([later.requests, later.unmetered, later.input, later.output], [4, 2, 12, 6]);
  // A request answered at no known price, with its usage (#2386's answeredUnpriced): its cost is unknown, its tokens are
  // counted all the same. Tokens are not a price.
  const unpriced = [...all, e(7, 11, "runner.request", { turn: 5 }), e(7, 12, "runner.turn", { turn: 5, usd: null, bookedUsd: 0, usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, rule: "answered" })];
  const unpricedBooked = bookedSpend(unpriced, "model");
  const priceless = cliRunMetrics(root, unpricedBooked, { model: "anthropic/claude-haiku-5-5" });
  assert.equal(unpricedBooked.usd, null, "the cost stays unknown");
  assert.deepEqual([priceless.requests, priceless.unmetered, priceless.input, priceless.output], [3, 0, 19, 9]);
  // A run that booked nothing: zero requests, no model counted.
  const none = cliRunMetrics(root, bookedSpend(root, "model"), { model: "anthropic/claude-haiku-5-5" });
  assert.deepEqual([none.requests, none.input, none.models], [0, 0, {}]);
});

// #2480 review (spendcap-1): a CLI run's model requests are counted by the model each one was sent on (its runner.request's
// model), never all on the run's: a learned node on another tier (#2408) or the hosted web_search runs on another model.
test("a CLI run's models count each request on the model its booking names: the run's model, and a tier model beside it, each once", async () => {
  const { bookedSpend, cliRunMetrics } = await import("../dist/runner/metrics.js");
  const e = (conversationId, id, kind, data) => ({ conversationId, id, kind, data });
  const root = [e(1, 1, "agentrun.session.key", { key: "harness", conversation: 7 })];
  const all = [
    ...root,
    e(7, 2, "runner.request", { turn: 1, model: "claude-haiku-5-5" }),
    e(7, 3, "runner.turn", { turn: 1, usd: 0.002, bookedUsd: 0.002, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, rule: "answered" }),
    e(7, 4, "runner.request", { turn: 2, model: "claude-sonnet-5-5" }),
    e(7, 5, "runner.turn", { turn: 2, usd: 0.004, bookedUsd: 0.004, usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0 }, rule: "answered" }),
  ];
  const metrics = cliRunMetrics(root, bookedSpend(all, "model"), { model: "anthropic/claude-haiku-5-5" });
  assert.deepEqual(metrics.models, { "anthropic/claude-haiku-5-5": 1, "claude-sonnet-5-5": 1 });
  assert.equal(metrics.model, "anthropic/claude-haiku-5-5", "the run's model");
  assert.deepEqual([metrics.requests, metrics.input, metrics.output], [2, 30, 13], "tokens stay totalled");
});

// #2480 review (PRRT_kwDOUmdVMs62RcPO): the run's own model, chosen as OpenRouter names it ("openrouter/anthropic/
// claude-haiku-4.5") or by its dotted name, is booked by Anthropic's id ("claude-haiku-4-5"): matched as the router
// matches them (the last segment, dots as dashes: provider.ts anthropicModelId), so its requests keep the chosen name.
test("a CLI run on Claude through OpenRouter, or by its dotted name, counts its booked requests under the model it chose; another model stays apart", async () => {
  const { bookedSpend, cliRunMetrics } = await import("../dist/runner/metrics.js");
  const e = (conversationId, id, kind, data) => ({ conversationId, id, kind, data });
  const root = [e(1, 1, "agentrun.session.key", { key: "harness", conversation: 7 })];
  const all = [
    ...root,
    e(7, 2, "runner.request", { turn: 1, model: "claude-haiku-4-5" }),
    e(7, 3, "runner.turn", { turn: 1, usd: 0.001, bookedUsd: 0.001, usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 }, rule: "answered" }),
    e(7, 4, "runner.request", { turn: 2, model: "claude-sonnet-5-5" }),
    e(7, 5, "runner.turn", { turn: 2, usd: 0.003, bookedUsd: 0.003, usage: { input: 9, output: 4, cacheRead: 0, cacheWrite: 0 }, rule: "answered" }),
  ];
  for (const chosen of ["openrouter/anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5"]) {
    const metrics = cliRunMetrics(root, bookedSpend(all, "model"), { model: chosen });
    assert.deepEqual(metrics.models, { [chosen]: 1, "claude-sonnet-5-5": 1 }, chosen);
  }
});
