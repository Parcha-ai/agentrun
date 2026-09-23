// The model tier on an LLM node: validated, and handed to the runner so a route by risk can send the
// few thin cases to the strong tier while everything else stays on the run model.
import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, validateWorkflow } from "../dist/index.js";

const schemas = { row: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } };
const wf = (tier) => ({ v: 2, name: "tier", schemas, output: { schemaId: "row", path: "row" }, root: { node: "chain", steps: [
  { node: "agent", label: "second look", instructions: "Look again.", out: "row", as: "row", ...(tier ? { tier } : {}) },
] } });

test("tier is validated and reaches the runner", async () => {
  assert.equal(validateWorkflow(wf("strong")).ok, true);
  assert.equal(validateWorkflow(wf("fast")).ok, true);
  const bad = validateWorkflow(wf("huge"));
  assert.ok(bad.errors.some((e) => /tier must be fast\|default\|strong/.test(e)), bad.errors.join("\n"));
  const seen = [];
  const out = await runWorkflow(wf("strong"), {}, { runNode: async (p) => { seen.push(p.tier); return { ok: true }; } });
  assert.equal(out.status, "complete");
  assert.deepEqual(seen, ["strong"]);
  const none = [];
  await runWorkflow(wf(undefined), {}, { runNode: async (p) => { none.push(p.tier); return { ok: true }; } });
  assert.deepEqual(none, [undefined]);
});

