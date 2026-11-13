// Step guards in a learned workflow's call (runner/step-guard.ts, through runLearned): a guarded step's p from its own
// confidence (self), one Jev call over its input and output (jev), or both (a fitted logistic, else the lower); below the
// guard's threshold the call hands the job back with the guard's row in its words and its trace; at or above it the
// workflow answers. A guard's Jev is a decision of the call on the run's decisions, as a decision node's is: held to
// the run's gate on jev, admitted on its one cap and settled at what it charged (the workflow's cost). Each check is a
// row the run's metrics keep (`guards`). The model is a stand-in registry, Jev the tests' fake (faux-jev.mjs: every yes
// 0.92) under the faux switch: no network, no key.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY } from "./fixtures/faux-jev.mjs";
import { scratch, withEnv } from "./support.mjs";
import { learnedWorkflowTool } from "../dist/learned-workflow.js";
import { guardsOf, LEARNED_NODES } from "../dist/learned-nodes.js";
import { guardP, JEV_GUARD_MODEL } from "../dist/runner/step-guard.js";
import { pathMetrics } from "../dist/runner/workflow-first.js";
import { decisionProvidersIn, providersNamed } from "../dist/decisions.js";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const MODEL = { id: "stand-in", provider: "stand-in", api: "stand-in", name: "stand-in", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content, stopReason) => ({ role: "assistant", content, stopReason, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage, timestamp: Date.now() });

/** A workflow of one guarded step answering the question: an agent node (it reports its confidence) or an extract. */
const flowOf = (guard, kind = "agent") => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: kind, label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer", ...(kind === "agent" ? { tools: [] } : {}), guard },
});

/** The run's decisions on the faux Jev, as the adapter loop hands them (decisionProvidersIn over the claim's keys, its
 *  one cap's ledger.decisions): each request the Jev provider was asked, each admission and settle; `env`: the faux's. */
async function decisionsOf(t, env = {}) {
  const calls = join(await scratch(t), "jev.jsonl");
  // Its calls filed in `calls`, each charged $0.00002; no failure, hang or missing usage but what `env` sets.
  withEnv(t, { AGENTRUN_TEST_FAUX_JEV_CALLS: calls, AGENTRUN_TEST_FAUX_JEV_COST: "0.00002", ...env }, ["AGENTRUN_TEST_FAUX_JEV_STATUS", "AGENTRUN_TEST_FAUX_JEV_HANG", "AGENTRUN_TEST_FAUX_JEV_NO_USAGE"]);
  const registry = await decisionProvidersIn({ TYPESAFE_API_KEY: CANARY, AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV });
  const asked = [];
  const jev = registry.providers.jev;
  const providers = { ...registry, providers: { ...registry.providers, jev: { ...jev, decide: (request, ctx) => (asked.push(request), jev.decide(request, ctx)) } } };
  const admitted = [];
  const settled = [];
  const book = {
    async admit(request) { admitted.push(request); return { holdUsd: 0.001 }; },
    async settle(id, how) { settled.push([id, how]); return how.usd ?? null; },
    spentUsd: () => settled.reduce((sum, [, how]) => sum + (how.usd ?? 0), 0),
    heldUsd: () => 0,
  };
  const sent = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { decisions: { providers, book, pause: async () => assert.fail("no pause") }, asked, admitted, settled, book, sent };
}

/** One learned_workflow call of `flow` on a stand-in model that submits `submitted` (its confidence beside its record),
 *  with the run's `decisions` and gate `policy`: what it said, the entries it kept (its trace) and the trace's nodes. */
async function call(t, flow, { submitted = { answer: 42 }, decisions, policy = () => "allow" } = {}) {
  const work = mkdtempSync(join(tmpdir(), "learned-guard-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const models = {
    getModel: () => MODEL,
    getModels: () => [MODEL],
    completeSimple: async (_model, context) => {
      const answered = (context?.messages ?? []).some((m) => m.role === "toolResult");
      return answered ? message([{ type: "text", text: "Done." }], "stop") : message([{ type: "toolCall", id: "submit-1", name: "submit", arguments: { value: submitted } }], "toolUse");
    },
  };
  const tool = learnedWorkflowTool({ workflows: [{ name: "answer", description: "Answers a question", workflow: JSON.stringify(flow) }], granted: [], env: {}, work, models, modelOf: () => ({ provider: "stand-in", modelId: "stand-in" }), policy, denyFrom: () => "agent", ...(decisions ? { decisions } : {}) });
  const kept = [];
  const api = { callId: "call-1", commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const said = await tool.execute({ name: "answer", input: { question: "six times seven" } }, api, { abortSignal: new AbortController().signal });
  const nodes = kept.find((entry) => entry.kind === LEARNED_NODES)?.data?.nodes ?? [];
  return { said, kept, nodes, text: (said.output ?? []).map((part) => part.text ?? "").join("") };
}

test("self: a step not sure enough of itself hands the job back with its guard's row; one sure enough answers", { timeout: 60_000 }, async (t) => {
  const guard = { signal: "self", threshold: 0.7 };
  const low = await call(t, flowOf(guard), { submitted: { answer: 41, confidence: 0.3 } });
  assert.equal(low.said.isError, true, low.text);
  assert.match(low.text, /handed the job back at its step "answer": its guard put the chance this step is right at 0\.30/);
  assert.match(low.text, /Its guards: guard on "answer" \(self\): p 0\.30 against threshold 0\.7 \(its own confidence 0\.30\); handed back\./);
  assert.match(low.text, /- answer: \{"answer":41\}/, "what it had found, without its confidence");
  assert.deepEqual(low.nodes.map(({ label, status, guard: row }) => ({ label, status, guard: row })), [{ label: "answer", status: "escalated", guard: { node: "answer", signal: "self", self: 0.3, p: 0.3, threshold: 0.7, escalated: true } }]);

  const high = await call(t, flowOf(guard), { submitted: { answer: 42, confidence: 0.9 } });
  assert.equal(high.said.isError, false, high.text);
  assert.match(high.text, /42/);
  assert.doesNotMatch(high.text, /confidence/, "the step's confidence is not the workflow's answer");
  assert.deepEqual(high.nodes[0]?.guard, { node: "answer", signal: "self", self: 0.9, p: 0.9, threshold: 0.7, escalated: false });
});

test("jev: one Jev decision over the step's input and output, on the pinned model, admitted on the run's cap and settled at its charge", { timeout: 60_000 }, async (t) => {
  const run = await decisionsOf(t);
  const served = await call(t, flowOf({ signal: "jev", threshold: 0.9, question: "Is 42 the product asked for?" }, "extract"), { decisions: run.decisions });
  assert.equal(served.said.isError, false, served.text);
  assert.equal(run.sent().length, 1, "one Jev call");
  assert.equal(run.sent()[0].authorized, true, "on the run's Jev key");
  const [asked] = run.asked;
  assert.equal(asked.model, JEV_GUARD_MODEL.typesafe);
  assert.equal(JEV_GUARD_MODEL.typesafe, "jev-1.14.0");
  assert.deepEqual({ label: asked.label, path: asked.executionPath }, { label: "answer guard", path: "/root#guard" });
  assert.deepEqual(asked.state, { step: "answer", input: { question: "six times seven" }, output: { answer: 42 } });
  assert.deepEqual(Object.values(asked.questions).map(({ type, instructions }) => ({ type, instructions })), [{ type: "noul", instructions: "Is 42 the product asked for?" }]);
  assert.deepEqual(served.nodes[0]?.guard, { node: "answer", signal: "jev", jev: 0.92, p: 0.92, threshold: 0.9, escalated: false });
  // Admitted on the run's one cap before it was sent, settled at what Jev charged: the workflow's cost.
  assert.equal(run.admitted.length, 1);
  assert.equal(run.admitted[0].kind, "decision");
  assert.deepEqual(run.settled.map(([id, how]) => [id, how.end]), [[run.admitted[0].id, "charged"]]);
  assert.ok(Math.abs(run.book.spentUsd() - 0.00002) < 1e-12, `the run's spend: ${run.book.spentUsd()}`);

  const handed = await call(t, flowOf({ signal: "jev", threshold: 0.95 }, "extract"), { decisions: (await decisionsOf(t)).decisions });
  assert.equal(handed.said.isError, true, handed.text);
  assert.match(handed.text, /Its guards: guard on "answer" \(jev\): p 0\.92 against threshold 0\.95 \(Jev 0\.92\); handed back\./);
});

test("jev with no Jev, jev set to deny, or a Jev that fails: no p, so the step hands back, never passes", { timeout: 60_000 }, async (t) => {
  const none = await call(t, flowOf({ signal: "jev", threshold: 0.1 }, "extract"));
  assert.equal(none.said.isError, true, none.text);
  assert.match(none.text, /guard on "answer" \(jev\): p none against threshold 0\.1 \(Jev none\); handed back/);
  assert.deepEqual(none.nodes[0]?.guard, { node: "answer", signal: "jev", p: null, threshold: 0.1, escalated: true });
  const denied = await decisionsOf(t);
  const refused = await call(t, flowOf({ signal: "jev", threshold: 0.1 }, "extract"), { decisions: denied.decisions, policy: (name) => (name === "jev" ? "deny" : "allow") });
  assert.equal(refused.said.isError, true, refused.text);
  assert.equal(refused.nodes[0]?.guard?.p, null);
  assert.equal(denied.sent().length, 0, "a denied Jev is never sent");
  const broken = await decisionsOf(t, { AGENTRUN_TEST_FAUX_JEV_STATUS: "401" });
  const failed = await call(t, flowOf({ signal: "jev", threshold: 0.1 }, "extract"), { decisions: broken.decisions });
  assert.equal(failed.said.isError, true, failed.text);
  assert.equal(failed.nodes[0]?.guard?.p, null);
});

test("both: the lower of self and Jev with no fit; through the fitted logistic with one", { timeout: 60_000 }, async (t) => {
  const unfitted = await call(t, flowOf({ signal: "both", threshold: 0.65 }), { submitted: { answer: 42, confidence: 0.6 }, decisions: (await decisionsOf(t)).decisions });
  assert.equal(unfitted.said.isError, true, unfitted.text);
  assert.deepEqual(unfitted.nodes[0]?.guard, { node: "answer", signal: "both", self: 0.6, jev: 0.92, p: 0.6, threshold: 0.65, escalated: true });
  assert.match(unfitted.text, /guard on "answer" \(both\): p 0\.60 against threshold 0\.65 \(its own confidence 0\.60, Jev 0\.92\); handed back/);
  const fit = { w: [2, 3], b: -3, n: 140, fitted_at: "2026-11-13T05:02:00Z" };
  const fitted = await call(t, flowOf({ signal: "both", threshold: 0.65, fit }), { submitted: { answer: 42, confidence: 0.6 }, decisions: (await decisionsOf(t)).decisions });
  assert.equal(fitted.said.isError, false, fitted.text);
  const p = 1 / (1 + Math.exp(-(-3 + 2 * 0.6 + 3 * 0.92)));
  assert.ok(Math.abs(fitted.nodes[0]?.guard?.p - p) < 1e-12, JSON.stringify(fitted.nodes[0]));
  assert.equal(fitted.nodes[0]?.guard?.escalated, false);
  // The combine on its own: raw probabilities in; a missing one is no p.
  assert.equal(guardP({ signal: "both" }, { self: 0.4, jev: 0.8 }), 0.4);
  assert.equal(guardP({ signal: "both" }, { self: 0.4, jev: null }), null);
  assert.equal(guardP({ signal: "self" }, { self: null, jev: 0.8 }), null);
  assert.ok(Math.abs(guardP({ signal: "jev", fit: { w: [4], b: -2, n: 30, fitted_at: "2026-11-13T05:02:00Z" } }, { self: null, jev: 0.5 }) - 0.5) < 1e-12, "a Platt fit on Jev alone");
});

test("the run record keeps each guard's row as metrics.guards; a workflow whose guard reads Jev is handed the Jev key", () => {
  const rows = [{ node: "answer", signal: "both", self: 0.6, jev: 0.92, p: 0.6, threshold: 0.65, escalated: true }];
  const entries = [
    { kind: LEARNED_NODES, data: { call: "workflow-first", workflow: "answer", nodes: [{ label: "fetch", kind: "call", status: "ok", duration_ms: 3 }, { label: "answer", kind: "agent", status: "escalated", duration_ms: 9, guard: rows[0] }], guards: rows } },
    { kind: "other", data: {} },
  ];
  // Each row names the workflow whose call made it (the entry's `workflow`): a run can call more than one.
  const named = rows.map((row) => ({ ...row, workflow: "answer" }));
  assert.deepEqual(guardsOf(entries), named);
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, undefined, entries).guards, named);
  assert.equal("guards" in pathMetrics({ input: {}, learning: { seed: "abc" } }, undefined, []), false, "no guard ran: no key");
  assert.deepEqual(providersNamed([{ node: "extract", guard: { signal: "jev", threshold: 0.5 } }]), ["jev"]);
  assert.deepEqual(providersNamed([{ node: "agent", guard: { signal: "both", threshold: 0.5 } }]), ["jev"]);
  assert.deepEqual(providersNamed([{ node: "agent", guard: { signal: "self", threshold: 0.5 } }]), []);
});

// Review on #2639: the trace keeps at most LEARNED_NODES_MAX nodes for the call's timeline row, but every guard check is
// kept beside it (`guards`), so a map over more items than that still gives the run's metrics (and the promotion replay
// and threshold refit that read them) every check, and the hand-back names the check that handed back past the cap.
test("every guard check is kept past the trace's cap: a map of 70 guarded judges, then one that hands back", { timeout: 120_000 }, async (t) => {
  const { LEARNED_NODES_MAX } = await import("../dist/learned-nodes.js");
  const run = await decisionsOf(t);
  const flow = {
    v: 2, name: "answer",
    schemas: {
      In: { type: "object", required: ["question", "items"], properties: { question: { type: "string" }, items: { type: "array", items: { type: "string" } } } },
      Check: { type: "object", required: ["right"], properties: { right: { type: "boolean", description: "Is the claim right?" } } },
    },
    input: { schemaId: "In" }, output: { schemaId: "Check", path: "answer" },
    root: { node: "chain", steps: [
      // The faux Jev says yes at 0.92 to each: a confidence of 0.84, over 0.5, and under 0.9.
      { node: "map", label: "each", itemsPath: "items", as: "checked", maxConcurrency: 4, body: { node: "judge", label: "check", state: { claim: "{item}" }, out: "Check", as: "check", guard: { signal: "self", threshold: 0.5 } } },
      { node: "judge", label: "answer", state: { claim: "{question}" }, out: "Check", as: "answer", guard: { signal: "self", threshold: 0.9 } },
    ] },
  };
  const items = Array.from({ length: 70 }, (_, i) => `claim ${i}`);
  const tool = learnedWorkflowTool({ workflows: [{ name: "answer", description: "Checks claims", workflow: JSON.stringify(flow) }], granted: [], env: {}, work: await scratch(t), models: { getModel: () => MODEL, getModels: () => [MODEL] }, modelOf: () => ({ provider: "stand-in", modelId: "stand-in" }), policy: () => "allow", denyFrom: () => "agent", decisions: run.decisions });
  const kept = [];
  const api = { callId: "call-1", commit: async (change) => change({ appendEntry: async (_conversation, entry) => void kept.push(entry) }) };
  const said = await tool.execute({ name: "answer", input: { question: "six times seven is 42", items } }, api, { abortSignal: new AbortController().signal });
  const text = (said.output ?? []).map((part) => part.text ?? "").join("");
  assert.equal(said.isError, true, text);
  const trace = kept.find((entry) => entry.kind === LEARNED_NODES)?.data;
  assert.equal(trace.nodes.length, LEARNED_NODES_MAX, "the timeline's trace stays capped");
  const rows = guardsOf(kept);
  assert.equal(rows.length, 71, "every check: 70 in the map, and the one that handed back");
  assert.equal(rows.filter((row) => row.node === "check" && !row.escalated).length, 70);
  assert.deepEqual(rows.at(-1), { node: "answer", signal: "self", self: 0.84, p: 0.84, threshold: 0.9, escalated: true, workflow: "answer" });
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, undefined, kept).guards, rows);
  assert.match(text, /guard on "answer" \(self\): p 0\.84 against threshold 0\.9 \(its own confidence 0\.84\); handed back/, "the hand-back names the check past the cap");
});

// Review on #2644 (recovered replays): a replay's outcome is how its workflow ended, never whether some node failed on the
// way. A map that collects a failed item and goes on to an escalate node handed back: the agent's recorded answer. Only a
// workflow that itself ended failed (or was refused) is no evidence.
test("a replay's outcome reads how its workflow ended: a recovered node failure that ends escalated is handed back", () => {
  const launch = { input: {}, learning: { seed: "abc" }, replay: { of: "graded-1", workflow: "answer", digest: "d" } };
  const handedBack = { path: "handed_back", workflow: "answer" };
  const entry = (ended, nodes) => ({ kind: LEARNED_NODES, data: { call: "workflow-first", workflow: "answer", nodes, ...(ended ? { ended } : {}) } });
  const recovered = [entry("escalated", [{ label: "check", kind: "extract", status: "failed", duration_ms: 3 }, { label: "check", kind: "extract", status: "ok", duration_ms: 3 }])];
  assert.equal(pathMetrics(launch, handedBack, recovered).replay.outcome, "handed_back", "a failed item the map collected, then an escalation: handed back");
  assert.equal(pathMetrics(launch, handedBack, [entry("failed", [{ label: "check", kind: "extract", status: "failed", duration_ms: 3 }])]).replay.outcome, "failed");
  assert.equal(pathMetrics(launch, handedBack, []).replay.outcome, "failed", "no word of how it ended (refused before any node ran): no evidence");
});

test("a learned_workflow call keeps how its workflow ended beside its nodes: escalated, complete, or failed", { timeout: 60_000 }, async (t) => {
  const guard = { signal: "self", threshold: 0.7 };
  const ended = (kept) => kept.find((entry) => entry.kind === LEARNED_NODES)?.data?.ended;
  assert.equal(ended((await call(t, flowOf(guard), { submitted: { answer: 41, confidence: 0.3 } })).kept), "escalated");
  assert.equal(ended((await call(t, flowOf(guard), { submitted: { answer: 42, confidence: 0.9 } })).kept), "complete");
  assert.equal(ended((await call(t, flowOf(guard), { submitted: { answer: "forty-two", confidence: 0.9 } })).kept), "failed");
});
