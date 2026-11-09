// The interpreter's host (runner/workflow-host.ts): the workflow task's adapters moved from app.ts, the run infrastructure
// (the model proxy, the node-tool table, the cap) injected. This proves the host drives a model node on the run's models,
// through the loop, to the run's end, with no cap wired — a faux model, no money. The call-node and decision adapters and
// the cap are exercised by the conformance subject and the money-parity reds once the money seam is wired.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorkflow } from "@parcha/agentrun-dsl";
import { storeOn } from "./store-helpers.mjs";
import { answerFlow, FAUX } from "./support.mjs";

const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowHost } = await import("../dist/runner/workflow-host.js");
const { runModels, FAUX_ENV } = await import("../dist/model.js");

test("the host runs a model node on the run's models through the loop, to the run's end", async (t) => {
  const { store } = await storeOn(t);
  const workflow = answerFlow();
  await store.agents.create({ id: "agent-1", name: "agent-1" }, { id: "rev-1", kind: "workflow", body: { workflow } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });

  const workRoot = mkdtempSync(join(tmpdir(), "wf-host-"));
  t.after(() => rmSync(workRoot, { recursive: true, force: true }));
  const { models, byTier } = await runModels({ [FAUX_ENV]: FAUX }, undefined, ["default"]);
  const log = [];
  const specOf = () => ({
    models, workflow, input: { question: "What is six times seven?" }, tools: inspectWorkflow(workflow).requires.tools, agentId: "agent-1", revisionId: "rev-1",
    build: () => workflowHost({
      modelOf: (tier) => byTier.get(tier ?? "default"),
      sharedExtensions: [],
      nodeTool: () => undefined,
      runEffect: async () => { throw new Error("this workflow has no call node"); },
      workRoot,
      flush: async () => store.flush(),
      log: (line) => log.push(line),
    }),
  });
  const loop = createWorkflowLoop(specOf)({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });

  assert.deepEqual(await loop.start(claim), { state: "ended" });
  const run = await store.runs.get("run-1");
  assert.equal(run.state, "ended");
  assert.equal(run.summary, "answer", "the completed node's label");
  assert.ok(log.some((line) => line.t === "node.start"), `the host's node log saw the node run: ${JSON.stringify(log)}`);
});
