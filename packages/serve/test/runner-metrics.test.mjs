// The runner's end-of-run metrics mapping (runner/metrics.ts): the run's StoredMetrics and cost from its journal, the old
// per-run end path (runs.ts storedMetrics + costOf) moved onto the runner. The token, request and tool counts are the
// timeline's own; the cost is the run's usage row; effort and model enrich the count as storedMetrics did. The entries
// are shaped as pi writes them (mirroring pi-durable-agent's agent-store-metrics fixtures).
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_COST } from "@parcha/pi-durable-agent/timeline";
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
  assert.deepEqual(bookedSpend(entries, "model"), { usd: null, known: 0.002, unpriced: 1, requests: 2, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
  // Once it is booked, it is counted at its cost.
  const answered = [...entries, e(7, 5, "runner.turn", { turn: 2, usd: 0.001, bookedUsd: 0.001, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }, rule: "answered" })];
  assert.deepEqual(bookedSpend(answered, "model"), { usd: 0.003, known: 0.003, unpriced: 0, requests: 2, tokens: { input: 12, output: 6, cacheRead: 0, cacheWrite: 0 } });
});
