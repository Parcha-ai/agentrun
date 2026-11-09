// learned_workflow on the runner (adapter-run-spec.ts learnedWorkflowHostTool): listed when the claim's seed lay chose
// learned workflows (runner/learning-seed.ts; runner-learned-workflows-seed pins that read). Every run's session — pi's and every CLI harness's — has a model port, so its model nodes run on the
// session's proxied models, read from the run's one ledger under the learned_workflow label
// (run.ledger.models(LEARNED_WORKFLOW_TOOL)): so a node's model call is a request on the run's one route, labelled and
// booked by the session. A run with no learned workflow lists none.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { learnedWorkflowHostTool, hostToolCtxOf } = await import("../dist/runner/adapter-run-spec.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");
const { PORT_PROVIDER } = await import("../dist/port-models.js");

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** One model node (`extract`) workflow. */
const answerFlow = {
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};

/** The `answer` workflow as the claim's seed lay hands it on. */
const answer = { name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(answerFlow) };

/** A run folder. */
function runDir() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learned-cli-"));
  dirs.push(dir);
  return dir;
}

/** A fake run: its one ledger records every label its proxied models are asked for (run.ledger.models). */
function fakeRun(asked) {
  const portModels = { getModel: () => undefined, getModels: () => [], completeSimple: async () => ({}), streamSimple: () => ({}) };
  return {
    harness: { commit: async () => {}, snapshot: async () => undefined, conversation: async () => undefined, waitForTask: async () => undefined },
    registry: {}, setModels: () => {},
    ledger: { models: async (label) => (asked.push(label), portModels) },
  };
}

test("a run lists learned_workflow for real: its model nodes run on the session's proxied models, asked under the learned_workflow label", async () => {
  const work = runDir();
  const asked = [];
  const run = fakeRun(asked);
  const tool = await learnedWorkflowHostTool({ run, kind: "agentic", granted: ["read"], plane: undefined, env: {}, work, workflows: [answer], ctx: hostToolCtxOf(run, ctx, new Map(), work) });
  assert.ok(tool && tool.name === LEARNED_WORKFLOW_TOOL, `learned_workflow is listed: ${JSON.stringify(tool && tool.name)}`);
  assert.deepEqual(asked, [LEARNED_WORKFLOW_TOOL], "its model nodes take the session's proxied models from the run's one ledger, under the learned_workflow label");
});

test("a run with no learned workflow lists none, nor a workflow revision's run; a revision never grants it to list it", async () => {
  const dir = runDir();
  const run = fakeRun([]);
  const none = await learnedWorkflowHostTool({ run, kind: "agentic", granted: ["read"], plane: undefined, env: {}, work: dir, workflows: [], ctx: hostToolCtxOf(run, ctx, new Map(), dir) });
  assert.equal(none, undefined, "no learned workflow, no learned_workflow tool");
  const workflowKind = await learnedWorkflowHostTool({ run, kind: "workflow", granted: ["read"], plane: undefined, env: {}, work: dir, workflows: [answer], ctx: hostToolCtxOf(run, ctx, new Map(), dir) });
  assert.equal(workflowKind, undefined, "a workflow revision's run has no learned_workflow tool");
  const ungranted = await learnedWorkflowHostTool({ run, kind: "agentic", granted: ["read"], plane: undefined, env: {}, work: dir, workflows: [answer], ctx: hostToolCtxOf(run, ctx, new Map(), dir) });
  assert.equal(ungranted?.name, LEARNED_WORKFLOW_TOOL, "listed though the revision names only its own tools, as main lists it");
});

/** The port provider the CLI learned_workflow's model nodes name (port-models.ts), so the session's one model answers. */
test("the CLI learned_workflow's model nodes name the session's port provider", () => {
  assert.equal(PORT_PROVIDER, "agentrun-session", "the port provider id learnedWorkflowHostTool's modelOf names");
});
