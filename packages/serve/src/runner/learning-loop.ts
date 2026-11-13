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
import { GENERAL_NO_BUDGET, GENERAL_THRESHOLD, ONE_CASE, type GeneralScores, type GeneralSource } from "../learn/general.js";
import { CONTRADICTED_REASON, CONTRADICTED_TWICE_REASON, CONTRADICTION_ASK, gradedItems, gradePrompt, parseVerdict, UNREADABLE_REASON, type IndexEntry, type NoteText, type Verdict, type VerdictItem } from "../learn/grade.js";
import { mergedNote, parseNoteFile, ruleOf } from "../learn/notes.js";
import type { LearnedFile, NoteLearned, Tokens } from "../learning.js";
import { learnedPlace } from "../learn/skills.js";
import { blobOid } from "../learn/folder.js";
import { notKept, SAME_NOTE, said, STOPPED } from "../learning-words.js";
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
  /** Each kept draft's dry run, by its workflow.json's path (learn/skills.ts draftDryRun), which the grader is told. */
  readonly dryRuns?: Readonly<Record<string, { readonly status: string; readonly detail?: string }>>;
  /** The skill of each draft's name as the folder held it at the seed, which the grader is shown beside the draft. */
  readonly drafted?: readonly NoteText[];
  readonly asked?: readonly string[];
  /** Why each draft waits for its owner's OK whatever the grade (the learning end's: skills.ts unpricedCalls). */
  readonly held?: Readonly<Record<string, readonly string[]>>;
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
  /** The proposal's notes named like a note main holds, left out of the grade and settled alone (learn/commit.ts
   *  readMain): `same` when main's note says its rule, else `taken`. */
  readonly taken?: readonly { readonly path: string; readonly reason: "same" | "taken" }[];
}

export type Problem = { readonly rule: string; readonly path?: string; readonly detail: string };

/** A grader call its learning run's cap refused before it was sent (learning-ask.ts bookedAsk: the run's cap left, its
 *  launch's max_cost_usd): nothing of it was spent, and the grade is skipped, said so (said.noRoomToGrade), never run past
 *  the cap, never a failure. `forGood`: no room could ever send it (its spend or price unknown), not only none now. */
export class GradeOverCap extends Error {
  /** `booked`: the grade's records when it was refused (GradeBooked), what it spent before it. */
  constructor(message: string, readonly forGood: boolean, readonly booked?: GradeBooked) {
    super(message);
    this.name = "GradeOverCap";
  }
}

/** A generality check its learning run's cap refused before any of its requests left (learning-dispatch.ts general: its
 *  worst case over the cap left): nothing of it was sent or spent, and it is skipped as `unchecked` "no_budget"
 *  (GENERAL_NO_BUDGET), said so, the grader then judged against the cap on its own. `forGood`: no room could ever send it
 *  (its provider's price unknown here), not only none now. */
export class GeneralOverCap extends Error {
  constructor(message: string, readonly forGood: boolean) {
    super(message);
    this.name = "GeneralOverCap";
  }
}

/** The grade's own records after an ask (learning-ask.ts bookedAsk: its session's booking): what every grade request of
 *  the learning run spent, an earlier attempt's included (null: unknown, as a cut one's), and how many left. What the
 *  grade ends with is read from these, never summed in memory alone: a runner that restarted before the grade was saved
 *  holds no sum of what its earlier attempt spent. */
export type GradeBooked = { readonly usd: number | null; readonly turns: number };

/** The folder's one write (learn/commit.ts learningCommit), a merge. */
export interface MergeChange {
  readonly kind: "merge";
  readonly runId: string;
  /** The round of the run's looks back it merges, past the first (learn/folder.ts runDiffKey). */
  readonly round?: number;
  readonly reason: string;
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly held?: readonly string[];
  readonly graded: Readonly<Record<string, string>>;
  /** The run's seed: a skill's or a draft's file not on main as it was on it is a conflict, never written over. */
  readonly seed?: string;
  /** New notes written over main's note of the same name, each superseding it by name (takenOnMain). */
  readonly replace?: readonly string[];
  /** Each skill re-filed as a note, retired on main in the same write (its SKILL.md, and the note that replaces it). */
  readonly retire?: readonly { readonly skill: string; readonly note: string }[];
}

export type LearningCommitResult =
  | { readonly ok: true; readonly main: string; readonly commit: string; readonly files: readonly string[]; readonly left?: readonly { readonly path: string; readonly reason: "same" | "taken" }[]; readonly already?: true }
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
  /** The run that learned, from the learning run's launch row (its input's runId), and the round of its looks back the
   *  learning run grades (its input's round; absent, the first). */
  sourceOf(learningRunId: string): Promise<{ readonly runId: string; readonly round?: number; readonly agentId: string; readonly instructions?: string; readonly policyError?: string; readonly nativeInstructions?: true } | undefined>;
  /** Its kept proposal of that round (store.learning.proposal). */
  proposal(runId: string, round: number): Promise<LearningProposal | undefined>;
  /** The agent's learning folder (learn/folder.ts learningWorkspace): its Workspace, and its end, called once the run is
   *  done with it, whichever way it goes out. */
  folder(agentId: string): { readonly workspace: unknown; end(): Promise<void> };
  /** Main as the grader reads it, from the folder's snapshot; problems when the proposal can't be graded on it. */
  readMain(ws: unknown, proposal: KeptProposal): Promise<GradeMain | { readonly problems: readonly Problem[] }>;
  /** One grader call, through the kernel's model proxy and the cap, booked to the agent's learning meter. `beside`: what
   *  the grade spent outside its records, at most (the generality check's dollars, else its worst case), which the cap's
   *  room for the call leaves out. */
  ask(request: { readonly prompt: string; readonly maxTokens: number; readonly beside?: number }, signal: AbortSignal, run: GraderRun): Promise<{ readonly text: unknown; readonly usd: number | null; readonly tokens?: Tokens | null; readonly booked?: GradeBooked }>;
  /** The folder's one write. */
  commit(ws: unknown, change: MergeChange): Promise<LearningCommitResult>;
  /** The texts main holds at these note paths (learn/commit.ts mainTexts): a note the merge keeps whose name main
   *  already holds is settled alone (takenOnMain). */
  mainTexts(ws: unknown, paths: readonly string[]): Promise<Readonly<Record<string, string>>>;
  /** Run `runId`'s merge, when it is on main already (learn/folder.ts readRunDiff: its diff file, named by the run as its
   *  commit's Run-Id trailer names it; a resume after its commit, before its end was recorded): the texts its own commit
   *  holds at these note paths, as that merge saved them, whatever main says of them since. Undefined when it is not. */
  merged(ws: unknown, runId: string, paths: readonly string[], round?: number): Promise<{ readonly texts: Readonly<Record<string, string>> } | undefined>;
  /** The clock (epoch ms), for a parked run's wake. */
  now?(): number;
  /** The generality pre-check (learn/general.ts): each proposed note's Jev probability that it holds for inputs other
   *  than the one it came from, by file, and what it cost. Undefined, or one that answers undefined (no Jev key on this
   *  host), skips it: every note goes to the grader. One that throws (Jev down) skips it too: what it spent is unknown, and
   *  the skip is kept on the grade's entry (`unchecked`) and said in the log. `sending` is called once, before its first
   *  paid request leaves, with their worst case under a cap (`held`): the loop marks the check sent there, durably
   *  (journal-kinds.ts learningGeneralSent). Under a cap, `before` is what an earlier attempt's cut check may have spent
   *  (its worst case), which the room for this one leaves out; one that doesn't fit throws GeneralOverCap, sending nothing. */
  general?(notes: readonly NoteText[], source: GeneralSource, signal: AbortSignal, run: string, sending?: (held?: number) => Promise<void>, before?: number): Promise<GeneralScores | undefined>;
  /** The bar a note's score must reach to go on to the grader (default GENERAL_THRESHOLD). */
  generalThreshold?: number;
  /** One line of the runner's log. */
  log?(line: string): void;
}

const ROOT = ROOT_CONVERSATION_ID;

/** The journal's learning entries' data (journal-kinds.ts learningGraded, learningDropped, learningMerged), as the reader
 *  of a run's learning end reads them (store-reads/learning.ts). What a grade spent: its dollars and tokens, each null when
 *  any ask's are unknown. `unchecked`: why the generality pre-check could not run (its provider's error), so the grader read
 *  every note; the run's learning end says the check was skipped. */
export type GradedData = { readonly source: string; readonly verdict: Verdict; readonly usd: number | null; readonly tokens?: Tokens | null; readonly graded: Readonly<Record<string, string>>; readonly unchecked?: string };
export type DroppedData = { readonly source: string; readonly reason: string; readonly detail: string; readonly problems?: readonly Problem[]; readonly usd?: number | null; readonly tokens?: Tokens | null; readonly unchecked?: string };
/** `verdict`: each item's final decision once the merge settled it (takenOnMain's and the commit's left-out notes dropped,
 *  with their words), which the run's learning end reads in place of the grade's (store-reads/learning.ts). */
export type MergedData = { readonly source: string; readonly main: string; readonly commit: string; readonly files: readonly string[]; readonly detail: string; readonly verdict: Verdict };
type UnavailableData = { readonly source: string; readonly error: string };
/** The generality check's end (journal-kinds.ts learningGeneral): its scores, or why it could not run (GENERAL_NO_BUDGET:
 *  no room under the cap), and what it spent (null once unknown: a request that failed, or one an earlier attempt sent and
 *  a restart cut). `held`: under a cap, the most every attempt's requests may have spent (each sent mark's worst case), the
 *  bound the grader's room leaves out when `usd` is unknown. */
export type GeneralData = { readonly source: string; readonly scores?: Readonly<Record<string, number>>; readonly unchecked?: string; readonly usd: number | null; readonly held?: number };
/** A sent mark of the check (journal-kinds.ts learningGeneralSent): `held`, its requests' worst case under a cap. */
type GeneralSentData = { readonly source: string; readonly held?: number };

/** The graded item a proposal's file is judged as (grade.ts itemOf): a draft's README.md with its workflow.json, every
 *  other file as itself. */
const itemOf = (file: string): string => {
  const place = learnedPlace(file);
  return place?.kind === "readme" ? `workflows/${place.name}/workflow.json` : file;
};

/** The why of a note whose name main already holds with other text, which it does not supersede: never written over,
 *  and the rest of what the run learned merges. */
export const NOTE_NAME_TAKEN = (name: string) => `A note named ${name} was added since this run started, or was there already; this one wasn't kept.`;
/** The why of a skill re-filed as a note whose file this run's own kept note (or another re-filed skill) takes: the run's
 *  own stands, and the skill is not written over it. */
export const NOTE_NAME_IN_RUN = (name: string) => `This run also kept a note named ${name}, so the rule was not re-filed over it.`;

/** What `verdict` merges once each note it keeps (a new note's, or a skill's re-filed as one: its item's `note`) is set
 *  beside the run's other kept notes and what main holds at that file (`onMain`, by path), one item at a time, never a
 *  refusal of the whole merge. One file is one item's: a skill re-filed as a note whose file the run's own kept note
 *  (or an earlier re-filed skill) takes is dropped, saying so (NOTE_NAME_IN_RUN), so one text is written and the item
 *  that holds it is the one whose hold it keeps. Against main: a note main holds the same is no change, dropped unsaid
 *  (SAME_NOTE); one whose own front matter supersedes the note of its name is a modification, written over it
 *  (`replace`, main's blob in `graded`, so a change since is a conflict); any other is dropped, saying so
 *  (NOTE_NAME_TAKEN), and main's note stands. No suffixed name: it would hold the same rule twice. A rule another note
 *  holds is the merge's own to settle, against the main it commits on (learn/commit.ts mergeOf). Merge when the grader
 *  said so and it still keeps an item. */
/** Whether `held`, the note main holds at `file`, says the same rule as `text`: their bodies, whitespace and case aside
 *  (notes.ts ruleOf), as readMain and the merge's own settle (learn/commit.ts) read it, whatever their front matter. A
 *  text that is no note is the same only when it is the same text. */
/** The rule a re-filed note says (notes.ts ruleOf), "" when its text is no note: what the merge checks main still holds
 *  before it retires the skill that note replaces. */
const ruleOfText = (file: string, text: string): string => {
  const note = parseNoteFile(file, text);
  return Array.isArray(note) ? "" : ruleOf(note.body);
};

const sameRule = (file: string, held: string, text: string): boolean => {
  const [theirs, ours] = [parseNoteFile(file, held), parseNoteFile(file, text)];
  return !Array.isArray(theirs) && !Array.isArray(ours) ? ruleOf(theirs.body) === ruleOf(ours.body) : held === text;
};

export function takenOnMain(proposal: Pick<KeptProposal, "notes">, verdict: Verdict, onMain: Readonly<Record<string, string>>): { verdict: Verdict; replace: string[]; graded: Record<string, string> } {
  const texts = new Map(proposal.notes.map(({ file, text }) => [file, text]));
  const replace: string[] = [];
  const graded: Record<string, string> = {};
  const items = oneItemAFile(proposal, verdict).items.map((item) => {
    const note = item.note ?? (texts.has(item.file) ? { file: item.file, text: texts.get(item.file)! } : undefined);
    const held = item.keep && note ? onMain[note.file] : undefined;
    if (!note || held === undefined) return item;
    const identical = held === note.text || held === mergedNote(note.text, { origin: item.origin ?? "run", ...(item.pending ? { pending: true } : {}) });
    const parsed = parseNoteFile(note.file, note.text);
    // One that supersedes the note of its own name and is not the very text main holds: a modification, written over it.
    if (!identical && !item.note && !Array.isArray(parsed) && parsed.supersedes.includes(note.file)) {
      replace.push(note.file);
      graded[note.file] = blobOid(held);
      return item;
    }
    // Else the same rule an active note of main keeps (whatever its front matter, case or spacing) is no change, dropped
    // unsaid, and a skill re-filed as it retired (mergeChangeOf); a retired or superseded note of that rule keeps it out
    // of every run, so it is a name main holds, and nothing is retired: the rule never vanishes. Any other is a name main
    // holds with another rule.
    const theirs = parseNoteFile(note.file, held);
    const same = !Array.isArray(theirs) && theirs.status === "active" && (identical || sameRule(note.file, held, note.text));
    return { file: item.file, keep: false, question: "Duplicate", why: same ? SAME_NOTE : NOTE_NAME_TAKEN(note.file.replace(/\.md$/, "")), ...(item.note ? { note: item.note } : {}) };
  });
  return { verdict: { ...verdict, items, merge: verdict.merge && items.some((item) => item.keep) }, replace, graded };
}

/** `verdict` with one item per file a kept note is written as, within the run: the files the run's own kept notes are,
 *  then each re-filed skill's as it is kept; a re-filed skill whose note file one of those takes is left out, saying so
 *  (NOTE_NAME_IN_RUN). The merge (takenOnMain) and its resume (resumedOf, from the saved grade) settle it the one way. */
export function oneItemAFile(proposal: Pick<KeptProposal, "notes">, verdict: Verdict): Verdict {
  const own = new Set(proposal.notes.map(({ file }) => file));
  const claimed = new Set(verdict.items.filter((item) => item.keep && !item.note && own.has(item.file)).map((item) => item.file));
  const items = verdict.items.map((item) => {
    if (!item.keep || !item.note) return item;
    if (claimed.has(item.note.file)) return { file: item.file, keep: false, question: "Duplicate", why: NOTE_NAME_IN_RUN(item.note.file.replace(/\.md$/, "")) };
    claimed.add(item.note.file);
    return item;
  });
  return { ...verdict, items, merge: verdict.merge && items.some((item) => item.keep) };
}

/** `proposal` with only what `verdict` keeps (a verdict per item): a note or file its item keeps or holds; a skill its
 *  item re-filed (`note`: a standing rule for every reply) is kept as that note instead, never as a skill. */
export function keptOf(proposal: KeptProposal, verdict: Verdict): KeptProposal {
  if (!verdict.items.length) return proposal;
  const kept = new Set(verdict.items.filter((item) => item.keep && !item.note).map((item) => item.file));
  const refiled = verdict.items.flatMap((item) => (item.keep && item.note ? [item.note] : []));
  return { ...proposal, notes: [...proposal.notes.filter(({ file }) => kept.has(file)), ...refiled], files: (proposal.files ?? []).filter(({ file }) => kept.has(itemOf(file))) };
}

/** Each item the verdict keeps by the file it is merged as: a re-filed skill's item by its note's file too. A dropped
 *  item names no file it merges as; of two kept items for one file (takenOnMain lets none through), the held one stands,
 *  so a hold is never lost to the order of the items. */
const itemsByFile = (verdict: Verdict): Map<string, Verdict["items"][number]> => {
  const byFile = new Map<string, Verdict["items"][number]>();
  for (const item of verdict.items.filter((one) => one.keep)) {
    for (const file of [item.file, ...(item.note ? [item.note.file] : [])]) if (!byFile.get(file)?.pending) byFile.set(file, item);
  }
  return byFile;
};

/** The merge of `merging` (what the verdict kept), the one rule learningCommit's merge is made by: each note with
 *  the origin its item gives (`you` for the user's own words, else the run's) and held for its owner's OK when its item
 *  is pending; a skill's SKILL.md or a draft's README.md held when its item is (a draft's workflow.json is held by its
 *  README); and the seed the source run started from, so a skill's or draft's file changed on main since is a conflict. */
export function mergeChangeOf(runId: string, merging: KeptProposal, verdict: Verdict, graded: Readonly<Record<string, string>>, round = 1): MergeChange {
  const judged = itemsByFile(verdict);
  const notes = merging.notes.map(({ file, text }) => ({ path: file, text: mergedNote(text, { origin: judged.get(file)?.origin ?? "run" }) }));
  const files = (merging.files ?? []).map(({ file, text }) => ({ path: file, text }));
  const held = [
    ...merging.notes.filter(({ file }) => judged.get(file)?.pending === true).map(({ file }) => file),
    ...files.filter(({ path }) => learnedPlace(path)?.kind !== "workflow" && judged.get(itemOf(path))?.pending === true).map(({ path }) => path),
  ];
  // Each skill re-filed as a note is retired on main in the same write (learn/commit.ts mergeOf): a kept one, and one
  // main already holds the same rule of as a note (dropped unsaid), so no old skill stays served beside its note.
  const retire = verdict.items.flatMap((item) => (item.note && (item.keep || item.why === SAME_NOTE) && learnedPlace(item.file)?.kind === "skill" ? [{ skill: item.file, note: item.note.file, rule: ruleOfText(item.note.file, item.note.text) }] : []));
  return {
    kind: "merge", runId, ...(round > 1 ? { round } : {}), reason: verdict.reason || "The grader kept every new note.", files: [...notes, ...files],
    ...(held.length ? { held } : {}), graded, ...(merging.seed ? { seed: merging.seed } : {}), ...(retire.length ? { retire } : {}),
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

/** `merging` and `verdict` once the merge left out `left` (learn/commit.ts LeftNote): each note it left out is no longer
 *  merged, and its item is dropped, unsaid when its rule is held already (SAME_NOTE), else saying its name is taken. */
export function leftOf(merging: KeptProposal, verdict: Verdict, left: readonly { readonly path: string; readonly reason: "same" | "taken" }[]): { merging: KeptProposal; verdict: Verdict } {
  if (!left.length) return { merging, verdict };
  const why = new Map(left.map(({ path, reason }) => [path, reason === "same" ? SAME_NOTE : NOTE_NAME_TAKEN(path.replace(/\.md$/, ""))]));
  const items = verdict.items.map((item) => {
    const file = item.note?.file ?? item.file;
    return item.keep && why.has(file) ? { file: item.file, keep: false, question: "Duplicate", why: why.get(file)!, ...(item.note ? { note: item.note } : {}) } : item;
  });
  return { merging: { ...merging, notes: merging.notes.filter(({ file }) => !why.has(file)) }, verdict: { ...verdict, items } };
}

/** What a merge already on main settled (learn/commit.ts: its files, and `left`, the new notes it did not write): each
 *  note the grade kept is kept when the merge wrote it, its path changed and main holding its rule there now (`onMain`,
 *  the texts main holds at the kept notes' paths), else left out, saying why as takenOnMain said it (`taken`, its
 *  verdict after main was read), or by main's text there (the same rule, or a name it holds with another), else as the
 *  commit does. Skills and drafts as the grade kept them. */
export function resumedOf(proposal: KeptProposal, graded: Verdict, taken: Verdict, result: { readonly files: readonly string[]; readonly left?: readonly { readonly path: string; readonly reason: "same" | "taken" }[] }, onMain: Readonly<Record<string, string>>): { merging: KeptProposal; verdict: Verdict } {
  const written = new Set(result.files);
  const texts = new Map(proposal.notes.map(({ file, text }) => [file, text]));
  const said = new Map((result.left ?? []).map(({ path, reason }) => [path, reason]));
  const notes = new Set(proposal.notes.map(({ file }) => file));
  // One item per file, as the first attempt's takenOnMain settled it: the saved grade keeps both a run's note and a skill
  // re-filed as a note of its file, and only one of them was written.
  const settled = oneItemAFile(proposal, graded);
  const items = settled.items.map((item, i) => {
    const file = item.note?.file ?? item.file;
    if (!item.keep || !(item.note || notes.has(file))) return item;
    // Saved: the merge changed its path and main holds its rule there now (`onMain`, read after the merge). A path the
    // merge changed for another reason (a note it marked superseded) holds another rule, and saves no item of its own.
    const text = item.note?.text ?? texts.get(file);
    const held = onMain[file];
    if (written.has(file) && (held === undefined || text === undefined || sameRule(file, held, text))) return item;
    const before = taken.items[i];
    if (before && !before.keep && before.why !== SAME_NOTE) return before;
    const same = held !== undefined && text !== undefined ? sameRule(file, held, text) : said.get(file) !== "taken";
    const why = same ? SAME_NOTE : NOTE_NAME_TAKEN(file.replace(/\.md$/, ""));
    return { file: item.file, keep: false, question: "Duplicate", why, ...(item.note ? { note: item.note } : {}) };
  });
  const verdict = { ...settled, items };
  return { merging: keptOf(proposal, verdict), verdict };
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
    /** Aborted by a person's stop (a stop row): the grade's request is cut at once, never left running past it, while the
     *  claim's signal stays whole so the stopped end is still written. */
    const stopAsk = new AbortController();

    return {
      async command(_command: Command): Promise<CommandOutcome> {
        return { refused: "a learning run takes no messages or answers" };
      },
      async stop(reason: StopReason): Promise<void> {
        stopped = reason;
        if (reason.kind === "command") stopAsk.abort(new Error("the run was stopped"));
      },
      async start(claim: Claim): Promise<LoopEnd> {
        const context: Context = withAbortSignal(deps.signal, BACKGROUND_CONTEXT);
        const journal: Journal = deps.journal(claim);
        let rooted = false;
        /** What the grade spent, as the run's learning end reads it (store-reads/learning.ts runLearningEnd): the graded
         *  entry's, a failed or cut grade's (null: unknown), else nothing graded, 0. Kept as the learning run's cost when it
         *  ends ended, failed or stopped, so what learning spent reads from the run rows alone (store learning.spend): a
         *  stop seen after a paid grade never hides it. */
        let spend: number | null = 0;
        /** One entry on the root, committed; `end` stages the run's state with it (keyed to this entry, its effect), and
         *  `take` the stop row it applies. An end that ends, fails or stops the run keeps what the grade spent as its cost. */
        const append = async (kind: string, data: unknown, end?: "ended" | "failed" | "stopped" | "parked", take?: number) => {
          const writes: StorageWrite[] = [];
          if (kind === KINDS.learningDropped && data !== null && typeof data === "object" && "usd" in data) spend = (data as DroppedData).usd ?? null;
          if (!rooted && !(await journal.conversation(ROOT, context))) writes.push({ type: "conversation", value: { id: ROOT } } as StorageWrite);
          const id = await journal.mintId();
          writes.push({ type: "entry", value: { id, conversationId: ROOT, kind, data } } as StorageWrite);
          if (end) journal.stage({ run: { state: end, ...(end === "parked" ? {} : { costUsd: spend }) }, effect: id, ...(take !== undefined ? { take: [{ command: take, effect: id }] } : {}) });
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
        if (source.policyError) {
          await append(KINDS.learningDropped, { source: source.runId, reason: "checker", detail: source.policyError } satisfies DroppedData, "ended");
          return { state: "ended" };
        }
        const round = source.round ?? 1;
        const kept = await learning.proposal(source.runId, round);
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
          if (graded) spend = graded.usd;
          if (!graded) {
            const main = await learning.readMain(ws, proposal);
            if ("problems" in main) {
              await append(KINDS.learningDropped, { source: source.runId, reason: "checker", detail: said.stale(main.problems as never), problems: main.problems } satisfies DroppedData, "ended");
              return { state: "ended" };
            }
            // A note named like one main holds now is settled alone, out of the grade (readMain's `taken`); the rest is
            // graded. Nothing left to grade keeps nothing.
            const taken = new Map((main.taken ?? []).map(({ path, reason }) => [path, reason]));
            let grading = proposal.notes.filter(({ file }) => !taken.has(file));
            const settledItems: VerdictItem[] = [...taken].map(([file, reason]) => ({ file, keep: false, question: "Duplicate", why: reason === "same" ? SAME_NOTE : NOTE_NAME_TAKEN(file.replace(/\.md$/, "")) }));
            // What the grader spends, as the server's grade counted it (grade.ts counter): each ask's dollars and tokens
            // added, either unknown (null) once any ask's is, and an ask that fails spent what nobody knows.
            let usd: number | null = 0;
            let tokens: Tokens | null = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
            // What the generality pre-check's Jev requests spent (its kept dollars, null once unknown), outside the
            // grader's records, and the most they may have spent (`beside`: those dollars, else their worst case), which
            // each grader call's room under the cap leaves out. The grade ends with both: Jev's and the grader's.
            let checkUsd: number | null = 0;
            let beside = 0;
            const spent = (): number | null => (checkUsd === null || usd === null ? null : checkUsd + usd);
            // The generality pre-check: a note Jev scores under the bar rests on its one input, and is dropped before the
            // grader reads it, its why said with the grader's items. Jev down or not set up here: every note is graded.
            let screened = false;
            // Why the check could not run, kept on the grade's (or the drop's) entry: never a silent skip.
            let unchecked: string | undefined;
            if (grading.length && learning.general) {
              const threshold = learning.generalThreshold ?? GENERAL_THRESHOLD;
              const input = proposal.asked?.[0] ?? proposal.triggered?.[0]?.text;
              // The check is paid and Jev dedupes none, so it is made durable as the grade's ask is (learning-ask.ts
              // bookedAsk): marked sent before its requests leave, and its end kept before the grader starts. A restart
              // reuses a check that ended, paying nothing again; one an earlier attempt sent with no end after it was cut,
              // what it spent is unknown (null, as a cut grade request is booked before it is asked again), and it is
              // asked again with that unknown kept.
              let ended = [...entries].reverse().find((entry) => entry.kind === KINDS.learningGeneral)?.data as GeneralData | undefined;
              if (!ended) {
                const sentMarks = entries.filter((entry) => entry.kind === KINDS.learningGeneralSent);
                const cut = sentMarks.length > 0;
                if (cut) learning.log?.(`learning run ${claim.runId}: a generality check an earlier attempt sent was cut, so what it spent is unknown; it is asked again`);
                // Under a cap: the most the cut attempts' requests may have spent (each mark's worst case), and this one's.
                const cutHeld = sentMarks.reduce((sum, entry) => sum + ((entry.data as GeneralSentData | undefined)?.held ?? 0), 0);
                let sentHeld = 0;
                let checked: GeneralScores | undefined;
                let failed: string | undefined;
                let overCap: GeneralOverCap | undefined;
                try {
                  checked = await learning.general(grading, { ...(source.instructions ? { job: source.instructions } : {}), ...(input !== undefined ? { input } : {}) }, AbortSignal.any([deps.signal, stopAsk.signal]), source.runId, async (held) => {
                    sentHeld += held ?? 0;
                    await append(KINDS.learningGeneralSent, { source: source.runId, ...(held !== undefined ? { held } : {}) } satisfies GeneralSentData);
                    await deps.flush();
                  }, cutHeld);
                } catch (error) {
                  // Cut by a stop, a lost claim or a shutdown: what it sent spent what nobody knows. A stop row ends the run
                  // stopped with that unknown; otherwise nothing more is written, and the next attempt finds it sent with no
                  // end, books it unknown and asks again.
                  if (stopped || deps.signal.aborted) {
                    spend = null;
                    return (await halted()) ?? { state: "interrupted" };
                  }
                  // No room under the run's cap for its worst case: nothing sent, skipped, said so (never silent), and the
                  // grader judged against the cap on its own.
                  if (error instanceof GeneralOverCap) overCap = error;
                  else {
                    // Its requests were sent and one failed: what they spent is unknown, never 0 (as an ask that fails is).
                    // Its error is kept and logged cut of the runner's secrets (LoopDeps.redact).
                    const message = (error as Error)?.message ?? String(error);
                    failed = deps.redact ? deps.redact(message) : message;
                    learning.log?.(`learning run ${claim.runId}: the generality check could not run, so the grader reads every note: ${failed}`);
                  }
                }
                const held = cutHeld + sentHeld;
                const bound = held > 0 ? { held } : {};
                if (checked) ended = { source: source.runId, scores: checked.scores, usd: cut ? null : checked.usd, ...bound };
                else if (overCap) {
                  learning.log?.(`learning run ${claim.runId}: the generality check has no room under the cap (${overCap.message}), so the grader reads every note`);
                  ended = { source: source.runId, unchecked: GENERAL_NO_BUDGET, usd: cut ? null : 0, ...bound };
                } else if (failed !== undefined) ended = { source: source.runId, unchecked: failed, usd: null, ...bound };
                else if (cut) ended = { source: source.runId, unchecked: "no Jev is set up on this host now", usd: null, ...bound };
                // Kept, durably, before the grader starts: a restart from here on asks Jev nothing.
                if (ended) {
                  await append(KINDS.learningGeneral, ended);
                  await deps.flush();
                }
              }
              if (ended) {
                checkUsd = ended.usd;
                beside = ended.usd ?? ended.held ?? 0;
                if (ended.unchecked !== undefined) unchecked = ended.unchecked;
                if (ended.scores) {
                  screened = true;
                  const scores = ended.scores;
                  const below = grading.filter(({ file }) => typeof scores[file] === "number" && scores[file]! < threshold);
                  settledItems.push(...below.map(({ file }) => ({ file, keep: false, question: "General", why: ONE_CASE(scores[file]!, threshold) })));
                  grading = grading.filter((note) => !below.includes(note));
                }
              }
            }
            // The notes the graded ones supersede, of those main gave: a dropped note's are not the grade's.
            const replacing = new Set(grading.flatMap((note) => { const parsed = parseNoteFile(note.file, note.text); return Array.isArray(parsed) ? [] : parsed.supersedes; }));
            const superseded = main.superseded.filter(({ file }) => replacing.has(file));
            if (!grading.length && !proposal.files?.length) {
              const verdict: Verdict = { merge: false, reason: settledItems.some(({ question }) => question === "General") ? "No new note holds beyond the one input it came from, or each is named like one the agent holds now." : "Every new note is named like one the agent holds now.", items: settledItems };
              // A proposal the generality check emptied is recorded as a grade (its verdict, each item's why, what the check
              // spent) before it is dropped, so the run's learning reads why each note was left out.
              if (screened) await append(KINDS.learningGraded, { source: source.runId, verdict, usd: spent(), tokens, graded: main.graded } satisfies GradedData);
              await append(KINDS.learningDropped, { source: source.runId, reason: "grader", detail: notKept(verdict, lostOf(proposal)), usd: spent(), tokens } satisfies DroppedData, "ended");
              return { state: "ended" };
            }
            const items = gradedItems(grading as NoteText[], (proposal.files ?? []) as NoteText[]);
            let prompt: string;
            try { prompt = gradePrompt({
              run: source.runId, ...(source.instructions ? { instructions: source.instructions } : {}), active: main.active, superseded, proposed: grading,
              ...(source.nativeInstructions?{nativeInstructions:true}:{}),
              ...(proposal.files?.length ? { files: proposal.files } : {}), ...(proposal.dryRuns ? { dryRuns: proposal.dryRuns } : {}), ...(proposal.drafted?.length ? { drafted: proposal.drafted } : {}), ...(proposal.asked ? { asked: proposal.asked } : {}), ...(proposal.triggered ? { triggered: proposal.triggered } : {}), ...(proposal.held ? { held: proposal.held } : {}),
            }); } catch (error) {
              // A full native policy can fill the remaining prompt budget. Refuse the whole proposal visibly;
              // no grader was called and no standing instruction or proposal is silently omitted.
              // Keep what the generality pre-check already spent.
              await append(KINDS.learningDropped, { source: source.runId, reason: "checker", detail: error instanceof Error ? error.message : "The grading evidence exceeds the supported prompt budget.", usd: spent(), tokens, ...(unchecked !== undefined ? { unchecked } : {}) } satisfies DroppedData, "ended");
              return { state: "ended" };
            }
            /** The asks of this attempt that answered: the records holding more requests than these is an earlier attempt's. */
            let answered = 0;
            // Once an ask read the grade's records (`booked`), its dollars are theirs: an earlier attempt's requests counted too.
            const fromRecords = (booked: GradeBooked | undefined) => {
              if (!booked) return;
              usd = booked.usd;
              // A request an earlier attempt sent (a restart before the grade was saved): its dollars are in the records,
              // its tokens in nothing this attempt read, so they are unknown, never none.
              if (booked.turns > answered) tokens = null;
            };
            // `again`: what the grade is told after its last answer, below the same prompt.
            const ask = async (again?: string) => {
              // Stopped before this ask: nothing is sent, so nothing of it is spent (what it spent stays as it was).
              if (stopAsk.signal.aborted) throw stopAsk.signal.reason;
              const timer = AbortSignal.timeout(GRADE_TIMEOUT_MS);
              let answer: Awaited<ReturnType<LearningLoopDeps["ask"]>>;
              try {
                answer = await learning.ask({ prompt: again ? `${prompt}\n\n${again}` : prompt, maxTokens: GRADE_MAX_TOKENS, ...(beside > 0 ? { beside } : {}) }, AbortSignal.any([deps.signal, timer, stopAsk.signal]), { journal: () => deps.journal(claim), flush: () => deps.flush() });
              } catch (error) {
                // A call the cap refused was never sent: it spent nothing, and what the grade spent before it stands, as its
                // records hold it (an earlier attempt's included).
                if (error instanceof GradeOverCap) fromRecords(error.booked);
                else {
                  usd = null;
                  tokens = null;
                }
                throw error;
              }
              answered += 1;
              usd = usd === null || answer.usd === null || !Number.isFinite(answer.usd) ? null : usd + answer.usd;
              const more = answer.tokens ?? null;
              tokens = tokens === null || more === null ? null : { input: tokens.input + more.input, cache_read: tokens.cache_read + more.cache_read, cache_write: tokens.cache_write + more.cache_write, output: tokens.output + more.output };
              fromRecords(answer.booked);
              return answer.text;
            };
            let verdict: Verdict;
            try {
              verdict = parseVerdict(await ask(), items, proposal.held);
              // An answer the host cannot read is asked once more, as the server's grade did.
              if (verdict.reason === UNREADABLE_REASON && !verdict.items.length) verdict = parseVerdict(await ask(), items, proposal.held);
              // One that kept every item and said no merge contradicts itself: asked once more, the contradiction named. A
              // second contradiction stands as no merge, said in the host's words as twice (learning-words.ts notKept); a
              // contradiction after an unreadable answer is one, and is said so.
              else if (verdict.reason === CONTRADICTED_REASON) {
                const again = parseVerdict(await ask(CONTRADICTION_ASK), items, proposal.held);
                verdict = again.reason === CONTRADICTED_REASON ? { ...again, reason: CONTRADICTED_TWICE_REASON } : again;
              }
            } catch (error) {
              // What the asks spent (and the check before them): a cut one's unknown (null), kept on a stopped run's row as
              // on a dropped one's.
              spend = spent();
              const end = await halted();
              if (end) return end;
              // No room under the run's cap for the grade (a call the cap refused): skipped, said so, with what it spent
              // before (an earlier ask's), never a failure and never past the cap.
              if (error instanceof GradeOverCap) {
                await append(KINDS.learningDropped, { source: source.runId, reason: "no_budget", detail: error.forGood ? said.gradeUncapped : said.noRoomToGrade, usd: spent(), tokens, ...(unchecked !== undefined ? { unchecked } : {}) } satisfies DroppedData, "ended");
                return { state: "ended" };
              }
              await append(KINDS.learningDropped, { source: source.runId, reason: "grade_failed", detail: said.stopped(STOPPED.noReview), usd: spent(), tokens, ...(unchecked !== undefined ? { unchecked } : {}) } satisfies DroppedData, "ended");
              void error;
              return { state: "ended" };
            }
            if (settledItems.length) verdict = { ...verdict, items: [...verdict.items, ...settledItems] };
            graded = { source: source.runId, verdict, usd: spent(), tokens, graded: main.graded, ...(unchecked !== undefined ? { unchecked } : {}) };
            spend = graded.usd;
            await append(KINDS.learningGraded, graded);
            // The verdict is durable before the merge, its side effect.
            await deps.flush();
          }
          const halt = await halted();
          if (halt) return halt;

          // Each note it keeps whose file main already holds (another run merged one by that name since, or a skill
          // re-filed as one) is settled alone (takenOnMain): never written over unless it supersedes it, and never a
          // refusal of everything else the run learned. Not when this run's own merge is on main already (the runner
          // stopped after its commit, before it recorded it): the notes there are that merge's, never "already there", so
          // the grade's verdict goes to the commit, which answers with that merge, and each item is settled by the text that
          // merge's own commit holds at its file (resumedOf: its rule there, not only a changed path, and never main's
          // text now, which a person may have edited since).
          const notePaths = graded.verdict.items.flatMap((item) => (!item.keep ? [] : item.note ? [item.note.file] : proposal.notes.some(({ file }) => file === item.file) ? [item.file] : []));
          let onMain: Readonly<Record<string, string>> = {};
          let already = false;
          try {
            const merge = await learning.merged(ws, source.runId, notePaths, source.round);
            already = merge !== undefined;
            onMain = merge ? merge.texts : notePaths.length ? await learning.mainTexts(ws, notePaths) : {};
          } catch (error) {
            // Main could not be read: parked as for a write that could not reach the folder, tried again after a backoff.
            await append(KINDS.learningUnavailable, { source: source.runId, error: (error as Error)?.message ?? String(error) } satisfies UnavailableData, "parked");
            return { state: "parked", wakeAt: now() + UNAVAILABLE_BACKOFF_MS[Math.min(unavailable, UNAVAILABLE_BACKOFF_MS.length - 1)]! };
          }
          const taken = already ? { verdict: oneItemAFile(proposal, graded.verdict), replace: [], graded: {} } : takenOnMain(proposal, graded.verdict, onMain);
          const verdict = taken.verdict;
          const merging = keptOf(proposal, verdict);
          const change = mergeChangeOf(source.runId, merging, verdict, { ...graded.graded, ...taken.graded }, round);
          // Nothing new left to merge: dropped, unless the grader kept a re-filed skill whose rule main already holds as a
          // note (takenOnMain's SAME_NOTE). Its old SKILL.md is still retired (mergeChangeOf's retire), in a write of that
          // alone, so no old skill stays served beside the note.
          if (!verdict.merge && !(graded.verdict.merge && change.retire?.length)) {
            await append(KINDS.learningDropped, { source: source.runId, reason: "grader", detail: notKept(verdict, lostOf(proposal)) } satisfies DroppedData, "ended");
            return { state: "ended" };
          }
          const result = await learning.commit(ws, taken.replace.length ? { ...change, replace: taken.replace } : change);
          if (result.ok) {
            // What the merge left out against the main it committed on (a rule a note holds, a name one holds), each
            // item alone: said as takenOnMain says it, and nothing of it learned.
            // A merge already on main (a resume after its commit): what it wrote is what its files say, so each note is
            // settled by the files: one written is kept as the grade kept it, one not written is left out (as takenOnMain
            // or the commit says why).
            const settled = result.already ? resumedOf(proposal, graded.verdict, verdict, result, onMain) : leftOf(merging, verdict, result.left ?? []);
            if (!settled.verdict.items.some((item) => item.keep) && !result.files.length) {
              await append(KINDS.learningDropped, { source: source.runId, reason: "grader", detail: notKept(settled.verdict, lostOf(proposal)) } satisfies DroppedData, "ended");
              return { state: "ended" };
            }
            // A write that retired a skill alone learned nothing new: said so.
            const detail = mergedWords(settled.merging, settled.verdict, checked) || said.empty;
            await append(KINDS.learningMerged, { source: source.runId, main: result.main, commit: result.commit, files: result.files, detail, verdict: settled.verdict } satisfies MergedData, "ended");
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
