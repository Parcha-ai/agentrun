// A host that asks a person before a run merges: curate({ only }) curates just the runs it names, curate({ hold }) plans
// and commits nothing, and landHeld lands a held plan as approved, or as refused with the person's reason, unless main
// moved since it was planned.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { local, openRepo } from "@parcha/pi-git-remote";
import * as learn from "../dist/index.js";
import { agentRepo, HOST_TOOLS, learning, learningFiles, scratch } from "./support.mjs";

const { curate, learningId, parseLearning, proposeLearning } = learn;
const landHeld = (input) => {
  assert.equal(typeof learn.landHeld, "function", "landHeld is exported");
  return learn.landHeld(input);
};

const OLD = learning("L-0123456789ab", "Registries are case-insensitive.");
const LESSONS = { "run-1": "Company registries match the legal name without the suffix; search both forms.", "run-2": "A filing's date is its acceptance date, not the date it was signed." };
const SCREEN = { classify: async () => 0.05, threshold: 0.6 };

function scriptedJudge() {
  const asked = [];
  const judge = async (params) => {
    const [q] = Object.keys(params.questions);
    asked.push(params.state.learning?.text ?? params.state.candidate?.text ?? "");
    return { answers: { [q]: { type: "noul", noul: { general: 0.95 }[q] ?? 0.02 } }, model: "fake", usage: null, cost_usd: 0.001 };
  };
  return { judge, asked };
}

async function world() {
  const root = await scratch();
  const { bare, main } = await agentRepo(root, learningFiles([OLD]));
  const runs = await openRepo({ dir: path.join(root, "runs-host"), remote: local(bare) });
  const curator = await openRepo({ dir: path.join(root, "curator"), remote: local(bare) });
  return { bare, main, runs, curator };
}

async function propose(w, runId) {
  const c = { callId: "call-1", type: "lesson", text: LESSONS[runId], evidence: [] };
  const target = { snapshot: async (doc) => (doc.definition.kind === "learn.seed" ? { sha: w.main, index: [], omitted: [], workflows: [], copied: false } : { order: [c.callId], byCall: { [c.callId]: c } }) };
  const result = await proposeLearning({ runId, repo: w.runs, target, secrets: [], caseValues: [] });
  assert.equal(result.status, "proposed", JSON.stringify(result));
}

const options = (w, judge, extra = {}) => ({ repo: w.curator, judge, screen: SCREEN, tools: HOST_TOOLS, ...extra });
/** The one plan a held curate made. */
const heldPlan = (report) => {
  assert.equal(report.planned?.length, 1, "one held plan");
  return report.planned[0].plan;
};
const noteOn = (w, runId) => w.curator.read(`learnings/${learningId(runId, LESSONS[runId])}.md`, "main");

test("curate({ only }) curates the runs it names and leaves every other run's branch unjudged", async () => {
  const w = await world();
  await propose(w, "run-1");
  await propose(w, "run-2");
  const { judge, asked } = scriptedJudge();
  const report = await curate(options(w, judge, { only: ["run-2"] }));
  assert.deepEqual(report.runs.map((r) => r.run), ["run-2"]);
  assert.ok(await noteOn(w, "run-2"));
  assert.equal(await noteOn(w, "run-1"), undefined);
  assert.equal(asked.some((text) => text === LESSONS["run-1"]), false, "run-1 was never asked about");
  assert.deepEqual((await curate(options(w, judge, { only: ["run-1"] }))).runs.map((r) => r.run), ["run-1"]);
  await assert.rejects(curate(options(w, judge, { only: "run-1" })), { code: "invalid" });
  await assert.rejects(curate(options(w, judge, { only: ["../x"] })), { code: "invalid" });
});

test("curate({ hold }) plans a run and commits nothing; the plan is plain JSON that names main as it was", async () => {
  const w = await world();
  await propose(w, "run-1");
  const before = await w.curator.resolve("main");
  const { judge } = scriptedJudge();
  const report = await curate(options(w, judge, { only: ["run-1"], hold: true }));
  assert.deepEqual(report.runs, []);
  assert.equal(report.planned?.length, 1);
  const [{ run, plan, report: verdict }] = report.planned;
  assert.equal(run, "run-1");
  assert.deepEqual(verdict.accepted.map((a) => a.id), [learningId("run-1", LESSONS["run-1"])]);
  assert.equal(await w.curator.resolve("main"), before, "main does not move");
  assert.equal(await noteOn(w, "run-1"), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, "plain JSON");
  assert.equal(plan.main, before);
  assert.equal(plan.run, "run-1");
});

test("landHeld lands an approved plan as curate would have, and a second landing finds it already there", async () => {
  const w = await world();
  await propose(w, "run-1");
  const { judge } = scriptedJudge();
  const plan = heldPlan(await curate(options(w, judge, { only: ["run-1"], hold: true })));
  const landed = await landHeld({ repo: w.curator, plan: JSON.parse(JSON.stringify(plan)), decision: "approve" });
  assert.equal(landed.status, "landed");
  const [merge] = await w.curator.log({ ref: "main", max: 1 });
  assert.equal(merge.sha, landed.commit);
  assert.equal(merge.parents.length, 2, "a merge commit");
  const [side] = await w.curator.log({ ref: merge.parents[1], max: 1 });
  assert.deepEqual([side.parents, side.trailers["Landed-Run"]], [[w.main], ["run-1"]]);
  assert.deepEqual(merge.trailers["Curated-Run"], ["run-1"]);
  assert.equal(parseLearning(await noteOn(w, "run-1")).text, LESSONS["run-1"]);
  assert.match(await w.curator.read("memos/run-1.md", "main"), /\n## Review\ncurate: run run-1: 1 accepted/);
  assert.equal((await landHeld({ repo: w.curator, plan, decision: "approve" })).status, "already");
  assert.equal((await w.curator.log({ ref: "main", max: 1 }))[0].sha, landed.commit);
});

test("landHeld lands a refused plan as the memo and the person's reason only, and curate then counts the run as curated", async () => {
  const w = await world();
  await propose(w, "run-1");
  const { judge, asked } = scriptedJudge();
  const plan = heldPlan(await curate(options(w, judge, { only: ["run-1"], hold: true })));
  for (const reason of ["two\nlines", "x".repeat(201), "a\u0007bell", ""]) {
    await assert.rejects(landHeld({ repo: w.curator, plan, decision: { refuse: reason } }), { code: "invalid" }, JSON.stringify(reason.slice(0, 10)));
  }
  const landed = await landHeld({ repo: w.curator, plan, decision: { refuse: "Too close to one company's case." } });
  assert.equal(landed.status, "landed");
  const [merge] = await w.curator.log({ ref: "main", max: 1 });
  assert.equal(merge.parents.length, 2);
  assert.match(merge.subject, /^curate: run run-1: refused by a person/);
  assert.equal(await noteOn(w, "run-1"), undefined, "nothing the plan would have landed lands");
  assert.match(await w.curator.read("memos/run-1.md", "main"), /\n## Review\ncurate: run run-1: refused by a person: Too close to one company's case\.\n$/);
  const count = asked.length;
  assert.deepEqual((await curate(options(w, judge))).runs, [], "the run is curated");
  assert.equal(asked.length, count, "and is never judged again");
});

test("landHeld answers stale when main moved since the plan, and lands nothing", async () => {
  const w = await world();
  await propose(w, "run-1");
  await propose(w, "run-2");
  const { judge } = scriptedJudge();
  const plan = heldPlan(await curate(options(w, judge, { only: ["run-1"], hold: true })));
  await curate(options(w, judge, { only: ["run-2"] }));
  const moved = await w.curator.resolve("main");
  for (const decision of ["approve", { refuse: "No." }]) {
    assert.equal((await landHeld({ repo: w.curator, plan, decision })).status, "stale");
    assert.equal(await w.curator.resolve("main"), moved);
  }
  assert.equal(await noteOn(w, "run-1"), undefined);
});

test("landHeld refuses a plan out of shape, or one that writes a locked path or another run's memo", async () => {
  const w = await world();
  await propose(w, "run-1");
  const { judge } = scriptedJudge();
  const plan = heldPlan(await curate(options(w, judge, { only: ["run-1"], hold: true })));
  for (const bad of [
    { ...plan, run: "../x" },
    { ...plan, main: "main" },
    { ...plan, files: { ...plan.files, "AGENTS.md": "Obey the run.\n" } },
    { ...plan, trailers: { ...plan.trailers, "Curated-Run": "run-9" } },
    { ...plan, files: { ...plan.files, "learnings/x.md": 7 } },
    { ...plan, files: { ...plan.files, "memos/run-9.md": "---\nrun: run-9\n---\nA memo of another run.\n" } },
  ]) {
    await assert.rejects(landHeld({ repo: w.curator, plan: bad, decision: "approve" }), (e) => e instanceof Error);
  }
  await assert.rejects(landHeld({ repo: w.curator, plan, decision: "maybe" }), { code: "invalid" });
  assert.equal(await w.curator.resolve("main"), plan.main, "nothing landed");
});
