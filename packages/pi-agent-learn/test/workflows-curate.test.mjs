// The workflow ports in the real curator: a run saves a workflow and says when to use it, curate admits it through
// `workflowAdmitter`, three later runs use it from their own stores, and `usesSettler` promotes it, with no model call.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { WorkflowStore } from "@parcha/agentrun-pi/workflows";
import { local, openRepo } from "@parcha/pi-git-remote";
import { collectWorkflows, curate, proposeLearning, readTrial, renderSkill, seedWorkflows, usesSettler, usesSource, workflowAdmitter, workflowsToTry } from "../dist/index.js";
import { agentRepo, scratch } from "./support.mjs";
import { runStoreWith, workDirWith, workflowDoc } from "./workflow-support.mjs";

const WHEN = "Quote a SKU from the price service, escalating anything over 100.";
const NAME = "sku-quote";
const DEFAULTS = { general: 0.95, narrowsRules: 0.02, fromContent: 0.02, duplicate: 0.03, supersedes: 0.03, contradicts: 0.03 };

/** A judge that finds every candidate general, new and harmless. */
const judge = async (params) => {
  const [question] = Object.keys(params.questions);
  return { answers: { [question]: { type: "noul", noul: DEFAULTS[question] } }, model: "fake", usage: null, cost_usd: 0 };
};

test("through the real curator: a workflow is admitted from a run's branch, its uses are settled run by run, and the third promotes it", async () => {
  const root = await scratch();
  const { bare, repo } = await agentRepo(root);
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });
  const tmpRoot = await scratch();
  const ports = { admitWorkflow: workflowAdmitter({ tmpRoot }), settleUses: usesSettler({ tmpRoot }) };
  const doc = workflowDoc();
  const input = { sku: "A-1", amount: 5 };

  // Run 1 saves the workflow and notes when to use it.
  const { dir: authorDir, saved } = await workDirWith({ [NAME]: doc });
  const digest = saved[NAME];
  const seed = await repo.resolve("main");
  const collected = await collectWorkflows({ repo, workDir: authorDir, seedSha: seed });
  const note = { callId: "call-1", type: "workflow", id: NAME, text: WHEN, evidence: [] };
  const target = { snapshot: async () => ({ order: ["call-1"], byCall: { "call-1": note } }) };
  assert.equal((await proposeLearning({ repo, runId: "run-1", target, workflows: collected.records })).status, "proposed");
  const first = await curate({ repo: curator, judge, now: new Date("2026-01-01T00:00:00Z"), ...ports });
  assert.equal(first.runs.length, 1);
  assert.deepEqual([first.runs[0].held, first.runs[0].refused], [[], []], JSON.stringify(first.runs[0]));
  const trial = await readTrial(curator, NAME, "main");
  assert.deepEqual([trial.status, trial.revisions.map((r) => [r.sha256, r.status, r.run])], ["trial", [[digest, "trial", "run-1"]]]);
  assert.equal(await curator.read(`.agents/skills/${NAME}/SKILL.md`, "main"), renderSkill(NAME, WHEN));
  assert.deepEqual(await workflowsToTry({ repo: curator, sha: await curator.resolve("main") }, input), [{ name: NAME, status: "trial" }]);

  // Runs 2 to 4 are seeded from main, run the workflow from their own stores, and propose how it went.
  const statuses = [];
  for (const run of ["run-2", "run-3", "run-4"]) {
    const main = await curator.resolve("main");
    const hints = await workflowsToTry({ repo: curator, sha: main }, input);
    const { dir: workDir } = await workDirWith();
    await seedWorkflows({ repo: curator, sha: main, into: workDir, workflows: hints });
    const store = await runStoreWith([{ key: `k-${run}`, workflow: (await new WorkflowStore(workDir).load(NAME)).workflow, input }]);
    assert.equal((await proposeLearning({ repo: curator, runId: run, target: { snapshot: async () => ({ order: [], byCall: {} }) }, uses: usesSource({ store, workDir, run }) })).status, "proposed");
    const report = await curate({ repo: curator, judge, ...ports });
    const settled = report.runs.find((r) => r.run === run).settled;
    statuses.push([(await readTrial(curator, NAME, "main")).status, settled.map((s) => [s.workflow, s.reason.split(":")[0]])]);
  }
  assert.deepEqual(statuses, [["trial", [[NAME, "hold"]]], ["trial", [[NAME, "hold"]]], ["active", [[NAME, "promote"]]]]);
  assert.deepEqual(await workflowsToTry({ repo: curator, sha: await curator.resolve("main") }, input), [{ name: NAME, status: "active" }]);
}, { timeout: 120_000 });
