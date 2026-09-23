// A parallel node runs independent branches at once on the same input state and merges each
// branch's patch; two branches writing one key is an error, and the validator wants two branches.
import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowSlice, validateWorkflow } from "../dist/index.js";

const side = { type: "object", required: ["v"], properties: { v: { type: "number" } } };
const branch = (as, label = `${as} branch`) => ({ node: "decide", label, instructions: `produce ${as}`, out: "side", as });
const wf = (branches) => ({
  v: 2, name: "parallel-test",
  schemas: { side, rec: { type: "object", required: ["total"], properties: { total: { type: "number" } } } },
  output: { schemaId: "rec", path: "record" },
  root: { node: "chain", steps: [
    { node: "code", label: "one: seed", code: "(s) => ({ a: 1 })" },
    { node: "parallel", label: "two: both sides", branches },
    { node: "code", label: "three: record", code: "(s) => ({ record: { total: (s.left ? s.left.v : 0) + (s.right ? s.right.v : 0) } })" },
  ] },
});
test("branches run concurrently on the same input and their patches merge", { timeout: 5000 }, async () => {
  let release;
  const bothStarted = [];
  const barrier = new Promise(resolve => { release = resolve; });
  const pending = runWorkflowSlice(wf([branch("left"), branch("right")]), { question: "q" }, { from: "one", to: "three" }, {
    runNode: async ({ label, user }) => {
      bothStarted.push(label);
      if (bothStarted.length === 2) release();
      await barrier;
      const a = JSON.parse(user).a;
      return { v: label.startsWith("left") ? a + 10 : a + 20 };
    },
  });
  const out = await pending;
  assert.equal(bothStarted.length, 2);
  assert.equal(out.status, "complete");
  assert.deepEqual({ left: out.state.left.v, right: out.state.right.v, total: out.state.record.total }, { left: 11, right: 21, total: 32 });
});

test("slicing still rejects two branches declaring the same key", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflowSlice(wf([branch("left", "left one"), branch("left", "left two")]), { question: "q" }, { from: "one", to: "two" }, { runNode: async () => { calls++; return { v: 1 }; } }),
    /branches 0 and 1 both write state\.left/,
  );
  assert.equal(calls, 0);
});

test("validation: a parallel node needs at least two branches and no report inside", () => {
  const one = validateWorkflow(wf([branch("left")]), { inputKeys: ["question"] });
  assert.ok(one.errors.some((e) => /at least two branches/.test(e)), one.errors.join("; "));
  const withReport = validateWorkflow(wf([branch("left"), { node: "report", label: "r", instructions: "x" }]), { inputKeys: ["question"] });
  assert.ok(withReport.errors.some((e) => /report node cannot live inside a parallel branch/.test(e)), withReport.errors.join("; "));
  const good = validateWorkflow(wf([branch("left"), branch("right")]), { inputKeys: ["question"] });
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("the validator rejects two branches that declare the same output key before any work runs", () => {
  const result = validateWorkflow(wf([branch("left", "left one"), branch("left", "left two")]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /branches 0 and 1 both write state\.left/.test(e)), result.errors.join("\n"));
  assert.equal(validateWorkflow(wf([branch("left"), branch("right")])).ok, true);
});

test("a branch that mutates a nested object in place cannot reach its sibling", async () => {
  const mutator = { node: "code", label: "left mutates", code: "(s) => { s.shared.n = 99; return { left: { v: s.shared.n } }; }" };
  const reader = { node: "decide", label: "right reads", instructions: "read", out: "side", as: "right" };
  const flow = wf([mutator, reader]);
  flow.root.steps[0] = { node: "code", label: "one: seed", code: "(s) => ({ a: 1, shared: { n: 1 } })" };
  const seen = [];
  const out = await runWorkflowSlice(flow, { question: "q" }, { from: "one", to: "two" }, { runNode: async ({ user }) => { seen.push(JSON.parse(user).shared.n); return { v: 5 }; } });
  assert.equal(out.status, "complete");
  assert.equal(seen[0], 1, "the sibling saw the input state, not the mutation");
  assert.equal(out.state.left.v, 99);
});

test("two maps with the same body-local key but different map keys are not a conflict", () => {
  const map = (as) => ({ node: "map", label: `${as} map`, itemsPath: "items", as, body: { node: "decide", label: `${as} item`, instructions: "one", out: "side", as: "row" } });
  const result = validateWorkflow(wf([map("lefts"), map("rights")]));
  assert.equal(result.ok, true, (result.errors || []).join("\n"));
  assert.equal(validateWorkflow(wf([map("same"), map("same")])).ok, false);
});
