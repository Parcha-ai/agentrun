// learningCommit: the one write API on an agent's learning folder (COMMIT-API.md v1, tl-learning). The runner's learning
// loop calls it for a run's merge, and a caller with a person's whole new text calls it for a person's write. Every
// call is ONE exec of the learning script on the folder's main (learn/folder.ts commitChange, one hold), computed from
// the folder's snapshot and the bodies it names. A main that moved under it (the script's exit 3) is computed again on
// the main that won, as long as no oid the caller read (`graded`, `ifMatch`) changed: a change it did not see is a
// conflict, never written over. A folder with no main yet is made in the same call (the script's init first).
import { isHeld, held } from "./skills.js";
import { buildIndex, INDEX_FILE, INDEX_LINES, type LearnedNote, mergedNote, NOTE_FILE, parseNoteFile, supersede } from "./notes.js";
import { mergeProblems, type Problem, supersededBy } from "./check.js";
import type { IndexEntry, NoteText } from "./grade.js";
import { FolderRefused, type FolderChange, readLearning, readRunDiff, readSnapshot, type Snapshot, snapshotNotes, topOf, writeLearning } from "./folder.js";
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

export type LearningCommitResult =
  | { ok: true; main: string; commit: string; files: string[] }
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

type Computed = LearningCommitResult | { pending: true };

/**
 * One write on the folder's main, one exec of the learning script: a run's merge or a person's write, as `change` says.
 * `ok` with the new main (its commit) and the paths the commit changed; `conflict` when an oid the caller read is
 * another blob on main now; `refused` when the folder as it would be is refused (a name main holds already, the index
 * past its lines, a note out of shape); `unavailable` when the workspace or the exec failed (retry later). A merge whose
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
    return { ok: true, main: done.main!, commit: done.main!, files: done.snapshot?.log[0]?.commit === done.main ? done.snapshot!.log[0]!.files : [] };
  } catch (error) {
    if (error instanceof FolderRefused) {
      return { ok: false, reason: "refused", problems: [...error.absent.map((path): Problem => ({ rule: "exists", path, detail: "the folder has a file by this name" })), ...error.same.map((path): Problem => ({ rule: "supersedes", path, detail: `${path} changed on main since it was read` }))] };
    }
    return { ok: false, reason: "unavailable", error: (error as Error)?.message ?? String(error) };
  }
}

/** A run's merge on main as the snapshot has it: its files (the held ones pending), the notes it supersedes marked, and
 *  MEMORY.md rebuilt from what is active then. */
async function mergeOf(change: Extract<LearningChange, { kind: "merge" }>, snapshot: Snapshot | undefined, body: (path: string, oid: string) => Promise<string>): Promise<{ result: Computed; change?: FolderChange }> {
  const conflicts = Object.entries(change.graded).filter(([path, oid]) => blobOf(snapshot, path) !== oid).map(([path]): Problem => ({ rule: "supersedes", path, detail: `${path} changed after the grade read it` }));
  if (conflicts.length) return { result: { ok: false, reason: "conflict", problems: conflicts } };
  const held = new Set(change.held ?? []);
  // Each new note as main keeps it (mergedNote): its own origin, `status: pending` when held, the run's risky mark gone.
  // A skill's SKILL.md or a draft's README.md held: `status: pending` last in its front matter.
  const files = new Map(change.files.map(({ path, text }) => {
    if (isNote(path) && blobOf(snapshot, path) === undefined) {
      const note = parseNoteFile(path, text);
      return [path, Array.isArray(note) ? text : mergedNote(text, { origin: note.origin, pending: held.has(path) })];
    }
    return [path, held.has(path) ? heldText(path, text) : text];
  }));
  const notes = snapshotNotes(snapshot);
  const active = new Set(notes.filter((note) => note.status === "active").map((note) => note.file));
  const refused: Problem[] = [];
  const fresh = [...files].filter(([path]) => isNote(path) && blobOf(snapshot, path) === undefined).flatMap(([path, text]) => {
    const note = parseNoteFile(path, text);
    return Array.isArray(note) ? [] : [note];
  });
  const marks = change.supersede ?? [...supersededBy(fresh)].map(([path, by]) => ({ path, by }));
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
    else if (!marks.some((one) => one.path === path)) refused.push({ rule: "exists", path, detail: "the folder has a note by this name" });
  }
  // mergeProblems asks of the new notes what a merge always asks: a free name, what they supersede active and named
  // once, the index's lines.
  if (!refused.length) refused.push(...mergeProblems({ files: topOf(snapshot), active: notes.filter((note) => note.status === "active") }, added));
  if (refused.length) return { result: { ok: false, reason: "refused", problems: refused } };
  const marked = new Set(written.map((note) => note.file));
  files.set(INDEX_FILE, buildIndex([...notes.filter((note) => !marked.has(note.file)), ...written]));
  return {
    result: { pending: true },
    change: { by: { run: change.runId, reason: change.reason }, writes: [...files].map(([path, text]) => ({ path, text })), absent: added.map((note) => note.file) },
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

/** Main as the grader reads it (the runner's learning loop `readMain`, grade.ts readForGrade): every active note's index
 *  line, the whole text of each note the proposal supersedes, and the blob each of those was read at (`graded`, which
 *  the merge checks); or `problems` when the proposal cannot join main as it is (learn/check.ts mergeProblems). From
 *  the folder's snapshot and its bodies: no git, no exec. */
export async function readMain(ws: Workspace, proposal: { readonly notes: readonly NoteText[] }): Promise<{ active: IndexEntry[]; superseded: NoteText[]; graded: Record<string, string> } | { problems: Problem[] }> {
  const added = proposal.notes.map(({ file, text }) => parseNoteFile(file, text));
  const bad = proposal.notes.filter((_, i) => Array.isArray(added[i])).map(({ file }): Problem => ({ rule: "note", path: file, detail: "the proposal's note is out of shape" }));
  if (bad.length) return { problems: bad };
  const notes = added as LearnedNote[];
  return readLearning(ws, async ({ snapshot, body }) => {
    const main = snapshotNotes(snapshot);
    const problems = mergeProblems({ files: topOf(snapshot), active: main.filter((note) => note.status === "active") }, notes);
    if (problems.length) return { problems };
    const oids = new Map((snapshot?.notes ?? []).map((note) => [note.file, note.oid]));
    // mergeProblems passed: each note superseded is active on main, and named once.
    const superseded = await Promise.all(notes.flatMap((note) => note.supersedes).map(async (file) => ({ file, text: await body(file, oids.get(file)!) })));
    return { active: main.filter((note) => note.status === "active").map(({ file, name, description }) => ({ file, name, description })), superseded, graded: Object.fromEntries(superseded.map(({ file }) => [file, oids.get(file)!])) };
  });
}
