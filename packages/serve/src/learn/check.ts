// The checker of what a run proposes for its agent's learning folder (SPEC.md): the files its end-of-run turn left in the
// run's copy of the folder, against the commit the run started from. Structure only, never whether a note is any good,
// which is the grader's. The host reads the copy itself (regular files only, never a link followed) and hands each change
// here with its bytes; nothing the checker refuses is ever written to git. Every problem it reports is printable: its
// path and detail are cut of the host's secrets and of text shaped like one, and a field over PRINT_MAX is redacted whole.
import { hiddenCharacter } from "./invisible.js";
import { INDEX_FILE, INDEX_LINES, type LearnedNote, NOTE_FILE, parseNoteFile } from "./notes.js";
import { redactSecrets, secretShapes, valueMatcher } from "./secrets.js";

/** Byte caps (UTF-8) and counts. Over a cap is refused, never cut. */
export const CAPS = Object.freeze({
  /** One note's file. */
  note: 4096,
  /** New notes in one run. */
  newNotes: 8,
  /** Notes one run's new notes supersede, together. */
  supersedes: 8,
  /** Changed paths in one run; over it nothing else is read. */
  changes: 64,
});

/** The rule a problem breaks. SPEC.md lists each. */
export type Rule =
  | "too_many_files" | "outside" | "file_name" | "file_mode" | "encoding" | "edited" | "deleted" | "exists" | "too_large"
  | "too_many_notes" | "invisible_unicode" | "secret_shape" | "secret_value" | "note" | "status" | "supersedes" | "index_full";

/** One problem with what a run proposed, printable as it is. */
export type Problem = { readonly rule: Rule; readonly path?: string; readonly detail: string };

/** One file of the run's copy that differs from the commit it started from. `mode` is git's (`100644` a regular file,
 *  `120000` a link, `040000` a folder; anything else is not a regular file). A change that is not a deletion carries its
 *  bytes, or only its `size` when that is over the note cap. */
export type Change = {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly mode?: string;
  readonly size?: number;
  readonly bytes?: Uint8Array;
};

/** The folder a proposal is checked against (the run's seed, or main at merge time): every path it holds, and its active
 *  notes. */
export type Base = { readonly files: Iterable<string>; readonly active: readonly LearnedNote[] };
/** A new note that passed, with its whole text. */
export type ProposedNote = LearnedNote & { readonly text: string };

export type CheckInput = {
  readonly base: Base;
  readonly changes: readonly Change[];
  /** Values the host holds as secrets: a file, or a file's name, that holds one is refused. */
  readonly refuseValues?: readonly string[];
};
/** `ok` when `problems` is empty; then `notes` are the new notes, each in shape. */
export type ProposalCheck = { readonly ok: boolean; readonly problems: Problem[]; readonly notes: ProposedNote[] };

const MODES: Record<string, string> = { "120000": "a link: never followed", "040000": "a folder: nothing in it was read" };

/** `problem` as it may be printed: its path and detail cut of `values` and of secret shapes, whole when over PRINT_MAX. */
export const printable = (problem: Problem, values: readonly string[]): Problem => ({
  rule: problem.rule,
  ...(problem.path === undefined ? {} : { path: redactSecrets(problem.path, values) }),
  detail: redactSecrets(problem.detail, values),
});

/** Checks what a run proposes against SPEC.md. `MEMORY.md` is the host's: a change to it is ignored, never refused. */
export function checkProposal(input: CheckInput): ProposalCheck {
  const values = input.refuseValues ?? [];
  const problems: Problem[] = [];
  const add = (rule: Rule, detail: string, path?: string) => void problems.push(printable(path === undefined ? { rule, detail } : { rule, path, detail }, values));
  const changes = input.changes.filter((change) => change.path !== INDEX_FILE);
  if (changes.length > CAPS.changes) {
    add("too_many_files", `${changes.length} changed paths; the cap is ${CAPS.changes} a run, and nothing else was read`);
    return { ok: false, problems, notes: [] };
  }
  const refused = valueMatcher(values);
  const base = new Set(input.base.files);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const notes: ProposedNote[] = [];
  const one = (change: Change): void => {
    const { path } = change;
    // A run picks its files' names: they reach main, the index and the logs.
    for (const kind of secretShapes(path)) add("secret_shape", `its name holds text shaped like a secret (${kind})`, path);
    if (refused(path)) add("secret_value", "its name holds a value the host named as secret", path);
    if (path.includes("/") || !path.endsWith(".md")) return add("outside", "only a .md file at the folder's top is a note", path);
    if (!NOTE_FILE.test(path)) return add("file_name", "a note's name is letters, digits, dots, dashes and underscores, starting with a letter or digit, and ends .md", path);
    if (change.status === "deleted") return add("deleted", "a run never deletes a note", path);
    if (change.mode !== undefined && change.mode !== "100644") return add("file_mode", MODES[change.mode] ?? "not a regular file: never read", path);
    if (change.status === "modified") return add("edited", "a run never edits a note: to replace one, it adds a new note that supersedes it", path);
    if (base.has(path)) return add("exists", "the folder has a note by this name", path);
    const size = change.size ?? change.bytes?.length ?? 0;
    if (size > CAPS.note) return add("too_large", `${size} bytes; the cap is ${CAPS.note}`, path);
    if (!change.bytes) throw new TypeError(`${path}: a change that is not a deletion carries its bytes`);
    let text: string;
    try {
      text = decoder.decode(change.bytes);
    } catch {
      return add("encoding", "it is not UTF-8", path);
    }
    const before = problems.length;
    const hidden = hiddenCharacter(text);
    if (hidden) add("invisible_unicode", `it holds U+${hidden.code.toString(16).toUpperCase().padStart(4, "0")}, a character a reader does not see, at character ${hidden.at}`, path);
    for (const kind of secretShapes(text)) add("secret_shape", `it holds text shaped like a secret (${kind})`, path);
    if (refused(text)) add("secret_value", "it holds a value the host named as secret", path);
    if (problems.length > before) return;
    const note = parseNoteFile(path, text);
    if (Array.isArray(note)) return note.forEach((reason) => add("note", reason, path));
    if (note.keys.includes("status") || note.keys.includes("superseded_by")) return add("status", "a run never sets status or superseded_by: the host does, when a later note supersedes this one", path);
    notes.push({ ...note, text });
  };
  for (const change of changes) one(change);
  const added = changes.filter((change) => change.status === "added").length;
  if (added > CAPS.newNotes) add("too_many_notes", `${added} new notes; the cap is ${CAPS.newNotes} a run`);
  if (!problems.length) problems.push(...mergeProblems(input.base, notes, values));
  return { ok: problems.length === 0, problems, notes: problems.length ? [] : notes };
}

/** What stops `notes` from joining `base` as they are: a name `base` holds (`exists`), a `supersedes` that names no
 *  active note of `base` or one another new note supersedes too, or more than CAPS.supersedes notes superseded, and an
 *  index past INDEX_LINES. The checker asks it of the run's seed; the host asks it again of main at merge time, since
 *  other runs may have merged meanwhile. */
export function mergeProblems(base: Base, notes: readonly LearnedNote[], refuseValues: readonly string[] = []): Problem[] {
  const files = new Set(base.files);
  const active = new Set(base.active.map((note) => note.file));
  const out: Problem[] = [];
  const replaced = new Set<string>();
  for (const note of notes) {
    if (files.has(note.file)) out.push({ rule: "exists", path: note.file, detail: "the folder has a note by this name" });
    for (const old of note.supersedes) {
      if (!active.has(old)) out.push({ rule: "supersedes", path: note.file, detail: `it supersedes ${old}, which is not an active note` });
      else if (replaced.has(old)) out.push({ rule: "supersedes", path: note.file, detail: `${old} is superseded by another new note too` });
      replaced.add(old);
    }
  }
  // The grader reads each note superseded in full (grade.ts): their count is capped, as the new notes' is.
  if (replaced.size > CAPS.supersedes) out.push({ rule: "supersedes", detail: `the new notes supersede ${replaced.size} notes; the cap is ${CAPS.supersedes} a run` });
  const lines = active.size - [...replaced].filter((file) => active.has(file)).length + notes.length;
  if (lines > INDEX_LINES) out.push({ rule: "index_full", detail: `the index would hold ${lines} lines; it holds at most ${INDEX_LINES}, so supersede a note rather than add one` });
  return out.map((problem) => printable(problem, refuseValues));
}
