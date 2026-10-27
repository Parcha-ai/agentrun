// An agent node's `max_turns`: how many turns the node asks its host for. The engine checks its shape and hands it
// to runNode as `maxTurns`; the host enforces it within its own cap, as it does `budget_usd`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow, validateWorkflow } from "../dist/index.js";

const SCHEMAS = { Out: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } };
const agent = (extra = {}) => ({ node: "agent", label: "research", instructions: "Find the answer.", out: "Out", as: "result", ...extra });
const wf = (root) => ({ v: 2, name: "t", schemas: SCHEMAS, output: { schemaId: "Out", path: "result" }, root });

test("validator: an agent node's max_turns is a positive integer", () => {
  assert.deepEqual(validateWorkflow(wf(agent({ max_turns: 24 })), { inputKeys: [] }), { ok: true });
  for (const bad of [0, -1, 1.5, "10", null]) {
    const result = validateWorkflow(wf(agent({ max_turns: bad })), { inputKeys: [] });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.match(result.errors.join("\n"), /max_turns must be a positive integer/, JSON.stringify(bad));
  }
});

test("runner: an agent node's max_turns reaches runNode as maxTurns, and is absent when the node names none", async () => {
  const seen = [];
  const runNode = async (request) => { seen.push(request); return { answer: "yes" }; };
  await runWorkflow(wf(agent({ max_turns: 24 })), {}, { runNode });
  await runWorkflow(wf(agent()), {}, { runNode });
  assert.equal(seen[0].maxTurns, 24);
  assert.equal(Object.hasOwn(seen[1], "maxTurns"), false);
});
