// The workflow loop on the runner (runner/workflow-loop.ts): a run of a workflow revision the runner claims like any run.
// The DSL's durable runner runs the revision's workflow (a faux model node) on the run's journal in the one store; the loop
// writes the end (the run's state, its summary) on the run's row. A cancel ends the run stopped; a claim lost before the end
// commit resumes the workflow from its journal and ends the run. No HTTP server, no per-run process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createWorkflowExtension, nodeRunner, taskScope } from "@parcha/agentrun-pi/durable";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { readWorkflowRun, startWorkflowRevision } from "@parcha/pi-durable-agent/workflow";
import { storeOn } from "./store-helpers.mjs";
import { answerFlow, FAUX } from "./support.mjs";

const { createWorkflowLoop, isWorkflowRevision } = await import("../dist/runner/workflow-loop.js");
const { runModels, FAUX_ENV } = await import("../dist/model.js");

/** A workflow agent, its revision and one claimed run. */
async function claimedWorkflow(t, workflow = answerFlow()) {
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  return { store, claim, workflow };
}

/** The workflow run spec the loop runs: the run's models (faux), and a host that runs model nodes on them. The call
 *  tools, decisions and cap a real run brings are not needed to prove the loop's own work. */
async function workflowSpec(workflow, input) {
  const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
  return {
    models, workflow, input, tools: inspectWorkflow(workflow).requires.tools, agentId: "agent-1", revisionId: "rev-1",
    build: () => {
      const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
      return {
        extensions: [nodes.extension],
        host: { run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }) },
      };
    },
  };
}

function loopOn(store, workflow, input, signal = new AbortController().signal) {
  const factory = createWorkflowLoop(() => workflowSpec(workflow, input));
  return factory({ journal: (claim) => store.journal(claim), flush: () => store.flush(), signal });
}

/** The DSL's durable runner over the run's journal, to terminal, with the Harness still open (a run that ran but whose
 *  loop has not written the end yet). */
async function runToTerminal(store, claim, { workflow, input }) {
  const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
  const nodes = nodeRunner({ agent: (node) => ({ model: byTier.get(node.tier ?? "default"), extensions: [], tools: [] }) });
  const workflows = createWorkflowExtension({ run: ({ runtime, context }) => ({ adapters: { runNode: nodes.on(taskScope(runtime), context).runNode }, durableNodes: true }) });
  const registry = createRegistry();
  registry.install(nodes.extension);
  registry.install(workflows.extension);
  const harness = await Harness.open(store.journal(claim), { models, registry, onReport: () => {} }, BACKGROUND_CONTEXT);
  await startWorkflowRevision({ harness, workflows, context: BACKGROUND_CONTEXT, run: { runId: claim.runId, agentId: "agent-1", revision: { id: "rev-1", kind: "workflow", body: { workflow } } }, input, tools: inspectWorkflow(workflow).requires.tools });
  return harness;
}

/** Polls the run's journal until one of its nodes is working (the workflow has started a node). */
async function untilWorking(store, runId, workflow) {
  for (let i = 0; i < 400; i++) {
    const view = await readWorkflowRun({ runId, storage: store.readJournal(runId), revision: { body: { workflow } } }, { context: BACKGROUND_CONTEXT });
    if (Object.values(view.status).includes("working")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the workflow never started a node");
}

test("the runner picks the workflow loop for a workflow revision, not an agentic one", () => {
  assert.equal(isWorkflowRevision({ kind: "workflow" }), true);
  assert.equal(isWorkflowRevision({ kind: "agentic" }), false);
});

test("a workflow run runs to its end through the loop: the run ends completed, its summary the completed node", async (t) => {
  const { store, claim } = await claimedWorkflow(t);
  const loop = loopOn(store, answerFlow(), { question: "What is six times seven?" });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  const run = await store.runs.get("run-1");
  assert.equal(run.state, "ended");
  assert.equal(run.summary, "answer", "the carry names the completed node");
  assert.equal(run.outcome, null, "a run that did not escalate has no outcome (reads completed)");
});

test("a cancel ends the run stopped, taking the stop row in the end commit", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  const loop = loopOn(store, workflow, { question: "Take your time." });
  const started = loop.start(claim);
  await untilWorking(store, "run-1", workflow);
  const stop = await store.command("run-1", { kind: "stop", body: {} });
  await loop.stop({ kind: "command", commandId: stop.id });
  assert.deepEqual(await started, { state: "stopped" });
  assert.equal((await store.runs.get("run-1")).state, "stopped");
  // The stop row was taken in the end commit, not left untaken.
  const rows = await store.commands("run-1", 0);
  assert.equal(rows.find((row) => row.id === stop.id).takenAt !== null, true, "the stop row is taken");
});

test("a workflow run takes no messages or answers", async (t) => {
  const { store, claim } = await claimedWorkflow(t);
  const loop = loopOn(store, answerFlow(), { question: "What is six times seven?" });
  const outcome = await loop.command({ id: 1, runId: "run-1", kind: "steer", body: { text: "faster" }, takenAt: null });
  assert.equal("refused" in outcome, true);
  await loop.start(claim);
});

test("a claim lost before the end commit resumes the workflow from its journal and ends the run", async (t) => {
  const { store, claim, workflow } = await claimedWorkflow(t);
  // The workflow runs to terminal on the first claim, but its loop never writes the end: a crash before the end commit.
  const harness = await runToTerminal(store, claim, { workflow, input: { question: "What is six times seven?" } });
  await harness.close(BACKGROUND_CONTEXT);
  assert.equal((await store.runs.get("run-1")).state, "running", "no end was written before the crash");

  // The runner loses the claim and re-claims; the loop resumes, reads the terminal workflow from the journal, and ends it.
  await store.release(claim, {});
  const claim2 = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const loop = loopOn(store, workflow, { question: "What is six times seven?" });
  assert.deepEqual(await loop.start(claim2), { state: "ended" });
  const run = await store.runs.get("run-1");
  assert.equal(run.state, "ended");
  assert.equal(run.summary, "answer");
});
