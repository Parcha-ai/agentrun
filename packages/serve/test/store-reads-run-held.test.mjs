// What a run held for its owner's OK, end to end over the store and the agent's learning rows: a run whose compile merge
// held its draft (a step calls a tool with no price, so it runs outside the run's cost and cap) reads, through
// GET /runs/{id}/learning's store read (runLearningOverStore), as the draft stands at the agent's newest save after each
// act on it: still waiting, approved (learned, nothing waits), then retired (said no more). The statuses are read from
// the rows themselves (statusesOf), once a read; with none given, as the run's learning end says.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { workflow } from "./learn-format-support.mjs";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";
import { learningAt } from "./learn-support.mjs";

const { runLearningOverStore } = await import("../dist/store-reads/learning.js");
const { changeWorkflow, statusesOf } = await import("../dist/learning-routes.js");
const { secretsShown } = await import("../dist/learning.js");

const NAME = "file-ticket";
const FLOW = `workflows/${NAME}/workflow.json`;
const README = `workflows/${NAME}/README.md`;

/** The README's ETag at the agent's newest save, as GET answers it. */
async function etagOf(store, agentId) {
  const item = (await learningAt(store, agentId)).view.workflows.find((one) => one.name === NAME);
  return `"${item.oid}"`;
}

test("a run's held draft reads as it stands on main after each act: waiting, then approved and learned, then retired and said no more", async (t) => {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "File the ticket.", learning: true } });
  // The run's compile merge, as it landed: its draft held for the owner's OK by its README.
  const seed = await landWorkflows(store, "agent-1", [{ name: NAME, description: "Files a ticket", workflow: JSON.parse(workflow({ name: NAME })), status: "pending" }]);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "File it." }, title: "t", place: { mode: "runner" }, learning: { seed, section: "" } } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "merged", merged: seed, detail: "Waiting for your OK: workflow file-ticket.", workflows: [{ file: FLOW, name: NAME, pending: true }] };
  await store.runs.update(claim, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: {}, proposal: kept } }] });

  const asked = [];
  const statuses = async (agentId) => (asked.push(agentId), statusesOf(store, agentId));
  const read = (by) => runLearningOverStore(store, "run-1", secretsShown([]), [], by);
  const held = (body) => body.workflows.map((one) => [one.name, one.pending === true]);

  assert.deepEqual(held(await read()), [[NAME, true]], "no statuses given: as its learning end says");
  assert.deepEqual(held(await read(statuses)), [[NAME, true]], "still pending at the newest save: it waits");
  assert.deepEqual(asked, ["agent-1"], "one read of the rows' statuses, for its agent");

  const approved = await changeWorkflow(store, "agent-1", README, { action: "approve", ifMatch: await etagOf(store, "agent-1"), refuse: [] });
  assert.equal(approved.status, 200);
  const learned = await read(statuses);
  assert.deepEqual(held(learned), [[NAME, false]], `approved since: learned, nothing waits: ${JSON.stringify(learned)}`);

  const retired = await changeWorkflow(store, "agent-1", README, { action: "retire", ifMatch: await etagOf(store, "agent-1"), refuse: [] });
  assert.equal(retired.status, 200);
  const gone = await read(statuses);
  assert.deepEqual([gone.workflows, gone.detail], [[], "What it learned was retired since."], JSON.stringify(gone));
});
