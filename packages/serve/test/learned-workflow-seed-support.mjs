// Shared by the runner's learned-workflow tests: an agent's learned workflows landed in its learning folder through the
// folder's one write (learningCommit), as a run's compile merge lands a draft and a person's retire retires one, and the
// learning start a launch carries over the commit they landed at. The runner reads them from there at the claim
// (runner/learning-seed.ts), never from a pin in the run's directory.
import assert from "node:assert/strict";

const { learningStoreOf } = await import("../dist/learn/store-of.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { readSnapshot } = await import("../dist/learn/folder.js");
const { changeWorkflow } = await import("../dist/learning-routes.js");
const { seedOf } = await import("../dist/learning.js");
const { recordPromotion } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");

/** The promotion records of `flows` (each `{ name, workflow }`) as their one check promoted them (runner/promotion.ts
 *  decideCheck): a landed workflow serves first only once its check promoted it, and with no run of the agent's to check
 *  it on it is never promoted (it stops). What a test of serving starts from. */
export const checkedOf = (flows) => flows.map(({ name, workflow }) => ({
  workflow: name, digest: workflowDigest({ workflow: JSON.stringify(workflow) }), at: new Date(0).toISOString(), decided: "promote", source: "check",
  reason: "checked on 1 of the agent's inputs: promoted", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 1, agreed: 1, alone: 1, of: [] },
}));

/** Records `flows` promoted by their checks (checkedOf) in `settings`, agent `agentId`'s promotion records. */
export async function promoteChecked(settings, agentId, flows) {
  for (const record of checkedOf(flows)) assert.equal((await recordPromotion(settings, agentId, record, () => true)).won, true);
}

/** A learned workflow's README.md, as a merge keeps it: its name and the line its tool's description says it with. */
export const readmeOf = (name, description, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n`;

/** Lands `flows` in agent `agentId`'s learning folder under `data`, each `{ name, description, workflow, status }`:
 *  merged by a run as its compile merge lands a draft (`pending`: held for its owner's OK), then `retired` ones retired
 *  by a person (the retire route's write, changeWorkflow). Answers main's commit after: the sha a run's learning start
 *  pins. */
export async function landWorkflows(data, agentId, flows) {
  // The folder made as a first run makes it (the learning script's init).
  await seedOf(data, agentId);
  const folder = learningStoreOf(data, agentId);
  let at = 0;
  for (const { name, description, workflow, status } of flows) {
    const readme = `workflows/${name}/README.md`;
    const merged = await learningCommit(folder, {
      runId: `run-learned-${++at}`, reason: `learned ${name}`,
      files: [{ path: `workflows/${name}/workflow.json`, text: JSON.stringify(workflow) }, { path: readme, text: readmeOf(name, description) }],
      ...(status === "pending" ? { held: [readme] } : {}),
    });
    assert.equal(merged.ok, true, JSON.stringify(merged));
  }
  for (const { name } of flows.filter(({ status }) => status === "retired")) {
    const readme = `workflows/${name}/README.md`;
    const item = await snapshotOf(data, agentId).then((snap) => snap.workflows.find((one) => one.name === name));
    const retired = await changeWorkflow(data, agentId, readme, { action: "retire", ifMatch: `"${item.files.find((file) => file.path === readme).oid}"`, refuse: [] });
    assert.equal(retired.status, 200, JSON.stringify(retired));
  }
  const folder2 = learningStoreOf(data, agentId);
  const statuses = Object.fromEntries((await readSnapshot(folder2)).workflows.map((one) => [one.name, one.status]));
  assert.deepEqual(statuses, Object.fromEntries(flows.map(({ name, status = "active" }) => [name, status])), "each workflow lands with its status");
  return (await seedOf(data, agentId)).sha;
}

/** Agent `agentId`'s learning folder snapshot, the folder opened for the read and ended after. */
async function snapshotOf(data, agentId) {
  const folder = learningStoreOf(data, agentId);
  return await readSnapshot(folder);
}

/** The run's learning start, as a launch carries it: the seed its learning pinned, no corrections section. */
export const startAt = (seed) => ({ seed, section: "" });
