// The workflow ports in the real curator: a run saves a workflow and says when to use it, curate admits it through
// `workflowAdmitter`, three later runs use it from their own stores, and `usesSettler` promotes it, with no model call.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { WorkflowStore } from "@parcha/agentrun-pi/workflows";
import { local, openRepo } from "@parcha/pi-git-remote";
import { collectWorkflows, curate, PROMOTION_DEFAULTS, proposeLearning, readTrial, renderSkill, schemaDescription, seedWorkflows, usesSource, workflowsToTry } from "../dist/index.js";
import { agentRepo, scratch, SCREEN_PASS, HOST_TOOLS } from "./support.mjs";
import { liveRun, runStoreWith, workDirWith, workflowDoc } from "./workflow-support.mjs";

const WHEN = "Quote a SKU from the price service, escalating anything over 100.";
const NAME = "sku-quote";
const DEFAULTS = { general: 0.95, narrowsRules: 0.02, fromContent: 0.02, duplicate: 0.03, supersedes: 0.03, contradicts: 0.03, workflowCase: 0.03 };

/** A judge that finds every candidate general, new and harmless. */
const judge = async (params) => {
  const [question] = Object.keys(params.questions);
  return { answers: { [question]: { type: "noul", noul: DEFAULTS[question] } }, model: "fake", usage: null, cost_usd: 0 };
};

test("through the real curator: a workflow is admitted from a run's branch, its uses are settled run by run, and the second promotes it", async () => {
  const root = await scratch();
  const { bare, repo } = await agentRepo(root);
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });
  // No ports are passed: curate admits and settles by default, so a host cannot forget the workflow pieces.
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
  const first = await curate({ screen: SCREEN_PASS, tools: HOST_TOOLS, repo: curator, judge, now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(first.runs.length, 1);
  assert.deepEqual([first.runs[0].held, first.runs[0].refused], [[], []], JSON.stringify(first.runs[0]));
  const trial = await readTrial(curator, NAME, "main");
  assert.deepEqual([trial.status, trial.revisions.map((r) => [r.sha256, r.status, r.run])], ["trial", [[digest, "trial", "run-1"]]]);
  // The skill is described from the workflow's own schemas, never from the run's note.
  assert.equal(await curator.read(`.agents/skills/${NAME}/SKILL.md`, "main"), renderSkill(NAME, schemaDescription(doc)));
  assert.deepEqual(await workflowsToTry({ repo: curator, sha: await curator.resolve("main") }, input), [{ name: NAME, status: "trial" }]);

  // Runs 2 and 3 are seeded from main, run the workflow from their own stores, and propose how it went.
  const statuses = [];
  for (const run of ["run-2", "run-3"]) {
    const main = await curator.resolve("main");
    const hints = await workflowsToTry({ repo: curator, sha: main }, input);
    const { dir: workDir } = await workDirWith();
    await seedWorkflows({ repo: curator, sha: main, into: workDir, workflows: hints });
    const store = await runStoreWith([{ key: `k-${run}`, workflow: (await new WorkflowStore(workDir).load(NAME)).workflow, input }]);
    assert.equal((await proposeLearning({ repo: curator, runId: run, target: { snapshot: async () => ({ order: [], byCall: {} }) }, uses: usesSource({ store, workDir, run }) })).status, "proposed");
    const report = await curate({ screen: SCREEN_PASS, tools: HOST_TOOLS, repo: curator, judge });
    const settled = report.runs.find((r) => r.run === run).settled;
    statuses.push([(await readTrial(curator, NAME, "main")).status, settled.map((s) => [s.workflow, s.reason.split(":")[0]])]);
  }
  assert.deepEqual(statuses, [["trial", [[NAME, "hold"]]], ["active", [[NAME, "promote"]]]]);
  assert.deepEqual(await workflowsToTry({ repo: curator, sha: await curator.resolve("main") }, input), [{ name: NAME, status: "active" }]);
}, { timeout: 120_000 });

test("a run that saves a new revision still counts its clean use of the trial it ran, first: that use promotes it, and the new revision then supersedes it (restorable)", async () => {
  const root = await scratch();
  const { bare, repo } = await agentRepo(root);
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });
  const input = { sku: "A-1", amount: 5 };
  const propose = async (run, { workDir, uses, saved }) => {
    const seed = await curator.resolve("main");
    const workflows = saved ? (await collectWorkflows({ repo: curator, workDir, seedSha: seed })).records : undefined;
    const proposed = await proposeLearning({ repo: curator, runId: run, target: { snapshot: async () => ({ order: [], byCall: {} }) }, ...(uses ? { uses } : {}), ...(workflows ? { workflows } : {}) });
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
    const report = await curate({ screen: SCREEN_PASS, tools: HOST_TOOLS, repo: curator, judge });
    return report.runs.find((r) => r.run === run);
  };
  // Run 1 saves revision one.
  const { dir: authorDir, saved } = await workDirWith({ [NAME]: workflowDoc() });
  const one = saved[NAME];
  const collected = await collectWorkflows({ repo, workDir: authorDir, seedSha: await repo.resolve("main") });
  const note = { callId: "call-1", type: "workflow", id: NAME, text: WHEN, evidence: [] };
  assert.equal((await proposeLearning({ repo, runId: "run-1", target: { snapshot: async () => ({ order: ["call-1"], byCall: { "call-1": note } }) }, workflows: collected.records })).status, "proposed");
  await curate({ screen: SCREEN_PASS, tools: HOST_TOOLS, repo: curator, judge, now: new Date("2026-01-01T00:00:00Z") });
  /** A run seeded from main that runs the live revision cleanly and, with `next`, saves a new revision of the name too. */
  const run = async (id, next) => {
    const main = await curator.resolve("main");
    const { dir: workDir } = await workDirWith();
    await seedWorkflows({ repo: curator, sha: main, into: workDir, workflows: await workflowsToTry({ repo: curator, sha: main }, input) });
    const store = await runStoreWith([{ key: `k-${id}`, workflow: (await new WorkflowStore(workDir).load(NAME)).workflow, input }]);
    const digest = next ? (await new WorkflowStore(workDir).save(NAME, next)).digest : undefined;
    return { report: await propose(id, { workDir, uses: usesSource({ store, workDir, run: id }), saved: Boolean(next) }), digest };
  };
  // All but the last clean use the package's promotion needs, from runs that save nothing: still a trial.
  for (let i = 2; i <= PROMOTION_DEFAULTS.promoteAfter; i += 1) {
    const { report } = await run(`run-${i}`);
    assert.deepEqual(report.settled.map((s) => s.reason.split(":")[0]), ["hold"], `run-${i}: still a trial`);
  }
  // The next run runs revision one cleanly AND saves revision three: its use is settled first, and promotes revision one.
  const { report: third, digest: three } = await run(`run-${PROMOTION_DEFAULTS.promoteAfter + 1}`, workflowDoc({ limit: 200 }));
  assert.deepEqual(third.settled.map((s) => [s.workflow, s.reason.split(":")[0]]), [[NAME, "promote"]], JSON.stringify(third));
  assert.deepEqual(third.accepted.map((a) => a.workflow), [NAME]);
  const trial = await readTrial(curator, NAME, "main");
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status]), [[one, "superseded"], [three, "trial"]], "revision one stays restorable under the new trial");
}, { timeout: 120_000 });

test("a curate with the ports turned off holds the workflows and their uses, and says so", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root);
  const { dir: workDir } = await workDirWith({ [NAME]: workflowDoc() });
  const collected = await collectWorkflows({ repo, workDir, seedSha: await repo.resolve("main") });
  await proposeLearning({ repo, runId: "run-1", target: { snapshot: async () => ({ order: [], byCall: {} }) }, workflows: collected.records });
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(path.join(root, "remote.git")) });
  const report = await curate({ screen: SCREEN_PASS, tools: HOST_TOOLS, repo: curator, judge, admitWorkflow: null, settleUses: null });
  assert.deepEqual(report.runs[0].held.map((h) => h.reason), ["no workflow admitter is installed"]);
  assert.equal(await curator.read(`.agents/skills/${NAME}/trial.json`, "main"), undefined);
});

test("a propose with only the run's working directory proposes the workflow it saved and how it used the ones it had", async () => {
  const root = await scratch();
  const { bare, repo } = await agentRepo(root);
  const doc = workflowDoc();
  const { dir: workDir, saved } = await workDirWith({ [NAME]: doc });
  const run = await liveRun([{ key: "k1", workflow: doc, input: { sku: "A-1", amount: 5 } }, { key: "k2", workflow: doc, input: { sku: "A-2", amount: 500 } }]);
  try {
    const result = await proposeLearning({ repo, runId: "run-1", target: run.harness, workDir });
    assert.equal(result.status, "proposed");
    const inspector = await openRepo({ dir: path.join(root, "inspector"), remote: local(bare) });
    await inspector.fetch();
    const branch = await inspector.resolve("runs/run-1");
    const names = (await inspector.list("", branch)).map((e) => e.path).filter((p) => p.startsWith("workflows/") || p.startsWith("uses/")).sort();
    assert.deepEqual(names, ["uses/run-1.json", `workflows/${NAME}/README.md`, `workflows/${NAME}/workflow.json`]);
    const uses = JSON.parse(await inspector.read("uses/run-1.json", branch));
    assert.deepEqual(uses.uses.map((u) => [u.name, u.sha256, u.outcome]), [[NAME, saved[NAME], "frozen"], [NAME, saved[NAME], "escalated"]]);
    // Explicit files win over what would be collected.
    const explicit = await proposeLearning({ repo, runId: "run-2", target: run.harness, workDir, workflows: {}, uses: () => undefined });
    assert.equal(explicit.status, "empty", "nothing was passed and nothing was collected");
  } finally {
    await run.close();
  }
});

test("a trial.json on main that does not parse holds that workflow, and curation goes on", async () => {
  const root = await scratch();
  const { bare, repo } = await agentRepo(root);
  const damaged = await repo.commitTo("main", { files: { [`.agents/skills/${NAME}/trial.json`]: "not json\n" }, message: "a damaged trial", parent: await repo.resolve("main") });
  await repo.push(damaged.sha, "main");
  const { dir: workDir } = await workDirWith({ [NAME]: workflowDoc() });
  const collected = await collectWorkflows({ repo, workDir, seedSha: damaged.sha });
  await proposeLearning({ repo, runId: "run-1", target: { snapshot: async () => ({ order: [], byCall: {} }) }, workflows: collected.records });
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });
  const report = await curate({ screen: SCREEN_PASS, tools: HOST_TOOLS, repo: curator, judge });
  assert.deepEqual(report.runs.map((r) => [r.run, r.held.map((h) => [h.workflow, h.reason]), r.refused]), [
    ["run-1", [[NAME, "its trial.json on main does not parse (format), so the workflow was held"]], []],
  ]);
  assert.equal(await curator.read(`.agents/skills/${NAME}/trial.json`, "main"), "not json\n");
});
