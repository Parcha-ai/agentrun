// A host may record an escalate node instead of obeying it (WorkflowDeps.softEscalate, by label; a child workflow's as its
// events name it): the node evaluates its `when` as any does, says whether it fired in its escalate.evaluated event
// (`soft: true`), and the run goes on past it. A replay uses it to read what the workflow would have answered past a
// check it is measuring. Every escalate the host does not name, and every one on a host that names none, hands back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow, validateWorkflow } from "../dist/index.js";

const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const flow = (steps) => ({
  v: 2, name: "soft",
  schemas: { Input: object({ score: { type: "number" }, live: { type: "boolean" } }), Out: object({ score: { type: "number" } }) },
  input: { schemaId: "Input" }, output: { schemaId: "Out", path: "out" },
  root: { node: "chain", steps },
});
const LOW = { node: "escalate", label: "low", when: { predicate: "lt", path: "score", n: 5 }, kind: "review", stage: "score", summary: "score {score}" };
const DEAD = { node: "escalate", label: "dead", when: { predicate: "field_equals", path: "live", value: false }, kind: "review", stage: "site", summary: "not live" };
const FINISH = { node: "code", label: "finish", code: "(s) => ({ out: { score: s.score } })" };

test("an escalate the host records goes on past it, its event saying it fired; one it does not name still hands back", async () => {
  const wf = flow([LOW, DEAD, FINISH]);
  assert.deepEqual(validateWorkflow(wf), { ok: true });
  const events = [];
  const onEvent = (event) => { if (event.type === "escalate.evaluated") events.push([event.label, event.detail.fired, event.detail.soft ?? false]); };
  const soft = (label) => label === "low";
  const past = await runWorkflow(wf, { score: 3, live: true }, { onEvent, softEscalate: soft });
  assert.equal(past.status, "complete", "low fired, recorded only: the run answered");
  assert.deepEqual(past.output, { score: 3 });
  assert.deepEqual(events, [["low", true, true], ["dead", false, false]]);
  events.length = 0;
  const quiet = await runWorkflow(wf, { score: 9, live: true }, { onEvent, softEscalate: soft });
  assert.equal(quiet.status, "complete");
  assert.deepEqual(events, [["low", false, true], ["dead", false, false]], "soft says the host records it, fired or not");
  const hard = await runWorkflow(wf, { score: 9, live: false }, { softEscalate: soft });
  assert.equal(hard.status, "escalated", "an escalate the host does not name hands back");
  assert.equal(hard.escalation.label, "dead");
  const none = await runWorkflow(wf, { score: 3, live: true }, {});
  assert.equal(none.status, "escalated", "no softEscalate: every escalate that fires hands back");
  assert.equal(none.escalation.label, "low");
});

test("a child workflow's escalate is named to the host as its events name it: parent/child", async () => {
  const child = { v: 2, name: "inner", schemas: flow([]).schemas, input: { schemaId: "Input" }, output: { schemaId: "Out", path: "out" }, root: { node: "chain", steps: [LOW, FINISH] } };
  const wf = flow([{ node: "workflow", label: "first", workflow: child, input: { score: "{score}", live: "{live}" }, out: "Out", as: "out" }]);
  assert.deepEqual(validateWorkflow(wf), { ok: true });
  const asked = [];
  const result = await runWorkflow(wf, { score: 3, live: true }, { softEscalate: (label) => (asked.push(label), label === "first/low") });
  assert.equal(result.status, "complete");
  assert.deepEqual(asked, ["first/low"]);
});
