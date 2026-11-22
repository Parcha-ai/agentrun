// learningCommit: the writes on an agent's learning. Every call is ONE save on the learning store's main (learn/folder.ts
// commitChange), computed from main's snapshot and the bodies it names. A main that moved under it (stale) is computed
// again on the main that won. A store with no main yet is made in the same call (its first commit first). Four writes:
//   - a run's compiled workflow draft (learningCommit), already checked, its files whole; a file that is not on main as
//     it was on the run's seed (or its `bases` commit) is a conflict, never written over;
//   - one line of an owner's feedback appended to corrections.md (appendCorrection), after the refusals;
//   - corrections.md replaced whole by a person (putCorrections), under the ETag they read;
//   - a purged run's feedback lines taken off main by the host (forgetRunText), each merge's scrub marked
//     `.agentrun/purged/<key>`, so it lands once.
import type { Problem } from "./check.js";
import { CORRECTIONS_CAP, CORRECTIONS_FILE, correctionLine, correctionsProblems } from "./corrections.js";
import { blobOid, type FolderChange, FolderMerged, FolderRefused, FolderTooLarge, forgetBody, readLearning, readSnapshot, type RunDiff, runMergeOf, type Snapshot, writeLearning } from "./folder.js";
import { HOST_DIR, type LearningStore, MARKER_KEY, type StoreDiffFile } from "./store.js";
import { held, isHeld } from "./workflow-draft.js";

/** A run's merge, one a round: its compiled draft's files, already checked, and its owner's correction. */
export type LearningChange = {
  /** The run that learned: the commit's Run-Id trailer and, with `round`, its marker's key (runDiffKey). */
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
   *  another run's merge changed it) is a conflict. The store checks it on main as it commits. */
  seed?: string;
  /** A commit the folder must still hold for the merge to land, its correction alone included (which no `same` covers):
   *  the run's seed, when this folder held it as the run's end began (runner/learning-end.ts). A reset of the agent's
   *  learning since removed it, so the whole merge is a conflict that says so. */
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

/** A write's failure as a result: the store's precondition (a file changed since the seed: a conflict), a write past
 *  what one save carries, or the store unavailable (retry later). */
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
 * A run's merge on the learning store's main, one save: its files (a held README with `status: pending`)
 * and its owner's correction appended to corrections.md. `ok` with the new main and the paths the commit changed;
 * `conflict` when a file is not on main as it was on the run's seed; `refused` when the correction holds what must never
 * be stored, or, with no draft beside it, would take corrections.md past its cap (nothing written); `unavailable` when
 * the store failed. The draft and the correction are judged apart: a correction past the cap beside a
 * draft (the file filled by another write after the run's check, correctionRefused) is left out alone, and the draft
 * merges, `ok` with the cap's refusal as `refusedCorrection`. A merge whose run already merged here (this round) is `ok`
 * with the commit that holds it, and writes nothing: checked before the write, again on each main it is computed on, and
 * by the store at `old` as it commits (its marker), so two calls racing for one round (a reclaimed run) merge it once.
 */
export async function learningCommit(store: LearningStore, change: LearningChange, opts: { retries?: number } = {}): Promise<LearningCommitResult> {
  try {
    const known = await runMergeOf(store, change.runId, change.round);
    if (known) return await already(store, change, known.merge, known);
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
    const done = await writeLearning<Computed>(store, async ({ snapshot, body }) => {
      // Read again on each main the write is computed on: a call that merged this round since the check above (a
      // reclaimed run's two claims racing) marked its commit, which this call's main may hold.
      const merged = await runMergeOf(store, change.runId, change.round);
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
      // `mustHold`: the store refuses the whole merge when it no longer holds it (a reset removed it).
      return { result: { pending: true, ...(refusedCorrection ? { refusedCorrection } : {}) }, change: { by: run(change.runId, change.reason, change.round), writes, ...(same.length ? { same } : {}), ...(change.mustHold ? { seed: change.mustHold } : {}) } };
    }, opts.retries ?? 3);
    const { result } = done;
    return "merged" in result ? await already(store, change, result.merged.merge, result.merged) : landed({ ...done, result });
  } catch (error) {
    // The round merged under this call past both reads: the store's compare and swap let one merge of it land (or a
    // purge scrubbed its key), and this call reads that one.
    if (error instanceof FolderMerged) return already(store, change, error.merge, await runMergeOf(store, change.runId, change.round).catch(() => undefined)).catch(failure);
    return failure(error);
  }
}

/** A round that merged already, `merge` its commit: `ok` with it and the paths its diff names (none for a key a purge
 *  scrubbed before it merged), nothing written again. Its merge left the correction out only at the cap. */
async function already(store: LearningStore, change: LearningChange, merge: string, known: RunDiff | undefined): Promise<LearningCommitResult> {
  const left = known !== undefined && change.correction !== undefined && !known.files.some((file) => file.path === CORRECTIONS_FILE);
  const refusedCorrection: Problem[] = left ? [{ rule: "too_large", path: CORRECTIONS_FILE, detail: `${CORRECTIONS_FILE} was at its cap of ${CORRECTIONS_CAP} bytes when the run's merge was written` }] : [];
  return { ok: true, main: (await readSnapshot(store))?.main ?? merge, commit: merge, files: known ? known.files.map((file) => file.path) : [], already: true, ...(refusedCorrection.length ? { refusedCorrection } : {}) };
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
export async function correctionRefused(store: LearningStore, text: string, refuseValues?: readonly string[], merge?: { runId: string; round?: number }): Promise<Problem[]> {
  const line = correctionLine(text);
  const own = correctionProblems(line, refuseValues);
  if (own.length) return own;
  if (merge && (await runMergeOf(store, merge.runId, merge.round))) return [];
  const before = await readLearning(store, ({ snapshot, body }) => correctionsOf(snapshot, body));
  const full = capProblem(appended(before, line));
  return full ? [full] : [];
}

/** One line of an owner's feedback appended to corrections.md on main, by run `runId`'s merge (learningCommit's
 *  `correction`, with no draft beside it). */
export const appendCorrection = (store: LearningStore, input: { runId: string; round?: number; text: string; refuseValues?: readonly string[] }): Promise<LearningCommitResult> =>
  learningCommit(store, { runId: input.runId, ...(input.round !== undefined ? { round: input.round } : {}), reason: "the owner's correction", files: [], correction: input.text, ...(input.refuseValues ? { refuseValues: input.refuseValues } : {}) });

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
export async function putCorrections(store: LearningStore, input: { text: string; ifMatch: string; refuseValues?: readonly string[] }): Promise<{ ok: true; text: string; oid: string } | { ok: false; reason: "conflict" | "refused"; problems: Problem[] }> {
  const problems = correctionsProblems(input.text, input.refuseValues);
  if (problems.length) return { ok: false, reason: "refused", problems };
  const seen = input.ifMatch.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const { result } = await writeLearning<{ ok: true; text: string; oid: string } | { ok: false; reason: "conflict"; problems: Problem[] }>(store, async ({ snapshot }) => {
    const now = snapshot?.corrections?.oid ?? blobOid("");
    if (now !== seen) return { result: { ok: false, reason: "conflict", problems: [{ rule: "kept", path: CORRECTIONS_FILE, detail: `${CORRECTIONS_FILE} changed since it was read` }] } };
    return { result: { ok: true, text: input.text, oid: blobOid(input.text) }, change: { by: { person: "edited", file: CORRECTIONS_FILE }, writes: [{ path: CORRECTIONS_FILE, text: input.text }] } };
  });
  return result;
}

/** The host's subject words for a purge's scrub (its commit reads `host: <these>`). */
const SCRUB = "a purged run's corrections removed";

/**
 * Run `runId`'s text taken off the learning's current files, at its purge (agent-delete.ts purgeRun): the lines each of
 * its merges added to corrections.md, as the store diffs that merge, dropped from main in one host commit per merge (a
 * line a person edited since is theirs and stays), marked `.agentrun/purged/<key>` (the merge's key, runDiffKey). Its
 * merges stay in the store's history until a learning reset or its agent's purge removes the store; another merge's
 * diff that shows such a line as context is served without it (purgedContextOut). Idempotent: each merge's scrub lands
 * once (a second is the store's `already`), and nothing left to drop makes no commit. A merge is found by its commit on
 * corrections.md's history whose Run-Id trailer names the run, its key by the marker the commit added. `commit`: the
 * host's last commit, when one was made.
 */
export async function forgetRunText(store: LearningStore, runId: string): Promise<{ commit?: string }> {
  let commit: string | undefined;
  for (const { key, added } of await correctionMerges(store, runId)) {
    // Lands once, by the merge's key: a call that stopped after it finds it landed and takes no line again, so another
    // run's same line stays; a merge of the run made since (a purge that stopped before the run's tombstone left it open
    // to a grade) is a key of its own, scrubbed in its turn.
    const done = await writeLearning<string | undefined>(store, async ({ snapshot, body }) => {
      if (!snapshot?.corrections) return { result: undefined };
      const before = await body(CORRECTIONS_FILE, snapshot.corrections.oid);
      const after = withoutLines(before, added);
      if (after === before) return { result: undefined };
      const write = after ? { writes: [{ path: CORRECTIONS_FILE, text: after }] } : { writes: [], deletes: [CORRECTIONS_FILE] };
      return { result: snapshot.corrections.oid, change: { by: { host: SCRUB }, purged: key, ...write } };
    }).catch((error: unknown) => (error instanceof FolderMerged ? { result: undefined, main: undefined } : Promise.reject(error)));
    if (done.result !== undefined) {
      forgetBody(done.result);
      commit = done.main;
    }
  }
  return commit ? { commit } : {};
}

/** Run `runId`'s merges that added a line to corrections.md, oldest first: each one's key (the `.agentrun/runs/<key>`
 *  marker its commit added) and the lines it added. */
async function correctionMerges(store: LearningStore, runId: string): Promise<{ key: string; added: string[] }[]> {
  const main = await store.head();
  if (!main) return [];
  const trailer = `Run-Id: ${runId}`;
  const commits = ((await store.log(main, { path: CORRECTIONS_FILE })) ?? []).filter(({ message }) => message.split("\n").includes(trailer)).reverse();
  const out: { key: string; added: string[] }[] = [];
  for (const { sha } of commits) {
    const files = (await store.diff(sha)) ?? [];
    const key = files.find(({ path, status }) => status === "added" && path.startsWith(RUNS_DIR))?.path.slice(RUNS_DIR.length);
    if (!key || !MARKER_KEY.test(key)) continue;
    const added = files.flatMap((file) => (file.path === CORRECTIONS_FILE && "patch" in file ? addedLines(file.patch) : []));
    if (added.length) out.push({ key, added });
  }
  return out;
}

const RUNS_DIR = `${HOST_DIR}/runs/`;
const PURGED_DIR = `${HOST_DIR}/purged/`;

/** The lines each purge's scrub took off corrections.md, by store and scrub commit: a commit's never change. */
const scrubbed = new Map<string, string[]>();

/**
 * A merge's diff `files` as a history read serves it: corrections.md's patch with each context line a purge's scrub
 * took off main left out (forgetRunText), so no read serves a purged run's line as another merge's context. The scrubs
 * are the host's commits on corrections.md's history that added a `.agentrun/purged/<key>` marker; a patch with no
 * context line reads none of them.
 */
export async function purgedContextOut(store: LearningStore, files: readonly StoreDiffFile[]): Promise<StoreDiffFile[]> {
  if (!files.some((file) => file.path === CORRECTIONS_FILE && "patch" in file && /^ /m.test(file.patch))) return [...files];
  const main = await store.head();
  if (!main) return [...files];
  const gone = new Set<string>();
  for (const { sha, message } of (await store.log(main, { path: CORRECTIONS_FILE })) ?? []) {
    if (message.split("\n")[0] !== `host: ${SCRUB}`) continue;
    const at = `${store.id}\0${sha}`;
    let lines = scrubbed.get(at);
    if (!lines) {
      const diff = (await store.diff(sha)) ?? [];
      lines = diff.some(({ path, status }) => status === "added" && path.startsWith(PURGED_DIR)) ? diff.flatMap((file) => (file.path === CORRECTIONS_FILE && "patch" in file ? takenLines(file.patch) : [])) : [];
      scrubbed.set(at, lines);
      for (const old of scrubbed.keys()) {
        if (scrubbed.size <= 256) break;
        scrubbed.delete(old);
      }
    }
    for (const line of lines) gone.add(line);
  }
  if (!gone.size) return [...files];
  return files.map((file) => (file.path === CORRECTIONS_FILE && "patch" in file ? { ...file, patch: withoutContext(file.patch, gone) } : file));
}

/** The lines a patch (git's hunks) takes away and does not add back: what a scrub removed. */
function takenLines(patch: string): string[] {
  const lines = patch.split("\n");
  const added = new Map<string, number>();
  for (const line of lines) if (line.startsWith("+")) added.set(line.slice(1), (added.get(line.slice(1)) ?? 0) + 1);
  return lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1)).filter((line) => {
    const left = added.get(line) ?? 0;
    if (left) added.set(line, left - 1);
    return !left && line.trim() !== "";
  });
}

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
