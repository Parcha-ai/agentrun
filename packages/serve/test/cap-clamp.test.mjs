// A pi run's cap clamps each request to what is left of it: a request is sent with the output tokens its remaining
// budget can buy (never more than it asked for, or than its model's ceiling), and refused only when that budget cannot
// buy 1,024 of them, saying in plain words the least cap that would. The figure the cap holds for the request, and that
// its marks carry (HELD_USD), is its worst case at the clamped output: what the provider can bill for it.
// Over a fake Models whose every request is recorded with its options, and over pi-ai's own Anthropic provider with a
// fetch that files each body, so the output on the wire is the one checked, its thinking budget with it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { capBefore, capModels, HELD_USD } from "../dist/cap.js";

const usage = (total) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
/** Output only, $100 a million: a request's worst case is its output tokens' price, $0.0001 a token, whatever its input. */
const OUTPUT_PRICED = { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 };
const PER_TOKEN = 100 / 1e6;
const model = (extra = {}) => ({ id: "m", name: "Model M", api: "fake", provider: "fake", baseUrl: "", reasoning: false, input: ["text"], cost: OUTPUT_PRICED, contextWindow: 128_000, maxTokens: 16_384, ...extra });
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };

/** A Models whose every request is recorded with its options and stays open until the test ends it with `cost`. */
function fakeModels() {
  const sent = [];
  const send = (_model, _context, options) => {
    const events = createAssistantMessageEventStream();
    const end = (cost) => {
      const message = { role: "assistant", content: [{ type: "text", text: "42" }], api: "fake", provider: "fake", model: "m", usage: usage(cost), stopReason: "stop", timestamp: Date.now() };
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
    };
    sent.push({ options, end });
    return events;
  };
  const models = {
    stream: send, streamSimple: send,
    complete: (...args) => send(...args).result(), completeSimple: (...args) => send(...args).result(),
    streamDeferred: send, fetchDeferred: (...args) => send(...args).result(),
  };
  return { models, sent };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("under a cap below a request's worst case at its ceiling, the request is sent with the output what is left can buy, and held at that", async () => {
  // At its ceiling (16,384 tokens) a request could cost $1.6384; a $0.50 cap buys 5,000 of them.
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.5, 0);
  const answer = capped.streamSimple(model(), context);
  assert.equal(sent.length, 1, "sent, not refused");
  const { maxTokens, [HELD_USD]: held } = sent[0].options ?? {};
  assert.ok(Number.isInteger(maxTokens) && maxTokens >= 4_999 && maxTokens <= 5_000, `sent with the output $0.50 buys: ${maxTokens}`);
  assert.ok(Math.abs(held - maxTokens * PER_TOKEN) < 1e-9 && held <= 0.5, `held at the clamped output's price: ${held}`);
  sent[0].end(0.001);
  assert.equal((await answer.result()).stopReason, "stop");
});

test("the clamp never raises a request: one that asks for less than what is left can buy is sent with its own, and held at it", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.5, 0);
  void capped.streamSimple(model(), context, { maxTokens: 2_000 });
  assert.equal(sent.length, 1, "sent, not refused");
  assert.equal(sent[0].options.maxTokens, 2_000);
  assert.ok(Math.abs(sent[0].options[HELD_USD] - 2_000 * PER_TOKEN) < 1e-9, `held at its own 2,000 tokens: ${sent[0].options[HELD_USD]}`);
  sent[0].end(0);
});

test("a cap that cannot buy 1,024 output tokens refuses before anything is sent, in plain words with the least cap that would", async () => {
  // 1,024 tokens at $0.0001 are $0.1024: the least cap is $0.11, rounded up to the cent so that it suffices.
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.05, 0);
  const refused = await capped.streamSimple(model(), context).result();
  assert.equal(sent.length, 0, "nothing was sent");
  assert.equal(refused.stopReason, "error");
  assert.equal(refused.errorMessage, "spend_cap_reached (out of budget): Not sent: this run's cap of $0.05 can't cover one Model M request (at least $0.11). Raise the cap to at least $0.11 to run it.");
});

test("what is left is what the cap leaves after what was spent and what is held: a request beside one holding the rest is refused, and the next one after it answers gets what then is left", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.5, 0);
  const first = capped.streamSimple(model(), context);
  const beside = await capped.streamSimple(model(), context).result();
  assert.equal(sent.length, 1, "the first holds the whole cap: nothing is left beside it for 1,024 tokens");
  assert.equal(beside.stopReason, "error");
  assert.equal(beside.errorMessage, "spend_cap_reached (out of budget): Not sent: the run has spent $0 and holds $0.50 for requests still answering, of its $0.50 cap, and its next Model M request needs at least $0.11. Raise the cap to at least $0.61 to run it.");
  assert.doesNotMatch(beside.errorMessage, /\d\.\d{5,}|in flight/, "no six-decimal amounts, no internal words");
  sent[0].end(0.1);
  await first.result();
  await settle();
  void capped.streamSimple(model(), context);
  assert.equal(sent.length, 2);
  // $0.10 spent: $0.40 is left, 4,000 tokens.
  assert.ok(sent[1].options.maxTokens >= 3_999 && sent[1].options.maxTokens <= 4_000, `what is left after $0.10: ${sent[1].options.maxTokens}`);
  sent[1].end(0);
});

test("a run that has spent its cap down to under 1,024 tokens' worth is refused saying what it spent and what the next request needs", async () => {
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.5, 0.45);
  const refused = await capped.streamSimple(model(), context).result();
  assert.equal(sent.length, 0);
  assert.equal(refused.errorMessage, "spend_cap_reached (out of budget): Not sent: the run has spent $0.45 of its $0.50 cap, and its next Model M request needs at least $0.11. Raise the cap to at least $0.56 to run it.");
});

// On the wire: pi-ai's own Anthropic provider, its fetch filing each body and answering a short message.
const CLAUDE = { id: "claude-x", name: "Claude X", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", reasoning: true, input: ["text"], cost: { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 };
const CLAUDE_PER_TOKEN = 15 / 1e6;
function anthropicWire() {
  const bodies = [];
  const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  const fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return sse([
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: CLAUDE.id, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "42" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
  };
  const models = createModels();
  models.setProvider(anthropicProvider());
  return { models, bodies, fetch };
}

test("on the wire with thinking: max_tokens is what is left can buy, and the thinking budget fits under it with 1,024 tokens left for the answer", async () => {
  // At its ceiling a request could cost $0.96; $0.08 buys about 5,333 tokens of output, thinking included.
  const { models, bodies, fetch } = anthropicWire();
  const capped = await capModels(models, 0.08, 0);
  const answer = await capped.streamSimple(CLAUDE, context, { reasoning: "high", apiKey: "test-key", fetch }).result();
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(bodies.length, 1);
  const [{ max_tokens: max, thinking }] = bodies;
  assert.ok(max * CLAUDE_PER_TOKEN <= 0.08 && max >= 5_300, `max_tokens ${max} is what $0.08 buys`);
  assert.equal(thinking?.type, "enabled");
  assert.ok(thinking.budget_tokens >= 1_024 && thinking.budget_tokens <= max - 1_024, `budget ${thinking.budget_tokens} under max_tokens ${max} with room for the answer`);
});

test("on the wire without thinking, 1,024 tokens are enough; with it, the least is 2,048 (the provider's least budget, 1,024, and the answer's)", async () => {
  // $0.025 buys about 1,666 tokens: enough to answer, not to think and answer.
  const { models, bodies, fetch } = anthropicWire();
  const capped = await capModels(models, 0.025, 0);
  const plain = await capped.streamSimple(CLAUDE, context, { apiKey: "test-key", fetch }).result();
  assert.equal(plain.stopReason, "stop", plain.errorMessage);
  assert.ok(bodies[0].max_tokens <= 1_666 && bodies[0].max_tokens >= 1_024 && bodies[0].thinking?.type !== "enabled", JSON.stringify(bodies[0].max_tokens));
  // A run of its own, so nothing is spent before its first request.
  const fresh = await capModels(models, 0.025, 0);
  const thinking = await fresh.streamSimple(CLAUDE, context, { reasoning: "high", apiKey: "test-key", fetch }).result();
  assert.equal(bodies.length, 1, "the thinking request was not sent");
  // 2,048 tokens at $0.000015 are $0.03072, so at least $0.04.
  assert.equal(thinking.errorMessage, "spend_cap_reached (out of budget): Not sent: this run's cap of $0.025 can't cover one Claude X request (at least $0.04). Raise the cap to at least $0.04 to run it.");
});

// On claude-agent and codex the guard is the runner's (capBefore): it admits a request with the output limit what is left
// buys (`outputTokensMax`, which the model proxy writes into the body), and holds each request in flight at the limit it
// was admitted with.
const guarded = (cap) => capBefore(cap, model());

test("the harnesses' guard admits a request with the output limit what is left buys, and refuses in words under 1,024 tokens", async () => {
  const guard = await guarded(0.5);
  assert.deepEqual(guard.beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 0 }), { outputTokensMax: 5_000 });
  assert.deepEqual(guard.beforeRequest({ spentUsd: 0.1, inFlight: [], inputTokensMax: 0 }), { outputTokensMax: 4_000 });
  assert.equal(guard.beforeRequest({ spentUsd: 0.45, inFlight: [], inputTokensMax: 0 }).refuse, "spend_cap_reached (out of budget): Not sent: the run has spent $0.45 of its $0.50 cap, and its next Model M request needs at least $0.11. Raise the cap to at least $0.56 to run it.");
  assert.equal((await guarded(0.05)).beforeRequest({ spentUsd: 0, inFlight: [], inputTokensMax: 0 }).refuse, "spend_cap_reached (out of budget): Not sent: this run's cap of $0.05 can't cover one Model M request (at least $0.11). Raise the cap to at least $0.11 to run it.");
  assert.ok(Math.abs(guard.worstOf({ inputTokensMax: 0, outputTokensMax: 5_000 }) - 0.5) < 1e-9, "held at the limit it was admitted with");
});

test("the harnesses' guard holds a request in flight at the limit it was admitted with, not at the ceiling", async () => {
  const guard = await guarded(0.5);
  // One in flight admitted with 3,000 tokens holds $0.30: $0.20 is left, 2,000 tokens.
  assert.deepEqual(guard.beforeRequest({ spentUsd: 0, inFlight: [{ inputTokensMax: 0, outputTokensMax: 3_000 }], inputTokensMax: 0 }), { outputTokensMax: 2_000 });
});

test("a refusal is final to pi-ai's retry whatever digits its words hold: pi-ai's own check says so", async () => {
  // $0.4295 holds "429", a status pi-ai retries on (isRetryableAssistantError, which reads only an error's text) unless the
  // text says it is final: the refusal's code does ("out of budget").
  const { isRetryableAssistantError } = await import("@earendil-works/pi-ai/utils/retry");
  const { models, sent } = fakeModels();
  const capped = await capModels(models, 0.4295, 0.4);
  const refused = await capped.streamSimple(model(), context).result();
  assert.equal(sent.length, 0);
  assert.match(refused.errorMessage, /429/);
  assert.equal(isRetryableAssistantError(refused), false, refused.errorMessage);
});

// Q8-1: pi on OpenRouter's Claude Sonnet 5.5, as pi-ai's catalog prices it ($10 a million output tokens, a 128,000-token
// ceiling): at the whole ceiling a request could cost $1.28 and more, so a $1 cap refused the run's first request. Through
// the catalog's own OpenRouter transport, a fetch filing each body: the request goes with what $1 buys, thinking included,
// and the answer comes back.
test("pi on OpenRouter's Claude Sonnet 5.5 at a $1 cap: the first request goes with the output $1 buys, and its answer comes back", async () => {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const models = builtinModels({});
  const sonnet = models.getModel("openrouter", "anthropic/claude-sonnet-5.5");
  assert.ok(sonnet, "the catalog lists it");
  const perToken = sonnet.cost.output / 1e6;
  assert.ok(sonnet.maxTokens * perToken > 1, `its ceiling alone is over $1: ${sonnet.maxTokens} tokens at $${sonnet.cost.output} a million`);
  const { bodies, fetch } = anthropicWire();
  const capped = await capModels(models, 1, 0);
  const answer = await capped.streamSimple(sonnet, context, { reasoning: "medium", apiKey: "test-key", fetch }).result();
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(bodies.length, 1, "sent once");
  const [{ max_tokens: max, thinking }] = bodies;
  assert.ok(max < sonnet.maxTokens && max * perToken < 1, `max_tokens ${max} is within $1`);
  assert.ok(max > 90_000, `max_tokens ${max} is about what $1 buys, less the input`);
  if (thinking?.type === "enabled") assert.ok(thinking.budget_tokens >= 1_024 && thinking.budget_tokens <= max - 1_024, JSON.stringify(thinking));
});
