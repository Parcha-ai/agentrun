// graph-view's ended-run path over the one store (graph-view.ts, given.store + given.context): a workflow run's view, pin
// and decisions read from A's journal (store.readJournal) in place of its per-run store file — readWorkflowRun over the
// journal for node status, the driver document's pin frame, and decisionsOverStore for the receipts. A real workflow (the
// DSL's durable runner on a faux model) runs on the run's journal; the graph reads back its completed node from A.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createWorkflowExtension, nodeRunner, taskScope } from "@parcha/agentrun-pi/durable";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { startWorkflowRevision } from "@parcha/pi-durable-agent/workflow";
import { storeOn } from "./store-helpers.mjs";
import { answerFlow, FAUX } from "./support.mjs";

const { runGraph } = await import("../dist/graph-view.js");
const { runModels, FAUX_ENV } = await import("../dist/model.js");

async function claimedWorkflow(t, workflow = answerFlow()) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  return { store, claim, workflow };
}

/** The DSL's durable runner over the run's journal in the one store, its model nodes on the faux model. */
async function runWorkflowOnJournal(store, claim, { workflow, input }) {
  const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
  const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
  const workflows = createWorkflowExtension({
    run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }),
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

test("the ended graph reads a stored workflow run's completed node from A's journal", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  const { harness, outcome } = await runWorkflowOnJournal(store, claim, { workflow, input: { question: "What is six times seven?" } });
  assert.equal(outcome.status, "complete", JSON.stringify(outcome));

  const root = mkdtempSync(join(tmpdir(), "graph-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const given = {
    run: { id: "run-1", agent: "agent-1", revision: "rev-1", status: "completed", paused: false, startedAt: now, endedAt: now },
    ended: true, workflow, storeFile: "/does-not-exist/run.sqlite", root, input: { question: "What is six times seven?" },
    modelCost: 0, llmRead: 0, store, context: BACKGROUND_CONTEXT,
  };
  const result = await runGraph(given);
  const node = workflow.root.steps?.[0] ? "/root/steps/0" : "/root";
  assert.equal(result.nodes[node].status, "done", "the node that ran reads done, from A's journal — no store file touched");
  await harness.close(BACKGROUND_CONTEXT);
});
