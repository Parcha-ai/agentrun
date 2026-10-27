// Pi's loop on the layout every harness shares: a run's branch the step 1 checker accepts, a curate that merges it with a
// merge commit after the checker and the injection screen, and workflows at workflows/<name>/ that old repositories still
// serve from .pi/agentrun/workflows/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkBranch } from "@parcha/agentrun-learn";
import { local, openRepo } from "@parcha/pi-git-remote";
import { curate, learningId, parseLearning, proposeLearning, readRevision, renderLearning, seedWorkflows, workflowsToTry } from "../dist/index.js";
import { agentRepo, learning, learningFiles, scratch } from "./support.mjs";
import { workDirWith, workflowDoc } from "./workflow-support.mjs";

const LESSON = "Company registries match the legal name without the suffix; search both forms.";
const OLD = learning("L-0123456789ab", "Registries are case-insensitive.");
const TOOLS = ["prices.quote"];
const SCREEN = async () => 0.05;
const ACCEPT = { general: 0.95, narrowsRules: 0.02, fromContent: 0.02, duplicate: 0.03, supersedes: 0.03, contradicts: 0.03, workflowCase: 0.02 };
const judge = async (params) => {
  const [q] = Object.keys(params.questions);
  return { answers: { [q]: { type: "noul", noul: ACCEPT[q] } }, model: "fake", usage: null, cost_usd: 0 };
};
const candidate = (over = {}) => ({ callId: "call-1", type: "lesson", text: LESSON, evidence: ["a 404 on the full name"], ...over });
const targetOf = (candidates, seed) => ({
  snapshot: async (doc) =>
    doc.definition.kind === "learn.seed"
      ? (seed === undefined ? undefined : { sha: seed, index: [], omitted: [], workflows: [], copied: false })
      : { order: candidates.map((c) => c.callId), byCall: Object.fromEntries(candidates.map((c) => [c.callId, c])) },
});
const gitIn = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
}).trim();

async function world(files = learningFiles([OLD])) {
  const root = await scratch();
  const { bare, main } = await agentRepo(root, files);
  const runs = await openRepo({ dir: path.join(root, "runs-host"), remote: local(bare) });
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });
  return { root, bare, main, runs, curator };
}

/** A seeded run that learned LESSON and used OLD, proposed on its branch. */
async function proposed(w, runId = "run-1", extra = {}) {
  const candidates = [candidate(), candidate({ callId: "call-2", type: "used", id: OLD.id, text: "It held.", evidence: [] })];
  const result = await proposeLearning({ runId, repo: w.runs, target: targetOf(candidates, w.main), secrets: [], caseValues: [], ...extra });
  assert.equal(result.status, "proposed", JSON.stringify(result));
  return result.sha;
}

test("a Pi run's branch is on the shared layout, and the step 1 checker accepts it", async () => {
  const w = await world();
  const tip = await proposed(w);
  const files = (await w.runs.list("", tip)).map((e) => e.path).filter((p) => !["AGENTS.md", "agent.json"].includes(p)).sort();
  const id = learningId("run-1", LESSON);
  assert.deepEqual(files, ["learnings/INDEX.md", `learnings/${OLD.id}.md`, `learnings/${id}.md`, "memos/run-1.md"].sort());
  assert.equal(parseLearning(await w.runs.read(`learnings/${OLD.id}.md`, tip)).uses, OLD.uses + 1, "a used mark is one more use on the note");
  const memo = await w.runs.read("memos/run-1.md", tip);
  assert.match(memo, new RegExp(`^---\\nrun: run-1\\nbase: ${w.main}\\nharness: pi\\noutcome: completed\\nuntrusted: false\\n---\\n## What happened\\n`));
  assert.match(memo, new RegExp(`learnings/${id}\\.md`));
  const report = await checkBranch({ cwd: w.bare, base: "main", head: "runs/run-1", branch: "runs/run-1", tools: TOOLS });
  assert.deepEqual(report.problems, []);
  assert.equal(report.forkPoint, w.main, "the branch starts at the commit the run was seeded from");
});

test("a workflow the run saved is a draft at workflows/<name>/ the checker accepts with the host's tools", async () => {
  const w = await world();
  const { dir } = await workDirWith({ "registry-lookup": workflowDoc() });
  const candidates = [candidate({ callId: "call-w", type: "workflow", id: "registry-lookup", text: "Use it for a registry quote under the limit.", evidence: [] })];
  const result = await proposeLearning({ runId: "run-2", repo: w.runs, target: targetOf(candidates, w.main), workDir: dir, secrets: [], caseValues: [] });
  assert.equal(result.status, "proposed", JSON.stringify(result));
  const draft = await w.runs.read("workflows/registry-lookup/workflow.json", result.sha);
  assert.ok(draft, "the draft is on the run's branch");
  assert.deepEqual(JSON.parse(draft), workflowDoc());
  assert.match(await w.runs.read("workflows/registry-lookup/README.md", result.sha), /a registry quote under the limit/);
  assert.equal((await w.runs.list("workflows/registry-lookup", result.sha)).length, 2, "no record or latest: those are the host's");
  assert.deepEqual((await checkBranch({ cwd: w.bare, base: "main", head: "runs/run-2", branch: "runs/run-2", tools: TOOLS })).problems, []);
});

test("curate merges a run's branch with a merge commit carrying the verdict, and git revert -m 1 undoes it", async () => {
  const w = await world();
  const tip = await proposed(w);
  const report = await curate({ repo: w.curator, judge, screen: SCREEN, tools: TOOLS, now: new Date("2026-10-27T05:00:00Z") });
  const id = learningId("run-1", LESSON);
  assert.deepEqual(report.runs[0].accepted.map((a) => a.id), [id]);
  const [merge] = await w.curator.log({ ref: "main", max: 1 });
  assert.deepEqual(merge.parents, [w.main, tip], "two parents: the main the run read, then the run");
  assert.match(merge.subject, /^curate: run run-1: 1 accepted/);
  assert.deepEqual(merge.trailers["Curated-Run"], ["run-1"]);
  assert.equal(parseLearning(await w.curator.read(`learnings/${id}.md`, "main")).text, LESSON);
  assert.match(await w.curator.read("memos/run-1.md", "main"), /\n## Review\ncurate: run run-1: 1 accepted/);
  assert.match(await w.curator.read("learnings/INDEX.md", "main"), new RegExp(`^- ${id}: `, "m"));
  const work = path.join(w.root, "work");
  gitIn(w.root, ["clone", "-q", w.bare, work]);
  gitIn(work, ["revert", "--no-edit", "-m", "1", merge.sha]);
  assert.equal(existsSync(path.join(work, "learnings", `${id}.md`)), false, "reverting the merge takes the run's learning back out");
  assert.equal(existsSync(path.join(work, "learnings", `${OLD.id}.md`)), true);
});

test("a checker refusal stops the merge: nothing the run proposed reaches main", async () => {
  const w = await world();
  const tip = await proposed(w);
  const planted = await w.runs.commitTo("runs/run-1", { files: { ".agents/skills/registry-lookup/trial.json": "{}\n" }, message: "plant", trailers: { "Run-Id": "run-1" }, parent: tip });
  await w.runs.push(planted.sha, "runs/run-1");
  const report = await curate({ repo: w.curator, judge, screen: SCREEN, tools: TOOLS });
  const [run] = report.runs;
  assert.deepEqual(run.accepted, []);
  assert.match(run.refused.map((r) => r.reason).join("; "), /the checker refuses the run's branch: host_owned/);
  assert.equal(await w.curator.read(`learnings/${learningId("run-1", LESSON)}.md`, "main"), undefined);
  assert.equal(parseLearning(await w.curator.read(`learnings/${OLD.id}.md`, "main")).uses, 0);
  const [merge] = await w.curator.log({ ref: "main", max: 1 });
  assert.equal(merge.parents.length, 2, "the refusal is still recorded as a merge of the run");
});

test("the injection screen: a score at or over the threshold is refused, and so is an item it could not judge", async () => {
  for (const [screen, reason] of [[async () => 0.75, /injection screen: 0\.75 at or over 0\.75/], [async () => { throw new Error("the judge is down"); }, /injection screen could not judge it/], [async () => "high", /injection screen could not judge it/]]) {
    const w = await world();
    await proposed(w);
    const [run] = (await curate({ repo: w.curator, judge, screen, tools: TOOLS })).runs;
    assert.deepEqual(run.accepted, [], String(reason));
    assert.match(run.refused.map((r) => r.reason).join("; "), reason);
    assert.equal(parseLearning(await w.curator.read(`learnings/${OLD.id}.md`, "main")).uses, 0, "a refused run's used marks do not count");
  }
  const w = await world();
  await proposed(w);
  const [run] = (await curate({ repo: w.curator, judge, screen: async () => 0.9, threshold: 0.95, tools: TOOLS })).runs;
  assert.equal(run.accepted.length, 1, "the host's threshold decides");
});

test("with no injection screen, curate refuses every candidate: no injection screen", async () => {
  const w = await world();
  await proposed(w);
  const [run] = (await curate({ repo: w.curator, judge, tools: TOOLS })).runs;
  assert.deepEqual(run.accepted, []);
  assert.deepEqual(run.refused.map((r) => r.reason), ["no injection screen"]);
});

test("an admitted workflow lands at workflows/<name>/: its records, latest, workflow.json and README.md, beside its trial", async () => {
  const w = await world();
  const { dir, saved } = await workDirWith({ "registry-lookup": workflowDoc() });
  const candidates = [candidate({ callId: "call-w", type: "workflow", id: "registry-lookup", text: "Use it for a registry quote under the limit.", evidence: [] })];
  await proposeLearning({ runId: "run-2", repo: w.runs, target: targetOf(candidates, w.main), workDir: dir, secrets: [], caseValues: [] });
  const report = await curate({ repo: w.curator, judge, screen: SCREEN, tools: TOOLS });
  assert.deepEqual(report.runs[0].accepted.map((a) => a.workflow), ["registry-lookup"]);
  const digest = saved["registry-lookup"];
  const files = (await w.curator.list("workflows/registry-lookup", "main")).map((e) => e.path).sort();
  assert.deepEqual(files, [`workflows/registry-lookup/${digest}.json`, "workflows/registry-lookup/README.md", "workflows/registry-lookup/latest", "workflows/registry-lookup/workflow.json"].sort());
  assert.deepEqual(JSON.parse(await w.curator.read("workflows/registry-lookup/workflow.json", "main")), workflowDoc());
  assert.ok(await w.curator.read(".agents/skills/registry-lookup/trial.json", "main"));
  assert.deepEqual(await w.curator.list(".pi/agentrun/workflows", "main"), [], "nothing is written to the old path");
});

test("an old repository's workflows, at .pi/agentrun/workflows/, are still read and served", async () => {
  const w = await world();
  const { dir, saved } = await workDirWith({ "registry-lookup": workflowDoc() });
  const candidates = [candidate({ callId: "call-w", type: "workflow", id: "registry-lookup", text: "Use it for a registry quote under the limit.", evidence: [] })];
  await proposeLearning({ runId: "run-2", repo: w.runs, target: targetOf(candidates, w.main), workDir: dir, secrets: [], caseValues: [] });
  await curate({ repo: w.curator, judge, screen: SCREEN, tools: TOOLS });
  // The same repository as an old one would hold it: the records moved back under .pi/agentrun/workflows/.
  const digest = saved["registry-lookup"];
  const moved = {};
  assert.ok(await w.curator.read(`workflows/registry-lookup/${digest}.json`, "main"), "curate wrote the record at the new path");
  for (const file of [`${digest}.json`, "latest"]) {
    moved[`.pi/agentrun/workflows/registry-lookup/${file}`] = await w.curator.read(`workflows/registry-lookup/${file}`, "main");
    moved[`workflows/registry-lookup/${file}`] = null;
  }
  moved["workflows/registry-lookup/workflow.json"] = null;
  moved["workflows/registry-lookup/README.md"] = null;
  const { sha } = await w.curator.commitTo("main", { files: moved, message: "an old repository's layout" });
  assert.deepEqual(JSON.parse(JSON.stringify(await readRevision(w.curator, "registry-lookup", digest, sha))), workflowDoc());
  const hints = await workflowsToTry({ repo: w.curator, sha }, { sku: "a-1", amount: 5 });
  assert.deepEqual(hints.map((h) => h.name), ["registry-lookup"]);
  const into = path.join(await scratch(), "run");
  const seeded = await seedWorkflows({ repo: w.curator, sha, into, workflows: hints });
  assert.deepEqual(seeded.loaded, [{ name: "registry-lookup", sha256: digest }]);
});

test("renderLearning is still the note format: a Pi note is valid under the step 1 checker", () => {
  assert.match(renderLearning(OLD), /^---\nid: L-0123456789ab\n/);
});
