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

/** The faux System One service (serves OpenRouter's Decisions catalog and answers decisions), pointed at under --faux. */
const FAUX_SYSTEM_ONE = fileURLToPath(new URL("../../decisions/dist/testing/faux-system-one.js", import.meta.url));

const TIMING = { leaseMs: 1_000, renewEveryMs: 250, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
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
