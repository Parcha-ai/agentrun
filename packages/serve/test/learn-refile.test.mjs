// A standing rule for every reply is a note, never a skill: notes are served whole on every run, a skill loads only when a
// job calls for it. The grader judges it (learn/grade.ts GRADE_RUBRIC: a skill that is a standing rule for every reply
// or report is mis-kept), and its verdict re-files such a skill as a note (decision `note`, parseVerdict and skillAsNote:
// `<name>.md`, the skill's description and body, of type feedback), merged in the skill's place (runner/learning-loop.ts
// keptOf, mergeChangeOf), pending when risky. A skill that would be no note is dropped, saying where it belongs. `note`
// is a skill's decision alone. Then a learning run whose faux grader re-files a skill writes the note to the folder, and
// no skill.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { GRADE_RUBRIC, gradedItems, gradePrompt, parseVerdict, REFILE_FAILED, skillAsNote, UNREADABLE_REASON } = await import("../dist/learn/grade.js");
const { parseNoteFile } = await import("../dist/learn/notes.js");
const { keptOf, mergeChangeOf } = await import("../dist/runner/learning-loop.js");
const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const { learningWorkspace, readSnapshot } = await import("../dist/learn/folder.js");
const { seedOf } = await import("../dist/learning.js");

/** The QA finding: a rule for every report, written as a skill. */
const SKILL = { file: "skills/report-format/SKILL.md", text: "---\nname: report-format\ndescription: How every report is laid out\n---\nStart every report with STATUS, at most 5 lines, and end it with Next:.\n" };
const NOTE = { file: "retries.md", text: "---\nname: Retries\ndescription: Retry a flaky fetch twice\ntype: feedback\n---\nRetry a flaky fetch twice.\n" };
const verdictOf = (items, merge = true) => JSON.stringify({ merge, reason: "Worth keeping.", items });

test("the rubric names a standing rule for every reply as mis-kept as a skill, and re-filed as a note; the prompt offers the note decision", () => {
  const flat = GRADE_RUBRIC.replace(/\s+/g, " ");
  assert.match(flat, /Is a skill a standing rule for every reply or every report, whatever the job, rather than the steps of one kind of job\? It is mis-kept as a skill/);
  assert.match(flat, /re-file it as a note, which every later run reads/);
  const prompt = gradePrompt({ run: "run-1", instructions: "Report on the week.", active: [], superseded: [], proposed: [NOTE], files: [SKILL], asked: [] });
  assert.match(prompt, /"decision": "keep", "pending", "note" or "drop"/);
  assert.match(prompt, /note, for a skill alone, re-files it as a note/);
});

test("a skill re-filed as a note: the note is <name>.md, the skill's description and body, of type feedback", () => {
  const note = skillAsNote(SKILL.file, SKILL.text);
  assert.equal(note.file, "report-format.md");
  const parsed = parseNoteFile(note.file, note.text);
  assert.ok(!Array.isArray(parsed), JSON.stringify(parsed));
  assert.deepEqual([parsed.name, parsed.description, parsed.type, parsed.body.trim()], ["Report format", "How every report is laid out", "feedback", "Start every report with STATUS, at most 5 lines, and end it with Next:."]);
  assert.equal(skillAsNote(SKILL.file, "---\nname: report-format\n---\nNo description.\n"), undefined, "no description, no note");
  assert.equal(skillAsNote("workflows/report/workflow.json", "{}"), undefined, "a skill's alone");
});

test("parseVerdict: a skill's decision note keeps it as that note, pending when Risky; note on any other item is no merge; one that would be no note is dropped, saying it belongs in a note", () => {
  const items = gradedItems([NOTE], [SKILL]);
  const refiled = parseVerdict(verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", origin: "you", why: "a rule for every report" }]), items);
  assert.equal(refiled.merge, true);
  const item = refiled.items.find(({ file }) => file === SKILL.file);
  assert.deepEqual([item.keep, item.pending, item.origin, item.note?.file], [true, undefined, "you", "report-format.md"]);
  const held = parseVerdict(verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", question: "Risky", why: "a rule for every report" }]), items);
  assert.equal(held.items.find(({ file }) => file === SKILL.file).pending, true);
  const onNote = parseVerdict(verdictOf([{ file: NOTE.file, decision: "note", why: "x" }, { file: SKILL.file, decision: "keep", why: "y" }]), items);
  assert.deepEqual([onNote.merge, onNote.reason], [false, UNREADABLE_REASON]);
  const bare = { file: SKILL.file, text: "---\nname: report-format\ndescription: \n---\nStart every report with STATUS.\n" };
  const failed = parseVerdict(verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", why: "a rule for every report" }]), gradedItems([NOTE], [bare]));
  const dropped = failed.items.find(({ file }) => file === SKILL.file);
  assert.deepEqual([dropped.keep, dropped.why, dropped.note], [false, REFILE_FAILED, undefined]);
  assert.equal(failed.merge, true, "the note it kept still merges");
});

test("keptOf and mergeChangeOf: a re-filed skill merges as its note, held when pending, with its item's origin; the skill is not merged", () => {
  const proposal = { seed: "s1", notes: [NOTE], files: [SKILL] };
  const verdict = parseVerdict(verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", origin: "you", question: "Risky", why: "a rule for every report" }]), gradedItems([NOTE], [SKILL]));
  const merging = keptOf(proposal, verdict);
  assert.deepEqual(merging.notes.map(({ file }) => file), ["retries.md", "report-format.md"]);
  assert.deepEqual(merging.files, []);
  const change = mergeChangeOf("run-1", merging, verdict, {});
  assert.deepEqual(change.files.map(({ path }) => path), ["retries.md", "report-format.md"]);
  assert.deepEqual(change.held, ["report-format.md"]);
  assert.match(change.files[1].text, /^origin: you$/m, "the user's own words");
});

test("a learning run whose grader re-files the skill writes the note to the folder, and no skill", async (t) => {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(tmpdir(), "learn-refile-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await agentWithRevision(store);
  const seed = (await seedOf(data, "agent-1")).sha;
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const proposal = { seed, notes: [], files: [SKILL], asked: ["start every report with STATUS, at most 5 lines, end with Next:"] };
  const kept = { state: "proposed", notes: [], skills: ["report-format"], workflows: [], proposal, detail: "Proposed 1 skill." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: { answer: "…" }, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const claim = await store.claim("learn-1", "runner-a", { leaseMs: 60_000 });
  const answer = verdictOf([{ file: SKILL.file, decision: "note", origin: "you", why: "a rule for every report, whatever the job" }]);
  const loop = learningLoopFactory({ store, data, ask: async () => ({ text: answer, usd: 0 }) })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  assert.deepEqual(await loop.start(claim), { state: "ended" });
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const snapshot = await readSnapshot(folder.workspace);
    assert.deepEqual(snapshot.notes.map(({ file, status }) => [file, status]), [["report-format.md", "active"]], "the rule is a note");
    assert.deepEqual(snapshot.skills, [], "and no skill");
  } finally {
    await folder.end();
  }
});
