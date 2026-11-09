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

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { sendCommand } = await import("../dist/runner/commands.js");

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

/** A store with one queued workflow run (its launch body) and a runner on the workflow loop with the money spec. */
async function worldWith(t, { capUsd, question, usage }) {
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
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: answerFlow() } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { question }, title: "t", place: { mode: "runner" }, ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}) } });
  const specOf = workflowSpecOf({ store, providerOf: gpt6Provider(submitOrigin(usage)) });
  runner = startRunner({ store, createLoop: createWorkflowLoop(specOf), name: "runner-a", ...TIMING });
  return { server, store };
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
