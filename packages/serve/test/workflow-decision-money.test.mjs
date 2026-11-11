// A workflow run's DECISIONS on the runner (runner/workflow-spec.ts): a judge/pick/sift/route node books through the one
// kernel cap (run-adapters createCap admit/settle), the same figure main holds for it (serve decision-cap.ts holdOf). The
// money-parity checks:
//  - a capped workflow with a faux decision provider books main's holdOf figure (the provider reports no cost, so the
//    decision settles at its hold);
//  - an uncapped workflow prices no decision: one whose catalog price could not be read is let go, never refused;
//  - a decision whose hold does not fit the cap is refused for room and parks the run, as main's cap does, and a raise
//    resumes it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { holdOf } = await import("../dist/decision-cap.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { servedTimelineRows } = await import("../dist/run-timeline-served.js");
const { viewOverStore } = await import("../dist/store-view.js");

/** The faux System One service (serves OpenRouter's Decisions catalog and answers decisions), pointed at under --faux. */
const FAUX_SYSTEM_ONE = fileURLToPath(new URL("../../decisions/dist/testing/faux-system-one.js", import.meta.url));

// A lease no stall of a loaded machine outlasts (the steady lease): each case runs one runner, and none is about a lost
// claim, so none may lose one. On a 1 s lease a loaded box retook the run seven times mid-check (epoch 8) and a run that
// should have parked on its decision ended. The next claim the money cases read is a raise's, never a lapse.
const TIMING = { leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A one-judge-node workflow: it reads {doc} and asks one noul question (the boolean `is_coi`). */
const askFlow = () => ({
  v: 2, name: "asked",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "judge", label: "ask", provider: "openrouter", model: "openai/gpt-6-sol", state: { doc: "{doc}" }, out: "Verdict", as: "verdict" },
});

/** The gpt-6-sol decision price in OpenRouter's catalog (per token, per request, per image), as the parity test uses. */
const priceOf = (overrides = {}) => ({ promptUsd: 1.25e-6, completionUsd: 10e-6, requestUsd: 0, imageUsd: 0, maxCompletionTokens: 4_096, ...overrides });

/** An answer for each question by its type (the faux provider answers exactly what it is asked). */
const answerFor = (question) => {
  if (question.type === "noul") return { type: "noul", noul: 0.8 };
  if (question.type === "choice") { const key = Object.keys(question.criteria ?? { first: "" })[0] ?? "first"; return { type: "choice", choice: key, probabilities: { [key]: 1 } }; }
  return { type: "score", score: 0, legend: { 0: "" }, probabilities: { 0: 1 } };
};

/** A faux OpenRouter decision provider: its catalog price is `price` (null: no price), it answers each question it is
 *  asked, reports `costUsd` (null: unknown), and records the request it was sent through `record`. */
function fauxOpenrouter({ price = priceOf(), costUsd = null, record } = {}) {
  return {
    id: "openrouter",
    needs: [],
    capabilities: { types: ["noul", "choice", "score"], inputs: ["text", "json"], evidence: "none", probability: "model", grounding: false, replay: "never", maxQuestions: null, maxStateBytes: null, models: null },
    priceOf: async () => price,
    decide: async (request) => {
      record?.(request);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answerFor(question)]));
      return { answers, evidence: [], model: request.model ?? null, usage: null, cost_usd: costUsd, cost_basis: costUsd === null ? "unknown" : "reported", provider_request_id: null };
    },
  };
}

/** A model provider that is never asked (a decision-only workflow runs no model node), for providerOf's default tier. */
const idleModelProvider = () => () => ({
  modelId: "openai/gpt-6-sol", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret-x",
  policy: anthropicPolicy({ model: "openai/gpt-6-sol", tools: [] }), price: () => 0,
  capModel: { id: "openai/gpt-6-sol", api: "anthropic-messages", price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, outputCeiling: 128_000 },
  fetch: async () => { throw new Error("the decision-only workflow asked a model, which it should not"); },
});

/** An Anthropic Messages origin that answers each request by calling `submit` with `value`, reporting `usage`. */
function submitOrigin(value, usage) {
  const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    return sse([
      { type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_0", name: "submit", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(value) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
      { type: "message_stop" },
    ]);
  };
}

/** A model provider whose answered request books at `u.output` × $100/M (input free), on `fetch`; the cap prices it the
 *  same, so a model node's spend is a known figure beside a decision's (the run's one ledger holds both). */
function metedModelProvider(fetch) {
  const perToken = 100 / 1e6;
  return () => ({
    modelId: "faux-model", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret-x",
    policy: anthropicPolicy({ model: "faux-model", tools: [] }),
    price: (_m, u) => (u.output ?? 0) * perToken,
    capModel: { id: "faux-model", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 },
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

/** A store with one queued workflow run and a runner on the workflow loop. `decider` (shorthand) answers the "openrouter"
 *  provider; `deciders` gives the whole registry. `flow`/`providerOf`/`input` default to a judge-only flow on an idle model. */
async function worldWith(t, { capUsd, doc = "Certificate of incorporation of Example Widgets, Inc.", input, flow = askFlow(), providerOf = idleModelProvider(), decider, deciders }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-dec-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const providers = deciders ?? { providers: { openrouter: decider }, default: "openrouter" };
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: flow } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: input ?? { doc }, title: "t", place: { mode: "runner" }, ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}) } });
  const specOf = workflowSpecOf({ store, providerOf, decisionProvidersOf: () => providers });
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

test("a capped workflow's decision books main's hold: the provider reports no cost, so it settles at holdOf", async (t) => {
  let sent;
  const decider = fauxOpenrouter({ price: priceOf(), costUsd: null, record: (request) => (sent = request) });
  const { server } = await worldWith(t, { capUsd: 1, decider });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "ended", `the run ends: ${JSON.stringify(row)}`);
  assert.ok(sent, "the decision was sent to the provider");
  // main's hold for the exact request the provider was sent (serve decision-cap.ts holdOf), under the run's mode.
  const hold = await holdOf({ id: "openrouter", priceOf: async () => priceOf() }, { label: "ask", kind: "judge", model: sent.model, state: sent.state, questions: sent.questions }, "expected");
  assert.ok("usd" in hold && hold.usd > 0, `main holds it at a figure: ${JSON.stringify(hold)}`);
  assert.ok(Math.abs((row.costUsd ?? 0) - hold.usd) < 1e-12, `the run books main's hold ${hold.usd}: ${row.costUsd}`);
});

test("a workflow's decision counts once in its cost: its served timeline's usage row and its view each say the run's one booked cost", async (t) => {
  const decider = fauxOpenrouter({ price: priceOf(), costUsd: 0.01 });
  const { server } = await worldWith(t, { capUsd: 1, decider });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "ended", `the run ends: ${JSON.stringify(row)}`);
  assert.ok(row.costUsd > 0, `the decision is booked: ${row.costUsd}`);
  const usage = (await servedTimelineRows({ serverSecrets: () => [], keyEnv: () => ({}) }, server, "run-1", BACKGROUND_CONTEXT)).filter((one) => one.kind === "usage");
  assert.equal(usage.length, 1, `one usage row: ${JSON.stringify(usage)}`);
  assert.deepEqual([Math.round(usage[0].usage.usd * 1e9) / 1e9, usage[0].usage.requests], [Math.round(row.costUsd * 1e9) / 1e9, 1], `the decision once, on the served timeline: ${JSON.stringify(usage[0])}`);
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.equal(Math.round(view.cost.usd * 1e9) / 1e9, Math.round(row.costUsd * 1e9) / 1e9, `and once in the view's cost: ${JSON.stringify(view.cost)}`);
});

test("an uncapped workflow prices no decision: one whose catalog price could not be read is let go, never refused", async (t) => {
  // A provider with no catalog price: under a cap this decision would be refused (no price), so the run would fail; with
  // no cap it is not priced at all, the decision is answered, and the run completes.
  const decider = fauxOpenrouter({ price: null, costUsd: 0.01 });
  const { server } = await worldWith(t, { capUsd: undefined, decider });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "ended", `an uncapped decision is let go and the run completes: ${JSON.stringify(row)}`);
  assert.equal((await rootEntries(server, KINDS.budget)).length, 0, "nothing parked: the decision was not priced");
});

test("a decision whose hold does not fit the cap is refused for room and parks the run; a raise resumes it", async (t) => {
  const decider = fauxOpenrouter({ price: priceOf(), costUsd: null });
  const { server, store } = await worldWith(t, { capUsd: 1e-6, decider });
  const parked = await waitRow(server, (r) => r.state === "parked" && r.runner === null);
  assert.equal(parked.state, "parked", `the run parks at the cap: ${JSON.stringify(parked)}`);
  const budgets = await rootEntries(store, KINDS.budget);
  assert.equal(budgets.length, 1, `the park wrote one budget entry: ${JSON.stringify(budgets)}`);
  const pending = budgets[0].pending;
  assert.equal(pending.cap_usd, 1e-6, "the pending names the run's cap");
  assert.equal(pending.spent_usd, 0, "nothing was spent before the first decision");
  assert.ok(pending.needs_usd > pending.cap_usd, `it needs more than the cap: ${JSON.stringify(pending)}`);
  assert.ok(pending.least_cap_usd >= pending.needs_usd - 1e-9 && pending.least_cap_usd <= pending.needs_usd + 0.01, `the least cap is the need rounded up: ${JSON.stringify(pending)}`);
  assert.ok(pending.suggested_cap_usd >= pending.least_cap_usd, "the suggested raise is at least the least cap");

  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 100 } });
  const ended = await waitRow(server, (r) => r.state === "ended" && r.runner === null);
  assert.equal(ended.state, "ended", `the raise resumes the run to its end: ${JSON.stringify(ended)}`);
});

/** A model node (extract) then a decision node: the model's spend and the decision's draw on one cap. */
const mixedFlow = () => ({
  v: 2, name: "mixed",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Mid: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "chain", steps: [
    { node: "extract", label: "note", instructions: "Note the doc.", out: "Mid", as: "note_out" },
    { node: "judge", label: "ask", provider: "openrouter", model: "openai/gpt-6-sol", state: { doc: "{doc}" }, out: "Verdict", as: "verdict" },
  ] },
});

test("a mixed model+decision run parks on the decision with the run's whole spend, as main holds it (one ledger)", async (t) => {
  // The model node books a known cost; the decision after it does not fit what is left, so it parks. The park's spent is
  // the model's cost, which proves the decision is judged on the run's model spend (the one cap), not on its own alone.
  const decider = fauxOpenrouter({ price: priceOf({ promptUsd: 0, completionUsd: 0, requestUsd: 10, maxCompletionTokens: 4_096 }), costUsd: null });
  const { server, store } = await worldWith(t, {
    capUsd: 1,
    flow: mixedFlow(),
    providerOf: metedModelProvider(submitOrigin({ note: "ok" }, { input_tokens: 10, output_tokens: 100 })),
    decider,
  });
  const parked = await waitRow(server, (r) => r.state === "parked" && r.runner === null);
  assert.equal(parked.state, "parked", `the decision parks the run after the model node booked: ${JSON.stringify(parked)}`);
  const pending = (await rootEntries(store, KINDS.budget))[0]?.pending;
  assert.ok(pending, "a budget entry was written");
  assert.equal(pending.cap_usd, 1, "the pending names the run's cap");
  // The model node booked 100 output tokens × $100/M = $0.01; the park's spent is that, the run's model spend.
  assert.ok(Math.abs(pending.spent_usd - 0.01) < 1e-9, `the park's spent is the model's $0.01, one ledger: ${JSON.stringify(pending)}`);
  assert.ok(Math.abs(pending.needs_usd - 10) < 1e-9, `the decision needs its $10 request fee: ${JSON.stringify(pending)}`);
});

/** Two decision nodes in a chain: the second is judged beside the first's booked spend. */
const twoJudgeFlow = () => ({
  v: 2, name: "two",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is it a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict2" },
  root: { node: "chain", steps: [
    { node: "judge", label: "ask1", provider: "openrouter", model: "openai/gpt-6-sol", state: { doc: "{doc}" }, out: "Verdict", as: "verdict1" },
    { node: "judge", label: "ask2", provider: "openrouter", model: "openai/gpt-6-sol", state: { doc: "{doc}" }, out: "Verdict", as: "verdict2" },
  ] },
});

test("a decision booked before a claim ends still counts after the next claim: the cap is never passed across a resume", async (t) => {
  // The first decision books $0.40; the second does not fit the $0.50 cap beside it, so the run parks after the first is
  // booked. A raise resumes a fresh claim: the first is replayed from the journal (never re-charged), its $0.40 still
  // counts, and the second now fits. The run books $0.40 + $0.40, each once.
  const decider = fauxOpenrouter({ price: priceOf({ promptUsd: 0, completionUsd: 0, requestUsd: 0.4, maxCompletionTokens: 4_096 }), costUsd: 0.4 });
  const { server, store } = await worldWith(t, { capUsd: 0.5, flow: twoJudgeFlow(), decider });
  const parked = await waitRow(server, (r) => r.state === "parked" && r.runner === null);
  assert.equal(parked.state, "parked", `the second decision parks the run after the first booked: ${JSON.stringify(parked)}`);
  const pending = (await rootEntries(store, KINDS.budget))[0]?.pending;
  assert.ok(pending && Math.abs(pending.spent_usd - 0.4) < 1e-9, `the park's spent is the first decision's $0.40: ${JSON.stringify(pending)}`);

  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 2 } });
  const ended = await waitRow(server, (r) => r.state === "ended" && r.runner === null);
  assert.equal(ended.state, "ended", `the raise resumes a fresh claim and the run ends: ${JSON.stringify(ended)}`);
  // Both decisions booked once each ($0.40 + $0.40); the first was not re-charged on the resume, and its spend survived.
  assert.ok(Math.abs((ended.costUsd ?? 0) - 0.8) < 1e-9, `the run books $0.40 + $0.40 across the two claims: ${ended.costUsd}`);
});

/** A one-judge workflow naming `provider`/`model`, for the production decision-provider path. */
const askProvider = (provider, model) => ({
  v: 2, name: "asked",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "judge", label: "ask", provider, ...(model ? { model } : {}), state: { doc: "{doc}" }, out: "Verdict", as: "verdict" },
});

/** A store with one queued judge run and a runner whose spec builds the decision providers from the run's SEALED keys
 *  (claim-secrets.ts + decisionProvidersIn), under --faux so the OpenRouter provider answers through the faux System One.
 *  `seal` are the provider keys to seal in the store; `capUsd` is omitted (uncapped) by default. */
async function sealedWorld(t, { seal, flow = askProvider("openrouter", "liquid/d1"), capUsd }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-sealed-"));
  const sealKey = randomBytes(32);
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(seal)) await putSealedKey(store, sealKey, name, value);
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: flow } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { doc: "Certificate of incorporation of Example Widgets, Inc." }, title: "t", place: { mode: "runner" }, ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}) } });
  // No decisionProvidersOf injected: the spec reads the run's keys from the store (sealKey). The decision keys are never in
  // this process's environment — only the faux-service pointers are, so a decision that runs got its key from the store.
  const specOf = workflowSpecOf({ store, sealKey, env: { AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_OPENROUTER: FAUX_SYSTEM_ONE }, providerOf: idleModelProvider() });
  runner = startRunner({ store, createLoop: createWorkflowLoop(specOf), name: "runner-a", ...TIMING });
  return { server };
}

test("a workflow decision on the runner runs on the run's stored provider key (claim secrets)", async (t) => {
  // The OpenRouter key is only in the store (sealed), never in the runner's environment; the spec reads it per claim and
  // builds the provider from it, so the decision is answered (through the faux service) and the run completes.
  const { server } = await sealedWorld(t, { seal: { OPENROUTER_API_KEY: `not-a-secret-${"stored"}` } });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "ended", `the decision ran on the run's stored key and the run ended: ${JSON.stringify(row)}`);
});

/** A chain whose first decision names `provider`, the second Jev: the run's keys cover Jev but not `provider`. */
const chainProviders = (provider) => ({
  v: 2, name: "chain",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict2" },
  root: { node: "chain", steps: [
    { node: "judge", label: "ask1", provider, state: { doc: "{doc}" }, out: "Verdict", as: "verdict1" },
    { node: "judge", label: "ask2", provider: "jev", state: { doc: "{doc}" }, out: "Verdict", as: "verdict2" },
  ] },
});

test("a run without the decision provider's stored key fails: the provider the run has no key for is refused, as main refuses it", async (t) => {
  // The run has the Jev key (TypeSafe) but no Parallel key, and its first node names Parallel. The spec builds the provider
  // registry from the run's own stored keys (Jev only), and the Parallel node is refused by main's decision-provider check
  // (checkDecisionProviders names the provider it lacks), the decision node's own failure — never asked of another provider
  // or run on this process's keys. The only difference from the passing run is the missing key, so the key is what gates it.
  const { server } = await sealedWorld(t, { seal: { TYPESAFE_API_KEY: `not-a-secret-${"jev"}` }, flow: chainProviders("parallel") });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.equal(row.state, "failed", `the run fails without the Parallel key: ${JSON.stringify(row)}`);
});

// ---- The cases the run's old in-process cap checked at its unit, here on the runner: a raise on a capped run, a raise
// finishing its pause, a decision at its cap, the catalog down mid-run, a map's items under one cap, a hold kept only once
// its request is admitted, and a refusal its provider did not bill.

/** A decision price that is its request fee alone: the hold is exactly `usd`. */
const feeOnly = (usd) => priceOf({ promptUsd: 0, completionUsd: 0, requestUsd: usd, maxCompletionTokens: 4_096 });

/** The run's budget entries (its pauses at the cap), oldest first, and its row once `done` holds and no runner has it. */
async function settledAt(server, store, done) {
  const row = await waitRow(server, (r) => r.runner === null && done(r));
  return { row, budgets: await rootEntries(store, KINDS.budget) };
}

/** Waits until the command `id` is taken or refused, and returns its row. */
async function commandSettled(server, id, ms = 20_000) {
  const from = Date.now();
  for (;;) {
    const row = (await server.commands("run-1", id - 1)).find((one) => one.id === id);
    if (row && (row.takenAt !== null || row.refused !== null)) return row;
    if (Date.now() - from > ms) return row;
    await sleep(20);
  }
}

test("a raise too small for the decision it parked at sends the run on, and the decision, judged again at the raised cap, parks it anew: its pause names the raised cap, never the old one", async (t) => {
  const decider = fauxOpenrouter({ price: feeOnly(10), costUsd: null });
  const { server, store } = await worldWith(t, { capUsd: 1, decider });
  const first = await settledAt(server, store, (r) => r.state === "parked");
  assert.deepEqual([first.row.state, first.budgets.length, first.budgets[0]?.pending.cap_usd], ["parked", 1, 1], JSON.stringify(first));

  // $2 is above the $1 cap still refused but under the $10 the decision needs.
  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 2 } });
  const again = await settledAt(server, store, (r) => r.state === "parked" && r.epoch > first.row.epoch);
  assert.equal(again.row.state, "parked", `the decision, judged again at $2, parks the run anew: ${JSON.stringify(again.row)}`);
  const pending = again.budgets.at(-1)?.pending;
  assert.deepEqual([pending?.cap_usd, pending?.needs_usd], [2, 10], `the pause stands at the raised cap: ${JSON.stringify(again.budgets)}`);
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.deepEqual([view.status, view.pending?.kind, view.pending?.cap_usd], ["input_required", "budget", 2], `the person sees the pause at $2: ${JSON.stringify(view.pending)}`);
  assert.equal(again.row.costUsd ?? 0, 0, "nothing was sent or booked");
});

test("a raise finishes a pause only above the cap still refused: the same raise again, or one under it, leaves the run parked where it stands; one past the need resumes it to its end with the pause gone", async (t) => {
  let asked = 0;
  const decider = fauxOpenrouter({ price: feeOnly(10), costUsd: null, record: () => (asked += 1) });
  const { server, store } = await worldWith(t, { capUsd: 1, decider });
  const first = await settledAt(server, store, (r) => r.state === "parked");
  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 2 } });
  const at2 = await settledAt(server, store, (r) => r.state === "parked" && r.epoch > first.row.epoch);
  assert.equal(at2.budgets.at(-1)?.pending.cap_usd, 2, JSON.stringify(at2.budgets));

  // The raise the run already has, again: a retry of the last, which resumed the pause before this one; it opens nothing.
  const same = await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 2 } });
  const sameRow = await commandSettled(server, same.id);
  assert.ok(sameRow && (sameRow.takenAt !== null || sameRow.refused !== null), `the same raise again is answered: ${JSON.stringify(sameRow)}`);
  // One under the cap the run has: refused in the cap's words.
  const under = await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 1.5 } });
  const underRow = await commandSettled(server, under.id);
  assert.match(underRow?.refused ?? "", /only raised/, `a raise under the cap is refused: ${JSON.stringify(underRow)}`);
  const still = await settledAt(server, store, (r) => r.state === "parked");
  assert.deepEqual([still.row.state, still.budgets.at(-1)?.pending.cap_usd, still.row.costUsd ?? 0, asked], ["parked", 2, 0, 0], `the run stands parked at its $2 pause, nothing sent: ${JSON.stringify(still)}`);
  const parkedView = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.deepEqual([parkedView.pending?.kind, parkedView.pending?.cap_usd], ["budget", 2], `its pause still shows at $2: ${JSON.stringify(parkedView.pending)}`);

  // Past the need: the pause is finished, the decision sent once, and the run ends with no pause to show.
  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 20 } });
  const ended = await waitRow(server, (r) => r.state === "ended" && r.runner === null);
  assert.equal(ended.state, "ended", JSON.stringify(ended));
  assert.deepEqual([asked, Math.round((ended.costUsd ?? 0) * 1e9) / 1e9], [1, 10], "the decision sent once, booked at its $10 hold");
  const view = await viewOverStore(server, "run-1", { origin: "", serverSecrets: () => [] });
  assert.equal(view.pending, null, `no pause once it ended: ${JSON.stringify(view.pending)}`);
});

test("a decision at its cap: a hold that is exactly the room left is sent and booked; one a hair over it parks the run unsent", async (t) => {
  await t.test("exactly the room", async (t) => {
    let asked = 0;
    const decider = fauxOpenrouter({ price: feeOnly(0.4), costUsd: null, record: () => (asked += 1) });
    const { server } = await worldWith(t, { capUsd: 0.4, decider });
    const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
    assert.deepEqual([row.state, asked, Math.round((row.costUsd ?? 0) * 1e9) / 1e9], ["ended", 1, 0.4], JSON.stringify(row));
  });
  await t.test("a hair over", async (t) => {
    let asked = 0;
    const decider = fauxOpenrouter({ price: feeOnly(0.4), costUsd: null, record: () => (asked += 1) });
    const { server, store } = await worldWith(t, { capUsd: 0.3999, decider });
    const parked = await settledAt(server, store, (r) => r.state === "parked");
    assert.deepEqual([parked.row.state, asked, parked.budgets[0]?.pending.cap_usd, parked.budgets[0]?.pending.needs_usd], ["parked", 0, 0.3999, 0.4], JSON.stringify(parked));
  });
});

test("OpenRouter's catalog down for a moment mid-run under a cap: the price is read again and the decision is sent, never stopped by the cap", async (t) => {
  let down = 1;
  let reads = 0;
  let asked = 0;
  const decider = { ...fauxOpenrouter({ price: feeOnly(0.01), costUsd: null, record: () => (asked += 1) }), priceOf: async () => { reads += 1; if (down-- > 0) throw new Error("catalog 503"); return feeOnly(0.01); } };
  const { server } = await worldWith(t, { capUsd: 1, decider });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.deepEqual([row.state, asked, reads], ["ended", 1, 2], `read again, then sent: ${JSON.stringify(row)}`);
});

test("OpenRouter's catalog unreadable for good mid-run under a cap (down, or a 200 with no list of models): the decision is never sent and its node fails, never a stop of the cap's", async (t) => {
  const { openrouterProvider } = await import("@parcha/agentrun-decisions");
  for (const [name, answer] of [["down", () => new Response("upstream", { status: 503 })], ["no list", () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })]]) {
    await t.test(name, async (t) => {
      let calls = 0;
      const real = openrouterProvider({ apiKey: `not-a-secret-${"openrouter"}`, fetch: async () => ((calls += 1), answer()) });
      let asked = 0;
      const decider = { ...fauxOpenrouter({ price: feeOnly(0.01), costUsd: null, record: () => (asked += 1) }), priceOf: (model) => real.priceOf(model) };
      const { server, store } = await worldWith(t, { capUsd: 1, decider });
      const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
      assert.equal(row.state, "failed", JSON.stringify(row));
      assert.equal(asked, 0, "the decision was never sent");
      assert.ok(calls >= 2, `the catalog was read again before the decision failed: ${calls}`);
      assert.doesNotMatch(String(row.error ?? row.summary ?? ""), /spend_cap_reached|out of budget/, `a catalog outage is no stop of the cap's: ${JSON.stringify(row)}`);
      assert.equal((await rootEntries(store, KINDS.budget)).length, 0, "nothing parked");
    });
  }
});

/** A map of two documents, each judged once (two decisions under one cap, at paths of their own). */
const mapFlow = () => ({
  v: 2, name: "mapped",
  schemas: {
    In: { type: "object", required: ["docs"], properties: { docs: { type: "array", items: { type: "string" } } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
    Out: { type: "object", required: ["count"], properties: { count: { type: "integer" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Out", path: "result" },
  root: { node: "chain", steps: [
    { node: "map", label: "each", itemsPath: "docs", as: "verdicts", resultPath: "verdict", maxConcurrency: 2,
      body: { node: "judge", label: "ask", provider: "openrouter", model: "openai/gpt-6-sol", state: { doc: "{item}" }, out: "Verdict", as: "verdict" } },
    { node: "code", label: "result", code: "(s) => ({ result: { count: s.verdicts.length } })" },
  ] },
});

test("a map's two decisions under one cap with room for one: the run parks once at the item that does not fit, one raise sends it on, and each item is answered and booked once", async (t) => {
  const asked = [];
  const decider = fauxOpenrouter({ price: feeOnly(0.4), costUsd: 0.4, record: (request) => asked.push(request.state?.doc) });
  const { server, store } = await worldWith(t, { capUsd: 0.5, flow: mapFlow(), input: { docs: ["first", "second"] }, decider });
  const parked = await settledAt(server, store, (r) => r.state === "parked" || r.state === "ended" || r.state === "failed");
  assert.equal(parked.row.state, "parked", `one item does not fit beside the other: ${JSON.stringify(parked)}`);
  assert.equal(parked.budgets.length, 1, `one pause: ${JSON.stringify(parked.budgets)}`);
  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 2 } });
  const ended = await waitRow(server, (r) => (r.state === "ended" || r.state === "failed") && r.runner === null);
  assert.equal(ended.state, "ended", `the raise sends the run on to its end, never to a review: ${JSON.stringify(ended)}`);
  assert.deepEqual([...asked].sort(), ["first", "second"], `each item asked once: ${JSON.stringify(asked)}`);
  assert.ok(Math.abs((ended.costUsd ?? 0) - 0.8) < 1e-9, `each item booked once: ${ended.costUsd}`);
});

test("a decision's hold is kept only once the driver has admitted its request: a runner that dies at its first write after pricing a decision never leaves a hold the next claim counts beside asking the decision again", async (t) => {
  // The stores' clock is real time plus `skew`, so the dead runner's claim is run out by moving it, never by waiting.
  let skew = 0;
  const now = () => Date.now() + skew;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-dec-crash-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const real = await openSqliteStore({ dataDir: dir, role: "runner", now });
  const second = await openSqliteStore({ dataDir: dir, role: "runner", now });
  const runners = [];
  // Runner A's last write never comes back while the case runs; once it is done (runner B holds the run under a later
  // claim, so nothing A does now lands) it fails, so A's claim unwinds and its proxies close.
  let unstick = () => {};
  t.after(async () => {
    unstick();
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of [real, second, server]) await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // Runner A's store: once the decision is priced (armed), the next flush lands and then A dies there, before anything is
  // sent: what that flush made durable (a hold, the driver's admission, or both) is what runner B finds.
  let armed = false;
  let died = false;
  let diedNow;
  const dead = new Promise((resolve) => (diedNow = resolve));
  const store = new Proxy(real, { get(target, key) {
    if (key === "flush") return async (...args) => {
      await target.flush(...args);
      if (!armed || died) return;
      died = true;
      runners[0].kill();
      diedNow();
      await new Promise((_, reject) => (unstick = () => reject(new Error("runner A died at this write"))));
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const asked = [];
  const base = fauxOpenrouter({ price: feeOnly(0.4), costUsd: 0.4, record: (request) => asked.push(request) });
  const decider = { ...base, priceOf: async (model) => { if (!died) armed = true; return base.priceOf(model); } };
  const providers = { providers: { openrouter: decider }, default: "openrouter" };
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: askFlow() } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { doc: "Certificate of incorporation of Example Widgets, Inc." }, title: "t", place: { mode: "runner" }, max_cost_usd: 1 } });
  runners.push(startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf: idleModelProvider(), decisionProvidersOf: () => providers })), name: "runner-a", ...TIMING }));
  await dead;
  assert.equal(asked.length, 0, "runner A died before the decision was sent");
  // Runner A's claim runs out; runner B takes the run over.
  skew += TIMING.leaseMs + 60_000;
  runners.push(startRunner({ store: second, createLoop: createWorkflowLoop(workflowSpecOf({ store: second, providerOf: idleModelProvider(), decisionProvidersOf: () => providers })), name: "runner-b", ...TIMING }));
  const ended = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  // Runner A's write made the request admitted (runner B never asks it again: the driver escalates it, asked and never
  // answered) or it did not (runner B asks it once). Either way the run counts it once at most: a hold kept before the
  // admission would be counted cut beside runner B's own, $0.80 for one $0.40 decision.
  assert.ok(asked.length <= 1, `asked at most once: ${asked.length}`);
  assert.ok((ended.costUsd ?? 0) <= 0.4 + 1e-9, `the decision counted once at most, never its dead runner's hold beside a second ask: ${JSON.stringify(ended)}`);
  if (asked.length === 1) assert.deepEqual([ended.state, Math.round((ended.costUsd ?? 0) * 1e9) / 1e9], ["ended", 0.4], `asked by runner B, booked at what it charged: ${JSON.stringify(ended)}`);
});

test("a decision its provider refuses unbilled (rate limited) charged nothing: its hold is booked at $0, and the run's cost says $0", async (t) => {
  const { DecisionProviderError } = await import("@parcha/agentrun-dsl");
  let asked = 0;
  const decider = { ...fauxOpenrouter({ price: feeOnly(0.4), costUsd: null }), decide: async () => { asked += 1; throw new DecisionProviderError("rate_limited", "too many requests"); } };
  const { server } = await worldWith(t, { capUsd: 1, decider });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.deepEqual([row.state, asked, row.costUsd], ["failed", 1, 0], `asked once, refused unbilled, nothing counted: ${JSON.stringify(row)}`);
});

test("a decision the cap refuses inside its admission parks the run only once the driver's commit of its failed end has landed: a commit the store refuses there never leaves the run parked with the decision still asked", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-dec-refused-commit-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const real = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await real.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // Once the decision is priced (armed), the first commit is the driver's admission of the request, which lands; the next
  // is its end, failed and unsent after the cap refused it for room, which the store refuses.
  let armed = false;
  let stored = 0;
  let refusedOne = false;
  const store = new Proxy(real, { get(target, key) {
    if (key === "journal") return (claim) => {
      const journal = target.journal(claim);
      return new Proxy(journal, { get(inner, property) {
        const value = Reflect.get(inner, property, inner);
        if (property !== "commit") return typeof value === "function" ? value.bind(inner) : value;
        return async (...args) => {
          if (armed && !refusedOne && stored >= 1) {
            refusedOne = true;
            throw new Error("the store refused this commit");
          }
          const result = await value.apply(inner, args);
          if (armed && result.stored > 0) stored += 1;
          return result;
        };
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const base = fauxOpenrouter({ price: feeOnly(10), costUsd: null });
  const decider = { ...base, priceOf: async (model) => { armed = true; return base.priceOf(model); } };
  const providers = { providers: { openrouter: decider }, default: "openrouter" };
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: askFlow() } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { doc: "Certificate of incorporation of Example Widgets, Inc." }, title: "t", place: { mode: "runner" }, max_cost_usd: 1 } });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf: idleModelProvider(), decisionProvidersOf: () => providers })), name: "runner-a", ...TIMING });
  const row = await waitRow(server, (r) => r.state !== "running" && r.state !== "queued" && r.runner === null);
  assert.ok(refusedOne, "the store refused the commit after the admission");
  assert.notEqual(row.state, "parked", `a refused commit of the decision's failed end is thrown, never a park with the decision still asked: ${JSON.stringify(row)}`);
});
