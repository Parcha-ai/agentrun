// readWorkflowRunOver (store-reads/workflow.ts): a workflow run's view read from the one store (A), for graph-view's ended
// path. A real workflow runs to its end through the loop on a run's journal; the reader returns today's readWorkflowRun
// result (node status, outcome, output) from that journal, read with no claim.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeRunner } from "../dist/workflow/node-runner.js";
import { taskScope } from "../dist/workflow/node.js";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { storeOn } from "./store-helpers.mjs";
import { answerFlow, FAUX } from "./support.mjs";

const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { readWorkflowRunOver } = await import("../dist/store-reads/workflow.js");
const { runModels, FAUX_ENV } = await import("../dist/model.js");

async function runWorkflowToEnd(store, claim, workflow, input) {
  const specOf = async () => {
    const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
    return {
      models, workflow, input, tools: inspectWorkflow(workflow).requires.tools, agentId: "agent-1", revisionId: "rev-1",
      build: () => {
        const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
        return { extensions: [nodes.extension], host: { run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }) } };
      },
    };
  };
  const loop = createWorkflowLoop(specOf)({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  return loop.start(claim);
}

test("readWorkflowRunOver reads an ended workflow run's view from the one store's journal", async (t) => {
  const { store } = await storeOn(t);
  const workflow = answerFlow();
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  assert.deepEqual(await runWorkflowToEnd(store, claim, workflow, { question: "What is six times seven?" }), { state: "ended" });

  const view = await readWorkflowRunOver(store, "run-1");
  assert.equal(view.outcome, "completed");
  assert.deepEqual(view.output, { answer: 42 });
  assert.equal(view.status["/root/steps/0"], "done");
});

test("readWorkflowRunOver is undefined for an unknown run and for a non-workflow revision", async (t) => {
  const { store } = await storeOn(t);
  assert.equal(await readWorkflowRunOver(store, "nope"), undefined);
  await store.agents.create({ id: "agent-2", name: "agent-2" }, { id: "rev-2", kind: "agentic", body: { instructions: "Answer." } });
  await store.runs.create({ id: "run-2", agentId: "agent-2", revisionId: "rev-2" });
  assert.equal(await readWorkflowRunOver(store, "run-2"), undefined);
});
