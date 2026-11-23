// learningCommit: the writes on an agent's learning folder. Every call is ONE exec of the learning script on the folder's
// main (learn/folder.ts commitChange, one hold), computed from the folder's snapshot and the bodies it names. A main
// that moved under it (the script's exit 3) is computed again on the main that won. A folder with no main yet is made
// in the same call (the script's init first). Four writes:
//   - a run's compiled workflow draft (learningCommit), already checked, its files whole; a file that is not on main as
//     it was on the run's seed (or its `bases` commit) is a conflict, never written over;
//   - one line of an owner's feedback appended to corrections.md (appendCorrection), after the refusals;
//   - corrections.md replaced whole by a person (putCorrections), under the ETag they read;
//   - a purged run's learned workflows put back as they were before it (off main when it wrote them new) and its feedback
//     lines taken off main, by the host (forgetRunText).
import { isWorkspaceError, type Workspace } from "../workspace/index.js";
import type { Problem } from "./check.js";
import { CORRECTIONS_CAP, CORRECTIONS_FILE, correctionLine, correctionsProblems } from "./corrections.js";
import { blobOid, DIFFS_DIR, folderAt, type FolderChange, folderFailure, FolderMerged, folderPaused, FolderRefused, FolderTooLarge, FolderUnreadable, forgetBody, learningRepair, readLearning, readRunDiff, readSnapshot, type RunDiff, runDiffKey, runMergeOf, type Snapshot, writeLearning } from "./folder.js";
import { held, isHeld } from "./workflow-draft.js";
import { said } from "../learning-words.js";

/** A run's merge, one a round: its compiled draft's files, already checked, and its owner's correction. */
export type LearningChange = {
  /** The run that learned: the commit's Run-Id trailer and, with `round`, the diff file's name (runDiffKey). */
  runId: string;
  /** Which of the run's merges this is (absent: its first): a follow-up's later round merges once of its own. */
  round?: number;
  /** Why: the commit's message and the log's `reason`. */
  reason: string;
  /** What merges: a draft's files, each whole. */
  files: { path: string; text: string }[];
  /** One line of its owner's feedback appended to corrections.md (its whitespace folded: correctionLine), refused as
   *  appendCorrection refuses one: what must never be stored (`refuseValues`), or the file past CORRECTIONS_CAP. */
  correction?: string;
  refuseValues?: readonly string[];
  /** Paths written with `status: pending` (waiting for the owner's OK): a draft's README.md. */
  held?: string[];
  /** The commit the run started from: a file that is not on main as it was on it (a person retired or approved it,
   *  another run's merge changed it) is a conflict. The script checks it on main as it commits. */
  seed?: string;
  /** A commit the folder must still hold for the merge to land, its correction alone included (which no `same` covers):
   *  the run's seed, when this folder held it as the run's end began (runner/learning-end.ts). A reset of the agent's
   *  learning since removed it, so the whole merge is a conflict that says so. Absent when the run's seed was read from
   *  another folder than this one (a Mode 2 run's end writes the folder on its disk). */
  mustHold?: string;
  /** A file checked against another commit than `seed`, by its path: a workflow the run's compile turn revised from
   *  main's text, against the commit it read that text at. */
  bases?: Readonly<Record<string, string>>;
};

export type LearningCommitResult =
  /** `refusedCorrection`: the correction the merge left out beside its draft, corrections.md at its cap on main by then
   *  (another write filled it after the run's check), in the cap's words. */
  | { ok: true; main: string; commit: string; files: string[]; already?: true; refusedCorrection?: Problem[] }
  | { ok: false; reason: "conflict"; problems: Problem[] }
  | { ok: false; reason: "refused"; problems: Problem[] }
  /** `paused`: the folder's backend can't answer or its script timed out (folder.ts folderPaused), in learning's words
   *  (learning-words.ts said.paused): learning pauses. */
  | { ok: false; reason: "unavailable"; error: string; paused?: string };

/** The blob `path` is on the snapshot's main: corrections.md or a draft's file. */
function blobOf(snapshot: Snapshot | undefined, path: string): string | undefined {
  if (!snapshot) return undefined;
  if (path === CORRECTIONS_FILE) return snapshot.corrections?.oid;
  for (const item of snapshot.workflows) {
    const file = item.files.find((one) => one.path === path);
    if (file) return file.oid;
  }
  return undefined;
}

type Computed = LearningCommitResult | { pending: true; refusedCorrection?: Problem[] } | { merged: RunDiff };

/** A write's failure as a result: the script's precondition (a file changed since the seed: a conflict), a write past
 *  what one exec carries, or the folder unavailable (retry later). */
function failure(error: unknown): LearningCommitResult {
  if (error instanceof FolderRefused && error.seed !== undefined) return { ok: false, reason: "conflict", problems: [{ rule: "kept", detail: "the agent's learning was reset after the run started, so what it learned has nothing to land on" }] };
  if (error instanceof FolderRefused) return { ok: false, reason: "conflict", problems: [...error.same, ...error.absent].map((path): Problem => ({ rule: "kept", path, detail: `${path} changed on main after the run started` })) };
  if (error instanceof FolderTooLarge) return { ok: false, reason: "refused", problems: [{ rule: "too_large", detail: error.message }] };
  return { ok: false, reason: "unavailable", error: (error as Error)?.message ?? String(error), ...(folderPaused(error) ? { paused: said.paused(error.why, error.timedOut) } : {}) };
}

/** What a write landed, from writeLearning's answer: its new main and the paths it changed. */
const landed = (done: { result: Exclude<Computed, { merged: RunDiff }>; main?: string; snapshot?: Snapshot }): LearningCommitResult =>
  "pending" in done.result
    ? { ok: true, main: done.main!, commit: done.main!, files: done.snapshot?.log[0]?.commit === done.main ? done.snapshot!.log[0]!.files : [], ...(done.result.refusedCorrection ? { refusedCorrection: done.result.refusedCorrection } : {}) }
    : done.result;

/**
 * A run's merge on the folder's main, one exec of the learning script: its files (a held README with `status: pending`)
 * and its owner's correction appended to corrections.md. `ok` with the new main and the paths the commit changed;
 * `conflict` when a file is not on main as it was on the run's seed; `refused` when the correction holds what must never
 * be stored, or, with no draft beside it, would take corrections.md past its cap (nothing written); `unavailable` when
 * the workspace or the exec failed. The draft and the correction are judged apart: a correction past the cap beside a
 * draft (the file filled by another write after the run's check, correctionRefused) is left out alone, and the draft
 * merges, `ok` with the cap's refusal as `refusedCorrection`. A merge whose run already merged here (this round) is `ok`
 * with the commit that holds it, and writes nothing: checked before the write, again on each main it is computed on, and
 * by the script in the commit's own ref transaction, so two calls racing for one round (a reclaimed run) merge it once.
 */
export async function learningCommit(ws: Workspace, change: LearningChange, opts: { retries?: number } = {}): Promise<LearningCommitResult> {
  const key = runDiffKey(change.runId, change.round);
  try {
    const known = await runMergeOf(ws, change.runId, change.round);
    if (known) return await already(ws, change, known.merge, known);
    const line = change.correction === undefined ? undefined : correctionLine(change.correction);
    // The line alone first: what it holds is refused whatever the file around it holds.
    const own = line === undefined ? [] : correctionProblems(line, change.refuseValues);
    if (own.length) return { ok: false, reason: "refused", problems: own };
    const marked = new Set(change.held ?? []);
    const drafts = change.files.map(({ path, text }) => ({ path, text: marked.has(path) && !isHeld(text) ? held(text) : text }));
    const same = change.files.flatMap(({ path }) => {
      const commit = change.bases?.[path] ?? change.seed;
      return commit ? [{ commit, path }] : [];
    });
    const done = await writeLearning<Computed>(ws, async ({ snapshot, body }) => {
      // Read again on each main the write is computed on: a call that merged this round since the check above (a
      // reclaimed run's two claims racing) wrote its diff before the snapshot this call read.
      const merged = await readRunDiff(ws, key);
      if (merged) return { result: { merged } };
      const writes = [...drafts];
      let refusedCorrection: Problem[] | undefined;
      if (line !== undefined) {
        const text = appended(await correctionsOf(snapshot, body), line);
        const full = capProblem(text);
        if (full && !drafts.length) return { result: { ok: false, reason: "refused", problems: [full] } };
        if (full) refusedCorrection = [full];
        else writes.push({ path: CORRECTIONS_FILE, text });
      }
      // `mustHold`: the script refuses the whole merge when the folder no longer holds it (a reset removed it).
      return { result: { pending: true, ...(refusedCorrection ? { refusedCorrection } : {}) }, change: { by: run(change.runId, change.reason, change.round), writes, ...(same.length ? { same } : {}), ...(change.mustHold ? { seed: change.mustHold } : {}) } };
    }, opts.retries ?? 3);
    const { result } = done;
    return "merged" in result ? await already(ws, change, result.merged.merge, result.merged) : landed({ ...done, result });
  } catch (error) {
    // The round merged under this call past both reads (its diff not written yet): the script's ref transaction let
    // one merge of it land, and this call reads that one.
    if (error instanceof FolderMerged) return already(ws, change, error.merge, await readRunDiff(ws, key).catch(() => undefined)).catch(failure);
    return failure(error);
  }
}

/** A round that merged already, `merge` its commit: `ok` with it and the paths its diff names (none when its diff is
 *  not written yet), nothing written again. Its merge left the correction out only at the cap. */
async function already(ws: Workspace, change: LearningChange, merge: string, known: RunDiff | undefined): Promise<LearningCommitResult> {
  const left = known !== undefined && change.correction !== undefined && !known.files.some((file) => file.path === CORRECTIONS_FILE);
  const refusedCorrection: Problem[] = left ? [{ rule: "too_large", path: CORRECTIONS_FILE, detail: `${CORRECTIONS_FILE} was at its cap of ${CORRECTIONS_CAP} bytes when the run's merge was written` }] : [];
  return { ok: true, main: (await readSnapshot(ws))?.main ?? merge, commit: merge, files: known ? known.files.map((file) => file.path) : [], already: true, ...(refusedCorrection.length ? { refusedCorrection } : {}) };
}

const run = (runId: string, reason: string, round?: number): FolderChange["by"] => ({ run: runId, reason, ...(round !== undefined && round > 1 ? { round } : {}) });

/** corrections.md's text as main holds it now ("" when it holds none). */
const correctionsOf = async (snapshot: Snapshot | undefined, body: (path: string, oid: string) => Promise<string>): Promise<string> =>
  snapshot?.corrections ? body(CORRECTIONS_FILE, snapshot.corrections.oid) : "";
/** corrections.md's text `before` with `line` appended on a line of its own. */
const appended = (before: string, line: string): string => `${before}${before && !before.endsWith("\n") ? "\n" : ""}${line}`;
/** What a correction's line holds that must never be stored, whatever the file around it holds. */
const correctionProblems = (line: string, refuseValues?: readonly string[]): Problem[] => correctionsProblems(line, refuseValues).filter((problem) => problem.rule !== "too_large");
/** The cap's refusal of corrections.md as `text`, in its words; none within the cap. */
const capProblem = (text: string): Problem | undefined => {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > CORRECTIONS_CAP ? { rule: "too_large", path: CORRECTIONS_FILE, detail: `${CORRECTIONS_FILE} would hold ${bytes} bytes; the cap is ${CORRECTIONS_CAP} bytes` } : undefined;
};

/** Why run `runId`'s correction (`text`) would be refused on main as it is now: its line's own problems, else the cap's;
 *  empty when it would be taken. Read before the run's merge, so a refused correction never holds its draft back. A
 *  round (`merge`) whose merge is on main already (a stop after its commit, before the run's end was saved) is never
 *  checked for room again, its own line counted twice: empty, and its merge (learningCommit) gives back what it did. */
export async function correctionRefused(ws: Workspace, text: string, refuseValues?: readonly string[], merge?: { runId: string; round?: number }): Promise<Problem[]> {
  const line = correctionLine(text);
  const own = correctionProblems(line, refuseValues);
  if (own.length) return own;
  if (merge && (await runMergeOf(ws, merge.runId, merge.round))) return [];
  const before = await readLearning(ws, ({ snapshot, body }) => correctionsOf(snapshot, body));
  const full = capProblem(appended(before, line));
  return full ? [full] : [];
}

/** One line of an owner's feedback appended to corrections.md on main, by run `runId`'s merge (learningCommit's
 *  `correction`, with no draft beside it). */
export const appendCorrection = (ws: Workspace, input: { runId: string; round?: number; text: string; refuseValues?: readonly string[] }): Promise<LearningCommitResult> =>
  learningCommit(ws, { runId: input.runId, ...(input.round !== undefined ? { round: input.round } : {}), reason: "the owner's correction", files: [], correction: input.text, ...(input.refuseValues ? { refuseValues: input.refuseValues } : {}) });

/** corrections.md as a person reads it: its text and its ETag's blob (an empty file's when main holds none). */
export async function readCorrections(snapshot: Snapshot | undefined, body: (path: string, oid: string) => Promise<string>): Promise<{ text: string; oid: string }> {
  const text = await correctionsOf(snapshot, body);
  return { text, oid: snapshot?.corrections?.oid ?? blobOid("") };
}

/**
 * corrections.md replaced whole by a person: `ifMatch`, the blob they read (an ETag, quoted or not; an empty file's when
 * main held none), must be main's now, else a conflict. Refused, nothing written, as appendCorrection refuses. `ok` with
 * the new text and its blob.
 */
export async function putCorrections(ws: Workspace, input: { text: string; ifMatch: string; refuseValues?: readonly string[] }): Promise<{ ok: true; text: string; oid: string } | { ok: false; reason: "conflict" | "refused"; problems: Problem[] }> {
  const problems = correctionsProblems(input.text, input.refuseValues);
  if (problems.length) return { ok: false, reason: "refused", problems };
  const seen = input.ifMatch.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const { result } = await writeLearning<{ ok: true; text: string; oid: string } | { ok: false; reason: "conflict"; problems: Problem[] }>(ws, async ({ snapshot }) => {
    const now = snapshot?.corrections?.oid ?? blobOid("");
    if (now !== seen) return { result: { ok: false, reason: "conflict", problems: [{ rule: "kept", path: CORRECTIONS_FILE, detail: `${CORRECTIONS_FILE} changed since it was read` }] } };
    return { result: { ok: true, text: input.text, oid: blobOid(input.text) }, change: { by: { person: "edited", file: CORRECTIONS_FILE }, writes: [{ path: CORRECTIONS_FILE, text: input.text }] } };
  });
  return result;
}

/**
 * Run `runId`'s text taken off the folder's current files, at its purge (agent-delete.ts purgeRun): first its learned
 * workflows (forgetRunWorkflows; `purged`: whether another run is purged), whether or not it left a diff file; then the
 * lines each of its merges added to corrections.md, as its diff file keeps them, dropped from main in one host commit
 * per merge (a line a person edited since is theirs and stays); each other merge's diff that shows such a line as
 * context written without it; then the run's diff files deleted, last, so a call stopped part way finds what it has
 * left to do. Its merges stay in the folder's git history until a learning reset or its agent's purge deletes the
 * folder. Idempotent: each merge's scrub lands once, nothing left to drop makes no commit, and a run with no diff file
 * and no workflow here is no work.
 * `commit`: the host's last commit, when one was made.
 */
export async function forgetRunText(ws: Workspace, runId: string, purged: (run: string) => Promise<boolean>): Promise<{ commit?: string }> {
  let commit = await forgetRunWorkflows(ws, runId, async (run) => run === runId || (await purged(run)));
  const names = await diffNames(ws);
  const own = new RegExp(`^${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.r\\d+)?\\.json(\\..+)?$`);
  const mine = names.filter((name) => own.test(name));
  if (!mine.length) return commit ? { commit } : {};
  const lines: string[] = [];
  for (const name of mine.filter(isDiffFile)) {
    const added = ((await diffOrNone(ws, name))?.files ?? []).flatMap((file) => (file.path === CORRECTIONS_FILE && "patch" in file ? addedLines(file.patch) : []));
    if (!added.length) continue;
    lines.push(...added);
    // Lands once, by the merge's diff key (the folder's ref for its scrub): a call that stopped after it finds it landed
    // and takes no line again, so another run's same line stays; a merge of the run made since (a purge that stopped
    // before the run's tombstone left it open to a grade) is a key of its own, scrubbed in its turn.
    const done = await writeLearning<string | undefined>(ws, async ({ snapshot, body }) => {
      if (!snapshot?.corrections) return { result: undefined };
      const before = await body(CORRECTIONS_FILE, snapshot.corrections.oid);
      const after = withoutLines(before, added);
      if (after === before) return { result: undefined };
      const write = after ? { writes: [{ path: CORRECTIONS_FILE, text: after }] } : { writes: [], deletes: [CORRECTIONS_FILE] };
      return { result: snapshot.corrections.oid, change: { by: { host: "a purged run's corrections removed" }, purged: name.slice(0, -".json".length), ...write } };
    }).catch((error: unknown) => (error instanceof FolderMerged ? { result: undefined, main: undefined } : Promise.reject(error)));
    if (done.result !== undefined) {
      forgetBody(done.result);
      commit = done.main;
    }
  }
  if (lines.length) {
    const gone = new Set(lines);
    for (const name of names.filter((one) => isDiffFile(one) && !own.test(one))) {
      const diff = await diffOrNone(ws, name);
      if (!diff) continue;
      let changed = false;
      const files = diff.files.map((file) => {
        if (file.path !== CORRECTIONS_FILE || !("patch" in file)) return file;
        const patch = withoutContext(file.patch, gone);
        if (patch === file.patch) return file;
        changed = true;
        return { ...file, patch };
      });
      if (!changed) continue;
      await ws.write(`${DIFFS_DIR}/${name}`, `${JSON.stringify({ ...diff, files })}\n`).catch((error: unknown) => { throw folderFailure(error); });
    }
  }
  for (const name of mine) await ws.remove(`${DIFFS_DIR}/${name}`, { force: true }).catch((error: unknown) => { throw folderFailure(error); });
  return commit ? { commit } : {};
}

/** Each learned workflow on main whose workflow.json run `runId` wrote last (SnapLearned.run, the rule purged-workflow.ts
 *  reads) put back in one host commit as it stood at the newest commit where its writer was no purged run (`purged`,
 *  `runId` among them), every file of its `workflows/<name>/` folder, its writer that run again (the commit's
 *  `Written-By` line: folder.ts writerOf); taken off main whole when the purged runs wrote every version of it. So a
 *  purge takes off main only what purged runs put there, and a version another run wrote, a champion included, stays
 *  served. The commit, or undefined when main holds none of the run's (a repeat finds its own put back, and one another
 *  run wrote since names that run). The snapshot is rebuilt from main first (two execs and a checkout): a merge that
 *  moved main and stopped before its snapshot leaves one that names none of that merge's workflows, and finding no work
 *  commits nothing that would show it stale. One more read-only exec of main's history when the run wrote one, and one
 *  per version put back; either read finding nothing refuses (FolderUnreadable), so no guess takes a folder off. */
async function forgetRunWorkflows(ws: Workspace, runId: string, purged: (run: string) => Promise<boolean>): Promise<string | undefined> {
  if (await readSnapshot(ws)) await learningRepair(ws);
  const done = await writeLearning<boolean>(ws, async ({ snapshot }) => {
    const mine = (snapshot?.workflows ?? []).filter((item) => item.run === runId);
    if (!mine.length) return { result: false };
    // No history read, no guess: a purge that can't tell what came before the run's version refuses (503, sent again
    // later), and never takes the whole folder off main.
    const unread = () => new FolderUnreadable(false, "the learning folder's history at main can't be read, so a purge puts nothing back and takes nothing off: send the DELETE again");
    const history = await folderAt(ws, snapshot!.main);
    if (!history) throw unread();
    const writes: { path: string; text: string }[] = [];
    const deletes: string[] = [];
    const written: Record<string, string | null> = {};
    for (const item of mine) {
      // Newest first: the first writer no purged run is the version to put back, as it stood just before the next
      // writer took the file over.
      const writers = history.writers(item.name);
      let back: { path: string; text: string }[] = [];
      for (let i = 1; i < writers.length; i++) {
        const { run } = writers[i]!;
        if (run !== null && (await purged(run))) continue;
        const before = writers[i - 1]!.before;
        const at = before ? await folderAt(ws, before) : undefined;
        if (!at) throw unread();
        const files = at.snapshot.workflows.find((one) => one.name === item.name)?.files ?? [];
        back = files.map(({ path, oid }) => ({ path, text: at.blobs.get(oid)!.toString("utf8") }));
        // Named even when `back` is main's bytes already, so the writer still moves (folder.ts writtenIn).
        if (back.length) written[item.name] = run;
        break;
      }
      writes.push(...back);
      deletes.push(...[...item.files.map(({ path }) => path), ...(item.links ?? [])].filter((path) => !back.some((file) => file.path === path)));
    }
    const host = writes.length ? "a purged run's workflows put back as they were before it" : "a purged run's workflows removed";
    return { result: true, change: { by: { host, written }, writes, deletes } };
  });
  return done.result ? done.main : undefined;
}

/** The names in the folder's diffs directory; none when it is not there. */
const diffNames = (ws: Workspace): Promise<string[]> =>
  ws.list(DIFFS_DIR).then((entries) => entries.filter((entry) => entry.kind === "file").map((entry) => entry.name), (error: unknown) => (isWorkspaceError(error, "NOT_FOUND") ? [] : Promise.reject(folderFailure(error))));
/** A merge's diff file, `<key>.json`; not one a stopped write left half written (`.json.<suffix>`). */
const isDiffFile = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name);
/** Diff file `name` as readRunDiff reads it, or undefined when it does not read as one: a folder that can't be read
 *  throws. */
const diffOrNone = (ws: Workspace, name: string): Promise<RunDiff | undefined> =>
  readRunDiff(ws, name.slice(0, -".json".length)).catch((error: unknown) => (error instanceof FolderUnreadable ? Promise.reject(error) : undefined));

/** The lines a patch (git's hunks) adds and does not take away: what a merge appended. */
function addedLines(patch: string): string[] {
  const lines = patch.split("\n");
  const taken = new Map<string, number>();
  for (const line of lines) if (line.startsWith("-")) taken.set(line.slice(1), (taken.get(line.slice(1)) ?? 0) + 1);
  return lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)).filter((line) => {
    const left = taken.get(line) ?? 0;
    if (left) taken.set(line, left - 1);
    return !left && line.trim() !== "";
  });
}

/** `text` with the last line equal to each of `lines` left out. */
function withoutLines(text: string, lines: readonly string[]): string {
  const kept = text.split("\n");
  for (const line of lines) {
    const at = kept.lastIndexOf(line);
    if (at >= 0) kept.splice(at, 1);
  }
  return kept.join("\n");
}

/** `patch` (git's hunks) with each context line that is one of `gone` left out, a hunk that lost one given the header
 *  of what it keeps: the start moved past the lines it lost at its top (git names the line before when it keeps none
 *  on a side), each count less what it lost. */
function withoutContext(patch: string, gone: ReadonlySet<string>): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  const dropped = (line: string) => line.startsWith(" ") && gone.has(line.slice(1));
  for (let i = 0; i < lines.length;) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[i]!);
    if (!head) {
      out.push(lines[i++]!);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end]!.startsWith("@@")) end++;
    const body = lines.slice(i + 1, end);
    const kept = body.filter((line) => !dropped(line));
    const lost = body.length - kept.length;
    if (!lost) out.push(lines[i]!, ...body);
    else {
      const top = body.findIndex((line) => !dropped(line));
      const lead = top < 0 ? lost : top;
      const [olds, news] = [Number(head[2] ?? 1) - lost, Number(head[4] ?? 1) - lost];
      const at = (start: string, count: number) => Number(start) + lead - (count ? 0 : 1);
      out.push(`@@ -${at(head[1]!, olds)},${olds} +${at(head[3]!, news)},${news} @@${head[5]}`, ...kept);
    }
    i = end;
  }
  return out.join("\n");
}
