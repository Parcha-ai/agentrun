// A node's sopSection may name several SOP sections: the node's system prompt carries each slice, in order,
// so a judgment node reads the SOP's own blockers, corrections and criteria instead of a restatement.
import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowSlice } from "../dist/index.js";

const SOP = ["## ONE", "first rule", "## TWO", "second rule", "## THREE", "third rule", ""].join("\n");
const wf = (sopSection) => ({
  v: 2, name: "sop-sections",
  schemas: { rec: { type: "object", required: ["total"], properties: { total: { type: "number" } } } },
  output: { schemaId: "rec", path: "record" },
  root: { node: "chain", steps: [
    { node: "decide", label: "judge", instructions: "decide", sopSection, out: "rec", as: "record" },
  ] },
});

test("a list of sopSection names puts every named slice in the node's system prompt, in order", async () => {
  const seen = [];
  const deps = { sop: SOP, runNode: async ({ system }) => { seen.push(system.join("\n---\n")); return { total: 1 }; } };
  await runWorkflowSlice(wf(["ONE", "THREE"]), { question: "q" }, { from: "judge" }, deps);
  assert.match(seen[0], /first rule[\s\S]*third rule/);
  assert.doesNotMatch(seen[0], /second rule/);
  await runWorkflowSlice(wf("TWO"), { question: "q" }, { from: "judge" }, deps);
  assert.match(seen[1], /second rule/);
  assert.doesNotMatch(seen[1], /first rule/);
});

test("one missing section among several fails the node instead of narrowing its rubric", async () => {
  let calls = 0;
  const deps = { sop: SOP, runNode: async () => { calls++; return { total: 1 }; } };
  await assert.rejects(runWorkflowSlice(wf(["ONE", "FOUR"]), { question: "q" }, { from: "judge" }, deps), /sopSection "FOUR" matches no/);
  assert.equal(calls, 0);
});
