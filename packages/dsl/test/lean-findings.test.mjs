// Claims the Lean model shows are false (spec/lean/AgentRunSemantics/Findings.lean). Each
// test asserts the claim as it is commonly stated and is marked `todo`: it runs, fails
// today, and documents the gap until the behavior or the claim changes. The conformance
// corpus pins the current behavior (spec/lean/conformance/*.json).
//
// Each test name leads with its disposition; this PR changes no runtime behavior.
//   [fix]        a shipped runtime defect: F7 ($host merge order), F8 (poll unbounded under
//                recovery), F9 (predicate paths stop at arrays).
//   [validator]  a check validateWorkflow should gain: F1 (requires after the first opaque
//                node; empty values), F2 (writes declaredWrites misses), F4 (child input
//                naming $host), F5 (child output that may be undefined).
//   [document]   behavior that stays and the docs must state: F3 ($ keys from code
//                patches). F6 (the write set) has no runtime test; see Findings.lean.
import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, validateWorkflow } from "../dist/index.js";

const V = { type: "object", properties: { v: { type: "string" } } };
const wf = (root, extra = {}) => ({ v: 2, name: "finding", schemas: { Any: { type: "object" }, V, ...(extra.schemas ?? {}) }, output: { schemaId: "Any" }, root });
const agent = (label, extra = {}) => ({ node: "agent", label, instructions: "Do it.", out: "V", ...extra });
const code = (label, source, as) => ({ node: "code", label, code: source, ...(as ? { as } : {}) });

async function reason(promise) {
  try { await promise; return null; } catch (error) { return error.reason ?? error.code ?? error.name; }
}

test("[validator] F1a: a validated workflow never fails required_nonempty (requires after a code node)", { todo: "F1: the validator stops tracking requires after the first code/map/parallel/loop/route" }, async () => {
  const w = wf({ node: "chain", steps: [code("noop", "s => ({})"), agent("answer", { as: "answer", requires: ["missing"] })] });
  assert.equal(validateWorkflow(w, { input: { q: 1 } }).ok, true);
  assert.equal(await reason(runWorkflow(w, { q: 1 }, { runNode: async () => ({ v: "x" }) })), null);
});

test("[validator] F1b: a validated workflow never fails required_nonempty (produced but empty)", { todo: "F1: validation guarantees a producer for the first key, not a non-empty value" }, async () => {
  const w = wf({ node: "chain", steps: [agent("draft", { as: "draft" }), agent("review", { as: "review", requires: ["draft"] })] });
  assert.equal(validateWorkflow(w, { input: { q: 1 } }).ok, true);
  assert.equal(await reason(runWorkflow(w, { q: 1 }, { runNode: async ({ label }) => (label === "draft" ? {} : { v: "x" }) })), null);
});

test("[validator] F5: a child invocation's validated as key holds a value", { todo: "F5: a permissive output schema lets undefined land at the parent's as" }, async () => {
  const child = { v: 2, name: "child", schemas: { CIn: { type: "object" }, CAny: {}, CR: { type: "object", properties: { a: { type: "string" } } } },
    input: { schemaId: "CIn" }, output: { schemaId: "CAny", path: "r.a" }, root: { node: "agent", label: "r", instructions: "x", out: "CR", as: "r" } };
  const w = wf({ node: "chain", steps: [{ node: "workflow", label: "w", workflow: child, input: { q: "{q}" }, out: "Undef", as: "w" }, agent("b", { as: "b", requires: ["w"] })] }, { schemas: { Undef: {} } });
  assert.equal(validateWorkflow(w, { input: { q: "x" } }).ok, true);
  assert.equal(await reason(runWorkflow(w, { q: "x" }, { runNode: async ({ label }) => (label.endsWith("r") ? {} : { v: "x" }) })), null);
});

test("[validator] F2a: parallel branches that pass validation never conflict (code patches)", { todo: "F2: declaredWrites ignores the keys an unaliased code node returns" }, async () => {
  const w = wf({ node: "parallel", label: "both", branches: [code("c1", "s => ({ k: 1 })"), code("c2", "s => ({ k: 2 })")] });
  assert.equal(validateWorkflow(w, { input: {} }).ok, true);
  assert.equal(await reason(runWorkflow(w, {}, {})), null);
});

test("[validator] F2b: parallel branches that pass validation never conflict (unaliased label)", { todo: "F2: declaredWrites ignores labels, <as>$answers and <as>$verify" }, async () => {
  const w = wf({ node: "parallel", label: "both", branches: [agent("x"), code("c", "s => ({ x: 1 })")] });
  assert.equal(validateWorkflow(w, { input: { q: 1 } }).ok, true);
  assert.equal(await reason(runWorkflow(w, { q: 1 }, { runNode: async () => ({ v: "a" }) })), null);
});

test("[document] F3: no workflow writes an engine-owned $ key", { todo: "F3: only $host is rejected in a code patch" }, async () => {
  const w = wf(code("c", "s => ({ $other: 1 })"));
  const result = await runWorkflow(w, {}, {}).catch(() => null);
  assert.ok(!result || !Object.keys(result.state).some((key) => key.startsWith("$")), "a $-prefixed key was written");
});

test("[validator] F4: validation rejects a child invocation whose input names $host", { todo: "F4: the reserved key is only checked when the child runs" }, () => {
  const child = { v: 2, name: "child", schemas: { CIn: { type: "object" }, Any2: { type: "object" } }, input: { schemaId: "CIn" }, output: { schemaId: "Any2" }, root: code("k", "s => ({ y: 1 })") };
  const w = wf({ node: "workflow", label: "w", workflow: child, input: { $host: "{q}" }, out: "Any", as: "w" });
  assert.equal(validateWorkflow(w, { input: { q: { a: 1 } } }).ok, false);
});

const hostRun = (order, hostFor) => runWorkflow(
  wf({ node: "parallel", label: "p", branches: order.map((label) => agent(label, { as: label })) }), { q: 1 },
  { runNode: async () => ({ v: "ok" }), hostPolicy: { decodeSubmission: (raw, ctx) => ({ value: raw, host: hostFor[ctx.node.label] }) } },
).then((r) => ({ host: r.host }), (e) => ({ error: e.reason }));

test("[fix] F7a: the $host merge does not depend on branch order (scalar then array)", { todo: "F7: a scalar host write followed by an array write is silently replaced" }, async () => {
  const hostFor = { a: { k: "scalar" }, b: { k: ["x"] } };
  assert.deepEqual(await hostRun(["a", "b"], hostFor), await hostRun(["b", "a"], hostFor));
});

test("[fix] F7b: the $host merge does not depend on branch order (arrays)", { todo: "F7: arrays append in branch order" }, async () => {
  const hostFor = { a: { log: ["from-a"] }, b: { log: ["from-b"] } };
  assert.deepEqual(await hostRun(["a", "b"], hostFor), await hostRun(["b", "a"], hostFor));
});

test("[fix] F8: a polled call stops at its poll deadline", { todo: "F8: with deps.recovery the engine leaves the poll bound to the host's recovery adapter" }, async () => {
  let effects = 0;
  const controller = new AbortController();
  const w = { v: 2, name: "poll", schemas: { R: { type: "object", properties: { done: { type: "boolean" } } }, Any: { type: "object" } }, output: { schemaId: "Any" },
    root: { node: "call", label: "c", via: "tool", tool: "t", out: "R", as: "r", deadline_s: 1, poll: { until: { predicate: "field_true", path: "done" }, interval_s: 0.1, deadline_s: 1 } } };
  const startedAt = Date.now() - 3_600_000;
  await runWorkflow(w, {}, {
    signal: controller.signal,
    runEffect: async () => { if (++effects >= 100) controller.abort(new Error("stopped by the test")); return { done: false }; },
    recovery: { resume: async () => undefined, commit: async () => {}, pollStartedAt: () => startedAt, wait: async () => {} },
  }).catch(() => {});
  assert.ok(effects <= 11, `${effects} polls after the deadline had passed`);
});

test("[fix] F9: a predicate reads a state path the way requires and interpolation do", { todo: "F9: predicates.ts getPath stops at arrays; workflow.ts getPath indexes them" }, async () => {
  const w = wf({ node: "chain", steps: [
    agent("a", { as: "a", requires: ["scores.0"], state: { first: "{scores.0}" } }),
    { node: "escalate", label: "gate", when: { predicate: "gte", path: "scores.0", n: 5 }, kind: "k", stage: "s", summary: "high" },
  ] });
  const result = await runWorkflow(w, { scores: [9] }, { runNode: async () => ({ v: "x" }) });
  assert.equal(result.status, "escalated");
});
