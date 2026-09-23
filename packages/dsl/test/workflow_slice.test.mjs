// A slice of a workflow runs on a seeded state: only the named root steps execute, the seed is the
// state those steps see, and the output schema is not checked because the slice may end before
// the record exists. This is the seam for hammering one node on frozen upstream state.
import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowSlice } from "../dist/index.js";

const wf = {
  v: 2, name: "slice-test",
  schemas: { rec: { type: "object", required: ["total"], properties: { total: { type: "number" } } } },
  output: { schemaId: "rec", path: "record" },
  root: { node: "chain", steps: [
    { node: "code", label: "one: seed a", code: "(s) => ({ a: 1 })" },
    { node: "code", label: "two: double a", code: "(s) => ({ b: s.a * 2 })" },
    { node: "code", label: "three: add", code: "(s) => ({ c: s.a + s.b })" },
    { node: "code", label: "four: record", code: "(s) => ({ record: { total: s.c } })" },
  ] },
};
const deps = { runNode: async () => { throw new Error("no LLM node in this test"); } };

test("only the named steps run, on the seed", async () => {
  const out = await runWorkflowSlice(wf, { question: "q" }, { from: "two", to: "three", seed: { a: 10 } }, deps);
  assert.equal(out.status, "complete");
  assert.deepEqual({ a: out.state.a, b: out.state.b, c: out.state.c }, { a: 10, b: 20, c: 30 });
  assert.equal(out.state.record, undefined, "step four did not run");
  assert.deepEqual(out.focus, { from: "two: double a", to: "three: add" });
});

test("to defaults to from; a label matches by prefix; the record schema is not checked", async () => {
  const out = await runWorkflowSlice(wf, { question: "q" }, { from: "three", seed: { a: 1, b: 5 } }, deps);
  assert.equal(out.state.c, 6);
  assert.equal(out.state.record, undefined);
});

test("an unknown label is an error, and to before from is an error", async () => {
  await assert.rejects(runWorkflowSlice(wf, {}, { from: "nine" }, deps), /names no root step/);
  await assert.rejects(runWorkflowSlice(wf, {}, { from: "three", to: "one" }, deps), /comes before/);
});

test("an unknown end label is an error, never a silent one-step run", async () => {
  const flow = { v: 2, name: "slice-end", schemas: { rec: { type: "object", properties: { total: { type: "number" } } } }, output: { schemaId: "rec", path: "record" },
    root: { node: "chain", steps: [{ node: "code", label: "one", code: "(s) => ({ a: 1 })" }, { node: "code", label: "two", code: "(s) => ({ record: { total: s.a } })" }] } };
  await assert.rejects(runWorkflowSlice(flow, { question: "q" }, { from: "one", to: "nope" }, {}), /"nope" names no root step/);
});
