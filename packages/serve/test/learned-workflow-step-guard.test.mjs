// Step guards in a learned workflow's call (runner/step-guard.ts, through runLearned): a guarded step's p from its own
// confidence (self), one Jev call over its input and output (jev), or both (a fitted logistic, else the lower); below the
// guard's threshold the call hands the job back with the guard's row in its words and its trace; at or above it the
// workflow answers. Every Jev call is booked under the call as a paid request of TypeSafe's (the workflow's cost), and
// each check is a row the run's metrics keep (`guards`). The model is a stand-in registry, Jev a stand-in fetch module
// under the faux switch: no network, no key.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { learnedWorkflowTool } from "../dist/learned-workflow.js";
import { guardsOf, LEARNED_NODES } from "../dist/learned-nodes.js";
import { guardP, JEV_GUARD_MODEL, jevGuardFee } from "../dist/runner/step-guard.js";
import { pathMetrics } from "../dist/runner/workflow-first.js";
import { FAUX_JEV_ENV, JEV_KEY_ENV, providersNamed } from "../dist/decisions.js";
import { FAUX_ENV } from "../dist/model.js";
import { TOOL_COST, TOOL_STARTED } from "../dist/timeline/index.js";

const MODEL = { id: "stand-in", provider: "stand-in", api: "stand-in", name: "stand-in", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content, stopReason) => ({ role: "assistant", content, stopReason, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage, timestamp: Date.now() });
const KEY = "ts-guard-test-key";

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

/** A stand-in Jev under the faux switch: a fetch module that answers the guard's question with `noul` and files each
 *  request's body; it counts only KEY. */
function fauxJev(dir, noul) {
  const file = join(dir, `jev-${Math.random().toString(36).slice(2)}.mjs`);
  const calls = `${file}.calls`;
  writeFileSync(calls, "");
  writeFileSync(file, `import { appendFileSync } from "node:fs";
export default async function jev(url, init = {}) {
  const body = JSON.parse(init.body);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ path: new URL(String(url)).pathname, authorized: new Headers(init.headers).get("authorization") === "Bearer ${KEY}", model: body.model, state: body.state, questions: body.questions }) + "\\n");
  const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: ${noul} }]));
  return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 90, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
}
`);
  return { env: { [FAUX_ENV]: "1", [FAUX_JEV_ENV]: file, [JEV_KEY_ENV]: KEY }, calls: () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

/** One learned_workflow call of `flow` on a stand-in model that submits `submitted` (its confidence beside its record),
 *  with `env`: what it said, the entries it kept (its trace, its paid requests' marks) and the trace's nodes. */
async function call(t, flow, { submitted = { answer: 42 }, env = {} } = {}) {
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
  const tool = learnedWorkflowTool({ workflows: [{ name: "answer", description: "Answers a question", workflow: JSON.stringify(flow) }], granted: [], env, work, models, modelOf: () => ({ provider: "stand-in", modelId: "stand-in" }), policy: () => "allow", denyFrom: () => "default" });
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
  assert.equal(low.kept.some((entry) => entry.kind === TOOL_STARTED), false, "a self guard asks Jev nothing");

  const high = await call(t, flowOf(guard), { submitted: { answer: 42, confidence: 0.9 } });
  assert.equal(high.said.isError, false, high.text);
  assert.match(high.text, /42/);
  assert.doesNotMatch(high.text, /confidence/, "the step's confidence is not the workflow's answer");
  assert.deepEqual(high.nodes[0]?.guard, { node: "answer", signal: "self", self: 0.9, p: 0.9, threshold: 0.7, escalated: false });
});

test("jev: one Jev call over the step's input and output, on the pinned model, booked under the call at TypeSafe's price", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "learned-guard-jev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const jev = fauxJev(dir, 0.92);
  const served = await call(t, flowOf({ signal: "jev", threshold: 0.9, question: "Is 42 the product asked for?" }, "extract"), { env: jev.env });
  assert.equal(served.said.isError, false, served.text);
  const [asked, ...more] = jev.calls();
  assert.deepEqual(more, [], "one Jev call");
  assert.equal(asked.authorized, true, "on the run's Jev key");
  assert.equal(asked.model, JEV_GUARD_MODEL.typesafe);
  assert.equal(JEV_GUARD_MODEL.typesafe, "jev-1.14.0");
  assert.deepEqual(asked.state, { step: "answer", input: { question: "six times seven" }, output: { answer: 42 } });
  assert.deepEqual(Object.values(asked.questions).map(({ type, instructions }) => ({ type, instructions })), [{ type: "noul", instructions: "Is 42 the product asked for?" }]);
  assert.deepEqual(served.nodes[0]?.guard, { node: "answer", signal: "jev", jev: 0.92, p: 0.92, threshold: 0.9, escalated: false });
  // Its mark and its charge, under the call (the step's own id within it), at TypeSafe's published price for its body.
  const started = served.kept.filter((entry) => entry.kind === TOOL_STARTED).map((entry) => entry.data);
  const cost = served.kept.filter((entry) => entry.kind === TOOL_COST).map((entry) => entry.data);
  assert.equal(started.length, 1, JSON.stringify(served.kept));
  assert.deepEqual({ tool: started[0].tool, charged_by: started[0].charged_by, call: started[0].call }, { tool: "learned_workflow", charged_by: "typesafe", call: "call-1/answer@/root#guard" });
  assert.ok(started[0].heldUsd > 0 && started[0].heldUsd < 0.001, JSON.stringify(started[0]));
  assert.deepEqual(cost.map(({ call: id, usd }) => ({ call: id, usd })), [{ call: "call-1/answer@/root#guard", usd: started[0].heldUsd }], "settled at its price");
  assert.equal(jevGuardFee("x".repeat(1_000_000)).usd, 0.042, "$0.042 a million input tokens, a token a byte");

  const handed = await call(t, flowOf({ signal: "jev", threshold: 0.95 }, "extract"), { env: fauxJev(dir, 0.92).env });
  assert.equal(handed.said.isError, true, handed.text);
  assert.match(handed.text, /Its guards: guard on "answer" \(jev\): p 0\.92 against threshold 0\.95 \(Jev 0\.92\); handed back\./);
});

test("jev with no Jev key, or a Jev that fails: no p, so the step hands back, never passes", { timeout: 60_000 }, async (t) => {
  const none = await call(t, flowOf({ signal: "jev", threshold: 0.1 }, "extract"));
  assert.equal(none.said.isError, true, none.text);
  assert.match(none.text, /guard on "answer" \(jev\): p none against threshold 0\.1 \(Jev none\); handed back/);
  assert.deepEqual(none.nodes[0]?.guard, { node: "answer", signal: "jev", p: null, threshold: 0.1, escalated: true });
  const dir = mkdtempSync(join(tmpdir(), "learned-guard-jev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const broken = fauxJev(dir, "Number.NaN");
  const failed = await call(t, flowOf({ signal: "jev", threshold: 0.1 }, "extract"), { env: broken.env });
  assert.equal(failed.said.isError, true, failed.text);
  assert.equal(failed.nodes[0]?.guard?.p, null);
});

test("both: the lower of self and Jev with no fit; through the fitted logistic with one", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "learned-guard-both-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unfitted = await call(t, flowOf({ signal: "both", threshold: 0.65 }), { submitted: { answer: 42, confidence: 0.6 }, env: fauxJev(dir, 0.92).env });
  assert.equal(unfitted.said.isError, true, unfitted.text);
  assert.deepEqual(unfitted.nodes[0]?.guard, { node: "answer", signal: "both", self: 0.6, jev: 0.92, p: 0.6, threshold: 0.65, escalated: true });
  assert.match(unfitted.text, /guard on "answer" \(both\): p 0\.60 against threshold 0\.65 \(its own confidence 0\.60, Jev 0\.92\); handed back/);
  const fit = { w: [2, 3], b: -3, n: 140, fitted_at: "2026-11-13T05:02:00Z" };
  const fitted = await call(t, flowOf({ signal: "both", threshold: 0.65, fit }), { submitted: { answer: 42, confidence: 0.6 }, env: fauxJev(dir, 0.92).env });
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
    { kind: LEARNED_NODES, data: { call: "workflow-first", workflow: "answer", nodes: [{ label: "fetch", kind: "call", status: "ok", duration_ms: 3 }, { label: "answer", kind: "agent", status: "escalated", duration_ms: 9, guard: rows[0] }] } },
    { kind: "other", data: {} },
  ];
  assert.deepEqual(guardsOf(entries), rows);
  assert.deepEqual(pathMetrics({ input: {}, learning: { seed: "abc" } }, entries).guards, rows);
  assert.equal("guards" in pathMetrics({ input: {}, learning: { seed: "abc" } }, []), false, "no guard ran: no key");
  assert.deepEqual(providersNamed([{ node: "extract", guard: { signal: "jev", threshold: 0.5 } }]), ["jev"]);
  assert.deepEqual(providersNamed([{ node: "agent", guard: { signal: "both", threshold: 0.5 } }]), ["jev"]);
  assert.deepEqual(providersNamed([{ node: "agent", guard: { signal: "self", threshold: 0.5 } }]), []);
});
