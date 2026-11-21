// learningCommit: the writes on an agent's learning folder. Every call is ONE exec of the learning script on the folder's
// main (learn/folder.ts commitChange, one hold), computed from the folder's snapshot and the bodies it names. A main
// that moved under it (the script's exit 3) is computed again on the main that won. A folder with no main yet is made
// in the same call (the script's init first). Three writes:
//   - a run's compiled workflow draft (learningCommit), already checked, its files whole; a file that is not on main as
//     it was on the run's seed (or its `bases` commit) is a conflict, never written over;
//   - one line of an owner's feedback appended to corrections.md (appendCorrection), after the refusals;
//   - corrections.md replaced whole by a person (putCorrections), under the ETag they read.
import type { Workspace } from "../workspace/index.js";
import type { Problem } from "./check.js";
import { CORRECTIONS_CAP, CORRECTIONS_FILE, correctionLine, correctionsProblems } from "./corrections.js";
import { blobOid, type FolderChange, FolderMerged, FolderRefused, FolderTooLarge, readLearning, readRunDiff, readSnapshot, type RunDiff, runDiffKey, runMergeOf, type Snapshot, writeLearning } from "./folder.js";
import { held, isHeld } from "./workflow-draft.js";

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
  | { ok: false; reason: "unavailable"; error: string };

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
  return { ok: false, reason: "unavailable", error: (error as Error)?.message ?? String(error) };
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
