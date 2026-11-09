// learned_workflow on the runner (adapter-run-spec.ts learnedWorkflowHostTool): listed when the run's pin names learned
// workflows. Every run's session — pi's and every CLI harness's — has a model port, so its model nodes run on the
// session's proxied models, read from the run's one ledger under the learned_workflow label
// (run.ledger.models(LEARNED_WORKFLOW_TOOL)): so a node's model call is a request on the run's one route, labelled and
// booked by the session. A run whose pin names no learned workflow lists none.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { learnedWorkflowHostTool, hostToolCtxOf } = await import("../dist/runner/adapter-run-spec.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");
const { LEARNING_PIN, LEARNED_WORKFLOWS_FILE } = await import("../dist/learning.js");
const { PORT_PROVIDER } = await import("../dist/port-models.js");

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** One model node (`extract`) workflow, as its directory keeps it: the run's pin names it, learned-workflows.json holds it. */
const answerFlow = {
  v: 2, name: "answer",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [{ node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" }] },
};

/** A run folder whose pin names the `answer` workflow and whose directory keeps it. */
function pinnedRun() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learned-cli-"));
  dirs.push(dir);
  writeFileSync(join(dir, LEARNING_PIN), JSON.stringify({ seed: null, section: "", workflows: ["answer"] }));
  writeFileSync(join(dir, LEARNED_WORKFLOWS_FILE), JSON.stringify([{ name: "answer", description: "Answers a question as a number", workflow: JSON.stringify(answerFlow) }]));
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
  const work = pinnedRun();
  const asked = [];
  const run = fakeRun(asked);
  const tool = await learnedWorkflowHostTool({ run, granted: [LEARNED_WORKFLOW_TOOL], plane: undefined, env: {}, work, ctx: hostToolCtxOf(run, ctx, new Map(), work) });
  assert.ok(tool && tool.name === LEARNED_WORKFLOW_TOOL, `learned_workflow is listed: ${JSON.stringify(tool && tool.name)}`);
  assert.deepEqual(asked, [LEARNED_WORKFLOW_TOOL], "its model nodes take the session's proxied models from the run's one ledger, under the learned_workflow label");
});

test("a run whose pin names no learned workflow lists none", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-learned-cli-none-"));
  dirs.push(dir);
  writeFileSync(join(dir, LEARNING_PIN), JSON.stringify({ seed: null, section: "" }));
  const run = fakeRun([]);
  const tool = await learnedWorkflowHostTool({ run, granted: [LEARNED_WORKFLOW_TOOL], plane: undefined, env: {}, work: dir, ctx: hostToolCtxOf(run, ctx, new Map(), dir) });
  assert.equal(tool, undefined, "no pin flows, no learned_workflow tool");
});

/** The port provider the CLI learned_workflow's model nodes name (port-models.ts), so the session's one model answers. */
test("the CLI learned_workflow's model nodes name the session's port provider", () => {
  assert.equal(PORT_PROVIDER, "agentrun-session", "the port provider id learnedWorkflowHostTool's modelOf names");
});
