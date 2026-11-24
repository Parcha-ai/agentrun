// Shared by the runner's learned-workflow tests: an agent's learned workflows saved on its learning rows through the one
// write a run's compile merge lands a draft with (learningCommit), then a person's retire (changeWorkflow), and the
// learning start a launch carries over the save they landed at. The runner reads them from there at the claim
// (runner/learning-seed.ts), never from a pin in the run's directory. `target` is the store (or a test server, or its
// data directory: learn-support.mjs overStore).
import assert from "node:assert/strict";
import { overStore } from "./learn-support.mjs";

const { learningCommit } = await import("../dist/learn/commit.js");
const { learningOf, readView } = await import("../dist/learn/rows.js");
const { changeWorkflow, etagOf } = await import("../dist/learning-routes.js");
const { recordPromotion } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");

/** The promotion records of `flows` (each `{ name, workflow }`) as their one check promoted them (runner/promotion.ts
 *  decideCheck): a landed workflow serves first only once its check promoted it, and with no run of the agent's to check
 *  it on it is never promoted (it stops). What a test of serving starts from. */
export const checkedOf = (flows) => flows.map(({ name, workflow }) => ({
  workflow: name, digest: workflowDigest({ workflow: JSON.stringify(workflow) }), at: new Date(0).toISOString(), decided: "promote", source: "check",
  reason: "checked on 1 of the agent's inputs: promoted", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 1, agreed: 1, alone: 1, of: [] },
}));

/** Records `flows` promoted by their checks (checkedOf) as agent `agentId`'s promotion records. */
export async function promoteChecked(target, agentId, flows) {
  await overStore(target, async (store) => {
    for (const record of checkedOf(flows)) assert.equal((await recordPromotion(store.learning, agentId, record, () => true)).won, true);
  });
}

/** Agent `agentId`'s promotion records replaced by `items` (each a PromotionRecord), as a test lays them down whole. */
export const putPromotions = (target, agentId, items) => overStore(target, (store) => store.learning.changeRecords(agentId, "promotion", () => ({
  records: items.map((record) => ({ runId: null, workflow: record.workflow, digest: record.digest, data: record })), result: undefined,
})));

/** A learned workflow's README.md, as a merge keeps it: its name and the line its tool's description says it with. */
export const readmeOf = (name, description, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n`;

/** Lands `flows` on agent `agentId`'s learning, each `{ name, description, workflow, status }`: merged by a run as its
 *  compile merge lands a draft (`pending`: held for its owner's OK), then `retired` ones retired by a person (the retire
 *  route's write, changeWorkflow). Answers the newest save's version id after: what a run's learning start pins. */
export async function landWorkflows(target, agentId, flows) {
  return overStore(target, async (store) => {
    const learning = learningOf(store, agentId);
    // The first save made as a first run's seed makes it.
    await store.learning.seed(agentId);
    let at = 0;
    for (const { name, description, workflow, status } of flows) {
      const readme = `workflows/${name}/README.md`;
      const merged = await learningCommit(learning, {
        runId: `run-learned-${++at}`, reason: `learned ${name}`,
        files: [{ path: `workflows/${name}/workflow.json`, text: JSON.stringify(workflow) }, { path: readme, text: readmeOf(name, description) }],
        ...(status === "pending" ? { held: [readme] } : {}),
      });
      assert.equal(merged.ok, true, JSON.stringify(merged));
    }
    for (const { name } of flows.filter(({ status }) => status === "retired")) {
      const item = (await readView(learning)).workflows.find((one) => one.name === name);
      const retired = await changeWorkflow(store, agentId, item.file, { action: "retire", ifMatch: etagOf(item.oid), refuse: [] });
      assert.equal(retired.status, 200, JSON.stringify(retired));
    }
    const view = await readView(learning);
    const statuses = Object.fromEntries(view.workflows.map((one) => [one.name, one.status]));
    assert.deepEqual(statuses, Object.fromEntries(flows.map(({ name, status = "active" }) => [name, status])), "each workflow lands with its status");
    return view.main;
  });
}

/** The run's learning start, as a launch carries it: the seed its learning pinned, no corrections section. */
export const startAt = (seed) => ({ seed, section: "" });
