// The checker of what a run proposes for its agent's learning folder (SPEC.md): its notes, a skill and workflow drafts,
// each a change against the commit the run started from. Structure only, never whether a note is any good,
// which is the grader's. The host reads the copy itself (regular files only, never a link followed) and hands each change
// here with its bytes; nothing the checker refuses is ever written to git. Every problem it reports is printable: its
// path and detail are cut of the host's secrets and of text shaped like one, and a field over PRINT_MAX is redacted whole.
import { hiddenCharacter } from "./invisible.js";
import { INDEX_FILE, INDEX_LINES, type LearnedNote, NOTE_FILE, parseNoteFile, ruleOf } from "./notes.js";
import { redactSecrets, secretShapes, valueMatcher } from "./secrets.js";
import { draftProblems, type DraftReader, frontKeys, LEARNED_KEYS, learnedName, learnedPlace, type LearnedPlace, setsStatus, skillProblems, WORKFLOWS_DIR } from "./skills.js";

/** The most the host adds to a run's note as it merges it: `origin: you` and `status: pending`, a front matter line
 *  each (notes.ts mergedNote). */
const HOST_LINES = Buffer.byteLength("origin: you\nstatus: pending\n");

/** Byte caps (UTF-8) and counts. Over a cap is refused, never cut. */
export const CAPS = Object.freeze({
  /** One note's file. */
  note: 4096,
  /** One note a run proposes: the note cap less HOST_LINES, so a run's note stays within `note` once the host merges
   *  it, and a person can still retire it and a later run supersede it, each read and checked against `note`. */
  runNote: 4096 - HOST_LINES,
  /** New notes in one run. */
  newNotes: 8,
  /** Notes one run's new notes supersede, together. */
  supersedes: 8,
  /** Changed paths in one run; over it nothing else is read. */
  changes: 64,
  /** One skill's SKILL.md, or one workflow draft's workflow.json: one grader reads each whole beside the notes, so the
   *  most a run proposes stays within its prompt (grade.ts GRADE_CAPS.prompt). */
  file: 16_384,
  /** One draft's README.md, which the host writes from the one-line description its block gives. */
  readme: 1_024,
  /** Skills one run adds or changes. */
  skills: 1,
  /** Workflow drafts one run adds or changes. */
  workflows: 1,
});

/** The rule a problem breaks. SPEC.md lists each. */
export type Rule =
  | "too_many_files" | "outside" | "file_name" | "file_mode" | "encoding" | "edited" | "deleted" | "exists" | "too_large"
  | "too_many_notes" | "invisible_unicode" | "secret_shape" | "secret_value" | "note" | "status" | "supersedes" | "index_full"
  | "skill" | "skill_outcome" | "too_many_skills" | "workflow" | "too_many_workflows" | "no_tool_list" | "executable_node"
  | "skill_front_matter" | "skill_status" | "duplicate";

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
/** What a proposal is checked against: every path at the seed's top, its active notes, and `rules`, when the caller read
 *  the active notes' texts, each one's rule (notes.ts ruleOf) to its file: a new note of the same rule is a duplicate. */
export type Base = { readonly files: Iterable<string>; readonly active: readonly LearnedNote[]; readonly rules?: ReadonlyMap<string, string> };
/** A new note that passed, with its whole text. */
export type ProposedNote = LearnedNote & { readonly text: string };

export type CheckInput = {
  readonly base: Base;
  readonly changes: readonly Change[];
  /** Values the host holds as secrets: a file, or a file's name, that holds one is refused. */
  readonly refuseValues?: readonly string[];
  /** How the run's job ended, its status (`completed`, `failed`, ...). Only a completed run adds or changes a skill:
   *  without it, none does. */
  readonly outcome?: string;
  /** The tools a workflow draft may name: the agent's granted tools a workflow's call node runs here (tools.ts
   *  learnedWorkflowTools). Without it, a draft that names a tool is refused. */
  readonly tools?: readonly string[];
  /** The agent's granted tools the gate does not allow, with what each is set to (tools.ts learnedDraftTools): a draft
   *  whose call node calls one is refused, in the words a workflow revision's is (learn/skills.ts gatedNodes). */
  readonly gated?: Readonly<Record<string, string>>;
  /** Where each of `gated`'s denies was set (this agent's settings or this server's), for the refusal's words. */
  readonly deniedBy?: Readonly<Record<string, "agent" | "server" | "default">>;
  /** The workflow DSL a draft is read with; a proposal that holds a draft is checked with it, never without. */
  readonly dsl?: DraftReader;
  /** The skills' and drafts' files whose text in the run's seed has a status (a person retired it, or it waits for its
   *  owner's OK): a run never changes those. A draft's is its README.md. */
  readonly kept?: readonly string[];
};
/** `ok` when `problems` is empty; then `notes` are the new notes, each in shape. */
export type ProposalCheck = { readonly ok: boolean; readonly problems: Problem[]; readonly notes: ProposedNote[] };

const MODES: Record<string, string> = { "120000": "a link: never followed", "040000": "a folder: nothing in it was read" };
/** Why a run's path is none of what it may propose. */
const OUTSIDE = "a run proposes notes at the folder's top, skills/<name>/SKILL.md, and workflows/<name>/ with its workflow.json and README.md";

/** `problem` as it may be printed: its path and detail cut of `values` and of secret shapes, whole when over PRINT_MAX. */
export const printable = (problem: Problem, values: readonly string[]): Problem => ({
  rule: problem.rule,
  ...(problem.path === undefined ? {} : { path: redactSecrets(problem.path, values) }),
  detail: redactSecrets(problem.detail, values),
});

type Add = (rule: Rule, detail: string, path?: string) => void;

/** No secret's shape or the host's values in a file's name: a writer picks its files' names, and they reach main, the
 *  index and the logs. */
function nameScanned(path: string, refused: (text: string) => boolean, add: Add): void {
  for (const kind of secretShapes(path)) add("secret_shape", `its name holds text shaped like a secret (${kind})`, path);
  if (refused(path)) add("secret_value", "its name holds a value the host named as secret", path);
}

/** A note's file name, whoever writes it: nameScanned, and a note's own (a `.md` file at the folder's top). False when
 *  it is not a note's name, and nothing else is read. */
function nameChecked(path: string, refused: (text: string) => boolean, add: Add, outside = "only a .md file at the folder's top is a note"): boolean {
  nameScanned(path, refused, add);
  if (path.includes("/") || !path.endsWith(".md")) return add("outside", outside, path), false;
  if (!NOTE_FILE.test(path)) return add("file_name", "a note's name is letters, digits, dots, dashes and underscores, starting with a letter or digit, and ends .md", path), false;
  return true;
}

/** A note's text by itself, whoever writes it: within the cap, UTF-8, no hidden character, no secret's shape or the host's
 *  values, its front matter in shape. The note when it is. */
function textChecked(path: string, size: number, bytes: Uint8Array | undefined, refused: (text: string) => boolean, add: Add, run = false): ProposedNote | undefined {
  const cap = run ? CAPS.runNote : CAPS.note;
  if (size > cap) return void add("too_large", `${size} bytes; the cap is ${cap}${run ? " for a run's note" : ""}`, path);
  const text = textOf(path, bytes, refused, add);
  if (text === undefined) return undefined;
  const note = parseNoteFile(path, text);
  if (Array.isArray(note)) return void note.forEach((reason) => add("note", reason, path));
  return { ...note, text };
}

/** A file's text, whatever it holds: UTF-8, no hidden character, no secret's shape or the host's values. Undefined,
 *  with why, when it is not. */
function textOf(path: string, bytes: Uint8Array | undefined, refused: (text: string) => boolean, add: Add): string | undefined {
  if (!bytes) throw new TypeError(`${path}: a change that is not a deletion carries its bytes`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return void add("encoding", "it is not UTF-8", path);
  }
  let found = false;
  const hidden = hiddenCharacter(text);
  if (hidden) found = (add("invisible_unicode", `it holds U+${hidden.code.toString(16).toUpperCase().padStart(4, "0")}, a character a reader does not see, at character ${hidden.at}`, path), true);
  for (const kind of secretShapes(text)) found = (add("secret_shape", `it holds text shaped like a secret (${kind})`, path), true);
  if (refused(text)) found = (add("secret_value", "it holds a value the host named as secret", path), true);
  return found ? undefined : text;
}

/** What a run may write of a skill or a workflow draft (`place`), by itself: a good folder name, never a deletion, a
 *  regular file within CAPS.file (a README within CAPS.readme), its text as textOf takes it, and in shape: a skill's
 *  front matter (skillProblems), with no `status`, which is the host's; a draft the DSL validates against `tools` with
 *  no node that runs code (draftProblems); a README that names its folder and says what the draft is for. */
function learnedChecked(change: Change, place: LearnedPlace, refused: (text: string) => boolean, input: CheckInput, add: Add): void {
  const { path } = change;
  nameScanned(path, refused, add);
  if (!learnedName(place.kind, place.name)) return add("file_name", place.kind === "skill" ? "a skill's name is lowercase letters, digits and single dashes, at most 64" : "a workflow's name is lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or digit", path);
  if (change.status === "deleted") return add("deleted", "a run never deletes a skill or a workflow", path);
  if (change.mode !== undefined && change.mode !== "100644") return add("file_mode", MODES[change.mode] ?? "not a regular file: never read", path);
  const size = change.size ?? change.bytes?.length ?? 0;
  const cap = place.kind === "readme" ? CAPS.readme : CAPS.file;
  if (size > cap) return add("too_large", `${size} bytes; the cap is ${cap}`, path);
  // A person's call stands: a skill or a draft whose seed text has a status (retired, or waiting for its owner's OK).
  const readmeOf = `${path.slice(0, path.lastIndexOf("/"))}/README.md`;
  if (input.kept?.includes(path) || (place.kind === "workflow" && input.kept?.includes(readmeOf))) return add("skill_status", "a person retired it, or it waits for its owner's OK: a run never changes it", path);
  const text = textOf(path, change.bytes, refused, add);
  if (text === undefined) return;
  if (place.kind === "workflow") {
    if (!input.dsl) throw new TypeError(`${path}: a workflow draft is read with the workflow DSL, which was not given`);
    for (const { rule, detail } of draftProblems(input.dsl, text, input.tools, input.gated, input.deniedBy)) add(rule, detail, path);
    return;
  }
  for (const reason of skillProblems(text, place.name)) add(place.kind === "skill" ? "skill" : "workflow", reason, path);
  // Its front matter says what it is and nothing more: Claude Code reads directives (a hook is a shell command) from any
  // other key. `status` has its own rule.
  const extra = (frontKeys(text) ?? []).filter((key) => !LEARNED_KEYS.includes(key) && key !== "status");
  if (extra.length) add("skill_front_matter", `its front matter sets ${extra.join(", ")}: a learned ${place.kind === "skill" ? "skill" : "workflow"} sets name and description alone`, path);
  if (place.kind === "skill" && setsStatus(text)) add("status", "a run never sets a skill's status: the host does, when it holds one for its owner's OK", path);
}

/** The checks one note's file passes by itself (SPEC.md), as a person writes it through the host: its name, the note cap,
 *  UTF-8, hidden characters, secret shapes and the host's values in its name and text, and its front matter. A person
 *  may set `status` and `superseded_by`; what a run may not do (edit, delete, set status) is checkProposal's. Every
 *  problem is printable. */
export function checkNote(path: string, bytes: Uint8Array, refuseValues: readonly string[] = []): { problems: Problem[]; note?: ProposedNote } {
  const problems: Problem[] = [];
  const add: Add = (rule, detail, at) => void problems.push(printable(at === undefined ? { rule, detail } : { rule, path: at, detail }, refuseValues));
  const refused = valueMatcher(refuseValues);
  const note = nameChecked(path, refused, add) ? textChecked(path, bytes.length, bytes, refused, add) : undefined;
  return problems.length || !note ? { problems } : { problems, note };
}

/** Checks what a run proposes against SPEC.md: its notes, and a skill or workflow drafts beside them (learnedChecked).
 *  `MEMORY.md` is the host's: a change to it is ignored, never refused. */
/** What must never be stored, in every change's name and text, whatever the checks would refuse it for first: the
 *  name and text scans (nameScanned, textOf) of each change, its text read whole (an edit, a file over its cap, one not
 *  a regular file included), printable as checkProposal's are. A text that is not UTF-8 is `encoding`: unread, so
 *  never trusted. Empty when nothing in them must be refused. Ahead of keeping some items of a proposal the checks
 *  refuse (propose.ts): an item refused before its text was read hides nothing. */
export function unstorable(changes: readonly Change[], refuseValues: readonly string[] = []): Problem[] {
  const problems: Problem[] = [];
  const add: Add = (rule, detail, path) => void problems.push(printable(path === undefined ? { rule, detail } : { rule, path, detail }, refuseValues));
  const refused = valueMatcher(refuseValues);
  for (const change of changes) {
    if (change.path === INDEX_FILE) continue;
    nameScanned(change.path, refused, add);
    if (change.bytes) textOf(change.path, change.bytes, refused, add);
  }
  return problems;
}

export function checkProposal(input: CheckInput): ProposalCheck {
  const values = input.refuseValues ?? [];
  const problems: Problem[] = [];
  const add: Add = (rule, detail, path) => void problems.push(printable(path === undefined ? { rule, detail } : { rule, path, detail }, values));
  const changes = input.changes.filter((change) => change.path !== INDEX_FILE);
  if (changes.length > CAPS.changes) {
    add("too_many_files", `${changes.length} changed paths; the cap is ${CAPS.changes} a run, and nothing else was read`);
    return { ok: false, problems, notes: [] };
  }
  const refused = valueMatcher(values);
  const base = new Set(input.base.files);
  const notes: ProposedNote[] = [];
  // Each rule held, by the file that holds it: the seed's active notes', then each new note's as it passes. A new note
  // of a rule held already is a duplicate, whatever its name; of two new notes the same, the first is kept.
  const rules = new Map(input.base.rules ?? []);
  const skills: string[] = [];
  const workflows = new Set<string>();
  let added = 0;
  const one = (change: Change): void => {
    const { path } = change;
    const place = learnedPlace(path);
    if (place) {
      // What the run writes, under a good name, is counted: a skill against the run's, a draft's file against its pair.
      if (change.status !== "deleted" && learnedName(place.kind, place.name)) {
        if (place.kind === "skill") skills.push(path);
        else workflows.add(place.name);
      }
      return learnedChecked(change, place, refused, input, add);
    }
    if (change.status === "added") added += 1;
    if (!nameChecked(path, refused, add, OUTSIDE)) return;
    if (change.status === "deleted") return add("deleted", "a run never deletes a note", path);
    if (change.mode !== undefined && change.mode !== "100644") return add("file_mode", MODES[change.mode] ?? "not a regular file: never read", path);
    if (change.status === "modified") return add("edited", "a run never edits a note: to replace one, it adds a new note that supersedes it", path);
    if (base.has(path)) return add("exists", "the folder has a note by this name", path);
    const note = textChecked(path, change.size ?? change.bytes?.length ?? 0, change.bytes, refused, add, true);
    if (!note) return;
    if (note.keys.includes("status") || note.keys.includes("superseded_by") || note.keys.includes("origin")) return add("status", "a run never sets status, superseded_by or origin: the host does, when it merges the note or a later one supersedes it", path);
    const rule = ruleOf(note.body);
    const holder = rules.get(rule);
    // One that supersedes the note it repeats updates it (its name or description, say): no duplicate.
    if (holder !== undefined && !note.supersedes.includes(holder)) return add("duplicate", `it says what ${holder} says`, path);
    rules.set(rule, path);
    notes.push(note);
  };
  for (const change of changes) one(change);
  if (added > CAPS.newNotes) add("too_many_notes", `${added} new notes; the cap is ${CAPS.newNotes} a run`);
  if (skills.length > CAPS.skills) add("too_many_skills", `${skills.length} skills added or changed; a run adds or changes at most ${CAPS.skills}`);
  if (workflows.size > CAPS.workflows) add("too_many_workflows", `${workflows.size} workflow drafts added or changed; a run adds or changes at most ${CAPS.workflows}`);
  // A skill is what every later run reads as how to do the job: only a run that did it writes one.
  if (input.outcome !== "completed") for (const path of skills) add("skill_outcome", `the run's outcome is ${input.outcome ?? "not known"}: only a completed run adds or changes a skill`, path);
  // A draft is its workflow.json and its README.md, together, as the folder will hold them.
  const gone = new Set(changes.filter((change) => change.status === "deleted").map((change) => change.path));
  const after = new Set([...base, ...changes.filter((change) => change.status !== "deleted").map((change) => change.path)].filter((path) => !gone.has(path)));
  for (const name of workflows) {
    const [json, readme] = ["workflow.json", "README.md"].map((file) => `${WORKFLOWS_DIR}/${name}/${file}`) as [string, string];
    if (after.has(json) !== after.has(readme)) add("workflow", `the folder holds ${after.has(json) ? "workflow.json" : "README.md"} without the other file`, after.has(json) ? readme : json);
  }
  if (!problems.length) problems.push(...mergeProblems(input.base, notes, values));
  return { ok: problems.length === 0, problems, notes: problems.length ? [] : notes };
}

/** The notes the active ones of `notes` supersede, each by the note that supersedes it. A note that waits for its
 *  owner's OK (`status: pending`) supersedes nothing until it is approved: what it names stays active. The one rule the
 *  merge writes by (runner/learning-loop.ts mergeChangeOf) and its index is counted by (mergeProblems). */
export function supersededBy(notes: readonly LearnedNote[]): Map<string, string> {
  return new Map(notes.filter((note) => note.status === "active").flatMap((note) => note.supersedes.map((old) => [old, note.file] as const)));
}

/** What stops `notes` from joining `base` as they are: a name `base` holds (`exists`), a `supersedes` that names no
 *  active note of `base` or one another new note supersedes too, or more than CAPS.supersedes notes superseded, and an
 *  index past INDEX_LINES, counted as the merge makes it (supersededBy: a pending note adds no line and replaces none).
 *  The checker asks it of the run's seed, where every new note is active; the host asks it again of main at merge time,
 *  with each note as it merges it, since other runs may have merged meanwhile. */
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
  const gone = supersededBy(notes);
  const lines = [...active].filter((file) => !gone.has(file)).length + notes.filter((note) => note.status === "active").length;
  if (lines > INDEX_LINES) out.push({ rule: "index_full", detail: `the index would hold ${lines} lines; it holds at most ${INDEX_LINES}, so supersede a note rather than add one` });
  return out.map((problem) => printable(problem, refuseValues));
}
