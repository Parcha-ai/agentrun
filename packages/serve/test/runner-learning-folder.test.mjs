// The learning run's merge on the agent's own learning folder: runner/learning-factory.ts with the folder's API
// (learn/folder.ts learningWorkspace, learn/commit.ts readMain and learningCommit), the grader alone faked. The merge is
// the one the server's grade made (grade.ts mergeProposal): it carries the source run's seed, so a skill a person changed
// on main after the run started is a conflict in the script's words and nothing is written over it; a note the grader
// says came from the user's own words lands on main with `origin: you`; and a draft the grader holds waits on main by
// its README (its workflow.json is held by it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";
import { DRAFT_PATH, README_PATH, readme, workflow } from "./learn-format-support.mjs";

const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalEntries } = await import("../dist/runner/journal-reader.js");
const { learningWorkspace, readSnapshot } = await import("../dist/learn/folder.js");
const { learningCommit } = await import("../dist/learn/commit.js");
const { retiredLearned } = await import("../dist/learn/index.js");

const note = (name, description) => `---\nname: ${name}\ndescription: ${description}\ntype: reference\n---\n${name}, in a sentence.\n`;
const UNITS = { file: "check-units.md", text: note("Check units", "Convert every amount to one unit before comparing") };
const SKILL_PATH = "skills/weekly-report/SKILL.md";
const SKILL = "---\nname: weekly-report\ndescription: How the weekly report is laid out\n---\nSteps.\n";
const text = (bytes) => Buffer.from(bytes).toString("utf8");
const answer = (items) => JSON.stringify({ merge: true, reason: "Worth keeping.", items: items.map((item) => ({ why: "General.", ...item })) });

/** `fn` on agent-1's learning folder in `data`, opened as the factory opens it, and ended after. */
async function inFolder(data, fn) {
  const { workspace, end } = learningWorkspace({ mode: "local", agentId: "agent-1", data });
  try {
    return await fn(workspace);
  } finally {
    await end();
  }
}

/** The store, with agent-1, and its data directory: where the agent's learning folder is. */
async function setUp(t) {
  const { store, dir } = await storeOn(t);
  await agentWithRevision(store);
  return { store, data: dir };
}

/** Run run-1 ended keeping `proposal`; its learning run claimed and run by the factory's loop on the folder in `data`,
 *  the grader answering `graded`. The loop's end, and the learning run's journal entries. */
async function learn(store, data, proposal, graded) {
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const kept = { state: "proposed", notes: [], skills: [], workflows: [], proposal, detail: "Proposed." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: { answer: "…" }, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const claim = await store.claim("learn-1", "runner-b", { leaseMs: 60_000 });
  const factory = learningLoopFactory({ store, data, ask: async () => ({ text: graded, usd: 0.01 }) });
  const end = await factory({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal }).start(claim);
  const entries = await journalEntries(store.journal(claim), BACKGROUND_CONTEXT);
  return { end, entries };
}

const shown = (entries) => JSON.stringify(entries.map((entry) => [entry.kind, entry.data]));

test("the merge carries the run's seed: a skill a person changed on main after the run started is a conflict in the script's words, dropped as stale, nothing written", async (t) => {
  const { store, data } = await setUp(t);
  const { seed, before } = await inFolder(data, async (ws) => {
    const made = await learningCommit(ws, { kind: "merge", runId: "run-0", reason: "A skill.", files: [{ path: SKILL_PATH, text: SKILL }], graded: {} });
    assert.equal(made.ok, true, JSON.stringify(made));
    const oid = (await readSnapshot(ws)).skills[0].oid;
    const retired = await learningCommit(ws, { kind: "person", action: "retired", file: SKILL_PATH, text: retiredLearned(SKILL), ifMatch: oid });
    assert.equal(retired.ok, true, JSON.stringify(retired));
    return { seed: made.main, before: await readSnapshot(ws) };
  });
  const proposal = { seed, notes: [UNITS], files: [{ file: SKILL_PATH, text: SKILL.replace("Steps.", "Better steps.") }] };
  const { end, entries } = await learn(store, data, proposal, answer([{ file: UNITS.file, decision: "keep" }, { file: SKILL_PATH, decision: "keep" }]));
  assert.deepEqual(end, { state: "ended" });
  const dropped = entries.filter((entry) => entry.kind === KINDS.learningDropped).map((entry) => [entry.data.reason, entry.data.problems]);
  assert.deepEqual(dropped, [["stale", [{ rule: "supersedes", path: SKILL_PATH, detail: `${SKILL_PATH} changed on main after the run started` }]]], shown(entries));
  assert.deepEqual(await inFolder(data, (ws) => readSnapshot(ws)), before, "main as the person left it");
});

test("a note the grader says came from the user's own words lands on main with origin: you; one the run worked out carries none", async (t) => {
  const { store, data } = await setUp(t);
  const TABLES = { file: "prefers-tables.md", text: note("Prefers tables", "Answer with a table when comparing") };
  const proposal = { notes: [UNITS, TABLES], asked: ["answer with a table when you compare"] };
  const { end, entries } = await learn(store, data, proposal, answer([{ file: UNITS.file, decision: "keep", origin: "run" }, { file: TABLES.file, decision: "keep", origin: "you" }]));
  assert.deepEqual(end, { state: "ended" });
  assert.equal(entries.filter((entry) => entry.kind === KINDS.learningMerged).length, 1, shown(entries));
  const { tables, units, snapshot } = await inFolder(data, async (ws) => ({ tables: text(await ws.read(TABLES.file)), units: text(await ws.read(UNITS.file)), snapshot: await readSnapshot(ws) }));
  assert.match(tables, /^origin: you$/m, "the user's own words");
  assert.doesNotMatch(units, /^origin:/m, "a run's own note names none, which reads as run");
  assert.deepEqual(snapshot.notes.map((one) => [one.file, one.origin]).sort(), [["check-units.md", "run"], ["prefers-tables.md", "you"]]);
});

test("a draft the grader holds waits on main by its README (status: pending); its workflow.json is as the run wrote it", async (t) => {
  const { store, data } = await setUp(t);
  const draft = workflow();
  const proposal = { notes: [UNITS], files: [{ file: DRAFT_PATH, text: draft }, { file: README_PATH, text: readme }] };
  const { end, entries } = await learn(store, data, proposal, answer([{ file: UNITS.file, decision: "keep" }, { file: DRAFT_PATH, decision: "pending" }]));
  assert.deepEqual(end, { state: "ended" });
  assert.equal(entries.filter((entry) => entry.kind === KINDS.learningMerged).length, 1, shown(entries));
  const { held, json, snapshot } = await inFolder(data, async (ws) => ({ held: text(await ws.read(README_PATH)), json: text(await ws.read(DRAFT_PATH)), snapshot: await readSnapshot(ws) }));
  assert.match(held, /^status: pending$/m, "the README holds the draft for its owner's OK");
  assert.equal(json, draft);
  assert.deepEqual(snapshot.workflows.map((one) => [one.name, one.status]), [["find-policies", "pending"]]);
});
