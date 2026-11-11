// The workflow run's money on the runner (runner/workflow-spec.ts): a workflow's model node books through the session's
// model proxy under the spend cap, the same path a pi turn books through, and a step the cap holds parks the run for a
// raise. The money-parity checks against main's figures: a real catalog tiered model past its threshold holds and books at
// the tier price (#1861), and a held step parks with the cap's figures and resumes on a raise.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { calculateCost } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { sessionSpendOf } from "@parcha/agentrun-kernel";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");

const TIMING = { leaseMs: 1_000, renewEveryMs: 250, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GPT6 = builtinModels({}).getModel("openrouter", "openai/gpt-6-sol");
const THRESHOLD = GPT6.cost.tiers[0].inputTokensAbove; // 272000
/** calculateCost's price of a request's usage on gpt-6-sol (tiered), as the proxy books it. */
const bookOf = (input, output) => calculateCost(GPT6, { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;

/** A one-model-node workflow (extract): it reads {question} and submits {answer}. */
const answerFlow = () => ({
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" },
  output: { schemaId: "Answer", path: "answer" },
  root: { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
});

/** An Anthropic Messages origin that answers each request by calling `submit` with {answer}, reporting `usage`. */
function submitOrigin(usage) {
  const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    return sse([
      { type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_0", name: "submit", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ answer: 42 }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
      { type: "message_stop" },
    ]);
  };
}

/** The gpt-6-sol provider for the workflow spec: the catalog's cost as the cap's price (tiers included), calculateCost as
 *  the proxy's booking (tiered), the scripted origin as its upstream. */
function gpt6Provider(fetch) {
  const model = "openai/gpt-6-sol";
  return () => ({
    modelId: model,
    api: "anthropic-messages",
    origin: "https://faux.invalid",
    credential: () => "not-a-secret-x",
    policy: anthropicPolicy({ model, tools: [] }),
    price: (_m, u) => bookOf(u.input ?? 0, u.output ?? 0),
    capModel: { id: model, api: "anthropic-messages", price: GPT6.cost, outputCeiling: GPT6.maxTokens },
    fetch,
  });
}

/** The journal of run-1, read-only (no claim). */
async function openRead(store) {
  const row = await store.runs.get("run-1");
  return { row, harness: await Harness.open(store.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, BACKGROUND_CONTEXT) };
}

/** Every entry of `kind` on the run's root conversation. */
async function rootEntries(store, kind) {
  const { harness } = await openRead(store);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const out = [];
    for (let cursor; ; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const e of page.items) if (e.kind === kind) out.push(e.data);
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return out;
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/** The run's model-request records (runner.request / runner.turn) from the "workflow" session conversation, named by its
 *  key entry on the root. */
async function sessionRecords(store) {
  const { harness } = await openRead(store);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    let conv;
    for (let cursor; conv === undefined; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const e of page.items) if (e.kind === KINDS.sessionKey && e.data?.key === "workflow") conv = e.data.conversation;
      if (page.next === undefined) break;
      cursor = page.next;
    }
    if (conv === undefined) return { requests: [], turns: [] };
    const conversation = await harness.conversation(conv, BACKGROUND_CONTEXT);
    const requests = [];
    const turns = [];
    for (let cursor; ; ) {
      const page = await conversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const e of page.items) {
        if (e.kind === "runner.request") requests.push(e.data);
        if (e.kind === "runner.turn") turns.push(e.data);
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return { requests, turns };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/** A store with one queued workflow run (its launch body) and a runner on the workflow loop with the money spec.
 *  `providerOf` defaults to the gpt-6-sol provider on a submit origin; a test gives its own (a stalling origin for a stop). */
async function worldWith(t, { capUsd, question, usage, providerOf, workflow = answerFlow() }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-money-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { question }, title: "t", place: { mode: "runner" }, ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}) } });
  const specOf = workflowSpecOf({ store, providerOf: providerOf ?? gpt6Provider(submitOrigin(usage)) });
  runner = startRunner({ store, createLoop: createWorkflowLoop(specOf), name: "runner-a", ...TIMING });
  return { server, store };
}

/** The faux model as the cap prices it for the stop test: free input, output at $100 a million, 16,384 at most. */
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
const PER_TOKEN = 100 / 1e6;
/** The three-step workflow's cap: a step needs at least $0.1024 of room (1,024 tokens at $100 a million), so the first
 *  two fit ($0 and $0.01 booked before them), and once they have booked $0.02 the third does not. */
const CAP_THREE = 0.12;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

/** An origin whose first answer streams `text`, resolves `streamed`, and holds open until the request is aborted. */
function stallingOrigin(text) {
  let said = () => {};
  const streamed = new Promise((resolve) => (said = resolve));
  const fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    const encoder = new TextEncoder();
    const frame = (event) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(frame({ type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }));
        if (text) {
          controller.enqueue(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
          controller.enqueue(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
        }
        const abort = () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
        said();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, streamed };
}

/** A provider priced as PRICED (free input, output $100/M), on `fetch`. */
function pricedProvider(fetch) {
  return () => ({ modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret-x", policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_m, u) => (u.output ?? 0) * PER_TOKEN, capModel: PRICED, fetch });
}

/** Every record of the "workflow" session conversation, in order (kind + data), for sessionSpendOf. */
async function rawSessionRecords(store) {
  const { harness } = await openRead(store);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    let conv;
    for (let cursor; conv === undefined; ) {
      const page = await root.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const e of page.items) if (e.kind === KINDS.sessionKey && e.data?.key === "workflow") conv = e.data.conversation;
      if (page.next === undefined) break;
      cursor = page.next;
    }
    if (conv === undefined) return [];
    const conversation = await harness.conversation(conv, BACKGROUND_CONTEXT);
    const out = [];
    for (let cursor; ; ) {
      const page = await conversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const e of page.items) out.push({ kind: e.kind, data: e.data });
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return out;
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/** The run's spend from its session records, as a reopened run reads it (sessionSpendOf). */
async function spendFromRecords(store) {
  return eight(sessionSpendOf(await rawSessionRecords(store)).spentUsd ?? 0);
}

/** Waits until `read()` of the run row satisfies `done`, or `ms` passes. */
async function waitRow(server, done, ms = 20_000) {
  const from = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    if (done(row)) return row;
    if (Date.now() - from > ms) return row;
    await sleep(20);
  }
}

test("a workflow model node books through the session proxy under the cap: the run ends and its cost is the booking", async (t) => {
  const { server, store } = await worldWith(t, { capUsd: 100, question: "What is six times seven?", usage: { input_tokens: 1000, output_tokens: 100 } });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "ended", `the run ends: ${JSON.stringify(row)}`);
  assert.equal(row.costUsd, bookOf(1000, 100), `its cost is calculateCost of the request's usage: ${row.costUsd}`);
});

test("a workflow run's served cost is its booking, never the $0 its model nodes' answers carry: its usage row and its view", async (t) => {
  const { server, store } = await worldWith(t, { capUsd: 100, question: "What is six times seven?", usage: { input_tokens: 1000, output_tokens: 100 } });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "ended", `the run ends: ${JSON.stringify(row)}`);
  const booked = await spendFromRecords(store);
  assert.ok(booked > 0, `the node's request is booked at a price: ${booked}`);
  const usage = (await runTimeline(server, "run-1", BACKGROUND_CONTEXT, { settled: true, ended: true })).findLast((one) => one.kind === "usage");
  assert.equal(eight(usage?.usage?.usd ?? 0), booked, `the usage row says the booking: ${JSON.stringify(usage)}`);
  assert.match(String(usage.summary), /^Cost: \$0\.\d{4} over 1 model request$/, `in the renderer's words: ${usage.summary}`);
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.equal(eight(view?.cost?.usd ?? 0), booked, `the view's cost is the booking: ${JSON.stringify(view?.cost)}`);
  assert.equal(eight(row.costUsd), booked, "the row's stored cost is the same booking");
});

test("a tiered model past its threshold: the hold and the booking are the tier price, not the base price (#1861)", async (t) => {
  const input = THRESHOLD + 128_000; // past the tier; the question's bytes bound the hold's input
  const question = "A".repeat(input);
  const { server, store } = await worldWith(t, { capUsd: 20, question, usage: { input_tokens: input, output_tokens: 100 } });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "ended", `the run ends: ${JSON.stringify(row)}`);

  // The booking is calculateCost at the tier (input rate 4, output rate 15), not the base (2, 10).
  const tier = bookOf(input, 100);
  const base = (input * 2 + 100 * 10) / 1e6;
  assert.ok(Math.abs(row.costUsd - tier) < 1e-9, `the booking is the tier price ${tier}: ${row.costUsd}`);
  assert.ok(tier > base + 0.1, "the tier price is above the base price (sanity)");

  // The hold on the request priced the input at the tier rate too: with the input past the threshold, the hold exceeds any
  // base-rate hold of the same request (base input + the model's whole output ceiling at the base output rate).
  const { requests } = await sessionRecords(store);
  assert.ok(requests.length >= 1, `a request was held: ${JSON.stringify(requests)}`);
  const held = requests[0].heldUsd;
  const baseHoldMax = (input * 2 + GPT6.maxTokens * 10) / 1e6;
  assert.ok(typeof held === "number" && held > baseHoldMax, `the hold is tier-priced (> any base-rate hold ${baseHoldMax}): ${held}`);
});

test("a step the cap holds parks the run with the cap's figures; a raise resumes it", async (t) => {
  // A cap too small for even the least request: the first model request is refused for room, the run parks.
  const { server, store } = await worldWith(t, { capUsd: 1e-6, question: "What is six times seven?", usage: { input_tokens: 1000, output_tokens: 100 } });
  const parked = await waitRow(server, (r) => r.state === "parked" && r.runner === null);
  assert.equal(parked.state, "parked", `the run parks at the cap: ${JSON.stringify(parked)}`);
  const budgets = await rootEntries(store, KINDS.budget);
  assert.equal(budgets.length, 1, `the park wrote one budget entry: ${JSON.stringify(budgets)}`);
  const pending = budgets[0].pending;
  assert.equal(pending.cap_usd, 1e-6, "the pending names the run's cap");
  assert.equal(pending.spent_usd, 0, "nothing was spent before the first request");
  assert.ok(pending.needs_usd > pending.cap_usd, `it needs more than the cap: ${JSON.stringify(pending)}`);
  // With nothing spent, the least cap that sends it is what it needs, rounded up to a cap figure (raiseFigure): at least
  // the need, and within a cent of it.
  assert.ok(pending.least_cap_usd >= pending.needs_usd - 1e-9 && pending.least_cap_usd <= pending.needs_usd + 0.01, `the least cap is the need rounded up: ${JSON.stringify(pending)}`);
  assert.ok(pending.suggested_cap_usd >= pending.least_cap_usd, "the suggested raise is at least the least cap");

  // A raise above the need makes the parked run claimable; the resume takes the raise and the run ends.
  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 100 } });
  const ended = await waitRow(server, (r) => r.state === "ended" && r.runner === null);
  assert.equal(ended.state, "ended", `the raise resumes the run to its end: ${JSON.stringify(ended)}`);
  assert.equal((await rootEntries(store, KINDS.raise)).length >= 1, true, "the resume wrote a raise entry");
});

/** Three model nodes (extract) in a chain, each submitting {answer}: three requests, one after another. */
const threeFlow = () => {
  const step = (n) => ({ node: "extract", label: `answer-${n}`, instructions: "Answer the question.", out: "Answer", as: `a${n}` });
  return { ...answerFlow(), name: "three", output: { schemaId: "Answer", path: "a3" }, root: { node: "chain", steps: [step(1), step(2), step(3)] } };
};

test("a workflow under a small cap parks at it once its booked spend leaves no room for the next step: the cap holds on a workflow run", async (t) => {
  // Each node's request costs $0.01 (100 output tokens at $100 a million), three in all, under a cap below their sum.
  const { server, store } = await worldWith(t, { capUsd: CAP_THREE, question: "What is six times seven?", workflow: threeFlow(), providerOf: pricedProvider(submitOrigin({ input_tokens: 100, output_tokens: 100 })) });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  const { turns } = await sessionRecords(store);
  const budgets = await rootEntries(store, KINDS.budget);
  assert.equal(row.state, "parked", `the run parks at its cap, never runs on: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  assert.equal(turns.length, 2, `two of its steps ran, never the third: ${JSON.stringify(turns)}`);
  const spent = await spendFromRecords(store);
  assert.equal(spent, 0.02, "booked at $0.01 each");
  assert.match(row.summary, /^Not sent: this run has spent \$0\.02 of its \$0\.12 cap/, `the park names the booked spend: ${row.summary}`);
  assert.ok(spent > 0 && spent <= CAP_THREE, `what it spent is booked at a price, within its cap: ${spent}`);
  assert.equal(eight(budgets.at(-1)?.pending?.spent_usd ?? 0), spent, `its park says that booked spend: ${JSON.stringify(budgets.at(-1)?.pending)}`);
});

test("a person's stop while a model node streams counts what it streamed and 1,024 tokens, never the hold", async (t) => {
  // A model node's request streams some text, then a person stops the run before it finishes: the stopped request's cost
  // is unknown, so the run books it at what it can have cost — its (free) input, each streamed byte as a token, and 1,024
  // tokens more — never past what the cap held for it. The stop-booking fix (on the money-gate base) lands the booking
  // before the run's end commit, so the records read it, not the hold.
  const origin = stallingOrigin("Half of one.md"); // 14 bytes streamed
  const { server, store } = await worldWith(t, { capUsd: 1, question: "Take your time.", providerOf: pricedProvider(origin.fetch) });
  const acting = (async () => {
    await origin.streamed;
    await sendCommand(server, "run-1", { kind: "stop", body: {} });
  })();
  acting.catch(() => {});
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  await acting;
  assert.equal(row.state, "stopped", `the person's stop ends the run: ${JSON.stringify(row)}`);
  const held = (await sessionRecords(store)).requests[0]?.heldUsd;
  assert.ok(typeof held === "number" && held > 0.5, `the request was held at most of the cap: ${held}`);
  assert.equal(await spendFromRecords(store), eight((14 + 1024) * PER_TOKEN), `14 bytes streamed and 1,024 tokens ($0.1038), not the $${held} held`);
});

test("a model node on a tier other than the default runs on that tier's model: asked, held and booked at its price", async (t) => {
  // Each tier its own model and price: the default's output $100 a million, the strong tier's $300. A node that names the
  // strong tier is asked of the strong model, held by the cap at the strong price, and booked at it, never the default's.
  const rates = { fast: 50 / 1e6, default: PER_TOKEN, strong: 300 / 1e6 };
  const asked = [];
  const tiers = [];
  const origin = submitOrigin({ input_tokens: 1000, output_tokens: 100 });
  const fetch = async (url, init = {}) => {
    asked.push(JSON.parse(String(init.body ?? "{}")).model);
    return origin(url, init);
  };
  const providerOf = (tier) => {
    tiers.push(tier);
    const id = `faux-${tier}`;
    return { modelId: id, api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret-x", policy: anthropicPolicy({ model: id, tools: [] }), price: (_m, u) => (u.output ?? 0) * rates[tier], capModel: { ...PRICED, id, price: { ...PRICED.price, output: rates[tier] * 1e6 } }, fetch };
  };
  const workflow = answerFlow();
  workflow.root.tier = "strong";
  const { server, store } = await worldWith(t, { capUsd: 100, question: "What is six times seven?", providerOf, workflow });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "ended", `the run ends: ${JSON.stringify(row)}`);
  assert.ok(tiers.includes("strong"), `the strong tier's provider is resolved: ${JSON.stringify(tiers)}`);
  assert.deepEqual(asked, ["faux-strong"], "the node's request is asked of the strong tier's model");
  assert.equal(eight(row.costUsd), eight(100 * rates.strong), `booked at the strong price: ${row.costUsd}`);
  const held = (await sessionRecords(store)).requests[0]?.heldUsd;
  assert.equal(eight(held), eight(PRICED.outputCeiling * rates.strong), `held at the strong price's bound: ${held}`);
});
