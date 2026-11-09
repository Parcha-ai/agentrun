// Shared by the runner's learned-workflow tests: an agent's learned workflows landed in its learning folder through the
// folder's one write (learningCommit), as a run's graded merge lands a draft and a person's retire retires one, and the
// learning start a launch carries over the commit they landed at. The runner reads them from there at the claim
// (runner/learning-seed.ts), never from a pin in the run's directory.
import assert from "node:assert/strict";

const { learningWorkspace } = await import("../dist/workspace/index.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { readSnapshot } = await import("../dist/learn/folder.js");
const { seedOf } = await import("../dist/learning.js");

/** A learned workflow's README.md, as a merge keeps it: its name and the line its tool's description says it with. */
export const readmeOf = (name, description, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n`;

/** Lands `flows` in agent `agentId`'s learning folder under `data`, each `{ name, description, workflow, status }`:
 *  merged by a run as its graded merge lands a draft (`pending`: held for its owner's OK), then `retired` ones retired by
 *  a person. Answers main's commit after: the sha a run's learning start pins. */
export async function landWorkflows(data, agentId, flows) {
  // The folder made as a first run makes it (the learning script's init).
  await seedOf(data, agentId);
  const folder = learningWorkspace({ mode: "local", data, agentId });
  try {
    let at = 0;
    for (const { name, description, workflow, status } of flows) {
      const readme = `workflows/${name}/README.md`;
      const merged = await learningCommit(folder.workspace, {
        kind: "merge", runId: `run-learned-${++at}`, reason: `learned ${name}`, graded: {},
        files: [{ path: `workflows/${name}/workflow.json`, text: JSON.stringify(workflow) }, { path: readme, text: readmeOf(name, description) }],
        ...(status === "pending" ? { held: [readme] } : {}),
      });
      assert.equal(merged.ok, true, JSON.stringify(merged));
    }
    for (const { name, description } of flows.filter(({ status }) => status === "retired")) {
      const item = (await readSnapshot(folder.workspace)).workflows.find((one) => one.name === name);
      const retired = await learningCommit(folder.workspace, { kind: "person", action: "retired", file: `workflows/${name}/README.md`, text: readmeOf(name, description, "status: retired\n"), ifMatch: item.oid });
      assert.equal(retired.ok, true, JSON.stringify(retired));
    }
    const statuses = Object.fromEntries((await readSnapshot(folder.workspace)).workflows.map((one) => [one.name, one.status]));
    assert.deepEqual(statuses, Object.fromEntries(flows.map(({ name, status = "active" }) => [name, status])), "each workflow lands with its status");
  } finally {
    await folder.end();
  }
  return (await seedOf(data, agentId)).sha;
}

/** The run's learning start, as a launch carries it: the seed its learning pinned, nothing given whole. */
export const startAt = (seed) => ({ given: [], seed, section: "", seedNotes: 0 });
