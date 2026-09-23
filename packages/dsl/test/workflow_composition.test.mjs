// The `workflow` node: a child workflow invoked as one step of its parent. The child's initial
// state is exactly the mapped input, only its validated output returns, the parent owns the
// terminal, a child escalation is the parent step's escalation, and the parent pin covers every
// child byte. Interpreter-level checks with no model and no effects.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow, validateWorkflow, workflowSha256, dryRunWorkflow } from "../dist/index.js";

const scalar = { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "number" } } };
const child = () => ({
  v: 2, name: "increment",
  schemas: { Input: scalar, Output: scalar },
  input: { schemaId: "Input" },
  output: { schemaId: "Output", path: "result" },
  root: { node: "chain", steps: [
    { node: "code", label: "scratch", code: "s => ({ scratch: s.value * 10 })" },
    { node: "code", label: "compute", code: "s => ({ result: { value: s.value + 1 } })" },
  ] },
});
const parent = () => ({
  v: 2, name: "twice",
  schemas: { Output: scalar },
  output: { schemaId: "Output", path: "second" },
  root: { node: "chain", steps: [
    { node: "workflow", label: "first", workflow: child(), input: { value: "{seed}" }, out: "Output", as: "first" },
    { node: "workflow", label: "second", workflow: child(), input: { value: "{first.value}" }, out: "Output", as: "second" },
  ] },
});
const deps = { runNode: async () => { throw new Error("unexpected model"); } };

test("a child sees only its mapped input and returns only its validated output at `as`", async () => {
  const wf = parent();
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["seed"] }), { ok: true });
  const input = { seed: 3, private: "parent only" };
  const result = await runWorkflow(wf, input, deps);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { value: 5 });
  assert.deepEqual(input, { seed: 3, private: "parent only" }, "the parent input is not mutated");
  assert.equal("scratch" in result.state, false, "child-local state never reaches the parent");
  assert.deepEqual(result.state.first, { value: 4 });
  // A child that reads a parent-only key sees nothing: its state is the mapped input alone.
  wf.root.steps[0].workflow.root.steps[1].code = "s => ({ result: { value: s.private ? -1 : s.value + 1 } })";
  assert.deepEqual((await runWorkflow(wf, input, deps)).output, { value: 5 });
});

test("child bytes are part of the parent's identity", () => {
  const a = parent(), b = parent();
  b.root.steps[0].workflow.root.steps[1].code = "s => ({ result: { value: 99 } })";
  assert.notEqual(workflowSha256(a), workflowSha256(b));
});

test("a child cannot own the terminal or skip its input contract; nothing runs", async () => {
  const cases = [
    ["report in a child", w => { w.root.steps[0].workflow.root.steps.push({ node: "report", label: "r", instructions: "write" }); }],
    ["artifact in a child", w => { w.root.steps[0].workflow.root.steps.push({ node: "artifact", label: "a", type: "video", path: "out.mp4" }); }],
    ["missing input schema", w => { delete w.root.steps[0].workflow.input; }],
    ["label missing", w => { w.root.steps[0].label = 3; }],
    ["as missing", w => { w.root.steps[0].as = ""; }],
    ["out not in parent schemas", w => { w.root.steps[0].out = "Missing"; }],
    ["input not a mapping", w => { w.root.steps[0].input = []; }],
  ];
  for (const [name, mutate] of cases) {
    const wf = parent();
    mutate(wf);
    assert.equal(validateWorkflow(wf, { inputKeys: ["seed"] }).ok, false, name);
    const started = [];
    await assert.rejects(() => runWorkflow(wf, { seed: 3 }, { ...deps, onEvent: event => { if (event.type === "node.start") started.push(event.label); } }), error => error.code === "workflow_invalid", name);
    assert.deepEqual(started, [], name);
  }
});

test("the child's input schema, the child's output schema and the parent's out schema each block continuation", async () => {
  const cases = [
    w => { w.root.steps[0].input.value = "bad"; },
    w => { w.root.steps[0].workflow.root.steps[1].code = "s => ({ result: { value: 'bad' } })"; },
    w => { w.schemas.Output = { ...scalar, properties: { value: { type: "number", minimum: 10 } } }; },
  ];
  for (const mutate of cases) {
    const wf = parent();
    mutate(wf);
    let second = 0;
    await assert.rejects(() => runWorkflow(wf, { seed: 3 }, { ...deps, onEvent: e => { if (e.type === "node.start" && e.label === "second") second += 1; } }));
    assert.equal(second, 0, "the next parent step never starts");
  }
});

test("a child escalation is the parent step's escalation, named under the invocation", async () => {
  const wf = parent();
  wf.root.steps[0].workflow.root.steps.splice(1, 0, { node: "escalate", label: "gate", when: { predicate: "field_equals", path: "scratch", value: 30 }, kind: "review", stage: "compute", summary: "scratch is {scratch}" });
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["seed"] }), { ok: true });
  const result = await runWorkflow(wf, { seed: 3 }, deps);
  assert.equal(result.status, "escalated");
  assert.equal(result.escalation.kind, "review");
  assert.equal(result.escalation.label, "first/gate");
  assert.equal(result.escalation.summary, "scratch is 30");
  assert.deepEqual(Object.keys(result.escalation.state), ["seed"], "the escalation carries the parent's state");
});

test("child steps are reported under the invocation's label, and the dry run resolves a child effect's schema in the child's catalog", async () => {
  const wf = parent();
  wf.root.steps[0].workflow.schemas.Lookup = { type: "object", required: ["hit"], properties: { hit: { type: "boolean" } } };
  wf.root.steps[0].workflow.root.steps.unshift({ node: "call", label: "lookup", via: "tool", tool: "mock:lookup", args: { q: "{value}" }, out: "Lookup", as: "lookup", deadline_s: 5 });
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["seed"] }), { ok: true });
  const labels = [];
  const result = await runWorkflow(wf, { seed: 3 }, { ...deps, onEvent: e => { if (e.type === "node.start") labels.push(e.label); }, runEffect: async ({ node, schema }) => { assert.equal(node.label, "first/lookup"); assert.deepEqual(schema.required, ["hit"]); return { hit: true }; } });
  assert.equal(result.status, "complete");
  assert.deepEqual(labels, ["first", "first/lookup", "first/scratch", "first/compute", "second", "second/scratch", "second/compute"]);
  assert.equal((await dryRunWorkflow(wf, { input: { seed: 3 } })).ok, true);
  // The rails count what spends: the child call, once; code nodes and the invocation itself spend nothing.
});

test("a workflow invocation executes inside a map or loop body", async () => {
  const invocation = { node: "workflow", label: "inner", workflow: child(), input: { value: "{item.value}" }, out: "Output", as: "inner" };
  const mapped = { v: 2, name: "fanout", schemas: { Output: scalar }, output: { schemaId: "Output", path: "second" }, root: { node: "chain", steps: [
    { node: "code", label: "items", code: "s => ({ xs: [{ value: 1 }, { value: 2 }] })" },
    { node: "map", label: "each", itemsPath: "xs", as: "ys", body: invocation },
    { node: "code", label: "pick", code: "s => ({ second: s.ys[0] })" },
  ] } };
  const looped = { ...mapped, root: { node: "chain", steps: [
    { node: "code", label: "seed", code: "s => ({ item: { value: 1 } })" },
    { node: "loop", label: "again", maxIters: 2, until: { predicate: "field_equals", path: "inner.value", value: 3 }, body: invocation },
    { node: "code", label: "pick", code: "s => ({ second: s.inner })" },
  ] } };
  for (const [wf, where] of [[mapped, "map"], [looped, "loop"]]) {
    const result = validateWorkflow(wf, { inputKeys: ["seed"] });
    assert.deepEqual(result, { ok: true }, where);
    const ran = await runWorkflow(wf, { seed: 1 }, {});
    assert.equal(ran.status, "complete");
    assert.deepEqual(ran.output, { value: 2 });

  }
});

test("an invocation whose input names an unreachable field fails validation the way a call node's args do", () => {
  const wf = parent();
  wf.root.steps[0].input = { value: "{missing.value}" };
  const result = validateWorkflow(wf, { inputKeys: ["seed"] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /\(first\): interpolates \{missing\.value\} but no upstream node produces "missing"/.test(e)), result.errors.join("\n"));
  const call = { ...parent(), root: { node: "chain", steps: [
    { node: "call", label: "lookup", via: "tool", tool: "mock:lookup", args: { q: "{missing.value}" }, out: "Output", as: "second", deadline_s: 5 },
  ] } };
  const callResult = validateWorkflow(call, { inputKeys: ["seed"] });
  assert.ok(callResult.errors.some(e => /\(lookup\): interpolates \{missing\.value\} but no upstream node produces "missing"/.test(e)), "the same error shape as a call node");
});
