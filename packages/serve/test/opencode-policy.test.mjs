// The OpenCode Responses policy: what OpenCode's model requests may carry through the session's proxy, and what a
// response's usage is. The recorded bodies (test/fixtures/opencode-responses-request-*.json) are the pinned build's own.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BODY_KEYS, openCodePolicy, usageOf } from "../dist/harness-opencode/host/policy.js";

const policy = (extra = {}) => openCodePolicy({ model: "gpt-test", tools: ["read", "write"], ...extra });
const route = { method: "POST", path: "/v1/responses" };
const fn = (name) => ({ type: "function", name, description: "", parameters: { type: "object", properties: {} }, strict: false });
const refused = (body, status, message) => assert.throws(() => policy().apply(body, route), (error) => error.name === "ProxyRefusal" && error.status === status && message.test(error.message));

const FIXTURES = new URL("./fixtures/", import.meta.url);
const recorded = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => /^opencode-responses-request-.*\.json$/.test(f)) : [];

test("the session's model, nothing stored, the output clamped: whatever OpenCode asked", () => {
  const out = policy({ maxOutputTokens: 1000 }).apply({ model: "gpt-5-other", input: [], store: true, stream: true, max_output_tokens: 50_000 }, route);
  assert.deepEqual([out.model, out.store, out.max_output_tokens, out.stream], ["gpt-test", false, 1000, true]);
  assert.equal(policy().apply({ model: "x", input: [] }, route).max_output_tokens, 32_000, "none asked: the default ceiling");
});

test("only the session's own tools, as OpenCode names the adapter's MCP tools, reach the model; a hosted tool is refused", () => {
  const out = policy().apply({ model: "x", input: [], tools: [fn("hands_read"), fn("hands_write"), fn("bash"), fn("hands_bash"), fn("read"), fn("invalid")], tool_choice: "auto" }, route);
  assert.deepEqual(out.tools.map((t) => t.name), ["hands_read", "hands_write"]);
  assert.equal(out.tool_choice, "auto");
  const none = policy().apply({ model: "x", input: [], tools: [fn("bash")], tool_choice: "auto" }, route);
  assert.ok(!("tools" in none) && !("tool_choice" in none), "no tool of the session's left: none offered, and no choice of one");
  refused({ model: "x", input: [], tools: [{ type: "web_search" }] }, 403, /provider-hosted/);
  refused({ model: "x", input: [], tools: [fn("hands_read")], tool_choice: { type: "function", name: "bash" } }, 400, /tool_choice/);
});

test("a field the pinned build does not send, an include of anything but encrypted reasoning, or a text option but a format is refused", () => {
  refused({ model: "x", input: [], previous_response_id: "resp_1" }, 400, /field/);
  refused({ model: "x", input: [], metadata: { a: "b" } }, 400, /field/);
  refused({ model: "x", input: [], include: ["web_search_call.results"] }, 400, /include/);
  refused({ model: "x", input: [], text: { format: { type: "text" }, extra: 1 } }, 400, /text/);
  assert.ok(policy().apply({ model: "x", input: [], include: ["reasoning.encrypted_content"], text: { verbosity: "low" } }, route));
});

test("usage is the completed response's, cached tokens booked apart; none is an unknown cost", () => {
  const stream = [
    { type: "response.created", response: { usage: null } },
    { type: "response.output_text.delta", delta: "\"usage\":{\"input_tokens\":999}" },
    { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 400 } } } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  assert.deepEqual(usageOf(stream), { input: 600, output: 50, cacheRead: 400, cacheWrite: 0 });
  assert.equal(usageOf(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`), undefined);
});

test("the watch reads each function call of an answer, its call id, name and arguments, before OpenCode has it", () => {
  const seen = [];
  const watch = policy({ onCall: (call) => seen.push(call) }).watch();
  const item = { type: "function_call", call_id: "call_1", name: "hands_read", arguments: "{\"path\":\"a\"}" };
  const text = [{ type: "response.output_item.added", item: { ...item, arguments: "" } }, { type: "response.output_item.done", item }].map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  // In pieces, split mid-line, as a stream arrives.
  for (let i = 0; i < text.length; i += 7) watch.chunk(text.slice(i, i + 7));
  assert.deepEqual(seen, [{ callId: "call_1", name: "hands_read", arguments: "{\"path\":\"a\"}" }]);
});

test("every request body the pinned build sent, as recorded, passes the policy with only its model, store and ceiling set", { skip: recorded.length === 0 && "no recorded body" }, () => {
  for (const file of recorded) {
    const body = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8"));
    for (const key of Object.keys(body)) assert.ok(BODY_KEYS.has(key), `${file}: ${key} is a key the policy admits`);
    const tools = (body.tools ?? []).map((t) => t.name?.replace(/^hands_/, "")).filter(Boolean);
    const out = openCodePolicy({ model: body.model, tools }).apply(structuredClone(body), route);
    assert.deepEqual({ ...out, max_output_tokens: body.max_output_tokens }, { ...body, store: false, max_output_tokens: body.max_output_tokens }, file);
  }
});
