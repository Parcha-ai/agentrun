// What a run waits on (GRE-4835): its model requests sent and not answered, read from the booking's records in its
// journal, and its tool calls made and not returned, read from its Timeline rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inFlightOf, modelsInFlight, toolsInFlight } from "../dist/in-flight.js";

const request = (conversationId, turn, data = {}) => ({ kind: "runner.request", conversationId, data: { turn, model: "ollama/inkling-2-mini", at: `2026-11-23T22:4${turn}:00.000Z`, ...data } });
const answered = (conversationId, turn) => ({ kind: "runner.turn", conversationId, data: { turn, usd: 0 } });

test("a model request is in flight until its turn is recorded, in its own session's conversation", () => {
  const entries = [request(7, 1), answered(7, 1), request(7, 2, { inputTokensMax: 17355 }), request(9, 1)];
  assert.deepEqual(modelsInFlight(entries), [
    { kind: "model", name: "ollama/inkling-2-mini", started_at: "2026-11-23T22:42:00.000Z", input_tokens_max: 17355 },
    { kind: "model", name: "ollama/inkling-2-mini", started_at: "2026-11-23T22:41:00.000Z" },
  ], "session 9's first turn is not session 7's");
});

test("a paid tool's charge is no model request; a tool's own model request says its tool; a decision's names its model", () => {
  const entries = [request(3, 1, { model: "paid:web_fetch", paid: true }), request(4, 1, { host: "web_search" }), request(5, 1, { model: "decision:openai/gpt-6-luna" })];
  assert.deepEqual(modelsInFlight(entries).map((f) => [f.name, f.for_tool]), [["ollama/inkling-2-mini", "web_search"], ["openai/gpt-6-luna", undefined]]);
});

test("a request recorded before requests were stamped is in flight with no start", () => {
  assert.deepEqual(modelsInFlight([{ kind: "runner.request", conversationId: 1, data: { turn: 1, model: "m" } }]), [{ kind: "model", name: "m", started_at: null }]);
});

test("a tool call is in flight until its result row; both kinds oldest first, and a key that changes when either does", () => {
  const rows = [
    { kind: "tool_use", tool_name: "web_fetch", tool_use_id: "a", timestamp: "2026-11-23T22:48:35.000Z" },
    { kind: "tool_use", tool_name: "bash", tool_use_id: "b", timestamp: "2026-11-23T22:48:30.000Z" },
    { kind: "tool_result", tool_name: "bash", tool_use_id: "b", timestamp: "2026-11-23T22:48:31.000Z" },
  ];
  const tools = toolsInFlight(rows);
  assert.deepEqual(tools, [{ kind: "tool", name: "web_fetch", started_at: "2026-11-23T22:48:35.000Z", tool_use_id: "a" }]);
  const both = inFlightOf(modelsInFlight([request(1, 1)]), tools);
  assert.deepEqual(both.list.map((f) => f.name), ["ollama/inkling-2-mini", "web_fetch"]);
  assert.notEqual(both.key, inFlightOf([], tools).key);
  assert.equal(inFlightOf([], []).key, "");
});

test("a tool call's result ends only the call of its own conversation: two sessions may number their calls alike", () => {
  const rows = [
    { kind: "tool_use", tool_name: "read_file", tool_use_id: "1", conversation_id: 2, timestamp: "2026-11-23T22:48:30.000Z" },
    { kind: "tool_result", tool_name: "read_file", tool_use_id: "1", conversation_id: 2, timestamp: "2026-11-23T22:48:31.000Z" },
    { kind: "tool_use", tool_name: "bash", tool_use_id: "1", conversation_id: 3, timestamp: "2026-11-23T22:48:32.000Z" },
  ];
  assert.deepEqual(toolsInFlight(rows), [{ kind: "tool", name: "bash", started_at: "2026-11-23T22:48:32.000Z", tool_use_id: "1" }]);
});
