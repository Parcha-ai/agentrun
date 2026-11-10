// learningCommit: the one write API on an agent's learning folder (COMMIT-API.md v1). The runner's learning
// loop calls it for a run's merge, and a caller with a person's whole new text calls it for a person's write. Every
// call is ONE exec of the learning script on the folder's main (learn/folder.ts commitChange, one hold), computed from
// the folder's snapshot and the bodies it names. A main that moved under it (the script's exit 3) is computed again on
// the main that won, as long as no oid the caller read (`graded`, `ifMatch`) changed: a change it did not see is a
// conflict, never written over. A folder with no main yet is made in the same call (the script's init first).
import { isHeld, held, retiredLearned } from "./skills.js";
import { buildIndex, INDEX_FILE, INDEX_LINES, type LearnedNote, mergedNote, NOTE_FILE, parseNoteFile, ruleOf, supersede } from "./notes.js";
import { mergeProblems, type Problem, supersededBy } from "./check.js";
import type { IndexEntry, NoteText } from "./grade.js";
import { FolderRefused, FolderTooLarge, type FolderChange, readLearning, readRunDiff, readSnapshot, type Snapshot, snapshotNotes, topOf, writeLearning } from "./folder.js";
import type { Workspace } from "../workspace/index.js";

export type LearningChange =
  | {
      kind: "merge";
      /** The run that learned: the commit's Run-Id trailer and the diff file's name. */
      runId: string;
      /** The grader's reason: the commit's message and the log's `reason`. */
      reason: string;
      /** What merges, already checked: notes, a skill's files, a draft's files, each whole. */
      files: { path: string; text: string }[];
      /** Paths written with `status: pending` (waiting for the owner's OK). */
      held?: string[];
      /** Active notes this merge marks superseded, and by which new note. Absent: what the new notes' own front matter
       *  supersedes (a held note supersedes nothing until it is approved), as the merge always marked them. */
      supersede?: { path: string; by: string }[];
      /** Path to the blob the grader read; one that is another blob on main now is a conflict. */
      graded: Record<string, string>;
      /** The commit the run started from (its pin's seed): a skill's or a draft's file that is not on main as it was on
       *  it (a person retired or approved it, another run's merge changed it) is a conflict, never written over. The
       *  script checks it on main as it commits. Optional, past COMMIT-API.md v1. */
      seed?: string;
      /** New notes written over the note main holds by the same name: each one the run's note supersedes by its own
       *  name (the learning loop's takenOnMain), its blob on main in `graded`, so a change since is a conflict. Any
       *  other new note main holds a note by when the merge commits is left out alone (`left`, `taken`). */
      replace?: string[];
      /** Skills re-filed as notes (grade.ts skillAsNote): each skill's SKILL.md main holds is retired in this write, so
       *  no old skill stays served beside the note that replaces it; not when `note` was left out as `taken` (another
       *  note holds that name, so the skill's rule would be lost). Its file is checked against the run's seed as a
       *  skill's file the merge writes is. */
      retire?: { skill: string; note: string }[];
    }
  | {
      kind: "person";
      action: "edited" | "created" | "retired" | "approved" | "restored";
      /** The note's file, or a skill's SKILL.md or a draft's README.md. */
      file: string;
      /** The file's new text, as the caller built it. */
      text: string;
      /** The blob the person saw (an ETag, quoted or not); null only for `created`, which takes a name main holds nothing by. */
      ifMatch: string | null;
      /** Other files the action changes (the notes an approve or a restore supersedes). */
      also?: { path: string; text: string }[];
      /** Approved-Via: console. */
      via?: "console";
    };

/** A new note a merge left out, settled against the main it commits on: `same`, a rule main's active notes (or an
 *  earlier note of the merge) already hold, or main's note by that name says it (no change); `taken`, main holds a note
 *  by that name with another rule, never written over. */
export type LeftNote = { path: string; reason: "same" | "taken" };

export type LearningCommitResult =
  | { ok: true; main: string; commit: string; files: string[]; left?: LeftNote[] }
  | { ok: false; reason: "conflict"; problems: Problem[] }
  | { ok: false; reason: "refused"; problems: Problem[] }
  | { ok: false; reason: "unavailable"; error: string };

/** The blob `path` is on the snapshot's main: the index, a note, a learned folder's file. */
function blobOf(snapshot: Snapshot | undefined, path: string): string | undefined {
  if (!snapshot) return undefined;
  if (path === INDEX_FILE) return snapshot.index.oid;
  const note = snapshot.notes.find((one) => one.file === path);
  if (note) return note.oid;
  for (const item of [...snapshot.skills, ...snapshot.workflows]) {
    const file = item.files.find((one) => one.path === path);
    if (file) return file.oid;
  }
  return undefined;
}

const isNote = (path: string) => !path.includes("/") && NOTE_FILE.test(path);

/** `text` as a path held for its owner's OK keeps it: a note with `status: pending` (its origin kept), a SKILL.md or a
 *  draft's README.md with `status: pending` last in its front matter. A draft's workflow.json is held by its README. */
function heldText(path: string, text: string): string {
  if (isNote(path)) {
    const note = parseNoteFile(path, text);
    return Array.isArray(note) ? text : mergedNote(text, { origin: note.origin, pending: true });
  }
  if (path.endsWith("/SKILL.md") || path.endsWith("/README.md")) return isHeld(text) ? text : held(text);
  return text;
}

type Computed = LearningCommitResult | { pending: true; left?: LeftNote[] };

/**
 * One write on the folder's main, one exec of the learning script: a run's merge or a person's write, as `change` says.
 * `ok` with the new main (its commit) and the paths the commit changed; `conflict` when an oid the caller read is
 * another blob on main now; `refused` when the folder as it would be is refused (the index past its lines, a note out
 * of shape); a new note named like one main holds, or of a rule one holds, is left out alone (`left`); `unavailable` when the workspace or the exec failed (retry later). A merge whose
 * run already merged here is `ok` with the commit that holds it, and writes nothing.
 */
export async function learningCommit(ws: Workspace, change: LearningChange, opts: { retries?: number } = {}): Promise<LearningCommitResult> {
  try {
    if (change.kind === "merge") {
      const known = await readRunDiff(ws, change.runId);
      if (known) {
        return { ok: true, main: (await readSnapshot(ws))?.main ?? known.merge, commit: known.merge, files: known.files.map((file) => file.path) };
      }
    }
    const done = await writeLearning<Computed>(ws, async ({ snapshot, body }) => (change.kind === "merge" ? mergeOf(change, snapshot, body) : personOf(change, snapshot)), opts.retries ?? 3);
    if (!("pending" in done.result)) return done.result;
    const left = done.result.left?.length ? { left: done.result.left } : {};
    return { ok: true, main: done.main!, commit: done.main!, files: done.snapshot?.log[0]?.commit === done.main ? done.snapshot!.log[0]!.files : [], ...left };
  } catch (error) {
    // The script's exit 4: a file changed since the seed is a conflict; a name held on main by a file that is no note
    // (a create over it) is refused.
    if (error instanceof FolderRefused) {
      if (error.same.length) return { ok: false, reason: "conflict", problems: error.same.map((path): Problem => ({ rule: "supersedes", path, detail: `${path} changed on main after the run started` })) };
      return { ok: false, reason: "refused", problems: error.absent.map((path): Problem => ({ rule: "exists", path, detail: "the folder has a note by this name" })) };
    }
    if (error instanceof FolderTooLarge) return { ok: false, reason: "refused", problems: [{ rule: "too_large", detail: error.message }] };
    return { ok: false, reason: "unavailable", error: (error as Error)?.message ?? String(error) };
  }
}

/** A run's merge on main as the snapshot has it: its files (the held ones pending), the notes it supersedes marked, and
 *  MEMORY.md rebuilt from what is active then. */
async function mergeOf(change: Extract<LearningChange, { kind: "merge" }>, snapshot: Snapshot | undefined, body: (path: string, oid: string) => Promise<string>): Promise<{ result: Computed; change?: FolderChange }> {
  const held = new Set(change.held ?? []);
  const replaced = new Set(change.replace ?? []);
  // Each new note settled against THIS main, the one the write commits on (computed again on the main that won when
  // another write landed first), one note at a time and never a refusal of the merge: a name main holds a note by (and
  // the merge does not replace) is left out, `same` when main's note says the same rule, else `taken`; a rule main's
  // active notes hold under another name, or an earlier note of this merge holds, is left out as `same` (notes.ts
  // ruleOf), unless the note supersedes the note it repeats (an update).
  const left: LeftNote[] = [];
  const newNotes = change.files.filter(({ path }) => isNote(path));
  if (newNotes.length) {
    const rules = new Map<string, string>();
    for (const note of snapshotNotes(snapshot).filter((one) => one.status === "active")) {
      const text = parseNoteFile(note.file, await body(note.file, blobOf(snapshot, note.file)!));
      if (!Array.isArray(text)) rules.set(ruleOf(text.body), note.file);
    }
    for (const { path, text } of newNotes) {
      const note = parseNoteFile(path, text);
      if (Array.isArray(note)) continue;
      const rule = ruleOf(note.body);
      const onMain = blobOf(snapshot, path);
      if (onMain !== undefined && !replaced.has(path)) {
        const theirs = parseNoteFile(path, await body(path, onMain));
        left.push({ path, reason: !Array.isArray(theirs) && ruleOf(theirs.body) === rule ? "same" : "taken" });
        continue;
      }
      const holder = rules.get(rule);
      if (holder !== undefined && holder !== path && !note.supersedes.includes(holder)) {
        left.push({ path, reason: "same" });
        continue;
      }
      rules.set(rule, path);
    }
  }
  const leftOut = new Set(left.map(({ path }) => path));
  // Each new note as main keeps it (mergedNote): its own origin, `status: pending` when held, the run's risky mark gone.
  // A skill's SKILL.md or a draft's README.md held: `status: pending` last in its front matter.
  const files = new Map(change.files.filter(({ path }) => !leftOut.has(path)).map(({ path, text }) => {
    if (isNote(path) && blobOf(snapshot, path) === undefined) {
      const note = parseNoteFile(path, text);
      return [path, Array.isArray(note) ? text : mergedNote(text, { origin: note.origin, pending: held.has(path) })];
    }
    return [path, held.has(path) ? heldText(path, text) : text];
  }));
  // Each re-filed skill main holds, not retired, retired in this write (`retire`), unless its note was left out as taken.
  const retiring: string[] = [];
  for (const { skill, note } of change.retire ?? []) {
    if (left.some((one) => one.path === note && one.reason === "taken")) continue;
    const oid = blobOf(snapshot, skill);
    const item = snapshot?.skills.find((one) => one.files.some((file) => file.path === skill));
    if (oid === undefined || !item || item.status === "retired") continue;
    files.set(skill, retiredLearned(await body(skill, oid)));
    retiring.push(skill);
  }
  // Nothing left to write: every new note is one main holds already, or a name it holds. No commit.
  if (![...files.keys()].length) return { result: { ok: true, main: snapshot?.main ?? "", commit: snapshot?.main ?? "", files: [], left } };
  const notes = snapshotNotes(snapshot);
  const active = new Set(notes.filter((note) => note.status === "active").map((note) => note.file));
  const refused: Problem[] = [];
  const fresh = [...files].filter(([path]) => isNote(path) && (blobOf(snapshot, path) === undefined || replaced.has(path))).flatMap(([path, text]) => {
    const note = parseNoteFile(path, text);
    return Array.isArray(note) ? [] : [note];
  });
  // A note written over main's by its own name supersedes that note by being it: never a mark of itself.
  const marks = change.supersede ?? [...supersededBy(fresh)].filter(([path, by]) => path !== by).map(([path, by]) => ({ path, by }));
  // The verdict was on the blobs the grade read: one this merge would write (mark or replace) that is another blob on
  // main now is the caller's conflict, named by the note that would mark it. One it leaves alone (a held note marks
  // nothing) is not written over, so it stands.
  const touched = new Set([...marks.map((mark) => mark.path), ...change.files.map(({ path }) => path)]);
  const conflicts = Object.entries(change.graded).filter(([path, oid]) => touched.has(path) && blobOf(snapshot, path) !== oid).map(([path]): Problem => ({ rule: "supersedes", path: marks.find((mark) => mark.path === path)?.by ?? path, detail: `${path} changed after the grade read it` }));
  if (conflicts.length) return { result: { ok: false, reason: "conflict", problems: conflicts } };
  for (const { path, by } of marks) {
    if (!active.has(path)) refused.push({ rule: "supersedes", path: by, detail: `it supersedes ${path}, which is not an active note` });
    else files.set(path, supersede(await body(path, blobOf(snapshot, path)!), by));
  }
  const added: LearnedNote[] = [];
  const written: LearnedNote[] = [];
  for (const [path, text] of files) {
    if (!isNote(path)) continue;
    const note = parseNoteFile(path, text);
    if (Array.isArray(note)) {
      refused.push({ rule: "note", path, detail: note.join("; ") });
      continue;
    }
    written.push(note);
    // A merge adds notes and marks the ones they supersede: it never writes over another note main holds.
    if (blobOf(snapshot, path) === undefined) added.push(note);
    else if (!marks.some((one) => one.path === path) && !replaced.has(path)) refused.push({ rule: "exists", path, detail: "the folder has a note by this name" });
  }
  // mergeProblems asks of the new notes what a merge always asks: a free name, what they supersede active and named
  // once, the index's lines.
  if (!refused.length) refused.push(...mergeProblems({ files: topOf(snapshot), active: notes.filter((note) => note.status === "active") }, added));
  if (refused.length) return { result: { ok: false, reason: "refused", problems: refused } };
  const marked = new Set(written.map((note) => note.file));
  files.set(INDEX_FILE, buildIndex([...notes.filter((note) => !marked.has(note.file)), ...written]));
  return {
    result: { pending: true, ...(left.length ? { left } : {}) },
    change: {
      by: { run: change.runId, reason: change.reason },
      writes: [...files].map(([path, text]) => ({ path, text })),
      absent: added.map((note) => note.file),
      ...(change.seed ? { same: [...change.files.filter(({ path }) => !isNote(path)).map(({ path }) => path), ...retiring].map((path) => ({ commit: change.seed!, path })) } : {}),
    },
  };
}

/** A person's write on main as the snapshot has it: the file and what the action also changes, MEMORY.md rebuilt. */
async function personOf(change: Extract<LearningChange, { kind: "person" }>, snapshot: Snapshot | undefined): Promise<{ result: Computed; change?: FolderChange }> {
  const current = blobOf(snapshot, change.file);
  const seen = change.ifMatch?.replace(/^"|"$/g, "") ?? null;
  if (change.action === "created" ? current !== undefined : seen === null || current !== seen) {
    return { result: { ok: false, reason: "conflict", problems: [{ rule: change.action === "created" ? "exists" : "supersedes", path: change.file, detail: current === undefined ? `${change.file} is not on main` : change.action === "created" ? "the folder has a note by this name" : `${change.file} changed since it was read` }] } };
  }
  const writes = [{ path: change.file, text: change.text }, ...(change.also ?? [])];
  const changed = new Map(writes.filter(({ path }) => isNote(path)).map(({ path, text }) => [path, parseNoteFile(path, text)]));
  const refused: Problem[] = [...changed].filter(([, note]) => Array.isArray(note)).map(([path, note]): Problem => ({ rule: "note", path, detail: (note as string[]).join("; ") }));
  if (refused.length) return { result: { ok: false, reason: "refused", problems: refused } };
  const after = [...snapshotNotes(snapshot).filter((note) => !changed.has(note.file)), ...[...changed.values()] as LearnedNote[]];
  const lines = after.filter((note) => note.status === "active").length;
  if (lines > INDEX_LINES) return { result: { ok: false, reason: "refused", problems: [{ rule: "index_full", detail: `the index would hold ${lines} lines; it holds at most ${INDEX_LINES}, so retire a note first` }] } };
  return {
    result: { pending: true },
    change: { by: { person: change.action, file: change.file, approved: change.via === "console" }, writes: [...writes, { path: INDEX_FILE, text: buildIndex(after) }], ...(change.action === "created" ? { absent: [change.file] } : {}) },
  };
}

/** The texts main holds at `paths`, each a note's file, by path: one main holds no note at is not in it. From the
 *  folder's snapshot and its bodies: no git, no exec. What a skill the grader re-filed as a note (grade.ts skillAsNote)
 *  would be written over, read before its merge. */
export async function mainTexts(ws: Workspace, paths: readonly string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  return readLearning(ws, async ({ snapshot, body }) => {
    const oids = new Map((snapshot?.notes ?? []).map((note) => [note.file, note.oid]));
    const held = paths.filter((path) => oids.has(path));
    return Object.fromEntries(await Promise.all(held.map(async (path) => [path, await body(path, oids.get(path)!)] as const)));
  });
}

/** Main as the grader reads it (the runner's learning loop `readMain`): every active note's index line, the whole text
 *  of each note the proposal supersedes, and the blob each of those was read at (`graded`, which the merge checks); the
 *  proposal's notes named like a note main holds now, settled alone (`taken`); or `problems` when the proposal cannot
 *  join main as it is (learn/check.ts mergeProblems). From the folder's snapshot and its bodies: no git, no exec. */
export async function readMain(ws: Workspace, proposal: { readonly notes: readonly NoteText[] }): Promise<{ active: IndexEntry[]; superseded: NoteText[]; graded: Record<string, string>; taken?: LeftNote[] } | { problems: Problem[] }> {
  const added = proposal.notes.map(({ file, text }) => parseNoteFile(file, text));
  const bad = proposal.notes.filter((_, i) => Array.isArray(added[i])).map(({ file }): Problem => ({ rule: "note", path: file, detail: "the proposal's note is out of shape" }));
  if (bad.length) return { problems: bad };
  return readLearning(ws, async ({ snapshot, body }) => {
    const main = snapshotNotes(snapshot);
    const oids = new Map((snapshot?.notes ?? []).map((note) => [note.file, note.oid]));
    // A new note named like one main holds (another run merged it since the run's seed, so the run never saw it) is
    // settled alone, never a drop of the whole proposal: left out of the grade, `same` when main's note says its rule,
    // else `taken`, and the rest is graded.
    const taken: LeftNote[] = [];
    for (const note of added as LearnedNote[]) {
      if (!oids.has(note.file)) continue;
      const theirs = parseNoteFile(note.file, await body(note.file, oids.get(note.file)!));
      taken.push({ path: note.file, reason: !Array.isArray(theirs) && ruleOf(theirs.body) === ruleOf(note.body) ? "same" : "taken" });
    }
    const notes = (added as LearnedNote[]).filter((note) => !oids.has(note.file));
    const problems = mergeProblems({ files: topOf(snapshot), active: main.filter((note) => note.status === "active") }, notes);
    if (problems.length) return { problems };
    // mergeProblems passed: each note superseded is active on main, and named once.
    const superseded = await Promise.all(notes.flatMap((note) => note.supersedes).map(async (file) => ({ file, text: await body(file, oids.get(file)!) })));
    return { active: main.filter((note) => note.status === "active").map(({ file, name, description }) => ({ file, name, description })), superseded, graded: Object.fromEntries(superseded.map(({ file }) => [file, oids.get(file)!])), ...(taken.length ? { taken } : {}) };
  });
}
