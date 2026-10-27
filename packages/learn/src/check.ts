import { draftProblems, parseIndex, parseMemo, parseNote, skillProblems, type Memo } from "./formats.js";
import { CAPS, isGitFile, isHostOwned, isLocked, LAYOUT, placeOf, RUN_ID, type Kind } from "./layout.js";
import { hiddenCharacter } from "./invisible.js";
import { secretShapes, valueMatcher } from "./secrets.js";

/** The rule a problem breaks. SPEC.md lists each. */
export type Rule =
  | "branch" | "too_many_files" | "locked" | "git_file" | "file_mode" | "host_owned" | "uses" | "outside_layout" | "deleted" | "too_large"
  | "too_many_notes" | "encoding" | "lfs_pointer" | "invisible_unicode" | "secret_shape" | "secret_value" | "memo_missing"
  | "memo" | "memo_run" | "memo_base" | "memo_unlisted" | "other_memo" | "note" | "note_run" | "index" | "index_note" | "skill"
  | "workflow" | "no_tool_list" | "executable_node";

/** One problem with a run's branch. `detail` never repeats a value that was refused. */
export type Problem = { readonly rule: Rule; readonly path?: string; readonly detail: string };

/** One file a run's branch changed, against the commit it starts from. `mode` is git's (`100644` for a regular file).
 *  `bytes` is the file at the branch's head; a change that is not a deletion carries it, unless `size` is over the
 *  file's cap or the path is locked or outside the layout. */
export type Change = {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly mode?: string;
  readonly size?: number;
  readonly bytes?: Uint8Array;
};

export type CheckInput = {
  /** The branch the run pushes, `runs/<run id>`. */
  readonly branch: string;
  readonly changes: readonly Change[];
  /** The commit the branch starts from on main. */
  readonly forkPoint?: string;
  /** The commit the host started the run from, when it says so; the memo's `base` is it or a prefix of it. Else the fork
   *  point. */
  readonly runBase?: string;
  /** Every path at the branch's head. Without it, index lines and workflow folders are not checked against the tree. */
  readonly headFiles?: Iterable<string>;
  /** The host's tool list, passed to the DSL's `validateWorkflow`. Without it, a draft that names a tool is refused. */
  readonly tools?: readonly string[];
  /** Values the host holds as secrets; a file that holds one is refused. */
  readonly refuseValues?: readonly string[];
  /** Paths the host locks beyond SPEC.md's, such as its hooks folder or its tool list's file. */
  readonly lockedPaths?: readonly string[];
};

/** `ok` when `problems` is empty: the branch may go on to the injection screen and the review. */
export type RunCheck = { readonly ok: boolean; readonly problems: Problem[] };

const CAP: Record<Kind, number> = { note: CAPS.note, index: CAPS.index, memo: CAPS.memo, skill: CAPS.file, workflow: CAPS.file, readme: CAPS.file, uses: CAPS.file };
const NEVER_DELETED: readonly Kind[] = ["note", "index", "memo", "uses"];
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
const MODES: Record<string, string> = { "120000": "a symlink", "160000": "a gitlink (submodule)", "100755": "an executable file" };

/** The run id of a `runs/<run id>` branch. */
export const runOf = (branch: string): string | undefined => (branch.startsWith("runs/") && RUN_ID.test(branch.slice(5)) ? branch.slice(5) : undefined);

/** Checks a run's branch against SPEC.md: structure only, never whether a note is any good. */
export function checkRun(input: CheckInput): RunCheck {
  const problems: Problem[] = [];
  const add = (rule: Rule, detail: string, path?: string): void => {
    problems.push(path === undefined ? { rule, detail } : { rule, path, detail });
  };
  const run = runOf(input.branch);
  if (!run) add("branch", input.branch === "" ? "no branch was named: give the branch the run pushes to" : `${JSON.stringify(input.branch)} is not runs/<run id>`);
  if (input.changes.length > CAPS.changes) {
    add("too_many_files", `${input.changes.length} changed paths; the cap is ${CAPS.changes} a run, and nothing else was read`);
    return { ok: problems.length === 0, problems };
  }
  const refused = valueMatcher(input.refuseValues ?? []);
  const head = input.headFiles === undefined ? undefined : new Set(input.headFiles);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const flagged = new Set<string>();
  const workflowDirs = new Set<string>();
  let memoChanged = false;
  let memo: Memo | undefined;
  let newNotes = 0;

  const one = (change: Change): void => {
    const { path } = change;
    if (isLocked(path, input.lockedPaths)) return add("locked", "a run never touches this path", path);
    if (isGitFile(path)) return add("git_file", "git attributes and submodules are never part of a run", path);
    if (change.status !== "deleted" && change.mode !== undefined && change.mode !== "100644") return add("file_mode", `${MODES[change.mode] ?? `git mode ${change.mode}`}: only a regular, non-executable file`, path);
    if (isHostOwned(path)) return add("host_owned", "a workflow's records, latest and trial.json are the host's, on main", path);
    const place = placeOf(path);
    if (!place) return add("outside_layout", "the layout does not hold this path", path);
    if (place.kind === "uses" && run !== undefined && place.id !== run) return add("uses", "a run carries only its own uses file", path);
    const ownMemo = place.kind === "memo" && (run === undefined || place.id === run);
    if (place.kind === "memo" && !ownMemo) add("other_memo", "a run changes only its own memo", path);
    if (place.kind === "workflow" || place.kind === "readme") workflowDirs.add(place.name!);
    if (change.status === "deleted") {
      if (NEVER_DELETED.includes(place.kind)) add("deleted", `a run never deletes a ${place.kind}`, path);
      return;
    }
    if (place.kind === "memo" && !ownMemo) return;
    if (ownMemo) memoChanged = true;
    if (place.kind === "note" && change.status === "added") newNotes += 1;
    const size = change.size ?? change.bytes?.length;
    if (size !== undefined && size > CAP[place.kind]) return add("too_large", `${size} bytes; the cap is ${CAP[place.kind]}`, path);
    if (!change.bytes) throw new TypeError(`${path}: a change that is not a deletion carries its bytes`);
    let text: string;
    try {
      text = decoder.decode(change.bytes);
    } catch {
      return add("encoding", "it is not UTF-8", path);
    }
    if (LFS_POINTER.test(text)) return add("lfs_pointer", "a Git LFS pointer, not the file", path);
    const hidden = hiddenCharacter(text);
    if (hidden) add("invisible_unicode", `it holds U+${hidden.code.toString(16).toUpperCase().padStart(4, "0")}, a character a reader does not see, at character ${hidden.at}`, path);
    const shapes = secretShapes(text);
    for (const kind of shapes) add("secret_shape", `it holds text shaped like a secret (${kind})`, path);
    const valued = refused(text);
    if (valued) add("secret_value", "it holds a value the host named as secret", path);
    if (hidden || shapes.length || valued) return;
    switch (place.kind) {
      case "note": {
        const note = parseNote(text);
        if (Array.isArray(note)) return note.forEach((reason) => add("note", reason, path));
        if (note.id !== place.id) return add("note", `its id ${note.id} is not its file name`, path);
        if (change.status === "added" && run !== undefined && !note.runs.includes(run)) add("note_run", `a new note names this run, ${run}, in its runs`, path);
        return;
      }
      case "index": {
        const ids = parseIndex(text);
        if (!Array.isArray(ids)) return ids.problems.forEach((reason) => add("index", reason, path));
        if (head) for (const id of ids) if (!head.has(`${LAYOUT.learnings}/${id}.md`)) add("index_note", `it names ${id}, which is not a note on the branch`, path);
        return;
      }
      case "skill":
        return skillProblems(text, place.name!).forEach((reason) => add("skill", reason, path));
      case "workflow":
        return draftProblems(text, input.tools).forEach(({ rule, detail }) => add(rule, detail, path));
      case "readme":
        if (text.trim() === "") add("workflow", "the README is empty", path);
        return;
      case "uses":
        try {
          JSON.parse(text);
        } catch {
          add("uses", "it does not parse as JSON", path);
        }
        return;
      case "memo": {
        const parsed = parseMemo(text);
        if (Array.isArray(parsed)) return parsed.forEach((reason) => add("memo", reason, path));
        memo = parsed;
        return;
      }
    }
  };

  for (const change of input.changes) {
    const before = problems.length;
    one(change);
    if (problems.length > before) flagged.add(change.path);
  }

  if (newNotes > CAPS.newNotes) add("too_many_notes", `${newNotes} new notes; the cap is ${CAPS.newNotes} a run`);
  if (head) {
    for (const name of workflowDirs) {
      const files = ["workflow.json", "README.md"].map((file) => `${LAYOUT.workflows}/${name}/${file}`);
      const present = files.filter((file) => head.has(file));
      if (present.length === 1) add("workflow", `the folder holds ${present[0]!.split("/").pop()} without the other file`, files.find((file) => !head.has(file))!);
    }
  }
  if (run !== undefined) {
    const memoPath = `${LAYOUT.memos}/${run}.md`;
    if (!memoChanged) add("memo_missing", "the branch carries no memo of its own", memoPath);
    if (memo) {
      if (memo.run !== run) add("memo_run", `its run is not the branch's, ${run}`, memoPath);
      const base = input.runBase ?? input.forkPoint;
      if (base !== undefined && !base.startsWith(memo.base)) add("memo_base", `its base is not the commit the run started from, ${base}`, memoPath);
      for (const { path } of input.changes) {
        if (path === memoPath || path === LAYOUT.index || path === `${LAYOUT.uses}/${run}.json` || flagged.has(path)) continue;
        if (!memo.proposed.some((named) => named === path || (named.endsWith("/") && path.startsWith(named)))) add("memo_unlisted", "the memo's Proposed changes does not name it", path);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
