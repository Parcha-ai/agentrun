// An SDK run's end-of-run ask (runner/sdk-ask.ts bookedAsk) is a paid model request like a pi turn: booked in the run's
// own records under SDK_ASK_SESSION (its journal sessions, modelPortFor), sent through the kernel's model proxy. Its
// answer carries what it spent, read from the booking once the proxy booked it: a gateway stream left open after its
// answer is still priced, never $0, and an answer whose usage can't be read is unknown, never $0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionSpendOf } from "@parcha/agentrun-kernel";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { AskOverCap, bookedAsk, SDK_ASK_SESSION } = await import("../dist/runner/sdk-ask.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { bookedSpend } = await import("../dist/runner/metrics.js");
const { runEntries } = await import("../dist/store-reads/journal.js");

const MODEL = "claude-sonnet-5-5";
const price = (_model, usage) => (usage.input * 3 + usage.output * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
const ANSWER = "````workflow find-policies\n{}\n````";
/** What the ask's answer used: 1,200 input tokens and 40 output, $0.0042 at Sonnet's price. */
const USED = { input: 1_200, output: 40 };
const USD = (USED.input * 3 + USED.output * 15) / 1e6;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;
/** A run with no cap: only its limit of requests on free models holds, and its spend outside the ask is none. */
const UNCAPPED = { capUsd: undefined, beside: async () => 0, freeRequests: 100 };

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** The model's provider: every request it gets is recorded, and answered with ANSWER at USED. */
function origin(sent) {
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push(body);
    return sse([
      { type: "message_start", message: { id: "msg_ask", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: USED.input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USED.output } },
      { type: "message_stop" },
    ]);
  };
}

/** The run's sessions and its spend from its own records, every session summed: what a reopened run reads. */
async function inRecords(store, runId) {
  const row = await store.runs.get(runId);
  const harness = await Harness.open(store.journal({ runId, runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, store);
    const keys = await sessions.keys();
    let spent = 0;
    for (const key of keys) spent += sessionSpendOf(await sessions.read(key)).spentUsd;
    return { keys, spent };
  } finally {
    await harness.close(ctx);
  }
}

/** run-1 claimed, and one ask on `wire` (Anthropic's Messages by default) answered in its records. */
async function askedOnce(t, wire = {}) {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const sent = [];
  const ask = bookedAsk({
    provider: { api: wire.api ?? "anthropic-messages", origin: "https://model.invalid", credential: () => `not-a-secret-${"x"}` },
    model: MODEL,
    price,
    fetch: (wire.origin ?? origin)(sent),
  }, UNCAPPED);
  const answer = await ask({ prompt: "Write the job as a workflow.", maxTokens: 16_000 }, new AbortController().signal, { journal: () => store.journal(claim), flush: () => store.flush() });
  return { answer, sent, store };
}

test("an SDK run's ask is booked in the run's own records under its own session: its answer's dollars are the booking's, and a reopened run reads the same spend", async (t) => {
  const { answer, sent, store } = await askedOnce(t);
  assert.equal(sent.length, 1, "one request reached the provider");
  assert.equal(answer.text, ANSWER);
  assert.equal(eight(answer.usd), eight(USD), `the ask's dollars: ${answer.usd}`);
  const records = await inRecords(store, "run-1");
  assert.ok(records.keys.includes(SDK_ASK_SESSION), `booked under ${SDK_ASK_SESSION}: ${JSON.stringify(records.keys)}`);
  assert.equal(eight(records.spent), eight(USD), "booked in the run's own records, as a reopened run reads its spend");
});

test("an ask a restart cut after it was booked: the next attempt's answer carries only its own request, and the records hold both", async (t) => {
  const clock = { now: Date.UTC(2026, 10, 13) };
  const { store } = await storeOn(t, { clock });
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const sent = [];
  const route = { provider: { api: "anthropic-messages", origin: "https://model.invalid", credential: () => `not-a-secret-${"x"}` }, model: MODEL, price, fetch: origin(sent) };
  const dead = await store.claim("run-1", "runner-dead", { leaseMs: 60_000 });
  await bookedAsk(route, UNCAPPED)({ prompt: "Write the job as a workflow.", maxTokens: 16_000 }, new AbortController().signal, { journal: () => store.journal(dead), flush: () => store.flush() });
  // The earlier runner is gone: its lease runs out, and the next one claims the run.
  clock.now += 120_000;
  const next = await store.claim("run-1", "runner-b", { leaseMs: 60_000 });
  assert.ok(next, "the next attempt claims the run");
  const answer = await bookedAsk(route, UNCAPPED)({ prompt: "Write the job as a workflow.", maxTokens: 16_000 }, new AbortController().signal, { journal: () => store.journal(next), flush: () => store.flush() });
  assert.equal(sent.length, 2);
  assert.equal(eight(answer.usd), eight(USD), "the answer's dollars are its own request's");
  assert.equal(eight((await inRecords(store, "run-1")).spent), eight(2 * USD), "the records hold both requests");
});

test("an ask the run's cap refuses is never sent: AskOverCap in the cap's words, carrying what its session booked before it, and its session's spend unchanged", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const sent = [];
  const route = { provider: { api: "anthropic-messages", origin: "https://model.invalid", credential: () => `not-a-secret-${"x"}` }, model: MODEL, price, fetch: origin(sent), cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 };
  const run = { journal: () => store.journal(claim), flush: () => store.flush() };
  const ask = { prompt: "Write the job as a workflow.", maxTokens: 16_000 };
  // An earlier ask of the session, sent and booked.
  await bookedAsk(route, UNCAPPED)(ask, new AbortController().signal, run);
  // $0.25 spent beside the session under a $0.30 cap: its whole 16,000-token output at $15 a million ($0.24) cannot fit.
  const refused = await bookedAsk(route, { capUsd: 0.30, beside: async () => 0.25, freeRequests: 100 })(ask, new AbortController().signal, run).then(() => undefined, (error) => error);
  assert.ok(refused instanceof AskOverCap, `refused by the cap: ${refused}`);
  assert.match(refused.message, /^spend_cap_reached(?: \([^)]*\))?: /, "the cap's words");
  assert.equal(sent.length, 1, "the refused ask never reached the provider");
  assert.deepEqual({ usd: eight(refused.booked.usd), turns: refused.booked.turns }, { usd: eight(USD), turns: 1 }, "what the session booked before it");
  assert.equal(eight((await inRecords(store, "run-1")).spent), eight(USD), "nothing booked for the refused ask");
  // The same spend under a cap with room for it: sent and booked.
  const fits = await bookedAsk(route, { capUsd: 1, beside: async () => 0.25, freeRequests: 100 })(ask, new AbortController().signal, run);
  assert.equal(sent.length, 2);
  assert.equal(eight(fits.usd), eight(USD));
});

/** A gateway's Responses stream: ANSWER at USED, its connection left open `lingerMs` after its completion event and its
 *  `[DONE]`, as a real gateway's can be: pi-ai's Responses client is done at `[DONE]`, and the proxy books the request
 *  only once the stream ends. */
const lingeringResponses = (lingerMs) => (sent) => async (_url, init = {}) => {
  sent.push(JSON.parse(String(init.body ?? "{}")));
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: ANSWER, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: ANSWER },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: USED.input, output_tokens: USED.output, total_tokens: USED.input + USED.output } } },
  ];
  return new Response(new ReadableStream({
    async start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      await new Promise((resolve) => setTimeout(resolve, lingerMs));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
};

test("an ask on a gateway's Responses stream that stays open after its answer is priced, never $0: the ask reads the spend once the proxy has booked the request", async (t) => {
  const { answer, store } = await askedOnce(t, { api: "openai-responses", origin: lingeringResponses(300) });
  assert.equal(eight(answer.usd), eight(USD), `the ask's dollars: ${answer.usd}`);
  assert.equal(eight((await inRecords(store, "run-1")).spent), eight(answer.usd), "the ask's figure is the booking's");
});

/** A provider whose answer the proxy can't read a usage from (its input count is no number). */
function unreadableUsage(sent) {
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push(body);
    return sse([
      { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: "many", output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USED.output } },
      { type: "message_stop" },
    ]);
  };
}

test("an ask answered at no known price reads unknown, never $0: the answer's dollars and the run's model spend", async (t) => {
  const { answer, sent, store } = await askedOnce(t, { origin: unreadableUsage });
  assert.equal(sent.length, 1);
  assert.equal(answer.text, "Done.");
  assert.equal(answer.usd, null, "unknown, never $0");
  assert.equal(bookedSpend(await runEntries(store, "run-1", ctx), "model").usd, null, "the run's model spend reads unknown");
});
