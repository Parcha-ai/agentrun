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
const { keptOf, mergeChangeOf, NOTE_NAME_TAKEN, SAME_NOTE, takenOnMain } = await import("../dist/runner/learning-loop.js");
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
async function refileRun(t, { existing, race = {}, notes: runNotes = [NOTE], files = [SKILL], answer: given } = {}) {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(tmpdir(), "learn-refile-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await agentWithRevision(store);
  await seedOf(data, "agent-1");
  /** Each of `notes` (file to text) committed on main, as a person or another run's merge lands it. */
  const land = async (notes) => {
    for (const [file, text] of Object.entries(notes)) {
      const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
      try {
        const made = await learningCommit(folder.workspace, { kind: "person", action: "created", file, text, ifMatch: null });
        assert.equal(made.ok, true, JSON.stringify(made));
      } finally {
        await folder.end();
      }
    }
  };
  await land(typeof existing === "string" ? { "report-format.md": existing } : (existing ?? {}));
  const seed = (await seedOf(data, "agent-1")).sha;
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const proposal = { seed, notes: runNotes, files, asked: ["start every report with STATUS, at most 5 lines, end with Next:"] };
  const kept = { state: "proposed", notes: runNotes.map(({ file }) => file), skills: files.map(({ file }) => file.split("/")[1]), workflows: [], proposal, detail: "Proposed." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: { answer: "…" }, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const claim = await store.claim("learn-1", "runner-a", { leaseMs: 60_000 });
  const answer = given ?? verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", why: "a rule for every report, whatever the job" }]);
  // `race`: notes another run merges while this one is graded, after its read of main and before its merge.
  const loop = learningLoopFactory({ store, data, ask: async () => (await land(race), { text: answer, usd: 0 }) })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
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
  assert.match(words, /^Learned: Retries\. Not kept: A note named report-format was added since this run started, or was there already; this one wasn't kept\.$/);
});

/** A run's new note named like one another run merged meanwhile: check-units.md, with `body`. */
const UNITS = (body, extra = "") => ({ file: "check-units.md", text: `---\nname: Check units\ndescription: Convert amounts to one unit first\ntype: feedback\n${extra}---\n${body}\n` });
const KEEP_BOTH = (files) => verdictOf(files.map((file) => ({ file, decision: "keep", why: "useful" })));

test("a new note another run merged meanwhile by the same name and text is no change: dropped unsaid, and the run's other note merges", async (t) => {
  const units = UNITS("Convert every amount to cents before comparing.");
  const { end, notes, words } = await refileRun(t, { race: { [units.file]: units.text }, notes: [units, NOTE], files: [], answer: KEEP_BOTH([units.file, NOTE.file]) });
  assert.deepEqual(end, { state: "ended" }, "never a failed learning run");
  assert.equal(notes[units.file], units.text);
  assert.ok(notes["retries.md"], "the other note merged");
  assert.equal(words, "Learned: Retries");
});

test("a new note whose name another run merged meanwhile with other text is dropped alone, saying so; main's note stands and the run's other note merges", async (t) => {
  const theirs = UNITS("Convert every amount to cents before comparing.");
  const ours = UNITS("Convert every amount to dollars before comparing.");
  const { end, notes, words } = await refileRun(t, { race: { [theirs.file]: theirs.text }, notes: [ours, NOTE], files: [], answer: KEEP_BOTH([ours.file, NOTE.file]) });
  assert.deepEqual(end, { state: "ended" }, "never a failed learning run");
  assert.equal(notes[theirs.file], theirs.text, "never written over");
  assert.ok(notes["retries.md"], "the other note merged");
  assert.match(words, /^Learned: Retries\. Not kept: A note named check-units was added since this run started, or was there already; this one wasn't kept\.$/);
});

test("takenOnMain and the merge: a kept note that supersedes the note of its own name, which main holds, is a modification written over it; one that does not is dropped alone; the same text is dropped unsaid", async (t) => {
  const theirs = UNITS("Convert every amount to cents before comparing.");
  const ours = UNITS("Convert every amount to cents, rounding half up, before comparing.", "supersedes: [check-units.md]\n");
  const verdict = parseVerdict(KEEP_BOTH([ours.file, NOTE.file]), [ours, NOTE]);
  const settled = takenOnMain({ notes: [ours, NOTE] }, verdict, { [ours.file]: theirs.text });
  assert.deepEqual([settled.verdict.merge, settled.replace, settled.verdict.items.map((item) => item.keep)], [true, [ours.file], [true, true]]);
  const other = takenOnMain({ notes: [UNITS("Dollars."), NOTE] }, parseVerdict(KEEP_BOTH([ours.file, NOTE.file]), [UNITS("Dollars."), NOTE]), { [ours.file]: theirs.text });
  assert.deepEqual([other.replace, other.verdict.items.map((item) => item.keep), other.verdict.items[0].why], [[], [false, true], NOTE_NAME_TAKEN("check-units")]);
  const same = takenOnMain({ notes: [theirs, NOTE] }, parseVerdict(KEEP_BOTH([theirs.file, NOTE.file]), [theirs, NOTE]), { [theirs.file]: theirs.text });
  assert.equal(same.verdict.items[0].why, SAME_NOTE);
  // The merge takes it as a modification: written over main's note, never refused as exists.
  const data = mkdtempSync(join(tmpdir(), "learn-refile-replace-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await seedOf(data, "agent-1");
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    assert.equal((await learningCommit(folder.workspace, { kind: "person", action: "created", file: theirs.file, text: theirs.text, ifMatch: null })).ok, true);
    const change = mergeChangeOf("run-9", keptOf({ seed: "s", notes: [ours, NOTE], files: [] }, settled.verdict), settled.verdict, settled.graded);
    const merged = await learningCommit(folder.workspace, { ...change, replace: settled.replace });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.match((await mainTexts(folder.workspace, [ours.file]))[ours.file], /rounding half up/);
  } finally {
    await folder.end();
  }
});
