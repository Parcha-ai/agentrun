// A standing rule for every reply is a note, never a skill: notes are served whole on every run, a skill loads only when a
// job calls for it. The grader judges it (learn/grade.ts GRADE_RUBRIC: a skill that is a standing rule for every reply
// or report is mis-kept), and its verdict re-files such a skill as a note (decision `note`, parseVerdict and skillAsNote:
// `<name>.md`, the skill's description and body, of type feedback), merged in the skill's place (runner/learning-loop.ts
// keptOf, mergeChangeOf), pending when risky. A skill that would be no note is dropped, saying where it belongs. `note`
// is a skill's decision alone. Then a learning run whose faux grader re-files a skill writes the note to the folder, and
// no skill; a note of that name main already holds is never written over, and never fails the run: the same text is no
// change, other text drops that item alone, saying so, and the rest merges.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { GRADE_RUBRIC, gradedItems, gradePrompt, parseVerdict, REFILE_FAILED, skillAsNote, UNREADABLE_REASON } = await import("../dist/learn/grade.js");
const { parseNoteFile } = await import("../dist/learn/notes.js");
const { keptOf, mergeChangeOf } = await import("../dist/runner/learning-loop.js");
const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const { learningWorkspace, readSnapshot } = await import("../dist/learn/folder.js");
const { learningCommit, mainTexts } = await import("../dist/learn/commit.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalEntries } = await import("../dist/runner/journal-reader.js");
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

/** A learning run of run-1, which proposed NOTE and SKILL; its faux grader keeps NOTE and re-files SKILL as a note.
 *  `existing`: a note's text main holds at report-format.md first. Answers its end, the folder's notes and skills after,
 *  and the words its learning ended with. */
async function refileRun(t, { existing } = {}) {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(tmpdir(), "learn-refile-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await agentWithRevision(store);
  await seedOf(data, "agent-1");
  if (existing !== undefined) {
    const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
    try {
      const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file: "report-format.md", text: existing, ifMatch: null });
      assert.equal(made.ok, true, JSON.stringify(made));
    } finally {
      await folder.end();
    }
  }
  const seed = (await seedOf(data, "agent-1")).sha;
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const proposal = { seed, notes: [NOTE], files: [SKILL], asked: ["start every report with STATUS, at most 5 lines, end with Next:"] };
  const kept = { state: "proposed", notes: ["Retries"], skills: ["report-format"], workflows: [], proposal, detail: "Proposed 1 note and 1 skill." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: { answer: "…" }, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const claim = await store.claim("learn-1", "runner-a", { leaseMs: 60_000 });
  const answer = verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", why: "a rule for every report, whatever the job" }]);
  const loop = learningLoopFactory({ store, data, ask: async () => ({ text: answer, usd: 0 }) })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  const end = await loop.start(claim);
  const entries = await journalEntries(store.journal(claim), BACKGROUND_CONTEXT);
  const words = entries.find((entry) => entry.kind === KINDS.learningMerged || entry.kind === KINDS.learningDropped)?.data.detail;
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const snapshot = await readSnapshot(folder.workspace);
    const notes = await mainTexts(folder.workspace, snapshot.notes.map(({ file }) => file));
    return { end, notes, skills: snapshot.skills, words };
  } finally {
    await folder.end();
  }
}

test("a learning run whose grader re-files the skill writes the note to the folder beside the run's other note, and no skill", async (t) => {
  const { end, notes, skills, words } = await refileRun(t);
  assert.deepEqual(end, { state: "ended" });
  assert.deepEqual(Object.keys(notes).sort(), ["report-format.md", "retries.md"], "the rule is a note");
  assert.equal(notes["report-format.md"], skillAsNote(SKILL.file, SKILL.text).text);
  assert.deepEqual(skills, [], "and no skill");
  assert.match(words, /Learned 2 notes/);
});

test("a re-filed rule main already holds the same is no change: dropped as a duplicate, never said, and the run's other note merges", async (t) => {
  const same = skillAsNote(SKILL.file, SKILL.text).text;
  const { end, notes, skills, words } = await refileRun(t, { existing: same });
  assert.deepEqual(end, { state: "ended" }, "the run never fails on it");
  assert.equal(notes["report-format.md"], same, "main's note as it was");
  assert.ok(notes["retries.md"], "the run's other note merged");
  assert.deepEqual(skills, []);
  assert.equal(words, "Learned: Retries", "nothing said of the duplicate");
});

test("a re-filed rule whose note name main holds with other text is dropped alone, saying so; main's note stands and the run's other note merges", async (t) => {
  const other = "---\nname: Report format\ndescription: How a report is laid out\ntype: feedback\n---\nOpen every report with a summary line.\n";
  const { end, notes, skills, words } = await refileRun(t, { existing: other });
  assert.deepEqual(end, { state: "ended" }, "the run never fails on it");
  assert.equal(notes["report-format.md"], other, "never written over");
  assert.ok(notes["retries.md"], "the run's other note merged");
  assert.deepEqual(skills, []);
  assert.match(words, /^Learned: Retries\. Not kept: A note named report-format exists; the rule wasn't kept\.$/);
});
