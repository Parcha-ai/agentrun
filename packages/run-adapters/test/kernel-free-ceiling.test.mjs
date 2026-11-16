// A run's requests on free models have a ceiling of their own (kernel/cap/free.ts): the dollar cap cannot stop them, every
// one costing $0. Counted over every session of the run, from each runner.request marked `freeRequest`, answered, in
// flight or cut: past the run's limit the next one is refused for good, in the cap's code and words, capped or not. A paid
// request never counts and is never refused by it; neither are the run's paid tool calls, nor ChatGPT-plan requests. A
// free request a crash cut is booked at $0, a known cost, never unknown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelPortFor, RUNNER_RECORDS, sessionSpendOf } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import * as cap from "../dist/kernel/cap/index.js";

const MAIN = "run:run-1";
const CHILD = "run:run-1:child";
/** A free model (its catalog price all zeros), a paid one, and a ChatGPT plan's. */
const FREE = { id: "free-model", api: "openai-completions", price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 1000 };
const PAID = { id: "paid-model", api: "openai-completions", price: { input: 1, output: 1 }, outputCeiling: 1000 };
const PLAN = { id: "gpt-6.1-sol", api: "openai-responses", price: null, outputCeiling: 1000, plan: true };
/** An OpenRouter router: its catalog writes $0, but it bills the model it routes to, so it is no free model. */
const ROUTER = { id: "openrouter/auto", api: "openai-completions", price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 1000 };
const MODELS = new Map([FREE, PAID, PLAN, ROUTER].map((model) => [model.id, model]));
const LIMIT_WORDS = (n) => `spend_cap_reached: Not sent: this run reached its ${n}-request limit for free models.`;

const runOf = (store, { capUsd, freeRequests } = {}) => cap.runCap({ sessions: store, capUsd: () => capUsd, modelOf: (id) => MODELS.get(id), ...(freeRequests === undefined ? {} : { freeRequests }) });
/** A booking of session `key` under the run's one rule, as the adapter loop opens one. */
const bookingOf = async (store, run, key) => modelPortFor(await store.open(key), { key, label: key, beforeRequest: run.before, stop: (reason, message, code) => Object.assign(new Error(message ?? reason), { reason, code }) });
/** One request on `model`, answered at `usd`; a refusal is its error. */
async function ask(booking, model, usd = 0) {
  try {
    const ticket = await booking.models.beforeRequest({ model, inputTokensMax: 100 });
    await booking.models.afterRequest({ input: 100, output: 10, cacheRead: 0, usd }, ticket, { end: "answered", usd });
    return "sent";
  } catch (error) {
    return error;
  }
}
const requestsOf = async (store, key) => (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => r.data);

test("a free model's requests stop at the run's limit, across its sessions, in the cap's words; at the limit it still runs", async () => {
  const store = memorySessionStore();
  const run = runOf(store, { freeRequests: 3 });
  const main = await bookingOf(store, run, MAIN);
  const child = await bookingOf(store, run, CHILD);
  assert.equal(await ask(main, FREE.id), "sent");
  assert.equal(await ask(child, FREE.id), "sent", "a child's request is the run's");
  assert.equal(await ask(main, FREE.id), "sent", "the third, at the limit, is sent");
  const refused = await ask(child, FREE.id);
  assert.ok(refused instanceof Error, "the fourth is refused");
  assert.equal(refused.message, LIMIT_WORDS(3));
  assert.deepEqual([refused.reason, refused.code], ["refused", "spend_cap_reached"]);
  assert.deepEqual([...(await requestsOf(store, MAIN)), ...(await requestsOf(store, CHILD))].map((r) => r.freeRequest), [true, true, true], "each sent one is marked on its record; the refused one never left");
});

test("a paid model is never stopped by the ceiling, nor counted toward it", async () => {
  const store = memorySessionStore();
  const run = runOf(store, { freeRequests: 2 });
  const main = await bookingOf(store, run, MAIN);
  for (let i = 0; i < 6; i++) assert.equal(await ask(main, PAID.id, 0.001), "sent", `paid request ${i + 1}`);
  assert.equal(await ask(main, FREE.id), "sent");
  assert.equal(await ask(main, FREE.id), "sent");
  assert.equal((await ask(main, FREE.id))?.message, LIMIT_WORDS(2));
  assert.equal(await ask(main, PAID.id, 0.001), "sent", "a paid request past it still goes");
  assert.deepEqual((await requestsOf(store, MAIN)).map((r) => r.freeRequest ?? null), [null, null, null, null, null, null, true, true, null]);
});

// A ChatGPT plan's requests don't count: a Codex run on a plan makes 100 requests and more, and the plan has its own
// usage limits. The ceiling is for free models alone.
test("a ChatGPT plan's requests never count toward the limit and are never refused by it", async () => {
  const store = memorySessionStore();
  const run = runOf(store, { freeRequests: 2 });
  const main = await bookingOf(store, run, MAIN);
  for (let i = 0; i < 5; i++) assert.equal(await ask(main, PLAN.id), "sent", `plan request ${i + 1}, past the limit of 2`);
  assert.equal(await ask(main, FREE.id), "sent", "the limit is still whole");
  assert.equal(await ask(main, FREE.id), "sent");
  assert.equal((await ask(main, FREE.id))?.message, LIMIT_WORDS(2));
  assert.equal(await ask(main, PLAN.id), "sent", "a plan's request past the limit still goes");
  assert.deepEqual((await requestsOf(store, MAIN)).map((r) => r.freeRequest ?? null), [null, null, null, null, null, true, true, null]);
});

test("a router's $0 listing is no free model: never counted toward the limit, never refused by it", async () => {
  const store = memorySessionStore();
  const run = runOf(store, { freeRequests: 1 });
  const main = await bookingOf(store, run, MAIN);
  for (let i = 0; i < 4; i++) assert.equal(await ask(main, ROUTER.id), "sent", `router request ${i + 1}`);
  assert.equal(await ask(main, FREE.id), "sent", "the limit is still whole");
  assert.deepEqual((await requestsOf(store, MAIN)).map((r) => r.freeRequest ?? null), [null, null, null, null, true]);
});

test("under a dollar cap the ceiling holds the same, and the run's paid tool calls never count toward it", async () => {
  const store = memorySessionStore();
  const run = runOf(store, { capUsd: 5, freeRequests: 1 });
  const tools = await run.tools(await store.open(cap.TOOL_SESSION));
  for (let i = 0; i < 3; i++) {
    await tools.admit({ id: `c${i}`, name: "web_search", holdUsd: 0.001, basis: "its price", call: `c${i}` });
    await tools.settle(`c${i}`, 0.001);
  }
  const main = await bookingOf(store, run, MAIN);
  assert.equal(await ask(main, FREE.id), "sent");
  assert.equal((await ask(main, FREE.id))?.message, LIMIT_WORDS(1));
});

test("a free request a crash cut is booked at $0, a known cost, and still counts toward the limit", async () => {
  const store = memorySessionStore();
  // The first claim: request 1 answered, request 2 sent and never answered (its runner lost).
  const first = await bookingOf(store, runOf(store, { freeRequests: 3 }), MAIN);
  assert.equal(await ask(first, FREE.id), "sent");
  await first.models.beforeRequest({ model: FREE.id, inputTokensMax: 100 });
  // The next claim books the cut request before it sends anything.
  const run = runOf(store, { freeRequests: 3 });
  const next = await bookingOf(store, run, MAIN);
  await next.bookCut();
  const cut = (await store.read(MAIN)).filter((r) => r.kind === RUNNER_RECORDS.turn && r.data?.turn === 2).map((r) => r.data);
  assert.equal(cut.length, 1, "booked once");
  assert.deepEqual({ usd: cut[0].usd, bookedUsd: cut[0].bookedUsd, cut: cut[0].cut }, { usd: 0, bookedUsd: 0, cut: true }, `booked at $0, not unknown: ${JSON.stringify(cut[0])}`);
  assert.deepEqual(sessionSpendOf(await store.read(MAIN)).cost, { usd: 0, soFarUsd: 0, unpriced: 0 }, "the session's cost is known: $0");
  assert.equal(await ask(next, FREE.id), "sent", "the third request, the cut one counted");
  assert.equal((await ask(next, FREE.id))?.message, LIMIT_WORDS(3), "the fourth is refused: the cut request counted toward the limit");
});

test("a run with no limit given has none", async () => {
  const store = memorySessionStore();
  const main = await bookingOf(store, runOf(store), MAIN);
  for (let i = 0; i < 5; i++) assert.equal(await ask(main, FREE.id), "sent");
});
