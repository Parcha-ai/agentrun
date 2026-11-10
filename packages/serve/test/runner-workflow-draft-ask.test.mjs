// The host asks for a workflow draft once a learned skill has served enough runs (runner/learning-end.ts draftForOf): of
// the skills a run was offered (its launch's learning start), the one offered to DRAFT_AFTER_RUNS or more earlier runs of
// its agent, with no learned workflow of its name on the agent's main, active or waiting for its owner's OK. Its job is
// then asked for as a workflow draft in one line of the run's end-of-run prompt (learn/reflect.ts reflectPrompt draftFor).
// The counts come from each run's launch, the workflows from the agent's learning folder; the end-of-run turn through a
// real runner is runner-learning-end.test.mjs's.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerFlow } from "./support.mjs";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";

const { draftForOf } = await import("../dist/runner/learning-end.js");
const { DRAFT_AFTER_RUNS } = await import("../dist/learn/reflect.js");
const { learningFolderOf, seedOf } = await import("../dist/learning.js");
const { launchBody } = await import("../dist/run-launch.js");

const AGENT = "agent-1";
const SKILL = "weekly-report";

/** A store's runs of AGENT, newest first: run-1 (the one ending) offered `offered`, then `earlier` runs, each offered the
 *  skills its entry lists. Only `list` and `launch` are read. */
function storeOf(offered, earlier) {
  const runs = [{ id: "run-1", skills: offered }, ...earlier.map((skills, i) => ({ id: `run-0${i}`, skills }))];
  const bodies = new Map(runs.map(({ id, skills }) => [id, launchBody({ input: { content: "hi" }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: null, section: "", seedNotes: 0, skills } })]));
  return {
    runs: {
      list: async ({ agentId, limit }) => (agentId === AGENT ? runs.map(({ id }) => ({ id, agentId: AGENT })).slice(0, limit) : []),
      launch: async (id) => ({ body: bodies.get(id) }),
    },
  };
}

/** A data directory with AGENT's learning folder made (a first run makes it), and `flows` landed in it. */
async function folderWith(t, flows = []) {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-draft-ask-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  if (flows.length) await landWorkflows(data, AGENT, flows);
  else await seedOf(data, AGENT);
  return { learningFolder: (agentId) => learningFolderOf(data, agentId) };
}

const ask = async (t, { offered = [SKILL], earlier, flows }) => draftForOf({ ...(await folderWith(t, flows)), store: storeOf(offered, earlier) }, AGENT, "run-1", offered);

test("the host waits for 3 earlier runs", () => assert.equal(DRAFT_AFTER_RUNS, 3));

test("a skill offered to 3 earlier runs, with no learned workflow of its name, is asked for as a draft", async (t) => {
  assert.deepEqual(await ask(t, { earlier: [[SKILL], [SKILL], [SKILL]] }), [SKILL]);
});

test("a skill offered to 2 earlier runs is not, and the ending run itself never counts", async (t) => {
  assert.deepEqual(await ask(t, { earlier: [[SKILL], [SKILL], ["another-skill"], []] }), []);
});

test("a skill with a learned workflow of its name, active or waiting for its owner's OK, is not asked for; a retired one is", async (t) => {
  const earlier = [[SKILL], [SKILL], [SKILL]];
  const flow = (status) => [{ name: SKILL, description: "Writes the weekly report", workflow: answerFlow(), ...(status ? { status } : {}) }];
  assert.deepEqual(await ask(t, { earlier, flows: flow() }), [], "active");
  assert.deepEqual(await ask(t, { earlier, flows: flow("pending") }), [], "pending");
  assert.deepEqual(await ask(t, { earlier, flows: flow("retired") }), [SKILL], "retired: no draft covers the job now");
  // A workflow of another name covers another job.
  assert.deepEqual(await ask(t, { earlier, flows: [{ name: "other-job", description: "Another job", workflow: answerFlow() }] }), [SKILL]);
});

test("one skill at most is asked for: the first due in the seed's order; a skill the run was not offered is never", async (t) => {
  const earlier = [[SKILL, "find-policies"], [SKILL, "find-policies"], ["find-policies"], ["stale-skill"], ["stale-skill"], ["stale-skill"]];
  assert.deepEqual(await ask(t, { offered: [SKILL, "find-policies"], earlier }), ["find-policies"], "weekly-report served 2, find-policies 3");
  assert.deepEqual(await ask(t, { offered: ["find-policies", SKILL], earlier: [...earlier, [SKILL]] }), ["find-policies"], "both due: the first offered");
  assert.deepEqual(await ask(t, { offered: [], earlier }), [], "a run offered no skill asks nothing, whatever earlier runs had");
  // A due skill whose workflow is there gives way to the next due one.
  const flows = [{ name: "find-policies", description: "Finds policies", workflow: answerFlow() }];
  assert.deepEqual(await ask(t, { offered: ["find-policies", SKILL], earlier: [...earlier, [SKILL]], flows }), [SKILL]);
});

test("only the agent's latest runs are read: a skill offered to 3 runs older than DRAFT_SCAN_RUNS of them is no repeated job", async (t) => {
  const { DRAFT_SCAN_RUNS } = await import("../dist/runner/learning-end.js");
  const filler = Array.from({ length: DRAFT_SCAN_RUNS }, () => []);
  assert.deepEqual(await ask(t, { earlier: [...filler.slice(1), [SKILL], [SKILL], [SKILL]] }), [], "two of the three are past the latest runs");
  assert.deepEqual(await ask(t, { earlier: [...filler.slice(3), [SKILL], [SKILL], [SKILL]] }), [SKILL], "all three within them");
});

test("a learning folder that can't be read asks for nothing: never a draft that may be there already", async () => {
  const broken = { workspace: { read: async () => { throw new Error("the folder is down"); } }, end: async () => {} };
  const store = storeOf([SKILL], [[SKILL], [SKILL], [SKILL]]);
  assert.deepEqual(await draftForOf({ store, learningFolder: () => broken }, AGENT, "run-1", [SKILL]), []);
});
