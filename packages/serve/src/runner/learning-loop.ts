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
import { besideCost, besideRoom, GRADE_CAPS, gradedItems, gradePrompt, parseVerdict, UNREADABLE_REASON, type IndexEntry, type NoteText, type Verdict } from "../learn/grade.js";
import { mergedNote, parseNoteFile, ruleOf } from "../learn/notes.js";
import type { LearnedFile, NoteLearned, Tokens } from "../learning.js";
import { learnedPlace, SKILLS_DIR, WORKFLOWS_DIR } from "../learn/skills.js";
import { blobOid } from "../learn/folder.js";
import { notKept, SAME_NOTE, said, STOPPED } from "../learning-words.js";
import { journalEntries } from "./journal-reader.js";
import { changedLast, clustersOf, clustersWithin, consolidatePrompt, heldToClusters, partnersOf, rankOf } from "../learn/consolidate.js";
import type { ConsolidationMain } from "../learn/commit.js";
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
  /** The proposal's notes named like a note main holds, left out of the grade and settled alone (learn/commit.ts
   *  readMain): `same` when main's note says its rule, else `taken`. */
  readonly taken?: readonly { readonly path: string; readonly reason: "same" | "taken" }[];
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
   *  already holds is settled alone (takenOnMain). */
  mainTexts(ws: unknown, paths: readonly string[]): Promise<Readonly<Record<string, string>>>;
  /** Whether run `runId`'s merge is on main already (learn/folder.ts readRunDiff: its diff file, named by the run as its
   *  commit's Run-Id trailer names it): a resume after its commit, before its end was recorded. */
  merged(ws: unknown, runId: string): Promise<boolean>;
  /** The clock (epoch ms), for a parked run's wake. */
  now?(): number;
  /** Consolidation (learn/consolidate.ts), all of it or none: a loop without it never runs one and never queues one. */
  consolidation?: ConsolidationDeps;
}

/** What a learning loop consolidates with: each part required, so none is ever half there. */
export interface ConsolidationDeps {
  /** A consolidation run: its agent, the agent's instructions and tools, and the pairs a merge put out of step, from its
   *  launch; undefined for a run that grades another run's learning. */
  of(learningRunId: string): Promise<Consolidation | undefined>;
  /** What a consolidation reads of main (learn/commit.ts consolidationMain): undefined when the folder has none. */
  main(ws: unknown): Promise<ConsolidationMain | undefined>;
  /** Each note's runs given it and that read it (the learning view's `runs`), for the rank. */
  noteRuns(agentId: string): Promise<ReadonlyMap<string, { readonly given: number; readonly read: number }>>;
  /** The checks over a consolidation's answer, against main as `seed` (propose.ts proposeRun, as a run's end-of-run turn
   *  is checked): the proposal kept, or why nothing is. */
  checkAnswer(ws: unknown, input: { readonly seed: string; readonly answer: string; readonly tools?: readonly string[] }): Promise<CheckedAnswer>;
  /** After a merge of a run's learning, before its learning run (`learningRunId`) ends: whether a consolidation is due
   *  for its agent (learn/consolidate.ts consolidationDue), and queue it. A throw parks the learning run, which asks
   *  again when it wakes (its merge is on main already). */
  afterMerge(ws: unknown, merged: { readonly agentId: string; readonly runId: string; readonly learningRunId: string }): Promise<void>;
}

/** A consolidation run's own facts, from its launch. */
export type Consolidation = { readonly agentId: string; readonly instructions?: string; readonly tools?: readonly string[]; readonly pairs: readonly { readonly skill: string; readonly workflow: string; readonly changed: "skill" | "workflow" }[] };
/** What the checks kept of a consolidation's answer, or why nothing. */
export type CheckedAnswer = { readonly state: "proposed"; readonly proposal: KeptProposal; readonly left?: readonly Problem[] } | { readonly state: "dropped"; readonly reason: string; readonly detail?: string; readonly problems?: readonly Problem[] };
/** A consolidation's journal entry (journal-kinds.ts learningConsolidation): its proposal held to its clusters, what the
 *  checks and the hold left out, the notes that stay active, what its ask spent, and `beside`, the other side of each
 *  pair the proposal writes one side of, as main holds it (the grader compares the two, and grades neither). */
type ConsolidationData = { readonly proposal: KeptProposal; readonly left: readonly Problem[]; readonly stayActive: readonly string[]; readonly usd: number | null; readonly beside?: readonly NoteText[] };

const ROOT = ROOT_CONVERSATION_ID;

/** A skill's or a draft's key file: its SKILL.md, or its workflow.json. */
const keyFileOf = ({ kind, name }: { readonly kind: "skill" | "workflow"; readonly name: string }): string => (kind === "skill" ? `${SKILLS_DIR}/${name}/SKILL.md` : `${WORKFLOWS_DIR}/${name}/workflow.json`);

/** On consolidation's read of main: the companions of a side (`target`), every partner of it (partnersOf) as main holds
 *  it, a draft's workflow.json and README.md, a skill's SKILL.md, less any in `written`. */
const companionsOn = (main: { readonly skills: readonly { readonly name: string; readonly text: string }[]; readonly workflows: readonly { readonly name: string; readonly json: string; readonly readme: string }[] }, partners: readonly { readonly skill: string; readonly workflow: string }[]) =>
  (target: { readonly kind: "skill" | "workflow"; readonly name: string }, written: ReadonlySet<string>): NoteText[] =>
    partners.filter((pair) => pair[target.kind] === target.name).flatMap((pair): NoteText[] => {
      if (target.kind === "workflow") {
        const skill = main.skills.find(({ name }) => name === pair.skill);
        return skill ? [{ file: keyFileOf({ kind: "skill", name: skill.name }), text: skill.text }] : [];
      }
      const workflow = main.workflows.find(({ name }) => name === pair.workflow);
      return workflow ? [{ file: keyFileOf({ kind: "workflow", name: workflow.name }), text: workflow.json }, { file: `${WORKFLOWS_DIR}/${workflow.name}/README.md`, text: workflow.readme }] : [];
    }).filter(({ file }) => !written.has(file));

/** The notes a new note supersedes, by its front matter; none for one that does not parse. */
const parseNoteFileOr = ({ file, text }: { readonly file: string; readonly text: string }): { supersedes: readonly string[] } => {
  const note = parseNoteFile(file, text);
  return Array.isArray(note) ? { supersedes: [] } : note;
};

/** The journal's learning entries' data (journal-kinds.ts learningGraded, learningDropped, learningMerged), as the reader
 *  of a run's learning end reads them (store-reads/learning.ts). What a grade spent: its dollars and tokens, each null when
 *  any ask's are unknown. */
export type GradedData = { readonly source: string; readonly verdict: Verdict; readonly usd: number | null; readonly tokens?: Tokens | null; readonly graded: Readonly<Record<string, string>> };
export type DroppedData = { readonly source: string; readonly reason: string; readonly detail: string; readonly problems?: readonly Problem[]; readonly usd?: number | null; readonly tokens?: Tokens | null };
/** `verdict`: each item's final decision once the merge settled it (takenOnMain's and the commit's left-out notes dropped,
 *  with their words), which the run's learning end reads in place of the grade's (store-reads/learning.ts). */
export type MergedData = { readonly source: string; readonly main: string; readonly commit: string; readonly files: readonly string[]; readonly detail: string; readonly verdict: Verdict };
type UnavailableData = { readonly source: string; readonly error: string };

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
    // Else the same rule (whatever its front matter, case or spacing) is no change, dropped unsaid; any other is a name
    // main holds with another rule.
    const same = identical || sameRule(note.file, held, note.text);
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
export function mergeChangeOf(runId: string, merging: KeptProposal, verdict: Verdict, graded: Readonly<Record<string, string>>): MergeChange {
  const judged = itemsByFile(verdict);
  const notes = merging.notes.map(({ file, text }) => ({ path: file, text: mergedNote(text, { origin: judged.get(file)?.origin ?? "run" }) }));
  const files = (merging.files ?? []).map(({ file, text }) => ({ path: file, text }));
  const held = [
    ...merging.notes.filter(({ file }) => judged.get(file)?.pending === true).map(({ file }) => file),
    ...files.filter(({ path }) => learnedPlace(path)?.kind !== "workflow" && judged.get(itemOf(path))?.pending === true).map(({ path }) => path),
  ];
  // Each skill re-filed as a note is retired on main in the same write (learn/commit.ts mergeOf): a kept one, and one
  // main already holds the same rule of as a note (dropped unsaid), so no old skill stays served beside its note.
  const retire = verdict.items.flatMap((item) => (item.note && (item.keep || item.why === SAME_NOTE) && learnedPlace(item.file)?.kind === "skill" ? [{ skill: item.file, note: item.note.file }] : []));
  return {
    kind: "merge", runId, reason: verdict.reason || "The grader kept every new note.", files: [...notes, ...files],
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
        /** What the grade spent, as the run's learning end reads it (store-reads/learning.ts runLearningEnd): the graded
         *  entry's, a failed or cut grade's (null: unknown), else nothing graded, 0. Kept as the learning run's cost when it
         *  ends ended, failed or stopped, so what learning spent reads from the run rows alone (store learning.spend): a
         *  stop seen after a paid grade never hides it. */
        let spend: number | null = 0;
        /** A consolidation run's own ask's spend, before its grade's (0 for a run that grades another run's learning): a
         *  consolidation's cost is both, its ask's and its grade's, on its row as any learning run's. */
        let asked: number | null = 0;
        const plus = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
        /** One entry on the root, committed; `end` stages the run's state with it (keyed to this entry, its effect), and
         *  `take` the stop row it applies. An end that ends, fails or stops the run keeps what the grade spent as its cost. */
        const append = async (kind: string, data: unknown, end?: "ended" | "failed" | "stopped" | "parked", take?: number) => {
          const writes: StorageWrite[] = [];
          if (kind === KINDS.learningDropped && data !== null && typeof data === "object" && "usd" in data) spend = plus(asked, (data as DroppedData).usd ?? null);
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

        /** The grade and the merge of `proposal` on the agent's learning folder `ws`, as the learning of `who` (its Run-Id on
         *  the merge, its `source` in the journal): a run's kept proposal, or a consolidation's own. `checked` is what the
         *  checks left out, said with the merge; `beside`, what the grader reads with the proposal and grades not (a pair's
         *  side main holds). After a run's merge, `afterwards` asks whether a consolidation is due, before the run ends. */
        const settle = async (ws: unknown, who: { readonly runId: string; readonly agentId: string; readonly instructions?: string }, proposal: KeptProposal, checked: readonly Problem[], afterwards: boolean, beside: readonly NoteText[] = [], consolidation = false): Promise<LoopEnd> => {
          const source = who;
          const entries = await journalEntries(journal, context);
          rooted = entries.length > 0;
          const unavailable = entries.filter((entry) => entry.kind === KINDS.learningUnavailable).length;

          // The grade: once. A verdict already in the journal is the one the merge goes on.
          let graded = entries.find((entry) => entry.kind === KINDS.learningGraded)?.data as GradedData | undefined;
          if (graded) spend = plus(asked, graded.usd);
          if (!graded) {
            const main = await learning.readMain(ws, proposal);
            if ("problems" in main) {
              await append(KINDS.learningDropped, { source: source.runId, reason: "checker", detail: said.stale(main.problems as never), problems: main.problems } satisfies DroppedData, "ended");
              return { state: "ended" };
            }
            // A note named like one main holds now is settled alone, out of the grade (readMain's `taken`); the rest is
            // graded. Nothing left to grade keeps nothing.
            const taken = new Map((main.taken ?? []).map(({ path, reason }) => [path, reason]));
            const grading = proposal.notes.filter(({ file }) => !taken.has(file));
            const settledItems = [...taken].map(([file, reason]) => ({ file, keep: false, question: "Duplicate", why: reason === "same" ? SAME_NOTE : NOTE_NAME_TAKEN(file.replace(/\.md$/, "")) }));
            if (!grading.length && !proposal.files?.length) {
              const verdict: Verdict = { merge: false, reason: "Every new note is named like one the agent holds now.", items: settledItems };
              await append(KINDS.learningDropped, { source: source.runId, reason: "grader", detail: notKept(verdict, lostOf(proposal)) } satisfies DroppedData, "ended");
              return { state: "ended" };
            }
            const items = gradedItems(grading as NoteText[], (proposal.files ?? []) as NoteText[]);
            const prompt = gradePrompt({
              run: source.runId, ...(source.instructions ? { instructions: source.instructions } : {}), active: main.active, superseded: main.superseded, proposed: grading,
              ...(proposal.files?.length ? { files: proposal.files } : {}), ...(beside.length ? { beside } : {}), ...(proposal.asked ? { asked: proposal.asked } : {}), ...(proposal.triggered ? { triggered: proposal.triggered } : {}),
              ...(consolidation ? { consolidation: true as const } : {}),
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
              // What the asks spent: a cut one's unknown (null), kept on a stopped run's row as on a dropped one's.
              spend = plus(asked, usd);
              const end = await halted();
              if (end) return end;
              await append(KINDS.learningDropped, { source: source.runId, reason: "grade_failed", detail: said.stopped(STOPPED.noReview), usd, tokens } satisfies DroppedData, "ended");
              void error;
              return { state: "ended" };
            }
            if (settledItems.length) verdict = { ...verdict, items: [...verdict.items, ...settledItems] };
            graded = { source: source.runId, verdict, usd, tokens, graded: main.graded };
            spend = plus(asked, usd);
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
          // the grade's verdict goes to the commit, which answers with that merge, and each item is settled by the text main
          // holds at its file (resumedOf: its rule there, not only a changed path).
          const notePaths = graded.verdict.items.flatMap((item) => (!item.keep ? [] : item.note ? [item.note.file] : proposal.notes.some(({ file }) => file === item.file) ? [item.file] : []));
          let onMain: Readonly<Record<string, string>> = {};
          let already = false;
          try {
            already = await learning.merged(ws, source.runId);
            if (notePaths.length) onMain = await learning.mainTexts(ws, notePaths);
          } catch (error) {
            // Main could not be read: parked as for a write that could not reach the folder, tried again after a backoff.
            await append(KINDS.learningUnavailable, { source: source.runId, error: (error as Error)?.message ?? String(error) } satisfies UnavailableData, "parked");
            return { state: "parked", wakeAt: now() + UNAVAILABLE_BACKOFF_MS[Math.min(unavailable, UNAVAILABLE_BACKOFF_MS.length - 1)]! };
          }
          const taken = already ? { verdict: oneItemAFile(proposal, graded.verdict), replace: [], graded: {} } : takenOnMain(proposal, graded.verdict, onMain);
          const verdict = taken.verdict;
          if (!verdict.merge) {
            await append(KINDS.learningDropped, { source: source.runId, reason: "grader", detail: notKept(verdict, lostOf(proposal)) } satisfies DroppedData, "ended");
            return { state: "ended" };
          }
          const merging = keptOf(proposal, verdict);
          // What the grader read beside the proposal is pinned too: changed on main since the seed, the merge is refused.
          const change = { ...mergeChangeOf(source.runId, merging, verdict, { ...graded.graded, ...taken.graded }), ...(beside.length ? { pinned: beside.map(({ file }) => file) } : {}) };
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
            const detail = mergedWords(settled.merging, settled.verdict, checked);
            // Whether the agent's learning is due a consolidation now, queued before this run ends: a queue that fails
            // parks the run (its merge is on main, so it wakes to the same merge and asks again), never a lost one.
            if (afterwards && learning.consolidation) {
              try {
                await learning.consolidation.afterMerge(ws, { agentId: source.agentId, runId: source.runId, learningRunId: claim.runId });
              } catch (error) {
                await append(KINDS.learningUnavailable, { source: source.runId, error: `a consolidation could not be queued: ${(error as Error)?.message ?? String(error)}` } satisfies UnavailableData, "parked");
                return { state: "parked", wakeAt: now() + UNAVAILABLE_BACKOFF_MS[Math.min(unavailable, UNAVAILABLE_BACKOFF_MS.length - 1)]! };
              }
            }
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

        /** A consolidation run (learn/consolidate.ts) on the agent's learning folder `ws`: its active notes clustered by what
         *  they say (ranked by their runs' evidence), the pairs out of step read whole, one ask on the grade model for the
         *  replacements, the usual checks, the hold to its clusters, then the usual grade and merge. Nothing to consolidate
         *  is no ask. Its proposal is journaled before its grade, so a resumed run never asks again. */
        const consolidateOn = async (ws: unknown, job: Consolidation, consolidating: ConsolidationDeps): Promise<LoopEnd> => {
          const who = { runId: claim.runId, agentId: job.agentId, ...(job.instructions ? { instructions: job.instructions } : {}) };
          const entries = await journalEntries(journal, context);
          rooted = entries.length > 0;
          let made = entries.find((entry) => entry.kind === KINDS.learningConsolidation)?.data as ConsolidationData | undefined;
          const graded = entries.find((entry) => entry.kind === KINDS.learningGraded)?.data as GradedData | undefined;
          asked = made ? made.usd : 0;
          spend = graded ? plus(asked, graded.usd) : asked;
          const nothing = async (detail: string, problems?: readonly Problem[]): Promise<LoopEnd> => {
            await append(KINDS.learningDropped, { source: who.runId, reason: problems?.length ? "checker" : "empty", detail: problems?.length ? said.checker(problems as never) : detail, ...(problems?.length ? { problems } : {}) } satisfies DroppedData, "ended");
            return { state: "ended" };
          };
          if (!made) {
            const main = await consolidating.main(ws);
            if (!main) return nothing(said.empty);
            const runs = await consolidating.noteRuns(job.agentId);
            const texts = new Map(main.notes.map(({ file, text }) => [file, text]));
            const notes = main.notes.flatMap(({ file, text }) => {
              const note = parseNoteFile(file, text);
              return Array.isArray(note) ? [] : [note];
            });
            const counts = (file: string) => runs.get(file) ?? { given: 0, read: 0 };
            // The clusters, best first, while what they would supersede fits one merge (the checks' cap).
            const clusters = clustersWithin(clustersOf(notes, (note) => rankOf(counts(note.file))));
            // Which side of each pair changed last, as main's log says now: a merge since the queue may have changed the
            // other side (a pair it wrote whole is in step again). A pair past what the log keeps keeps the queue's word.
            const pairs = job.pairs.flatMap((pair) => {
              const skill = main.skills.find(({ name }) => name === pair.skill);
              const workflow = main.workflows.find(({ name }) => name === pair.workflow);
              if (!skill || !workflow) return [];
              const changed = changedLast(main.changes, pair.skill, pair.workflow) ?? pair.changed;
              return changed === "both" ? [] : [{ skill, workflow, changed }];
            });
            // What the grader reads beside a rewrite: every partner of the side the model rewrites (the one that did not
            // change last), as main holds it. A rewrite is asked about only when all of its partners fit beside it, in
            // the count the grade holds (GRADE_CAPS.beside) and in the room its prompt leaves (besideRoom): never one
            // shown or pinned in part, and never a paid request whose grade could not be made.
            const partners = partnersOf({ skills: main.skills, workflows: main.workflows });
            const companionsOf = companionsOn(main, partners);
            const active = notes.filter((note) => note.status === "active").map(({ file, name, description }) => ({ file, name, description }));
            const room = besideRoom({ ...(job.instructions ? { instructions: job.instructions } : {}), active, superseded: clusters.flat().map(({ file }) => ({ file, text: texts.get(file)! })), newNotes: clusters.length });
            const chosen = new Map<string, NoteText>();
            const leftOut: Problem[] = [];
            const fits = new Set<string>();
            for (const { skill, workflow, changed } of pairs) {
              const target = changed === "skill" ? { kind: "workflow" as const, name: workflow.name } : { kind: "skill" as const, name: skill.name };
              const key = `${target.kind}/${target.name}`;
              if (fits.has(key) || leftOut.some(({ path }) => path === keyFileOf(target))) continue;
              const all = companionsOf(target, new Set());
              const next = new Map([...chosen, ...all.map((one): [string, NoteText] => [one.file, one])]);
              if (next.size <= GRADE_CAPS.beside && besideCost([...next.values()]) <= room) {
                for (const [file, one] of next) chosen.set(file, one);
                fits.add(key);
              } else {
                leftOut.push({ rule: "consolidate", path: keyFileOf(target), detail: `left out of this consolidation: the ${all.length} files of its partners do not fit beside it in the grade (at most ${GRADE_CAPS.beside} files, and the room its prompt leaves)` });
              }
            }
            const asking = pairs.filter(({ skill, workflow, changed }) => fits.has(changed === "skill" ? `workflow/${workflow.name}` : `skill/${skill.name}`));
            if (!clusters.length && !asking.length) return leftOut.length ? nothing(said.stale(leftOut as never), leftOut) : nothing(said.empty);
            const prompt = consolidatePrompt({
              ...(job.instructions ? { instructions: job.instructions } : {}),
              clusters: clusters.map((cluster) => cluster.map((note) => ({ file: note.file, text: texts.get(note.file)!, ...counts(note.file) }))),
              pairs: asking,
            });
            let answer: Awaited<ReturnType<LearningLoopDeps["ask"]>>;
            try {
              answer = await learning.ask({ prompt, maxTokens: GRADE_MAX_TOKENS }, AbortSignal.any([deps.signal, AbortSignal.timeout(GRADE_TIMEOUT_MS)]), { journal: () => deps.journal(claim), flush: () => deps.flush() });
            } catch {
              // A cut request may have been billed: its cost is unknown before a pending stop ends the run on it.
              asked = null;
              spend = null;
              const end = await halted();
              if (end) return end;
              await append(KINDS.learningDropped, { source: who.runId, reason: "grade_failed", detail: said.stopped(STOPPED.noReview), usd: null, tokens: null } satisfies DroppedData, "ended");
              return { state: "ended" };
            }
            asked = answer.usd === null || !Number.isFinite(answer.usd) ? null : answer.usd;
            spend = asked;
            const checked = await consolidating.checkAnswer(ws, { seed: main.seed, answer: typeof answer.text === "string" ? answer.text : "", ...(job.tools ? { tools: job.tools } : {}) });
            if (checked.state !== "proposed") return nothing(checked.reason === "empty" ? said.empty : (checked.detail ?? said.empty), checked.problems);
            // Held to what it was asked (the code check behind the grader's question): each note supersedes only notes of
            // one cluster, and a skill or a draft is one of a pair out of step. A cluster note no kept note supersedes stays.
            const replacements = checked.proposal.notes.flatMap(({ file, text }) => {
              const note = parseNoteFile(file, text);
              return Array.isArray(note) ? [] : [{ file, text, supersedes: note.supersedes }];
            });
            const held = heldToClusters(replacements, checked.proposal.files ?? [], clusters.map((cluster) => cluster.map(({ file }) => file)), asking.map(({ skill, workflow }) => ({ skill: skill.name, workflow: workflow.name })));
            const keptFiles = new Set(held.files);
            let proposal: KeptProposal = { notes: held.notes.map(({ file, text }) => ({ file, text })), ...(held.files.length ? { files: (checked.proposal.files ?? []).filter(({ file }) => keptFiles.has(file)) } : {}), seed: main.seed };
            const left = [...leftOut, ...(checked.left ?? []), ...held.problems];
            if (!proposal.notes.length && !proposal.files?.length) return nothing(said.stale(left as never), left);
            // A pair the answer wrote one side of (the other given back unchanged, which the checks take out): the other
            // side as main holds it goes to the grader beside it, so it can check both describe the same steps.
            // Each side the answer writes (it may rewrite the one that changed last instead): its partners it does not write
            // go to the grader beside it, as main holds them, each once, and the merge pins them. A written side whose
            // partners do not all fit (the count, the room the actual proposal leaves) is left out, never shown in part.
            let files = proposal.files ?? [];
            const writes = new Set(files.map(({ file }) => file));
            const actual = besideRoom({ ...(job.instructions ? { instructions: job.instructions } : {}), active, superseded: proposal.notes.flatMap((n) => parseNoteFileOr(n).supersedes).map((file) => ({ file, text: texts.get(file) ?? "" })), newNotes: proposal.notes.length, files });
            const companions = new Map<string, NoteText>();
            const written = [...new Set(files.flatMap(({ file }) => {
              const place = learnedPlace(file);
              return place && place.kind !== "readme" ? [`${place.kind}/${place.name}`] : place ? [`workflow/${place.name}`] : [];
            }))];
            for (const key of written) {
              const [kind, name] = key.split("/") as ["skill" | "workflow", string];
              const others = companionsOf({ kind, name }, writes);
              const next = new Map([...companions, ...others.map((one): [string, NoteText] => [one.file, one])]);
              if (next.size <= GRADE_CAPS.beside && besideCost([...next.values()]) <= actual) for (const [file, one] of next) companions.set(file, one);
              else {
                const prefix = `${kind === "skill" ? SKILLS_DIR : WORKFLOWS_DIR}/${name}/`;
                files = files.filter(({ file }) => !file.startsWith(prefix));
                left.push({ rule: "consolidate", path: keyFileOf({ kind, name }), detail: `left out of this consolidation: the files of its partners do not fit beside it in the grade (at most ${GRADE_CAPS.beside} files, and the room its prompt leaves)` });
              }
            }
            if (files.length !== (proposal.files ?? []).length) {
              proposal = { notes: proposal.notes, ...(files.length ? { files } : {}), seed: main.seed };
              if (!proposal.notes.length && !files.length) return nothing(said.stale(left as never), left);
            }
            const beside = [...companions.values()];
            made = { proposal, left, stayActive: held.stayActive, usd: asked, ...(beside.length ? { beside } : {}) };
            await append(KINDS.learningConsolidation, made);
            await deps.flush();
          }
          return settle(ws, who, made.proposal, made.left, false, made.beside ?? [], true);
        };

        const consolidating = learning.consolidation;
        const consolidation = consolidating ? await consolidating.of(claim.runId) : undefined;
        if (consolidating && consolidation) {
          const folder = learning.folder(consolidation.agentId);
          try {
            return await consolidateOn(folder.workspace, consolidation, consolidating);
          } finally {
            await folder.end().catch(() => {});
          }
        }

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

        // The folder is ended once the run is done with it, whichever way it goes out. Its end only sweeps what an exec
        // left behind (on Archil, the spill), after the run's own end is committed: a failed sweep changes no end.
        const folder = learning.folder(source.agentId);
        try {
          return await settle(folder.workspace, source, proposal, checked, true);
        } finally {
          await folder.end().catch(() => {});
        }
      },
    };
  };
}
