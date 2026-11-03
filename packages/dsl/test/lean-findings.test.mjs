import assert from "node:assert/strict";
import test from "node:test";
import { EffectFailure, runWorkflow, validateWorkflow } from "../dist/index.js";

// F1, F2, F3, F5's permissive child output, F7's mixed-shape conflicts and F9 are conformance cases
// (spec/lean/conformance, see its README), which the Lean model and lean-conformance.test.mjs both run.
// These tests keep what no case pins.

const V = { type: "object", properties: { v: { type: "string" } } };
const wf = (root, extra = {}) => ({ v: 2, name: "finding", schemas: { Any: { type: "object" }, V, ...(extra.schemas ?? {}) }, output: { schemaId: "Any" }, root });
const agent = (label, extra = {}) => ({ node: "agent", label, instructions: "Do it.", out: "V", ...extra });
const code = (label, source, as) => ({ node: "code", label, code: source, ...(as ? { as } : {}) });

test("F5: a typed parent output rejects a child's undefined output at the child boundary", async () => {
  const child = { v: 2, name: "child", schemas: { CIn: { type: "object" }, CAny: {}, CR: { type: "object", properties: { a: { type: "string" } } } },
    input: { schemaId: "CIn" }, output: { schemaId: "CAny", path: "r.a" }, root: { node: "agent", label: "r", instructions: "x", out: "CR", as: "r" } };
  const w = wf({ node: "chain", steps: [{ node: "workflow", label: "w", workflow: child, input: { q: "{q}" }, out: "Undef", as: "w" }, agent("b", { as: "b", requires: ["w"] })] }, { schemas: { Undef: { type: "string" } } });
  const calls = [];
  assert.equal(validateWorkflow(w, { input: { q: "x" } }).ok, true);
  await assert.rejects(runWorkflow(w, { q: "x" }, { runNode: async ({ label }) => { calls.push(label); return {}; } }), {
    code: "output_invalid", stage: "w", message: /does not satisfy the parent's schema "Undef"/,
  });
  assert.equal(calls.length, 1);
});

test("F4: a reserved child input is rejected before any parent or child runs", async () => {
  const child = { v: 2, name: "child", schemas: { CIn: { type: "object" }, Any2: { type: "object" } }, input: { schemaId: "CIn" }, output: { schemaId: "Any2" }, root: code("k", "s => ({ y: 1 })") };
  const invocation = { node: "workflow", label: "w", workflow: child, input: { $host: "{q}" }, out: "Any", as: "w" };
  const w = wf({ node: "chain", steps: [agent("first"), invocation] });
  const validated = validateWorkflow(w, { input: { q: { a: 1 } } });
  assert.equal(validated.ok, false);
  assert.ok(validated.errors.some(error => /root\.steps\[1\].*\(w\).*input must not contain the reserved "\$host" key/.test(error)), validated.errors.join("; "));
  let calls = 0;
  await assert.rejects(runWorkflow(w, { q: { a: 1 } }, { runNode: async () => { calls++; return { v: "x" }; } }), { code: "workflow_invalid" });
  assert.equal(calls, 0);
  for (const input of [{ $other: "{q}" }, { record: { $host: "{q}" } }]) {
    invocation.input = input;
    assert.equal(validateWorkflow(w, { input: { q: { a: 1 } } }).ok, true);
  }
});

const hostRun = (order, hostFor) => runWorkflow(
  wf({ node: "parallel", label: "p", branches: order.map((label) => agent(label, { as: label })) }), { q: 1 },
  { runNode: async () => ({ v: "ok" }), hostPolicy: { decodeSubmission: (raw, ctx) => ({ value: raw, host: hostFor[ctx.node.label] }) } },
).then((r) => ({ host: r.host }), (e) => ({ error: e.reason }));

test("[document] F7b: host array appends follow the declared branch order", async () => {
  const hostFor = { a: { log: ["from-a"] }, b: { log: ["from-b"] } };
  assert.deepEqual(await hostRun(["a", "b"], hostFor), { host: { log: ["from-a", "from-b"] } });
  assert.deepEqual(await hostRun(["b", "a"], hostFor), { host: { log: ["from-b", "from-a"] } });
});

test("F8: recovery reads expired receipts but admits no new effects after the original deadline", async t => {
  const w = { v: 2, name: "poll", schemas: { R: { type: "object", properties: { done: { type: "boolean" } } }, Any: { type: "object" } }, output: { schemaId: "Any" },
    root: { node: "call", label: "c", via: "tool", tool: "t", out: "R", as: "r", deadline_s: 1, poll: { until: { predicate: "field_true", path: "done" }, interval_s: 0.1, deadline_s: 1 } } };
  const startedAt = Date.now() - 3_600_000;
  for (const receipt of [undefined, { done: false }, { done: true }]) {
    await t.test(receipt ? `stored receipt: done=${receipt.done}` : "no stored receipt", async () => {
      let admissions = 0, reads = 0, waits = 0, commits = 0;
      const deps = {
        runEffect: async ({ node }) => {
          reads++;
          if (receipt) return structuredClone(receipt);
          if (Date.now() >= startedAt + node.poll.deadline_s * 1000) throw new EffectFailure("original poll deadline expired before admission", "timeout");
          admissions++;
          return { done: false };
        },
        recovery: {
          resume: async () => undefined,
          commit: async () => { commits++; },
          pollStartedAt: () => startedAt,
          wait: async (node, ms) => {
            waits++;
            if (Date.now() + ms >= startedAt + node.poll.deadline_s * 1000) throw new EffectFailure("original poll deadline expired before another poll", "timeout");
          },
        },
      };
      if (receipt?.done) {
        const result = await runWorkflow(w, {}, deps);
        assert.equal(result.status, "complete");
        assert.deepEqual(result.state.r, receipt);
        assert.equal(commits, 1);
      } else {
        await assert.rejects(runWorkflow(w, {}, deps), error => error instanceof EffectFailure && error.retryClass === "timeout" && /original poll deadline expired/.test(error.message));
        assert.equal(commits, 0);
      }
      assert.equal(admissions, 0);
      assert.equal(reads, 1);
      assert.equal(waits, receipt && !receipt.done ? 1 : 0);
    });
  }
});
