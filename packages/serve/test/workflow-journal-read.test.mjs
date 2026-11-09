// The workflow run view read from the one store's journal (pi-durable-agent/workflow readWorkflowRun/workflowCarry with a
// pi Storage), in place of a per-run store file. A real workflow (the DSL's durable runner, a faux model node) runs on a
// run's journal in the one store; the view and the carry read back from that journal match the run: its completed node, its
// output, and the carry the store keeps. No HTTP server, no per-run process: the engine runs on the store directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createWorkflowExtension, nodeRunner, taskScope } from "@parcha/agentrun-pi/durable";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { readWorkflowRun, startWorkflowRevision, workflowCarry } from "@parcha/pi-durable-agent/workflow";
import { storeOn } from "./store-helpers.mjs";
import { answerFlow, FAUX } from "./support.mjs";

const { runModels, FAUX_ENV } = await import("../dist/model.js");

/** A workflow agent, its revision and one claimed run. */
async function claimedWorkflow(t, workflow = answerFlow()) {
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  return { store, clock, claim, workflow };
}

/** The DSL's durable runner over the run's journal in the one store, its model nodes on the faux model. Returns the
 *  workflow's outcome once it ended, with the Harness still open on the journal. */
async function runWorkflowOnJournal(store, claim, { workflow, input }) {
  const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
  const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
  const workflows = createWorkflowExtension({
    run: ({ runtime, context, driver }) => (void driver, { adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }),
  });
  const registry = createRegistry();
  registry.install(nodes.extension);
  registry.install(workflows.extension);
  const harness = await Harness.open(store.journal(claim), { models, registry, onReport: () => {} }, BACKGROUND_CONTEXT);
  const outcome = await startWorkflowRevision({
    harness, workflows, context: BACKGROUND_CONTEXT,
    run: { runId: claim.runId, agentId: "agent-1", revision: { id: "rev-1", kind: "workflow", body: { workflow } } },
    input, tools: inspectWorkflow(workflow).requires.tools,
  });
  return { harness, outcome };
}

test("a workflow runs on the run's journal in the one store, and its view reads back from that journal", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  const { harness, outcome } = await runWorkflowOnJournal(store, claim, { workflow, input: { question: "What is six times seven?" } });
  assert.equal(outcome.status, "complete", JSON.stringify(outcome));

  // The view read from the one store's journal (no file), through a pi Storage: the server's read half of the run's journal.
  const view = await readWorkflowRun({ runId: "run-1", storage: store.readJournal("run-1"), revision: { body: { workflow } } }, { context: BACKGROUND_CONTEXT });
  assert.deepEqual(view.output, { answer: 42 }, "the workflow's output reads back from the journal");
  assert.equal(view.outcome, "completed");
  assert.equal(view.status[workflow.root.steps[0] ? "/root/steps/0" : "/root"], "done", "the node that ran reads done");

  await harness.close(BACKGROUND_CONTEXT);
});

test("workflowCarry reads the state and the completed node's label from the one store's journal", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  const { harness, outcome } = await runWorkflowOnJournal(store, claim, { workflow, input: { question: "What is six times seven?" } });

  const carry = await workflowCarry({ runId: "run-1", storage: store.readJournal("run-1"), revision: { body: { workflow } } }, outcome, { context: BACKGROUND_CONTEXT });
  assert.deepEqual(carry, { state: "completed", summary: "answer" }, "the carry names the completed node");

  await harness.close(BACKGROUND_CONTEXT);
});
