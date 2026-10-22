import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { local, openRepo } from "@parcha/pi-git-remote";
import { curate, deriveSeed, inboxPath, learningId, parseLearning, proposeFiles, renderInbox } from "../dist/index.js";
import { agentRepo, learning, learningFiles, scratch } from "./support.mjs";

const DEFAULTS = { general: 0.95, narrowsRules: 0.02, fromContent: 0.02, duplicate: 0.03, supersedes: 0.03, contradicts: 0.03 };

/** A judge answering from a script: the first line whose question, candidate text and existing text match sets p. */
function fakeJudge(script = []) {
  const calls = [];
  const judge = async (params) => {
    calls.push(structuredClone(params));
    const [q] = Object.keys(params.questions);
    const text = params.state.learning?.text ?? params.state.candidate?.text ?? "";
    const existing = params.state.existing?.text;
    const line = script.find((s) => s.q === q && (s.text === undefined || text.includes(s.text)) && (s.existing === undefined || existing?.includes(s.existing)));
    return { answers: { [q]: { type: "noul", noul: line ? line.p : DEFAULTS[q] } }, cost_usd: 0 };
  };
  return { judge, asked: (q) => calls.filter((c) => Object.keys(c.questions)[0] === q) };
}

async function world(files = {}) {
  const root = await scratch();
  const { bare } = await agentRepo(root, files);
  return { runs: await openRepo({ dir: path.join(root, "runs-host"), remote: local(bare) }), curator: await openRepo({ dir: path.join(root, "curator"), remote: local(bare) }) };
}

async function propose(w, runId, texts) {
  const candidates = texts.map((text, i) => ({ callId: `call-${i}`, type: "lesson", text, evidence: [] }));
  const result = await proposeFiles({ repo: w.runs, runId, files: { [inboxPath(runId)]: renderInbox(runId, candidates) }, candidates, secrets: [], caseValues: [] });
  assert.equal(result.status, "proposed", JSON.stringify(result));
}

const FACT = learning("L-f00000000001", "The archived EDGAR company page shows the SEC's assigned SIC code.", { type: "fact" });
const COUNTER = "Archived EDGAR pages are unreachable; do not count on them for the SIC code.";

test("by default a lesson is compared with lessons only: one that contradicts an active fact is accepted, and the fact is never asked about", async () => {
  const w = await world(learningFiles([FACT]));
  await propose(w, "run-1", [COUNTER]);
  const { judge, asked } = fakeJudge([{ q: "contradicts", text: "unreachable", p: 0.9 }]);
  const [run] = (await curate({ repo: w.curator, judge })).runs;
  assert.deepEqual(run.accepted.map((a) => a.id), [learningId("run-1", COUNTER)]);
  assert.equal(asked("contradicts").length, 0);
});

test("with factsOverLessons a lesson that contradicts an active fact is refused, and one the judge is unsure of is held", async () => {
  const w = await world(learningFiles([FACT]));
  await propose(w, "run-1", [COUNTER]);
  const { judge, asked } = fakeJudge([{ q: "contradicts", text: "unreachable", existing: "archived EDGAR company page", p: 0.9 }]);
  const [run] = (await curate({ repo: w.curator, judge, factsOverLessons: true })).runs;
  assert.deepEqual(run.accepted, []);
  assert.deepEqual(run.refused.map((r) => [r.of, r.reason]), [[FACT.id, `contradicts the active fact ${FACT.id} (0.90)`]]);
  assert.equal(asked("contradicts").length, 1);

  const v = await world(learningFiles([FACT]));
  await propose(v, "run-1", [COUNTER]);
  const unsure = fakeJudge([{ q: "contradicts", text: "unreachable", p: 0.4 }]);
  const [held] = (await curate({ repo: v.curator, judge: unsure.judge, factsOverLessons: true })).runs;
  assert.deepEqual(held.held.map((h) => [h.of, h.reason]), [[FACT.id, `unsure whether it contradicts the active fact ${FACT.id} (0.40)`]]);
});

const long = (n) => `Learning ${String(n).padStart(2, "0")}: ${"check the registry's own search before any aggregator, and note which one answered. ".repeat(3)}`.trim();

test("past the index cap a fact is archived by use by default, and never while no more than factFloor facts are active", async () => {
  // Enough learnings to fill the index, the least used of them a fact.
  const all = Array.from({ length: 30 }, (_, n) => learning(`L-${String(n).padStart(12, "0")}`, long(n), { uses: n === 4 ? 0 : 5 + n, ...(n === 4 ? { type: "fact" } : {}) }));
  let k = 1;
  while (deriveSeed("0".repeat(40), all.slice(0, k + 1), { copied: true }).omitted.length === 0) k += 1;
  const seeded = all.slice(0, k);
  const archivedWith = async (options) => {
    const w = await world(learningFiles(seeded));
    await propose(w, "run-1", [long(99)]);
    const [run] = (await curate({ repo: w.curator, judge: fakeJudge().judge, ...options })).runs;
    return run.archived.map((a) => a.id);
  };
  assert.deepEqual(await archivedWith({}), ["L-000000000004"], "today: the unused fact goes first");
  const kept = await archivedWith({ factFloor: 5 });
  assert.equal(kept.length, 1);
  assert.notEqual(kept[0], "L-000000000004", "with a floor above the active facts, a lesson goes instead");
});

test("factFloor is a whole number from 0", async () => {
  const w = await world();
  await assert.rejects(curate({ repo: w.curator, judge: fakeJudge().judge, factFloor: -1 }), { code: "invalid" });
  await assert.rejects(curate({ repo: w.curator, judge: fakeJudge().judge, factFloor: 1.5 }), { code: "invalid" });
});

test("parseLearning keeps a fact a fact", () => {
  assert.equal(parseLearning(learningFiles([FACT])[`learnings/${FACT.id}.md`]).type, "fact");
});
