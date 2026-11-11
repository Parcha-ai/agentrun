// A standing rule for every reply is a note, never a skill: notes are served whole on every run, a skill loads only when a
// job calls for it. The grader judges it (learn/grade.ts GRADE_RUBRIC: a skill that is a standing rule for every reply
// or report is mis-kept), and its verdict re-files such a skill as a note (decision `note`, parseVerdict and skillAsNote:
// `<name>.md`, the skill's description and body, of type feedback), merged in the skill's place (runner/learning-loop.ts
// keptOf, mergeChangeOf), pending when risky. A skill that would be no note is dropped, saying where it belongs. `note`
// is a skill's decision alone. Then a learning run whose faux grader re-files a skill writes the note to the folder, and
// no skill; a note of that name main already holds is never written over, and never fails the run: the same text is no
// change, other text drops that item alone, saying so, and the rest merges. One copy of each rule: a new note whose body
// is exactly an active note's (whitespace and case aside), under another name, is a duplicate, at the checks and at the
// merge; of two new notes the same, the first is kept.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { GRADE_RUBRIC, gradedItems, gradePrompt, NOTES_FULL, parseVerdict, REFILE_FAILED, skillAsNote, UNREADABLE_REASON } = await import("../dist/learn/grade.js");
const { parseNoteFile, ruleOf } = await import("../dist/learn/notes.js");
const { checkProposal } = await import("../dist/learn/check.js");
const { keptOf, mergeChangeOf, NOTE_NAME_TAKEN, takenOnMain } = await import("../dist/runner/learning-loop.js");
const { SAME_NOTE, wordsOf } = await import("../dist/learning-words.js");
const { learningLoopFactory } = await import("../dist/runner/learning-factory.js");
const { learningWorkspace, readSnapshot } = await import("../dist/learn/folder.js");
const { learningCommit, mainTexts } = await import("../dist/learn/commit.js");
const { CAPS } = await import("../dist/learn/check.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const { journalEntries } = await import("../dist/runner/journal-reader.js");
const { seedOf } = await import("../dist/learning.js");
const { runLearningEnd } = await import("../dist/store-reads/learning.js");

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
async function refileRun(t, { existing, skill, committed, race = {}, notes: runNotes = [NOTE], files = [SKILL], answer: given } = {}) {
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
  // `skill`: a skill's SKILL.md main holds first, as an earlier run's merge landed it.
  if (skill) {
    const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
    try {
      const made = await learningCommit(folder.workspace, { kind: "merge", runId: "run-old", reason: "learned a skill", graded: {}, files: [{ path: skill.file, text: skill.text }] });
      assert.equal(made.ok, true, JSON.stringify(made));
    } finally {
      await folder.end();
    }
  }
  const seed = (await seedOf(data, "agent-1")).sha;
  // `committed`: run-1's merge landing on main while it is graded (these files), as a learning run that committed and
  // went down before it recorded its end leaves it for its resume: graded, and its own merge already on main.
  const commitFirst = async () => {
    if (!committed) return;
    const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
    try {
      const made = await learningCommit(folder.workspace, { kind: "merge", runId: "run-1", reason: "first attempt", graded: {}, files: committed });
      assert.equal(made.ok, true, JSON.stringify(made));
    } finally {
      await folder.end();
    }
  };
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const source = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  const proposal = { seed, notes: runNotes, files, asked: ["start every report with STATUS, at most 5 lines, end with Next:"] };
  const kept = { state: "proposed", notes: runNotes.map(({ file }) => file), skills: files.map(({ file }) => file.split("/")[1]), workflows: [], proposal, detail: "Proposed." };
  await store.runs.update(source, { state: "ended" }, { also: [{ table: "learning_proposals", row: { turn: { answer: "…" }, proposal: kept } }, { table: "learning_run", row: { id: "learn-1" } }] });
  const claim = await store.claim("learn-1", "runner-a", { leaseMs: 60_000 });
  const answer = given ?? verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", why: "a rule for every report, whatever the job" }]);
  // `race`: notes another run merges while this one is graded, after its read of main and before its merge.
  const loop = learningLoopFactory({ refuse: async () => [], store, data, ask: async () => (await land(race), await commitFirst(), { text: answer, usd: 0 }) })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  const end = await loop.start(claim);
  const entries = await journalEntries(store.journal(claim), BACKGROUND_CONTEXT);
  const words = entries.find((entry) => entry.kind === KINDS.learningMerged || entry.kind === KINDS.learningDropped)?.data.detail;
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const snapshot = await readSnapshot(folder.workspace);
    const notes = await mainTexts(folder.workspace, snapshot.notes.map(({ file }) => file));
    return { end, notes, skills: snapshot.skills, words, learning: await runLearningEnd(store, "run-1") };
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

/** A note named `name` (its file `<slug>.md`) whose body is `body`. */
const noteNamed = (slug, name, body, extra = "") => ({ file: `${slug}.md`, text: `---\nname: ${name}\ndescription: ${name}, as a rule\ntype: feedback\n${extra}---\n${body}\n` });

test("ruleOf: a note's rule is its body alone, whitespace and case set aside; nothing near is the same", () => {
  assert.equal(ruleOf("Convert every amount\n to   CENTS first."), ruleOf("convert every amount to cents first."));
  assert.notEqual(ruleOf("Convert every amount to cents first."), ruleOf("Convert every amount to cents, first."));
});

test("the checks: a new note whose rule an active note of the seed holds, under another name, is a duplicate; of two new notes the same, the first passes; one that supersedes the note it repeats is no duplicate", () => {
  const active = noteNamed("units", "Units", "Convert every amount to cents first.");
  const base = { files: ["MEMORY.md", active.file], active: [parseNoteFile(active.file, active.text)], rules: new Map([[ruleOf("Convert every amount to cents first."), active.file]]) };
  const change = ({ file, text }) => ({ path: file, status: "added", mode: "100644", bytes: Buffer.from(text) });
  const again = noteNamed("check-units", "Check units", "convert every amount  to CENTS first.");
  const one = checkProposal({ base, changes: [change(again)] });
  assert.deepEqual(one.problems.map(({ rule, path, detail }) => [rule, path, detail]), [["duplicate", again.file, "it says what units.md says"]]);
  const first = noteNamed("first", "First", "Retry a flaky fetch twice.");
  const second = noteNamed("second", "Second", "retry a flaky fetch twice.");
  const two = checkProposal({ base, changes: [change(first), change(second)] });
  assert.deepEqual(two.problems.map(({ rule, path }) => [rule, path]), [["duplicate", second.file]]);
  const update = noteNamed("units-v2", "Units", "Convert every amount to cents first.", "supersedes: [units.md]\n");
  assert.deepEqual(checkProposal({ base, changes: [change(update)] }).problems, []);
});

test("the merge: a kept note whose rule main's active note holds under another name is dropped unsaid, and the run's other note merges", async (t) => {
  const units = noteNamed("units", "Units", "Convert every amount to cents first.");
  const again = noteNamed("check-units", "Check units", "convert every amount  to CENTS first.");
  const { end, notes, words } = await refileRun(t, { existing: { [units.file]: units.text }, notes: [again, NOTE], files: [], answer: KEEP_BOTH([again.file, NOTE.file]) });
  assert.deepEqual(end, { state: "ended" });
  assert.equal(notes[again.file], undefined, "not kept under its other name");
  assert.equal(notes[units.file], units.text);
  assert.ok(notes["retries.md"], "the other note merged");
  assert.equal(words, "Learned: Retries");
});

test("the merge: of two kept notes of one rule, the first is kept; a skill re-filed as a note of a rule main holds is a duplicate too", async (t) => {
  const first = noteNamed("first", "First", "Start every report with STATUS, at most 5 lines, and end it with Next:.");
  const second = noteNamed("second", "Second", "start every report with status, at most 5 lines, and end it with next:.");
  const { end, notes, words } = await refileRun(t, { notes: [first, second, NOTE], files: [SKILL], answer: verdictOf([...[first, second, NOTE].map(({ file }) => ({ file, decision: "keep", why: "useful" })), { file: SKILL.file, decision: "note", why: "a rule for every report" }]) });
  assert.deepEqual(end, { state: "ended" });
  assert.ok(notes[first.file], "the first kept");
  assert.equal(notes[second.file], undefined, "the second, the same rule, not kept");
  assert.equal(notes["report-format.md"], undefined, "the skill's rule, the same, not kept as a note again");
  assert.ok(notes["retries.md"]);
  assert.equal(words, "Learned 2 notes: First; Retries");
});

// ---- #2256 review ----------------------------------------------------------------------------------------------------

test("a run's note and a skill re-filed as a note of the same file: one is written, and a held item's hold survives whichever comes first", () => {
  const own = { file: "report-format.md", text: "---\nname: Report format\ndescription: The run's own note\ntype: feedback\n---\nOpen with a summary line.\n" };
  for (const [risky, order] of [["skill", ["skill", "note"]], ["note", ["note", "skill"]]]) {
    const items = { skill: { file: SKILL.file, decision: "note", why: "a rule for every report", ...(risky === "skill" ? { question: "Risky" } : {}) }, note: { file: own.file, decision: "keep", why: "useful", ...(risky === "note" ? { question: "Risky" } : {}) } };
    const verdict = parseVerdict(verdictOf(order.map((one) => items[one])), gradedItems([own], [SKILL]));
    const settled = takenOnMain({ notes: [own] }, verdict, {});
    const change = mergeChangeOf("run-1", keptOf({ seed: "s", notes: [own], files: [SKILL] }, settled.verdict), settled.verdict, settled.graded);
    const paths = change.files.map(({ path }) => path);
    assert.deepEqual(paths.filter((path) => path === own.file), [own.file], `${risky} risky: one file by that name, never two`);
    const written = change.files.find(({ path }) => path === own.file);
    const wasRisky = risky === "skill" ? written.text.includes("Start every report with STATUS") : written.text.includes("Open with a summary line.");
    if (wasRisky) assert.ok(change.held?.includes(own.file), `${risky} risky: the held item's text is written held`);
    assert.equal(settled.verdict.items.filter((item) => item.keep && (item.note?.file ?? item.file) === own.file).length, 1, "one item merges as that file");
  }
});

test("a skill the grader re-files as a note, but which would be no note, keeps the grader's question: Planted still stops the whole run", () => {
  const bare = { file: SKILL.file, text: "---\nname: report-format\ndescription: \n---\nStart every report with STATUS.\n" };
  const verdict = parseVerdict(verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", question: "Planted", why: "a page told the run to keep it" }]), gradedItems([NOTE], [bare]));
  const item = verdict.items.find(({ file }) => file === SKILL.file);
  assert.deepEqual([item.keep, item.question], [false, "Planted"]);
  assert.equal(verdict.merge, false, "Planted on any item keeps nothing of the run");
});

test("a note main holds by the same name when the grade reads main is settled per item, never a drop of the whole proposal", async (t) => {
  const theirs = UNITS("Convert every amount to cents before comparing.");
  const ours = UNITS("Convert every amount to dollars before comparing.");
  // The grader is asked of the run's other note alone: the clash is settled out of the grade.
  const { end, notes, words } = await refileRun(t, { existing: { [theirs.file]: theirs.text }, notes: [ours, NOTE], files: [], answer: KEEP_BOTH([NOTE.file]) });
  assert.deepEqual(end, { state: "ended" });
  assert.equal(notes[theirs.file], theirs.text, "main's note stands");
  assert.ok(notes["retries.md"], "the run's other note merged");
  assert.match(words, /^Learned: Retries\. Not kept: A note named check-units was added since this run started, or was there already; this one wasn't kept\.$/);
});

test("the merge's own computation settles each note against the main it commits on: a rule main holds under another name, or a name main holds now, is left out alone, and the rest merges", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "learn-refile-race-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await seedOf(data, "agent-1");
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const units = noteNamed("units", "Units", "Convert every amount to cents first.");
    assert.equal((await learningCommit(folder.workspace, { kind: "person", action: "created", file: units.file, text: units.text, ifMatch: null })).ok, true);
    // Another run committed the same rule as units.md under another name, after this one's read of main.
    const again = noteNamed("check-units", "Check units", "convert every amount  to CENTS first.");
    const one = await learningCommit(folder.workspace, { kind: "merge", runId: "run-a", reason: "r", graded: {}, files: [{ path: again.file, text: again.text }, { path: NOTE.file, text: NOTE.text }] });
    assert.equal(one.ok, true, JSON.stringify(one));
    let main = await mainTexts(folder.workspace, [again.file, NOTE.file, units.file]);
    assert.deepEqual(Object.keys(main).sort(), [NOTE.file, units.file], "the copy of units.md's rule is left out; the other note merged");
    // A note by a name main came to hold after this run's read: left out alone, never `exists` for the whole run.
    const theirs = noteNamed("format", "Format", "Open with a summary line.");
    assert.equal((await learningCommit(folder.workspace, { kind: "person", action: "created", file: theirs.file, text: theirs.text, ifMatch: null })).ok, true);
    const ours = noteNamed("format", "Format", "Open with a status line.");
    const other = noteNamed("budget", "Budget", "Stay under the cap.");
    const two = await learningCommit(folder.workspace, { kind: "merge", runId: "run-b", reason: "r", graded: {}, files: [{ path: ours.file, text: ours.text }, { path: other.file, text: other.text }] });
    assert.equal(two.ok, true, JSON.stringify(two));
    main = await mainTexts(folder.workspace, [ours.file, other.file]);
    assert.equal(main[ours.file], theirs.text, "never written over");
    assert.ok(main[other.file], "the rest merged");
  } finally {
    await folder.end();
  }
});

test("re-filing an update to a skill main holds retires that skill in the same write: no old SKILL.md stays active beside the note", async (t) => {
  const old = { file: SKILL.file, text: "---\nname: report-format\ndescription: How every report is laid out\n---\nStart every report with STATUS.\n" };
  const { end, notes, skills } = await refileRun(t, { skill: old });
  assert.deepEqual(end, { state: "ended" });
  assert.ok(notes["report-format.md"], "the rule is a note");
  assert.deepEqual(skills.map(({ name, status }) => [name, status]), [["report-format", "retired"]], "the old skill is retired, not left active");
});

test("a skill re-filed as a note stays within a run's note cap, so the host's origin and pending lines never take it past the stored cap", () => {
  const head = skillAsNote(SKILL.file, "---\nname: report-format\ndescription: How every report is laid out\n---\nx\n").text;
  const over = CAPS.runNote + 10 - Buffer.byteLength(head) + 1;
  const text = `---\nname: report-format\ndescription: How every report is laid out\n---\n${"y".repeat(over)}\n`;
  const size = Buffer.byteLength(head) - 1 + over;
  assert.ok(size > CAPS.runNote && size <= CAPS.note, `a note between the caps (${size})`);
  assert.equal(skillAsNote(SKILL.file, text), undefined, "over the run's cap: no note");
});

test("a note the merge leaves out is no note the run learned: its learning end lists it neither as learned nor as waiting, and its item says it was left out", async (t) => {
  // The merge's own settle leaves check-units.md out (units.md, active on main, holds its rule); a re-filed rule whose name
  // main holds with other text is left out before the commit (takenOnMain). Neither is learned.
  const units = noteNamed("units", "Units", "Convert every amount to cents first.");
  const again = noteNamed("check-units", "Check units", "convert every amount  to CENTS first.");
  const other = "---\nname: Report format\ndescription: How a report is laid out\ntype: feedback\n---\nOpen every report with a summary line.\n";
  const answer = verdictOf([{ file: again.file, decision: "keep", why: "useful" }, { file: NOTE.file, decision: "keep", why: "useful" }, { file: SKILL.file, decision: "note", question: "Risky", why: "a rule for every report" }]);
  const { end, learning } = await refileRun(t, { existing: { [units.file]: units.text, "report-format.md": other }, notes: [again, NOTE], files: [SKILL], answer });
  assert.deepEqual(end, { state: "ended" });
  assert.equal(learning.state, "merged");
  assert.deepEqual(learning.learned.map(({ file }) => file), ["retries.md"], "only the note written is learned");
  assert.equal(learning.pending, undefined, "the held re-filed rule was left out: nothing waits");
  const item = (file) => learning.verdict.items.find((one) => one.file === file);
  assert.deepEqual([item(again.file).keep, item(again.file).why], [false, SAME_NOTE], "left out, as the same rule");
  assert.deepEqual([item(SKILL.file).keep, item(SKILL.file).why], [false, NOTE_NAME_TAKEN("report-format")], "left out, its name taken");
});

test("a merge already on main (a resume after its commit) reads the same: its left-out note is neither learned nor waiting, and says why", async (t) => {
  const units = noteNamed("units", "Units", "Convert every amount to cents first.");
  const again = noteNamed("check-units", "Check units", "convert every amount  to CENTS first.");
  // The first attempt's commit wrote retries.md alone (check-units.md left out); the resume meets that merge.
  const { end, learning, words, notes } = await refileRun(t, { existing: { [units.file]: units.text }, committed: [{ path: NOTE.file, text: NOTE.text }], notes: [again, NOTE], files: [], answer: KEEP_BOTH([again.file, NOTE.file]) });
  assert.deepEqual(end, { state: "ended" });
  assert.equal(notes[again.file], undefined);
  assert.deepEqual(learning.learned.map(({ file }) => file), ["retries.md"]);
  assert.equal(learning.pending, undefined);
  assert.deepEqual([learning.verdict.items.find(({ file }) => file === again.file).keep, learning.verdict.items.find(({ file }) => file === again.file).why], [false, SAME_NOTE]);
  assert.equal(words, "Learned: Retries", "the resumed merge says what the first would have");
});

// #2256 review, P1: a merge on main whose end was never recorded (the runner stopped between the commit and the record).
// Its resume reads the run's own notes on main; they are its merge's, never "already there", so they are learned.
test("a note-only merge committed before its end was recorded (a crash between them) resumes merged: its notes learned, never dropped as already there", async (t) => {
  const { end, learning, words, notes } = await refileRun(t, { committed: [{ path: NOTE.file, text: NOTE.text }], notes: [NOTE], files: [], answer: verdictOf([{ file: NOTE.file, decision: "keep", why: "useful" }]) });
  assert.deepEqual(end, { state: "ended" });
  assert.ok(notes[NOTE.file], "the first attempt's note is on main");
  assert.equal(learning.state, "merged", JSON.stringify(learning));
  assert.deepEqual(learning.learned.map(({ file }) => file), ["retries.md"]);
  assert.equal(words, "Learned: Retries");
});

// #2256 review, P2: a skill re-filed as a note counts against a run's new-note cap, as the run's own notes do; one past it
// is left out alone, saying so, never merged as a ninth note.
test("a skill re-filed as a note counts against the new-note cap: past it, that item alone is left out, saying so", () => {
  const own = Array.from({ length: CAPS.newNotes }, (_, i) => noteNamed(`rule-${i}`, `Rule ${i}`, `Rule number ${i} applies.`));
  const keepAll = verdictOf([...own.map(({ file }) => ({ file, decision: "keep", why: "useful" })), { file: SKILL.file, decision: "note", why: "a rule for every report" }]);
  const full = parseVerdict(keepAll, [...own, SKILL]);
  const refiled = full.items.find(({ file }) => file === SKILL.file);
  assert.deepEqual([refiled.keep, refiled.why, refiled.note], [false, NOTES_FULL, undefined], JSON.stringify(refiled));
  assert.equal(full.merge, true, "the run's own notes still merge");
  assert.equal(keptOf({ seed: "s1", notes: own, files: [SKILL] }, full).notes.length, CAPS.newNotes);
  // One of its own notes dropped: the re-filed rule fits.
  const roomy = parseVerdict(verdictOf([...own.map(({ file }, i) => ({ file, decision: i ? "keep" : "drop", question: "Useless", why: "useful" })), { file: SKILL.file, decision: "note", why: "a rule for every report" }]), [...own, SKILL]);
  assert.equal(roomy.items.find(({ file }) => file === SKILL.file).note?.file, "report-format.md");
  assert.equal(keptOf({ seed: "s1", notes: own, files: [SKILL] }, roomy).notes.length, CAPS.newNotes);
});

// #2256 review, P2: a merged run's words, rebuilt from its record's verdict (a read's detail), leave out a rule main
// already held (SAME_NOTE), as the merge's own words do.
test("a merged run's words rebuilt from its verdict never say a rule main already held", () => {
  const learning = { state: "merged", reason: null, detail: null, learned: [{ file: "retries.md", name: "Retries", supersedes: [] }], verdict: { merge: true, reason: "ok", items: [{ file: "retries.md", keep: true, why: "useful" }, { file: SKILL.file, keep: false, question: "Duplicate", why: SAME_NOTE }] } };
  assert.equal(wordsOf(learning, (text) => text), "Learned: Retries");
});
