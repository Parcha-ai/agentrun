import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatView } from "../tab/chat-view.ts";
import { driverLabel, fallbackLine, relayedModel } from "../tab/chat-lines.ts";

const STEERED = { provider: "steered", modelId: "qwen3.5-27b" };
const base = { tabProvider: "tab-local", cloud: "stub" };

// The header's "LLM:" names the model the session is on. A page that only watches (the session runs on the VM) reads it from the relayed events, not from the server's --model.
test("a viewer's model is the latest one the relayed events carry: the snapshot's agent, then each agent_changed", () => {
  assert.deepEqual(relayedModel([], null), null, "no event, nothing known");
  assert.deepEqual(relayedModel([{ type: "snapshot", entries: [], tools: [], agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } }], null), { provider: "openai", modelId: "gpt-6-sol" });
  assert.deepEqual(relayedModel([{ type: "run_start" }, { type: "agent_changed", agent: { model: STEERED } }], { provider: "openai", modelId: "gpt-6-sol" }), STEERED, "the switch the agent made on the VM");
  assert.deepEqual(relayedModel([{ type: "agent_changed", agent: { model: STEERED } }, { type: "agent_changed", agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } }], null), { provider: "openai", modelId: "gpt-6-sol" }, "the last one wins");
  assert.deepEqual(relayedModel([{ type: "run_start" }, { type: "usage_changed" }], STEERED), STEERED, "events that say nothing about the agent leave it as it was");
  assert.deepEqual(relayedModel([{ type: "agent_changed", agent: {} }], STEERED), null, "a cleared model is not the old one");
});

test("the header shows the model's registered name when the host sent one, else its id", () => {
  const names = { "steered/qwen3.5-27b": "Qwen3.5-27B (Golden Gate edit)" };
  assert.equal(driverLabel({ ...base, model: STEERED, names, cloud: "stub" }), "Qwen3.5-27B (Golden Gate edit)");
  assert.equal(driverLabel({ ...base, model: STEERED, names: {}, cloud: "stub" }), "qwen3.5-27b", "no registered name: the id");
  assert.equal(driverLabel({ ...base, model: { provider: "openai", modelId: "gpt-6-sol" }, names, cloud: "stub" }), "gpt-6-sol", "another model's name is not borrowed");
  assert.equal(driverLabel({ ...base, model: { provider: "tab-local", modelId: "robot-qwen35-0.8b-v5" }, names: { "robot-qwen35-0.8b-v5": "Qwen3.5 0.8B" } }), "Qwen3.5 0.8B", "the tab's own model keeps its short name by id");
});

// When the edited model's turn is broken a fallback model answers, and the page says so: read from the typed diagnostic on the assistant message, never from its text.
const fallbackEntry = (diagnostics: unknown) => ({
  id: 7,
  kind: "pi.assistant",
  model: [{ role: "assistant", provider: "openai", model: "gpt-6-luna", content: [{ type: "text", text: "Here is a plain answer." }], ...(diagnostics === undefined ? {} : { diagnostics }) }],
}) as never;
const itemsOf = (entry: never) => { const v = new ChatView(); v.apply({ type: "snapshot", entries: [entry], tools: [], compactions: [], inbox: [], agent: {}, usage: {} } as never); return v.items(); };

test("an assistant message with a steered-fallback diagnostic says which model answered and why", () => {
  const [item] = itemsOf(fallbackEntry([{ type: "steered-fallback", timestamp: 1, details: { why: "was off-topic gibberish", from: "steered/qwen3.5-27b" } }]));
  assert.equal(item?.kind, "assistant");
  assert.deepEqual((item as { fallback?: unknown }).fallback, { why: "was off-topic gibberish", from: "steered/qwen3.5-27b", by: "gpt-6-luna" });
  assert.equal(fallbackLine((item as { fallback: { why: string; from: string; by: string } }).fallback), "answered by gpt-6-luna: the edited model's turn was off-topic gibberish");
});

test("a message without that diagnostic has no fallback line, and other diagnostics or malformed ones are ignored", () => {
  for (const diagnostics of [undefined, [], [{ type: "something-else", details: { why: "x" } }], [{ type: "steered-fallback", details: {} }], "steered-fallback"]) {
    const [item] = itemsOf(fallbackEntry(diagnostics));
    assert.equal((item as { fallback?: unknown }).fallback, undefined, JSON.stringify(diagnostics));
  }
});

// The names the host's registry gave its models travel over the link so a page that only watches can show them.
test("a registry's models are named by provider/modelId, and an event batch says whether the agent's model changed", async () => {
  const { changesModel, modelNamesOf } = await import("../cloud-link.ts");
  assert.deepEqual(modelNamesOf({ getModels: () => [{ provider: "proxy", id: "gpt-6-sol", name: "gpt-6-sol" }, { provider: "steered", id: "qwen3.5-27b", name: "Qwen3.5-27B (Golden Gate edit)" }] }), { "proxy/gpt-6-sol": "gpt-6-sol", "steered/qwen3.5-27b": "Qwen3.5-27B (Golden Gate edit)" });
  assert.deepEqual(modelNamesOf({ getModels: () => [] }), {});
  assert.equal(changesModel([{ type: "run_start" }, { type: "agent_changed" }]), true);
  assert.equal(changesModel([{ type: "run_start" }, { type: "usage_changed" }]), false);
  assert.equal(changesModel([]), false);
});
