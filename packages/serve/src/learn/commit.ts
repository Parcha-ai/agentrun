// learningCommit: the writes on an agent's learning (learn/rows.ts writeLearning: one save, compare and swap on the
// agent's newest version, computed again on the one that won). Three writes:
//   - a run's compiled workflow draft (learningCommit), already checked, its files whole; a file that is not at the
//     newest version as it was at the run's seed (or its `bases` save) is a conflict, never written over;
//   - one line of an owner's feedback appended to corrections.md (appendCorrection), after the refusals, the file's
//     oldest lines dropped when the cap needs it (corrections.ts withCorrection: the newest correction wins);
//   - corrections.md replaced whole by a person (putCorrections), under the ETag they read.
// A purged run's text needs no write here: its purge deletes its rows (Store.learning.purgeRun). A run's merge read at a
// save a purge came after (its seed, a revised workflow's base) is refused whole: `purged`.
import type { Problem } from "./check.js";
import { CORRECTIONS_CAP, CORRECTIONS_FILE, correctionLine, correctionsProblems, withCorrection } from "./corrections.js";
import { type AgentLearning, blobOid, type LearningRead, type LearningWrite, LearningBusy, LearningMerged, LearningRefused, readView, type RunDiff, runMergeOf, writeLearning } from "./rows.js";
import { held, isHeld } from "./workflow-draft.js";

/** A run's merge, one a round: its compiled draft's files, already checked, and its owner's correction. */
export type LearningChange = {
  /** The run that learned, and with `round` its merge key (runDiffKey). */
  runId: string;
  /** Which of the run's merges this is (absent: its first): a follow-up's later round merges once of its own. */
  round?: number;
  /** Why: the log's `reason`. */
  reason: string;
  /** What merges: a draft's files, each whole. */
  files: { path: string; text: string }[];
  /** One line of its owner's feedback appended to corrections.md (its whitespace folded: correctionLine), the file's
   *  oldest lines dropped to keep it within CORRECTIONS_CAP; refused as appendCorrection refuses one: what must never be
   *  stored (`refuseValues`), or the line past CORRECTIONS_CAP alone. */
  correction?: string;
  refuseValues?: readonly string[];
  /** Paths written with `status: pending` (waiting for the owner's OK): a draft's README.md. */
  held?: string[];
  /** The save the run started from: a file that is not at the newest version as it was at it (a person retired or
   *  approved it, another run's merge changed it) is a conflict. */
  seed?: string;
  /** A save the agent's learning must still hold for the merge to land, its correction alone included (which no `same`
   *  covers): the run's seed, when it was held as the run's end began (runner/learning-end.ts). A reset of the agent's
   *  learning since removed it, so the whole merge is a conflict that says so. */
  mustHold?: string;
  /** A file checked against another save than `seed`, by its path: a workflow the run's compile turn revised from the
   *  newest text, against the save it read that text at. */
  bases?: Readonly<Record<string, string>>;
};

export type LearningCommitResult =
  /** `refusedCorrection`: the correction the merge left out beside its draft, its line past the cap alone, in the cap's
   *  words. `droppedLines`: how many of corrections.md's oldest lines the kept correction pushed out (absent: none). */
  | { ok: true; main: string; commit: string; files: string[]; already?: true; refusedCorrection?: Problem[]; droppedLines?: number }
  | { ok: false; reason: "conflict"; problems: Problem[] }
  | { ok: false; reason: "refused"; problems: Problem[] }
  /** A run's purge came after the save the run's merge was read at (its seed): that purge rewrote what the run started
   *  from, so its draft can't be told apart from the purged run's bytes, and nothing of it is written. */
  | { ok: false; reason: "purged"; problems: Problem[] }
  | { ok: false; reason: "unavailable"; error: string };

type Computed = LearningCommitResult | { pending: true; refusedCorrection?: Problem[]; droppedLines?: number };

/** A write's failure as a result: a precondition (a file changed since the seed, or the seed gone: a conflict), or the
 *  store unavailable (retry later). */
function failure(error: unknown): LearningCommitResult {
  if (error instanceof LearningRefused && error.purged !== undefined) return { ok: false, reason: "purged", problems: [{ rule: "kept", detail: "a run's learning was purged after this run started, so what it learned can't be told apart from what the purge took" }] };
  if (error instanceof LearningRefused && error.seed !== undefined) return { ok: false, reason: "conflict", problems: [{ rule: "kept", detail: "the agent's learning was reset after the run started, so what it learned has nothing to land on" }] };
  if (error instanceof LearningRefused) return { ok: false, reason: "conflict", problems: error.same.map((path): Problem => ({ rule: "kept", path, detail: `${path} changed on main after the run started` })) };
  return { ok: false, reason: "unavailable", error: (error as Error)?.message ?? String(error) };
}

/**
 * A run's merge on the agent's learning, one save: its files (a held README with `status: pending`) and its owner's
 * correction appended to corrections.md. `ok` with the new version and the paths it changed; `conflict` when a file is
 * not at the newest version as it was at the run's seed; `purged` when the merge gives files and a run's purge came after
 * its seed (or a revised workflow's base), nothing written; `refused` when the correction holds what must never be stored,
 * or, with no draft beside it, its line alone is past corrections.md's cap (nothing written); `unavailable` when the store
 * failed. A kept correction that would take the file past its cap drops the file's oldest lines to fit (`droppedLines`):
 * the newest correction wins. The draft and the correction are judged apart: a line past the cap alone beside a draft is
 * left out alone, and the draft merges, `ok` with the cap's refusal as `refusedCorrection`. A merge whose run already
 * merged (this round) is `ok` with the save that holds it, and
 * writes nothing: its merge key is taken once, in the save's own transaction, so two calls racing for one round (a
 * reclaimed run) merge it once.
 */
export async function learningCommit(learning: AgentLearning, change: LearningChange, opts: { retries?: number } = {}): Promise<LearningCommitResult> {
  try {
    const known = await runMergeOf(learning, change.runId, change.round);
    if (known) return await already(learning, change, known.merge, known);
    const line = change.correction === undefined ? undefined : correctionLine(change.correction);
    // The line alone first: what it holds is refused whatever the file around it holds; so is a line past the cap alone,
    // which no dropped line makes room for.
    const own = line === undefined ? [] : correctionProblems(line, change.refuseValues);
    if (own.length) return { ok: false, reason: "refused", problems: own };
    const tooLarge = line === undefined ? undefined : capProblem(line);
    if (tooLarge && !change.files.length) return { ok: false, reason: "refused", problems: [tooLarge] };
    const marked = new Set(change.held ?? []);
    const drafts = change.files.map(({ path, text }) => ({ path, text: marked.has(path) && !isHeld(text) ? held(text) : text }));
    const same = change.files.flatMap(({ path }) => {
      const at = change.bases?.[path] ?? change.seed;
      return at ? [{ at, path }] : [];
    });
    // Every save the merge's files were read at: a purge after any of them refuses it whole (its correction too). A
    // correction alone copies nothing from them (its line is the owner's new words, appended to the newest
    // corrections.md), so a purge since never refuses it; its `mustHold` still refuses it after a reset.
    const readAt = drafts.length ? [...new Set([change.seed, change.mustHold, ...Object.values(change.bases ?? {})].filter((id): id is string => id !== undefined))] : [];
    const done = await writeLearning<Computed>(learning, async (read) => {
      const writes = [...drafts];
      let droppedLines = 0;
      if (line !== undefined && !tooLarge) {
        const { text, dropped } = withCorrection(correctionsOf(read), line);
        writes.push({ path: CORRECTIONS_FILE, text });
        droppedLines = dropped;
      }
      // `mustHold`: the whole merge is refused when the agent's learning no longer holds it (a reset removed it).
      return { result: { pending: true, ...(tooLarge ? { refusedCorrection: [tooLarge] } : {}), ...(droppedLines ? { droppedLines } : {}) }, change: { by: run(change.runId, change.reason, change.round), writes, ...(same.length ? { same } : {}), ...(change.mustHold ? { seed: change.mustHold } : {}), ...(readAt.length ? { readAt } : {}) } };
    }, opts.retries ?? 3);
    const { result, saved } = done;
    return "pending" in result ? { ok: true, main: saved!.id, commit: saved!.id, files: [...saved!.files], ...(result.refusedCorrection ? { refusedCorrection: result.refusedCorrection } : {}), ...(result.droppedLines ? { droppedLines: result.droppedLines } : {}) } : result;
  } catch (error) {
    // The round merged under this call past the read above (a reclaimed run's two claims racing): its merge key let one
    // merge of it land, and this call reads that one.
    if (error instanceof LearningMerged) return already(learning, change, error.save.id, await runMergeOf(learning, change.runId, change.round).catch(() => undefined)).catch(failure);
    if (error instanceof LearningBusy) return { ok: false, reason: "unavailable", error: error.message };
    return failure(error);
  }
}

/** A round that merged already, `merge` its save: `ok` with it and the paths its diff names, nothing written again. Its
 *  merge left the correction out only for its line past the cap alone. How many lines its correction dropped is not
 *  read again. */
async function already(learning: AgentLearning, change: LearningChange, merge: string, known: RunDiff | undefined): Promise<LearningCommitResult> {
  const left = known !== undefined && change.correction !== undefined && !known.files.some((file) => file.path === CORRECTIONS_FILE);
  const refused = left ? capProblem(correctionLine(change.correction!)) : undefined;
  return { ok: true, main: (await readView(learning))?.main ?? merge, commit: merge, files: known ? known.files.map((file) => file.path) : [], already: true, ...(refused ? { refusedCorrection: [refused] } : {}) };
}

const run = (runId: string, reason: string, round?: number): LearningWrite["by"] => ({ run: runId, reason, ...(round !== undefined && round > 1 ? { round } : {}) });

/** corrections.md's text at the version read ("" when it holds none). */
const correctionsOf = (read: LearningRead): string => read.text(CORRECTIONS_FILE) ?? "";
/** What a correction's line holds that must never be stored, whatever the file around it holds. */
const correctionProblems = (line: string, refuseValues?: readonly string[]): Problem[] => correctionsProblems(line, refuseValues).filter((problem) => problem.rule !== "too_large");
/** The cap's refusal of a correction's line past it alone, in its words; none within the cap. */
const capProblem = (line: string): Problem | undefined => {
  const bytes = Buffer.byteLength(line, "utf8");
  return bytes > CORRECTIONS_CAP ? { rule: "too_large", path: CORRECTIONS_FILE, detail: `${CORRECTIONS_FILE} would hold ${bytes} bytes for this correction alone; the cap is ${CORRECTIONS_CAP} bytes` } : undefined;
};

/** Why a run's correction (`text`) would be refused: its line's own problems, else the cap's for the line alone; empty
 *  when it would be taken. Never the file around it: a kept line drops the file's oldest lines to fit (learningCommit).
 *  Read before the run's merge, so a refused correction never holds its draft back. */
export function correctionRefused(text: string, refuseValues?: readonly string[]): Problem[] {
  const line = correctionLine(text);
  const own = correctionProblems(line, refuseValues);
  if (own.length) return own;
  const full = capProblem(line);
  return full ? [full] : [];
}

/** One line of an owner's feedback appended to corrections.md on main, by run `runId`'s merge (learningCommit's
 *  `correction`, with no draft beside it). */
export const appendCorrection = (learning: AgentLearning, input: { runId: string; round?: number; text: string; refuseValues?: readonly string[] }): Promise<LearningCommitResult> =>
  learningCommit(learning, { runId: input.runId, ...(input.round !== undefined ? { round: input.round } : {}), reason: "the owner's correction", files: [], correction: input.text, ...(input.refuseValues ? { refuseValues: input.refuseValues } : {}) });

/** corrections.md as a person reads it: its text and its ETag's blob (an empty file's when it holds none). */
export function readCorrections(read: LearningRead): { text: string; oid: string } {
  return { text: correctionsOf(read), oid: read.view?.corrections?.oid ?? blobOid("") };
}

/**
 * corrections.md replaced whole by a person: `ifMatch`, the blob they read (an ETag, quoted or not; an empty file's when
 * the agent held none), must be the newest's now, else a conflict. Refused, nothing written, as appendCorrection refuses. `ok` with
 * the new text and its blob.
 */
export async function putCorrections(learning: AgentLearning, input: { text: string; ifMatch: string; refuseValues?: readonly string[] }): Promise<{ ok: true; text: string; oid: string } | { ok: false; reason: "conflict" | "refused"; problems: Problem[] }> {
  // Kept as its notes hold it: every line ends in a newline (learn/rows.ts), so the text answered is the text read back.
  const text = input.text === "" || input.text.endsWith("\n") ? input.text : `${input.text}\n`;
  // Judged as sent first, so a refusal counts the bytes the person sent; then with the newline it is kept with.
  const sent = correctionsProblems(input.text, input.refuseValues);
  const problems = sent.length || text === input.text ? sent : correctionsProblems(text, input.refuseValues);
  if (problems.length) return { ok: false, reason: "refused", problems };
  const seen = input.ifMatch.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const { result } = await writeLearning<{ ok: true; text: string; oid: string } | { ok: false; reason: "conflict"; problems: Problem[] }>(learning, async ({ view }) => {
    const now = view?.corrections?.oid ?? blobOid("");
    if (now !== seen) return { result: { ok: false, reason: "conflict", problems: [{ rule: "kept", path: CORRECTIONS_FILE, detail: `${CORRECTIONS_FILE} changed since it was read` }] } };
    return { result: { ok: true, text, oid: blobOid(text) }, change: { by: { person: "edited", file: CORRECTIONS_FILE }, writes: [{ path: CORRECTIONS_FILE, text }] } };
  });
  return result;
}
