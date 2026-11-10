// The built-in learning run: a run of harness "learning" that grades what another run's end-of-run turn kept (its
// learning_proposals row) and merges what the grader keeps into the agent's learning folder, through the folder's one
// write script (learningCommit). The runner claims it like any run; this loop is on the same contract as the others, so
// the claim, the fence, a stop and the end commit are the runner's.
//
// Its journal says what happened, one entry each, on its root conversation:
//   agentrun.learning.graded   the verdict and what the grade spent, written BEFORE the merge, so a resumed run never
//                              asks the grader twice;
//   agentrun.learning.merged   what the merge wrote (the new main and its commit), with the run's end;
//   agentrun.learning.dropped  why nothing was merged (the grader kept nothing, main moved under it, the checker refused
//                              it), with the run's end.
// The merge is idempotent on the learning's source run (the script finds its Run-Id on main), so a run resumed after the
// merge's call merges once.

import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, type StorageWrite } from "@earendil-works/pi-durable";
import type { LearningProposal } from "../store/store.js";
import { gradedItems, gradePrompt, parseVerdict, UNREADABLE_REASON, type IndexEntry, type NoteText, type Verdict } from "../learn/grade.js";
import { mergedNote, parseNoteFile } from "../learn/notes.js";
import type { LearnedFile, NoteLearned, Tokens } from "../learning.js";
import { learnedPlace } from "../learn/skills.js";
import { blobOid } from "../learn/folder.js";
import { notKept, said, STOPPED } from "../learning-words.js";
import { journalEntries } from "./journal-reader.js";
import { KINDS } from "./journal-kinds.js";
import type { Claim, Command, CommandOutcome, Journal, Loop, LoopDeps, LoopEnd, StopReason } from "./loop-contract.js";

/** The grader's bounds, as the server's grade had them (grade.ts): one ask, its answer cut at GRADE_MAX_TOKENS. */
export const GRADE_TIMEOUT_MS = 180_000;
export const GRADE_MAX_TOKENS = 16_000;
/** A folder the merge could not reach (the workspace or its exec down): the run parks and is retried after this, doubling
 *  per try up to the last. */
export const UNAVAILABLE_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000] as const;

/** What the source run proposed (learning.ts Proposal), as kept in its learning_proposals row. */
export interface KeptProposal {
  readonly notes: readonly NoteText[];
  readonly files?: readonly NoteText[];
  readonly asked?: readonly string[];
  readonly triggered?: readonly { readonly source: string; readonly text: string }[];
  /** The commit of the learning folder's main the run started from (its pin's seed). */
  readonly seed?: string;
}

/** Main as the grader reads it: every active note's index line, the text of each note the proposal supersedes, and the
 *  blob each of those was read at (a merge on a main where one moved is a conflict). */
export interface GradeMain {
  readonly active: readonly IndexEntry[];
  readonly superseded: readonly NoteText[];
  readonly graded: Readonly<Record<string, string>>;
}

export type Problem = { readonly rule: string; readonly path?: string; readonly detail: string };

/** The folder's one write (learn/commit.ts learningCommit), a merge. */
export interface MergeChange {
  readonly kind: "merge";
  readonly runId: string;
  readonly reason: string;
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly held?: readonly string[];
  readonly graded: Readonly<Record<string, string>>;
  /** The run's seed: a skill's or a draft's file not on main as it was on it is a conflict, never written over. */
  readonly seed?: string;
  /** New notes written over main's note of the same name, each superseding it by name (takenOnMain). */
  readonly replace?: readonly string[];
}

export type LearningCommitResult =
  | { readonly ok: true; readonly main: string; readonly commit: string; readonly files: readonly string[] }
  | { readonly ok: false; readonly reason: "conflict" | "refused"; readonly problems: readonly Problem[] }
  | { readonly ok: false; readonly reason: "unavailable"; readonly error: string };

/** What the grader's call is lent for one claim: a journal of the learning run under that claim, its own to open and
 *  close (where its request is booked: runBooking over the run's sessions), and the flush that makes a request's record
 *  durable before it leaves. */
export interface GraderRun {
  journal(): Journal;
  flush(): Promise<void>;
}

export interface LearningLoopDeps {
  /** The run that learned, from the learning run's launch row (its input's runId). */
  sourceOf(learningRunId: string): Promise<{ readonly runId: string; readonly agentId: string; readonly instructions?: string } | undefined>;
  /** Its kept proposal (store.learning.proposal). */
  proposal(runId: string): Promise<LearningProposal | undefined>;
  /** The agent's learning folder (learn/folder.ts learningWorkspace): its Workspace, and its end, called once the run is
   *  done with it, whichever way it goes out. */
  folder(agentId: string): { readonly workspace: unknown; end(): Promise<void> };
  /** Main as the grader reads it, from the folder's snapshot; problems when the proposal can't be graded on it. */
  readMain(ws: unknown, proposal: KeptProposal): Promise<GradeMain | { readonly problems: readonly Problem[] }>;
  /** One grader call, through the kernel's model proxy and the cap, booked to the agent's learning meter. */
  ask(request: { readonly prompt: string; readonly maxTokens: number }, signal: AbortSignal, run: GraderRun): Promise<{ readonly text: unknown; readonly usd: number | null; readonly tokens?: Tokens | null }>;
  /** The folder's one write. */
  commit(ws: unknown, change: MergeChange): Promise<LearningCommitResult>;
  /** The texts main holds at these note paths (learn/commit.ts mainTexts): a note the merge keeps whose name main
   *  already holds is settled alone (takenOnMain). None: main is taken to hold none of them. */
  mainTexts?(ws: unknown, paths: readonly string[]): Promise<Readonly<Record<string, string>>>;
  /** The clock (epoch ms), for a parked run's wake. */
  now?(): number;
}

const ROOT = ROOT_CONVERSATION_ID;

/** The journal's learning entries' data (journal-kinds.ts learningGraded, learningDropped, learningMerged), as the reader
 *  of a run's learning end reads them (store-reads/learning.ts). What a grade spent: its dollars and tokens, each null when
 *  any ask's are unknown. */
export type GradedData = { readonly source: string; readonly verdict: Verdict; readonly usd: number | null; readonly tokens?: Tokens | null; readonly graded: Readonly<Record<string, string>> };
export type DroppedData = { readonly source: string; readonly reason: string; readonly detail: string; readonly problems?: readonly Problem[]; readonly usd?: number | null; readonly tokens?: Tokens | null };
export type MergedData = { readonly source: string; readonly main: string; readonly commit: string; readonly files: readonly string[]; readonly detail: string };
type UnavailableData = { readonly source: string; readonly error: string };

/** The graded item a proposal's file is judged as (grade.ts itemOf): a draft's README.md with its workflow.json, every
 *  other file as itself. */
const itemOf = (file: string): string => {
  const place = learnedPlace(file);
  return place?.kind === "readme" ? `workflows/${place.name}/workflow.json` : file;
};

/** The why of a note main already holds the same (a run's new note, or a skill re-filed as one): no change, so its words
 *  never say it. */
export const SAME_NOTE = "The same rule is already one of the agent's notes.";
/** The why of a note whose name main already holds with other text, which it does not supersede: never written over,
 *  and the rest of what the run learned merges. */
export const NOTE_NAME_TAKEN = (name: string) => `A note named ${name} was added since this run started, or was there already; this one wasn't kept.`;

/** What `verdict` merges once each note it keeps (a new note's, or a skill's re-filed as one: its item's `note`) is set
 *  beside what main holds at that file (`onMain`, by path), one item at a time, never a refusal of the whole merge: a
 *  note main holds the same is no change, dropped unsaid (SAME_NOTE); one whose own front matter supersedes the note of
 *  its name is a modification, written over it (`replace`, main's blob in `graded`, so a change since is a conflict);
 *  any other is dropped, saying so (NOTE_NAME_TAKEN), and main's note stands. No suffixed name: it would hold the same
 *  rule twice. Merge when the grader said so and it still keeps an item. */
export function takenOnMain(proposal: Pick<KeptProposal, "notes">, verdict: Verdict, onMain: Readonly<Record<string, string>>): { verdict: Verdict; replace: string[]; graded: Record<string, string> } {
  const texts = new Map(proposal.notes.map(({ file, text }) => [file, text]));
  const replace: string[] = [];
  const graded: Record<string, string> = {};
  const items = verdict.items.map((item) => {
    const note = item.note ?? (texts.has(item.file) ? { file: item.file, text: texts.get(item.file)! } : undefined);
    const held = item.keep && note ? onMain[note.file] : undefined;
    if (!note || held === undefined) return item;
    const same = held === note.text || held === mergedNote(note.text, { origin: item.origin ?? "run", ...(item.pending ? { pending: true } : {}) });
    const parsed = parseNoteFile(note.file, note.text);
    if (!same && !item.note && !Array.isArray(parsed) && parsed.supersedes.includes(note.file)) {
      replace.push(note.file);
      graded[note.file] = blobOid(held);
      return item;
    }
    return { file: item.file, keep: false, question: "Duplicate", why: same ? SAME_NOTE : NOTE_NAME_TAKEN(note.file.replace(/\.md$/, "")) };
  });
  return { verdict: { ...verdict, items, merge: verdict.merge && items.some((item) => item.keep) }, replace, graded };
}

/** `proposal` with only what `verdict` keeps (a verdict per item): a note or file its item keeps or holds; a skill its
 *  item re-filed (`note`: a standing rule for every reply) is kept as that note instead, never as a skill. */
export function keptOf(proposal: KeptProposal, verdict: Verdict): KeptProposal {
  if (!verdict.items.length) return proposal;
  const kept = new Set(verdict.items.filter((item) => item.keep && !item.note).map((item) => item.file));
  const refiled = verdict.items.flatMap((item) => (item.keep && item.note ? [item.note] : []));
  return { ...proposal, notes: [...proposal.notes.filter(({ file }) => kept.has(file)), ...refiled], files: (proposal.files ?? []).filter(({ file }) => kept.has(itemOf(file))) };
}

/** Each verdict item by the file it is merged as: a re-filed skill's item by its note's file too. */
const itemsByFile = (verdict: Verdict): Map<string, Verdict["items"][number]> => new Map(verdict.items.flatMap((item) => [[item.file, item] as const, ...(item.note ? [[item.note.file, item] as const] : [])]));

/** The merge of `merging` (what the verdict kept), the one rule learningCommit's merge is made by: each note with
 *  the origin its item gives (`you` for the user's own words, else the run's) and held for its owner's OK when its item
 *  is pending; a skill's SKILL.md or a draft's README.md held when its item is (a draft's workflow.json is held by its
 *  README); and the seed the source run started from, so a skill's or draft's file changed on main since is a conflict. */
export function mergeChangeOf(runId: string, merging: KeptProposal, verdict: Verdict, graded: Readonly<Record<string, string>>): MergeChange {
  const judged = itemsByFile(verdict);
  const notes = merging.notes.map(({ file, text }) => ({ path: file, text: mergedNote(text, { origin: judged.get(file)?.origin ?? "run" }) }));
  const files = (merging.files ?? []).map(({ file, text }) => ({ path: file, text }));
  const held = [
    ...merging.notes.filter(({ file }) => judged.get(file)?.pending === true).map(({ file }) => file),
    ...files.filter(({ path }) => learnedPlace(path)?.kind !== "workflow" && judged.get(itemOf(path))?.pending === true).map(({ path }) => path),
  ];
  return {
    kind: "merge", runId, reason: verdict.reason || "The grader kept every new note.", files: [...notes, ...files],
    ...(held.length ? { held } : {}), graded, ...(merging.seed ? { seed: merging.seed } : {}),
  };
}

/** What a merge of `merging` learned, as the server's grade named it on the run (learning-run.ts grade): the notes it
 *  added that runs read, with what each supersedes; the ones waiting for their owner's OK; its skills and workflow
 *  drafts, each pending when it waits. The merge's words and the reader of a run's learning end (store-reads/learning.ts)
 *  both name it so. */
export function learnedOf(merging: KeptProposal, verdict: Verdict): { learned: NoteLearned[]; pending: { file: string; name: string }[]; skills: LearnedFile[]; workflows: LearnedFile[] } {
  const waiting = new Set(verdict.items.filter((item) => item.pending).flatMap((item) => [item.file, ...(item.note ? [item.note.file] : [])]));
  const notes = merging.notes.flatMap(({ file, text }) => {
    const note = parseNoteFile(file, text);
    return Array.isArray(note) ? [] : [{ file, name: note.name, supersedes: note.supersedes }];
  });
  const made = (suffix: string): LearnedFile[] => (merging.files ?? []).filter(({ file }) => file.endsWith(suffix)).map(({ file }) => ({ file, name: file.split("/")[1]!, ...(waiting.has(file) ? { pending: true as const } : {}) }));
  return {
    learned: notes.filter(({ file }) => !waiting.has(file)),
    pending: notes.filter(({ file }) => waiting.has(file)).map(({ file, name }) => ({ file, name })),
    skills: made("/SKILL.md"),
    workflows: made("/workflow.json"),
  };
}

/** The merge's words, as the server's grade said them: what it learned (learnedOf), what the grader left out, and what
 *  the checks left out (the kept row's `left`). */
function mergedWords(merging: KeptProposal, verdict: Verdict, checked: readonly Problem[]): string {
  const { learned, pending, skills, workflows } = learnedOf(merging, verdict);
  // A re-filed rule main already holds the same is no change: never said.
  const left = verdict.items.filter((item) => !item.keep && item.why !== SAME_NOTE).map((item) => ({ why: item.why }));
  return said.merged(learned, pending, [...skills, ...workflows], left, checked as never);
}

/** The skills and drafts a proposal names, by their item's file: what a merge the grader refused loses (notKept). */
export const lostOf = (proposal: KeptProposal): LearnedFile[] => (proposal.files ?? []).flatMap(({ file }) => {
  const place = learnedPlace(file);
  return place && place.kind !== "readme" ? [{ file, name: place.name }] : [];
});

export function createLearningLoop(learning: LearningLoopDeps): (deps: LoopDeps) => Loop {
  return (deps) => {
    let stopped: StopReason | null = null;
    const now = learning.now ?? Date.now;

    return {
      async command(_command: Command): Promise<CommandOutcome> {
        return { refused: "a learning run takes no messages or answers" };
      },
      async stop(reason: StopReason): Promise<void> {
        stopped = reason;
      },
      async start(claim: Claim): Promise<LoopEnd> {
        const context: Context = withAbortSignal(deps.signal, BACKGROUND_CONTEXT);
        const journal: Journal = deps.journal(claim);
        let rooted = false;
        /** One entry on the root, committed; `end` stages the run's state with it (keyed to this entry, its effect), and
         *  `take` the stop row it applies. */
        const append = async (kind: string, data: unknown, end?: "ended" | "failed" | "stopped" | "parked", take?: number) => {
          const writes: StorageWrite[] = [];
          if (!rooted && !(await journal.conversation(ROOT, context))) writes.push({ type: "conversation", value: { id: ROOT } } as StorageWrite);
          const id = await journal.mintId();
          writes.push({ type: "entry", value: { id, conversationId: ROOT, kind, data } } as StorageWrite);
          if (end) journal.stage({ run: { state: end }, effect: id, ...(take !== undefined ? { take: [{ command: take, effect: id }] } : {}) });
          const result = await journal.commit([writes], () => {}, context);
          if (result.stored === 0) throw result.refused;
          rooted = true;
        };
        /** A stop row ends the run stopped, its row taken in that end; a lost claim or a shutdown writes nothing more. */
        const halted = async (): Promise<LoopEnd | null> => {
          if (!stopped) return null;
          if (stopped.kind !== "command") return { state: "interrupted" };
          await append(KINDS.end, { state: "stopped" }, "stopped", stopped.commandId);
          return { state: "stopped" };
        };

        const source = await learning.sourceOf(claim.runId);
        if (!source) {
          await append(KINDS.learningDropped, { source: "", reason: "no_source", detail: said.stopped(STOPPED.notChecked) } satisfies DroppedData, "failed");
          return { state: "failed", error: { code: "learning_no_source", message: "the learning run names no run that learned" } };
        }
        const kept = await learning.proposal(source.runId);
        if (!kept) {
          await append(KINDS.learningDropped, { source: source.runId, reason: "no_proposal", detail: said.stopped(STOPPED.notChecked) } satisfies DroppedData, "ended");
          return { state: "ended" };
        }
        // The row as the end-of-run hook keeps it: its state and words, the kept Proposal inside (a drop queues no learning
        // run, so a row that isn't proposed is read as nothing to grade).
        const row = kept.proposal as { readonly state?: string; readonly proposal?: KeptProposal; readonly left?: readonly Problem[] } | null;
        if (row?.state !== "proposed" || !row.proposal) {
          await append(KINDS.learningDropped, { source: source.runId, reason: "no_proposal", detail: said.stopped(STOPPED.notChecked) } satisfies DroppedData, "ended");
          return { state: "ended" };
        }
        const proposal = row.proposal;
        // What the checks left out of the proposal (propose.ts Proposed `left`), said with the merge.
        const checked = Array.isArray(row.left) ? row.left : [];

        /** The grade and the merge, on the agent's learning folder `ws`. */
        const onFolder = async (ws: unknown): Promise<LoopEnd> => {
          const entries = await journalEntries(journal, context);
          rooted = entries.length > 0;
          const unavailable = entries.filter((entry) => entry.kind === KINDS.learningUnavailable).length;

          // The grade: once. A verdict already in the journal is the one the merge goes on.
          let graded = entries.find((entry) => entry.kind === KINDS.learningGraded)?.data as GradedData | undefined;
          if (!graded) {
            const main = await learning.readMain(ws, proposal);
            if ("problems" in main) {
              await append(KINDS.learningDropped, { source: source.runId, reason: "checker", detail: said.stale(main.problems as never), problems: main.problems } satisfies DroppedData, "ended");
              return { state: "ended" };
            }
            const items = gradedItems(proposal.notes as NoteText[], (proposal.files ?? []) as NoteText[]);
            const prompt = gradePrompt({
              run: source.runId, ...(source.instructions ? { instructions: source.instructions } : {}), active: main.active, superseded: main.superseded, proposed: proposal.notes,
              ...(proposal.files?.length ? { files: proposal.files } : {}), ...(proposal.asked ? { asked: proposal.asked } : {}), ...(proposal.triggered ? { triggered: proposal.triggered } : {}),
            });
            // What the grade spends, as the server's grade counted it (grade.ts counter): each ask's dollars and tokens
            // added, either unknown (null) once any ask's is, and an ask that fails spent what nobody knows.
            let usd: number | null = 0;
            let tokens: Tokens | null = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
            const ask = async () => {
              const timer = AbortSignal.timeout(GRADE_TIMEOUT_MS);
              let answer: Awaited<ReturnType<LearningLoopDeps["ask"]>>;
              try {
                answer = await learning.ask({ prompt, maxTokens: GRADE_MAX_TOKENS }, AbortSignal.any([deps.signal, timer]), { journal: () => deps.journal(claim), flush: () => deps.flush() });
              } catch (error) {
                usd = null;
                tokens = null;
                throw error;
              }
              usd = usd === null || answer.usd === null || !Number.isFinite(answer.usd) ? null : usd + answer.usd;
              const more = answer.tokens ?? null;
              tokens = tokens === null || more === null ? null : { input: tokens.input + more.input, cache_read: tokens.cache_read + more.cache_read, cache_write: tokens.cache_write + more.cache_write, output: tokens.output + more.output };
              return answer.text;
            };
            let verdict: Verdict;
            try {
              verdict = parseVerdict(await ask(), items);
              // An answer the host cannot read is asked once more, as the server's grade did.
              if (verdict.reason === UNREADABLE_REASON && !verdict.items.length) verdict = parseVerdict(await ask(), items);
            } catch (error) {
              const end = await halted();
              if (end) return end;
              await append(KINDS.learningDropped, { source: source.runId, reason: "grade_failed", detail: said.stopped(STOPPED.noReview), usd, tokens } satisfies DroppedData, "ended");
              void error;
              return { state: "ended" };
            }
            graded = { source: source.runId, verdict, usd, tokens, graded: main.graded };
            await append(KINDS.learningGraded, graded);
            // The verdict is durable before the merge, its side effect.
            await deps.flush();
          }
          const halt = await halted();
          if (halt) return halt;

          // Each note it keeps whose file main already holds (another run merged one by that name since, or a skill
          // re-filed as one) is settled alone (takenOnMain): never written over unless it supersedes it, and never a
          // refusal of everything else the run learned.
          const notePaths = graded.verdict.items.flatMap((item) => (!item.keep ? [] : item.note ? [item.note.file] : proposal.notes.some(({ file }) => file === item.file) ? [item.file] : []));
          let onMain: Readonly<Record<string, string>> = {};
          if (notePaths.length && learning.mainTexts) {
            try {
              onMain = await learning.mainTexts(ws, notePaths);
            } catch (error) {
              // Main could not be read: parked as for a write that could not reach the folder, tried again after a backoff.
              await append(KINDS.learningUnavailable, { source: source.runId, error: (error as Error)?.message ?? String(error) } satisfies UnavailableData, "parked");
              return { state: "parked", wakeAt: now() + UNAVAILABLE_BACKOFF_MS[Math.min(unavailable, UNAVAILABLE_BACKOFF_MS.length - 1)]! };
            }
          }
          const taken = takenOnMain(proposal, graded.verdict, onMain);
          const verdict = taken.verdict;
          if (!verdict.merge) {
            await append(KINDS.learningDropped, { source: source.runId, reason: "grader", detail: notKept(verdict, lostOf(proposal)) } satisfies DroppedData, "ended");
            return { state: "ended" };
          }
          const merging = keptOf(proposal, verdict);
          const change = mergeChangeOf(source.runId, merging, verdict, { ...graded.graded, ...taken.graded });
          const result = await learning.commit(ws, taken.replace.length ? { ...change, replace: taken.replace } : change);
          if (result.ok) {
            const detail = mergedWords(merging, verdict, checked);
            await append(KINDS.learningMerged, { source: source.runId, main: result.main, commit: result.commit, files: result.files, detail } satisfies MergedData, "ended");
            return { state: "ended" };
          }
          if (result.reason === "conflict") {
            await append(KINDS.learningDropped, { source: source.runId, reason: "checker", detail: said.stale(result.problems as never), problems: result.problems } satisfies DroppedData, "ended");
            return { state: "ended" };
          }
          if (result.reason === "refused") {
            await append(KINDS.learningDropped, { source: source.runId, reason: "checker", detail: said.stale(result.problems as never), problems: result.problems } satisfies DroppedData, "failed");
            return { state: "failed", error: { code: "learning_refused", message: result.problems.map((problem) => problem.detail).join("; ") } };
          }
          // The folder could not be reached: parked, and tried again after a backoff, never in a hot loop.
          const error = "error" in result ? result.error : "the learning folder could not be reached";
          await append(KINDS.learningUnavailable, { source: source.runId, error } satisfies UnavailableData, "parked");
          const wait = UNAVAILABLE_BACKOFF_MS[Math.min(unavailable, UNAVAILABLE_BACKOFF_MS.length - 1)]!;
          return { state: "parked", wakeAt: now() + wait };
        };

        // The folder is ended once the run is done with it, whichever way it goes out. Its end only sweeps what an exec
        // left behind (on Archil, the spill), after the run's own end is committed: a failed sweep changes no end.
        const folder = learning.folder(source.agentId);
        try {
          return await onFolder(folder.workspace);
        } finally {
          await folder.end().catch(() => {});
        }
      },
    };
  };
}
