// The learned runner's request-time refusals and the learn-time check agree: whatever node the pi runner a learned
// workflow runs on (createPiRunner with the options learned-workflow.ts hands it) refuses when the node comes up, the
// checker (draftProblems) refuses at learn time, so a learned workflow never fails a node after earlier ones spent.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import { createPiRunner } from "@parcha/agentrun-pi";
import { draftProblems, LEARNED_MAX_TURNS } from "../dist/learn/index.js";

/** Whether the learned runner refuses `fields` (an agent node's) before it starts a session: its request-time checks. */
async function runnerRefuses(fields) {
  let started = false;
  const runner = createPiRunner({ model: { provider: "faux", id: "faux" }, sessionFactory: async () => { started = true; throw new Error("started"); }, tools: [], maxTurns: LEARNED_MAX_TURNS });
  const request = {
    kind: "agent", label: "n", system: ["Answer."], user: "{}", schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    ...(fields.max_turns !== undefined ? { maxTurns: fields.max_turns } : {}),
    ...(fields.context !== undefined ? { context: fields.context } : {}),
    ...(fields.budget_usd !== undefined ? { budgetUsd: fields.budget_usd } : {}),
    ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
    ...(fields.thinking !== undefined ? { thinking: fields.thinking } : {}),
    ...(Array.isArray(fields.tools) ? { tools: fields.tools } : {}),
  };
  try {
    await runner(request);
  } catch {
    // a refusal before the session, or the session factory's own stop
  }
  return !started;
}

/** A one-node draft whose agent node holds `fields`, as JSON. */
const draftOf = (fields) => JSON.stringify({
  v: 2, name: "parity",
  schemas: { In: { type: "object", properties: { q: { type: "string" } } }, Out: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
  input: { schemaId: "In" }, output: { schemaId: "Out", path: "out" },
  root: { node: "agent", label: "n", instructions: "Answer the question.", out: "Out", as: "out", ...fields },
});

test("every agent node the learned runner refuses when it comes up is refused at learn time, and every one it runs passes", async () => {
  const cases = [];
  for (const tools of [undefined, [], ["read"]])
    for (const context of [undefined, "fresh", "fork"])
      for (const max_turns of [undefined, 1, LEARNED_MAX_TURNS, LEARNED_MAX_TURNS + 1])
        cases.push(Object.fromEntries(Object.entries({ tools, context, max_turns }).filter(([, v]) => v !== undefined)));
  cases.push({ budget_usd: 0.5 }, { effort: "low" }, { thinking: "high" });
  let compared = 0;
  for (const fields of cases) {
    const text = draftOf(fields);
    // A draft the DSL itself refuses is refused whatever the runner would say.
    if (!dsl.validateWorkflow(JSON.parse(text), { executeCode: false, tools: ["read", "web_fetch"] }).ok) continue;
    const refused = await runnerRefuses(fields);
    const problems = draftProblems(dsl, text, ["read", "web_fetch"]);
    assert.equal(problems.length > 0, refused, `${JSON.stringify(fields)}: the runner ${refused ? "refuses" : "runs"} it, the checker says ${JSON.stringify(problems)}`);
    compared += 1;
  }
  assert.ok(compared >= 30, `compared ${compared} cases`);
});

test("the agent node's fields are the ones the parity grid covers: a new field that reaches the runner fails here until it is added", () => {
  assert.deepEqual([...dsl.NODE_FIELDS.agent].sort(), ["as", "budget_usd", "context", "effort", "instructions", "label", "max_turns", "node", "out", "requires", "sopSection", "state", "thinking", "tier", "tools", "verify"].sort());
});
