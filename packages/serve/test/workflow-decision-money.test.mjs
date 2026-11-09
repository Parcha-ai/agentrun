// A workflow run's DECISIONS on the runner (runner/workflow-spec.ts): a judge/pick/sift/route node books through the one
// kernel cap (run-adapters createCap admit/settle), the same figure main holds for it (serve decision-cap.ts holdOf). The
// money-parity checks:
//  - a capped workflow with a faux decision provider books main's holdOf figure (the provider reports no cost, so the
//    decision settles at its hold);
//  - an uncapped workflow prices no decision: one whose catalog price could not be read is let go, never refused;
//  - a decision whose hold does not fit the cap is refused for room and parks the run, as main's cap does, and a raise
//    resumes it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A store with one queued judge workflow run and a runner on the workflow loop, its decisions answered by `decider`. */
async function worldWith(t, { capUsd, doc = "Certificate of incorporation of Example Widgets, Inc.", decider }) {
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
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: askFlow() } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { doc }, title: "t", place: { mode: "runner" }, ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}) } });
  const specOf = workflowSpecOf({ store, providerOf: idleModelProvider(), decisionProvidersOf: () => ({ providers: { openrouter: decider }, default: "openrouter" }) });
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
