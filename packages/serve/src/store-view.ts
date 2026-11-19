// A run's served view, built from the one store (design 2.1): the same object GET /runs/{id} answered from the per-run
// files, now composed from the store's row (store-reads/runs.ts), its journal (store-reads/journal.ts) and its learning end
// (store-reads/learning.ts), fed through the run view's pure functions (run-view.ts) so the figures and words a person or a
// model sees do not change. runs.ts still answers the API from files; this is the store-backed path the server cut switches
// onto. viewOverStore answers the run read, summaryOverStore the run list, momentOverStore the one acceptance each act reads.
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CAPS, isMessageRow, type TimelineEvent } from "./timeline/index.js";
import { runLink } from "./console-links.js";
import { redacted, redactedAnswer, redactedOutput, withoutLoopback } from "./key-refusal.js";
import { structuredAnswer } from "./answer-json.js";
import { isObject } from "./validate.js";
import { currentLearning, holdsForOk, type ItemStatus, type Learning, learningView, LEARNING_LABEL, secretsShown, shortOf, type Shown } from "./learning.js";
import { said } from "./learning-words.js";
import { CONTENT_FILTER_WORDS, contentFiltered, MODERATED } from "./content-filter.js";
import { COMPUTER_UNAVAILABLE_CODE, lostEndMessage } from "./computer-lost.js";
import { launchOf } from "./handed-values.js";
import { learningStartOf, type RunLaunch, seedFailed } from "./run-launch.js";
import {
  momentOf,
  type Pending,
  pendingOf,
  stoppedTurn,
  type RunFacts,
  type RunMoment,
  type RunView,
  type RunViewMeta,
  type SignInReader,
  type Status,
  approvalOf,
  asksOf,
  answersOf,
  activePauseOf,
  budgetOf,
  browserPending,
  type ComputerAsk,
  computerPending,
  redactorOf,
  servedRunErrorWith,
  servedReviewWith,
  statusOf,
  WITHHELD_SIGN_IN,
  WITHHELD_TITLE,
  costWordsOfView,
  freeOf,
  stopAsked,
  usersOf,
  withAsks,
  withApprovalRows,
} from "./run-view.js";
import { reflects, type Reflect } from "./reflect-range.js";
import { freeCeilingMessage, overCapMessage, SPEND_CAP_REACHED } from "@parcha/agentrun-kernel/kernel/cap";
import { type BookedSpend, bookedSpend, cliModelWorked, type CostBasis, costBasisOf, costWordsOf, planSpend, type RunCost, runCostOf, storedBasisOf } from "./runner/metrics.js";
import { journalRecords, recordOf } from "./runner/journal-reader.js";
import { capNowOf, type EndData, KINDS } from "./runner/journal-kinds.js";
import { laidOf, pathViewOf, runLearningEnd, usedOnly } from "./store-reads/learning.js";
import { correctionCount } from "./learn/corrections.js";
import { isCliRecord, runReflect, runTimeline, wholeAnswerFor, wholeAnswers, withoutFeedbackRounds } from "./store-reads/journal.js";
import { costOfRun, type RunReadState, readRun } from "./store-reads/runs.js";
import { runCutValues, runErrorWordsOf, underCut } from "./run-cut.js";
import { Turns } from "./turns.js";
import { harnessOfBody } from "./harness.js";
import { LOGIN_HARNESS } from "./claude-login.js";
import { browserAsk as browserAskOf, BROWSER_HANDOVER_KIND } from "./browser-commands.js";
import { computerAsk as computerAskOf, COMPUTER_HANDOVER_KIND } from "./computer-commands.js";
import type { PendingAsk } from "./browser-person.js";
import { approvalsOf, type Approvals } from "./approvals.js";
import { FINAL_STATES, type KeptListing, type RunListing, type RunRow, stoppedByPerson, type Store } from "./store/store.js";
import { LISTING_HELD, LISTING_KEYED } from "./store/schema.js";
import { createHash } from "node:crypto";
import type { RecordingView } from "./run-recordings.js";

/** What the store-backed view needs beside the store: where its console lives, every secret it never shows (read now, so
 *  one rotated is cut at once), and the agents' saved sign-ins (for the handed-pointer cut). The server passes the same it
 *  passes the file path. */
export interface ViewDeps {
  readonly origin: string;
  readonly serverSecrets: () => string[];
  readonly signIns?: SignInReader;
  /** The server's clock (ms), for the claim-lease check that decides a run is live; defaults to Date.now. The server
   *  passes the same clock the store uses, so a test on a moved clock reads a fresh claim as live. */
  readonly now?: () => number;
  /** The environment a run's model key is read from, with the keys a person saved (run-cut.ts runErrorWordsOf): a failed
   *  run's error names a refused key in plain words, as its Timeline's error row does. Default: this process's
   *  environment (the server passes it with the keys a person saved). */
  readonly keyEnv?: () => NodeJS.ProcessEnv;
  /** Each learned item's status on agent `agentId`'s learning folder's main (learning-routes.ts statusesOf): what a run held
   *  for its owner's OK reads as it stands there. None: as the merge wrote it. */
  readonly statuses?: (agentId: string) => Promise<ReadonlyMap<string, ItemStatus> | undefined>;
  /** Run `runId`'s screen recordings (run-recordings.ts recordingsOf), the run ended at `endedAt` (null: it has not). Only
   *  the reads that answer a run as a whole pass it (a run's own read, its archive): absent, the view has no `recordings`,
   *  so a list, a poll or a status read opens no file. */
  readonly recordings?: (agentId: string, runId: string, endedAt: number | null) => Promise<RecordingView[]>;
}

/** A run that has ended reads one of these (the old RunRow state → the v2 status: an escalation is a completion with a
 *  review; a stopped run is a cancellation), as runs.ts's STATUS_OF mapped them. A running run reads its status from the
 *  journal, and so does an agentic run a person stopped, which reads running (runReadState). */
const STATUS_OF: Record<Exclude<RunReadState, "running">, Status> = { completed: "completed", failed: "failed", escalated: "completed", stopped: "cancelled" };
/** A settled run's v2 status from its row alone (STATUS_OF), the status its view reads (statusOf returns the outcome
 *  first); undefined for a run still going, whose status only its journal says. */
export const settledStatusOf = (state: RunReadState): Status | undefined => (state === "running" ? undefined : STATUS_OF[state]);
/** A run that has reached a last state (its view is its ended shape). */
const TERMINAL = new Set<Status>(["completed", "failed", "cancelled"]);
/** How long a run's listing waits before it is built again when its build could not read what it needed (ms): a listing
 *  that withheld the run for a sign-in it could not read back (listingOverStore), and the lister's build that failed
 *  (run-listing.ts). */
export const LISTING_RETRY_MS = 30_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** What a view last made of a run's text, by store and slot (a run's answer, or its input): the text it read (`input`),
 *  the digest of the values it was redacted of (`key`) and what that gave (`out`), so a second view of the same text and
 *  values reads nothing again (main's runs.ts servedOnce: a console polls a run's view, and an answer or an input can be
 *  large). Newest SERVED_KEPT slots of each store. */
const servedByStore = new WeakMap<Store, Map<string, { input: string; key: string; out: unknown }>>();
const SERVED_KEPT = 64;
function keptOnce<T>(store: Store, slot: string, input: string, values: readonly string[], make: () => T): T {
  let served = servedByStore.get(store.origin);
  if (!served) servedByStore.set(store.origin, (served = new Map()));
  const key = wholeAnswerFor(values).key;
  const last = served.get(slot);
  if (last && last.key === key && last.input === input) return last.out as T;
  const out = make();
  served.delete(slot);
  served.set(slot, { input, key, out });
  for (const oldest of served.keys()) {
    if (served.size <= SERVED_KEPT) break;
    served.delete(oldest);
  }
  return out;
}
/** A run's answer as served: redactedAnswer's, once per answer and held value set. */
const servedOnce = (store: Store, runId: string, input: string, values: readonly string[]): string =>
  keptOnce(store, `answer ${runId}`, input, values, () => redactedAnswer(input, values));
/** Whether a run's input is served (store-view's `input`): only when the cut a run's words get (redactedOutput) leaves it
 *  exactly as given, so "Run again" never sends an altered task. Read once per input and held value set. */
const inputWhole = (store: Store, runId: string, input: Record<string, unknown>, values: readonly string[]): boolean =>
  keptOnce(store, `input ${runId}`, JSON.stringify(input), values, () => isDeepStrictEqual(redactedOutput(input, values), input));

/** A run's whole answer as answerOfRun read it from the rows: its newest final-answer row, never the learning turn's, and
 *  never an earlier turn's: a final answer row before the person's last message belongs to the turn that message
 *  followed, so a follow-up whose own stop said nothing (no text block: a thinking-only stop) has no answer, null, not
 *  the answer before it. Read on the job's turns (withoutFeedbackRounds): a grade's feedback round asks no turn of the
 *  job's, so its words never cut the answer off. */
export const answerOf = (timeline: readonly TimelineEvent[]): string | null => {
  const rows = withoutFeedbackRounds(timeline);
  const asked = rows.findLastIndex((r) => isMessageRow(r) && r.agent_label === null && r.text !== null);
  const row = rows.findLast((r) => r.kind === "final_answer" && r.agent_label !== LEARNING_LABEL);
  return row && rows.lastIndexOf(row) > asked ? row.text ?? null : null;
};

/** A failed run's error from its row (its own words are the summary; the store keeps no code or detail apart). A run
 *  its cap ended once its cost passed it (the kernel's overCapEnd) is code spend_cap_reached, its message the words after
 *  the code, as main served it; a provider's content-filter stop is `moderated`, in words a person can act on
 *  (content-filter.ts); a run whose sandbox was lost more times than its claim starts new ones (computer-lost.ts lostEnd)
 *  is computer_unavailable, its message the words after the code; every other failure is run_failed. */
const errorOfRow = (summary: string | null): { code: string; message: string; retryable: false; details?: unknown } => {
  // A run that reached its limit of requests on free models (the kernel cap's freeCeilingEnd) ends as its cap ends one: code
  // spend_cap_reached, its message the words after the code.
  const over = overCapMessage(summary) ?? freeCeilingMessage(summary);
  if (over !== undefined) return { code: SPEND_CAP_REACHED, message: over, retryable: false };
  const lost = lostEndMessage(summary);
  if (lost !== undefined) return { code: COMPUTER_UNAVAILABLE_CODE, message: lost, retryable: false };
  if (summary !== null && contentFiltered(summary)) return { code: MODERATED, message: CONTENT_FILTER_WORDS, retryable: false };
  return { code: "run_failed", message: summary ?? "The run failed.", retryable: false };
};

/** An escalated run's review: as its end kept it (`kept`, the escalate node's kind, label and summary), else its row's
 *  summary as the reason. */
type SavedReview = { kind: string | null; node: string | null; reason: string };
const reviewOfRow = (state: RunReadState, summary: string | null, kept?: SavedReview): SavedReview | null => (state !== "escalated" ? null : (kept ?? { kind: null, node: null, reason: summary ?? "The workflow escalated." }));
const reviewAt = (review: SavedReview | null, endedAt: string): (SavedReview & { at: string }) | null => (review ? { kind: review.kind, node: review.node, reason: review.reason, at: endedAt } : null);

/** A run's facts as statusOf and momentOf read them, built from the run's journal: whether it stands parked at its cap
 *  (an active agentrun.budget park), and the browser ask it waits on (wired next). A terminal run reaches none of them
 *  (its outcome answers first). */
const factsOf = (run: StoreRun): RunFacts => ({ budgetWaiting: () => run.budget !== undefined, paused: () => run.paused, browserAsk: () => run.browserAsk, computerAsk: () => run.computerAsk });

// A workflow run paused in its process (the runner's workflow-loop pause): its row is parked with the pause's words and its
// newest agentrun.pause root entry has no agentrun.resume after it. Read by those kinds and words, as the runner writes them.
const PAUSE_KIND = "agentrun.pause", RESUME_KIND = "agentrun.resume", PAUSED_WORDS = "Paused.";
/** Whether the run stands paused in its process now: a parked row with the pause's words, and a newest pause not yet
 *  resumed (no resume entry after it). As the file-backed view read the workflow's pause file, so the server shows it
 *  paused (statusOf's `paused` fact), as main shows a paused workflow. */
function pausedOf(runRow: RunRow, entries: readonly { kind?: string; id?: unknown }[]): boolean {
  if (runRow.state !== "parked" || runRow.summary !== PAUSED_WORDS) return false;
  const lastOf = (kind: string) => entries.reduce((max, e) => (e.kind === kind ? Math.max(max, Number(e.id ?? 0)) : max), -1);
  const pause = lastOf(PAUSE_KIND);
  return pause >= 0 && pause > lastOf(RESUME_KIND);
}

/** The run read from the store: the row, its launch, its timeline, its agent's revision count for the version, its
 *  learning end, and the sign-in cut it serves through. Undefined for an unknown run. */
interface StoreRun {
  readonly native?: Record<string, unknown>;
  readonly sdk?: Record<string, unknown>;
  readonly row: NonNullable<Awaited<ReturnType<typeof readRun>>>;
  readonly runRow: RunRow;
  readonly launch: RunLaunch | undefined;
  readonly rows: TimelineEvent[];
  readonly version: number;
  readonly harness: string;
  readonly learningEnd: Learning | null;
  readonly view: RunView;
  /** The run's error text is withheld while this server can't read the sign-in it was handed. */
  readonly unshown: boolean;
  /** The values every served text is cut of (serverSecrets + the handed pointers that open). */
  readonly values: string[];
  /** A runner holds the run's claim now (not final, a runner named, its lease unexpired). */
  readonly live: boolean;
  /** The run's updated_at (ms): its latest change in the store — the runner's live tick while it runs, its end once ended,
   *  its start before either. */
  readonly updatedAtMs: number;
  /** When the turn of a message still open last wrote (the live tick), as ISO; null when none is open. */
  readonly lastProgressAt: string | null;
  /** The budget card the run shows while it stands parked at its cap (pending, kind budget), or undefined when it is not
   *  parked there. Also the source of the `budgetWaiting` fact. */
  readonly budget: Pending | undefined;
  /** Whether a workflow run stands paused in its process now (pausedOf): the source of the `paused` fact. */
  readonly paused: boolean;
  /** The browser hand-over the run's agent waits on (the newest ask still waiting), or undefined. Also the `browserAsk`
   *  fact. */
  readonly browserAsk: PendingAsk | undefined;
  /** The agent's ask on its desktop or phone the run waits on (computer-commands.ts), or undefined. Also the `computerAsk`
   *  fact. */
  readonly computerAsk: ComputerAsk | undefined;
  /** Whether the run ran unattended, as its revision kept it (approvals "never"), else the default (ask): the run read's
   *  `approvals` field, as runs.ts serves it. Named to stand apart from the approval-request map on the view. */
  readonly approvalsMode: Approvals;
  /** A completed workflow run's output, as its end kept it (EndData.output); null when it kept none. */
  readonly output: unknown;
  /** An escalated workflow run's review, as its end kept it (EndData.review); undefined when it kept none. */
  readonly review?: EndData["review"];
  /** An ended agentic run's structured answer against its revision's output schema (definition.output_schema), read off
   *  its final answer as the journal keeps it, whole and uncut (answer-json.ts structuredAnswer), or why it has none (a
   *  run with no final answer among them: result.output_error): undefined when the agent has no schema or the run has not
   *  ended. Cut of held values only when served (redactedOutput). */
  readonly structured: { value: unknown } | { why: string } | undefined;
  /** What the run's decisions booked (their own session, metrics.ts bookedSpend), undefined when it booked none: the run's cost
   *  adds it to its usage row's, as the timeline adds their receipts. */
  readonly decisions: BookedSpend | undefined;
  /** Its model requests billed to a ChatGPT plan (metrics.ts planSpend), undefined when it made none. */
  readonly plan: { readonly requests: number; readonly tokens: number } | undefined;
  /** What its model requests booked (metrics.ts bookedSpend "model": every session but its paid tools' and its
   *  decisions'): their tokens and how they were priced, for its cost's `tokens` and `basis`. */
  readonly model: BookedSpend;
  /** An ended run's cost from its booking (metrics.ts runCostOf, the rule its end stored it by), read in the same snapshot
   *  as its state; undefined for a run still going, imported, native, or that booked no request. */
  readonly endCost?: RunCost;
  /** Whether the run's last end wrote its cost (EndData.costUsd present: a figure or null), so the stored column holds the
   *  end's answer. False for an end whose spec reads no cost, which leaves the column as it was. */
  readonly endSaidCost?: boolean;
}

/** A runner holds the run's claim now: it is not in a final state, a runner is named on its row, and its lease has not run
 *  out (claimed_until >= now, the predicate the claimable query's `claimed_until < ?` is the negation of). `now` is the
 *  server's clock, so a test on a moved clock reads a fresh claim as live. */
function liveOf(runRow: RunRow, now: number): boolean {
  return !FINAL_STATES.includes(runRow.state) && runRow.runner !== null && runRow.claimedUntil !== null && runRow.claimedUntil >= now;
}

/** Whether the run's turn stands on a person: a tool call asked for their approval with no answer in its journal (the
 *  view's `approvals`, asksOf), or a browser or desktop hand-over neither answered in its journal nor by a hand-back row.
 *  By the journal alone, never by the clock: a hand-over past its expiry still holds the turn until its expiry is written
 *  as its answer, and only then does the turn go on. Such a turn has no model request in flight. */
export function standsOnPerson(approvals: ReadonlyMap<string, { readonly resolved?: true }>, entries: readonly { kind: string; data?: unknown }[], commands: Awaited<ReturnType<Store["commands"]>>): boolean {
  return [...approvals.values()].some((approval) => !approval.resolved) ||
    browserAskOf(entries as unknown as Parameters<typeof browserAskOf>[0], commands, Number.NEGATIVE_INFINITY) !== undefined ||
    computerAskOf(entries as unknown as Parameters<typeof computerAskOf>[0], commands, Number.NEGATIVE_INFINITY) !== undefined;
}

/** Reads the run from the store and builds the RunView the view functions read. Every read of the run (its row, launch,
 *  journal, live tick and commands) is made in one snapshot of the store (Store.snapshot), so the view is of one moment: a
 *  runner's commit that lands while it is built is in all of it or in none. What is read through the server's own handles
 *  (the run's cut, which reads the agent's sign-ins, and the learning statuses of its folder) is read outside the snapshot,
 *  before and after it: neither is part of the run's moment, and neither may wait on the snapshot's connection. */
async function storeRunOf(store: Store, runId: string, deps: ViewDeps): Promise<(StoreRun & { readonly shownEnd: Learning | null }) | undefined> {
  // The run's one cut (run-cut.ts): the pointers it was handed read back and every secret this server never shows, so a
  // run whose words could repeat one is cut of it, rows and all, or withheld when this server cannot read back what it
  // was handed (rowShown's choke point). The snapshot renders under it, so it is read first, and read again after: the cut
  // only grows, so one that is the same after the snapshot holds every value saved before the rows were read (underCut
  // builds again under a cut that grew meanwhile).
  const cutOf = async () => {
    const known = await store.runs.get(runId);
    return known ? runCutValues(deps, store, runId, { runRow: known, launch: await launchOf(store, runId) }) : undefined;
  };
  if (!(await store.runs.get(runId))) return undefined;
  const run = await underCut(async () => (await cutOf()) ?? "unreadable", (cut) => store.snapshot((snapshot) => storeRunIn(snapshot, runId, deps, cut)));
  if (!run?.shownEnd || !holdsForOk(run.shownEnd as Learning) || !deps.statuses) return run && { ...run, learningEnd: run.shownEnd };
  // What the learning end held for its owner's OK reads as it stands now on its agent's folder's main (learning.ts
  // currentLearning); its record stays as the merge wrote it.
  return { ...run, learningEnd: currentLearning(run.shownEnd, await deps.statuses(run.row.agent)) };
}

/** `storeRunOf`'s reads, over `store` (a snapshot) and the run's cut. */
async function storeRunIn(store: Store, runId: string, deps: ViewDeps, cut: Awaited<ReturnType<typeof runCutValues>>): Promise<(StoreRun & { readonly shownEnd: Learning | null }) | undefined> {
  const context = BACKGROUND_CONTEXT;
  const row = await readRun(store, runId, context);
  if (!row) return undefined;
  const runRow = await store.runs.get(runId);
  if (!runRow) return undefined;
  const launch = await launchOf(store, runId);
  const unshown = cut === "unreadable";
  const values = cut === "unreadable" ? [] : cut.values;
  const revision = await store.agents.revision(row.revision);
  const harness = launch?.harness ?? harnessOfBody((revision?.body ?? {}) as { harness?: string });
  // Whether the run ran unattended, from the revision it is pinned to (approvals "never"), else the default (ask).
  const approvalsMode = approvalsOf((revision?.body as { approvals?: unknown } | undefined)?.approvals);
  const outputSchema = row.kind === "agentic" ? (revision?.body as { outputSchema?: unknown } | undefined)?.outputSchema : undefined;
  const terminal = row.state !== "running";
  // Its structured answer, from the final answer as the journal keeps it: never the served text, which a held value
  // (a number among them) or a long answer's cut would have changed, so a block that meets the schema reads as written.
  const rawAnswer = outputSchema !== undefined && terminal ? answerOf(await runTimeline(store, runId, context, { settled: true, caps: { text: Number.POSITIVE_INFINITY } })) : null;
  const structured = outputSchema !== undefined && terminal ? (rawAnswer !== null ? structuredAnswer(rawAnswer, outputSchema) : { why: "the run gave no final answer" }) : undefined;
  // The timeline, then the waiting row a run asking a question shows (withAsks), as the file path's rows carried it, so a
  // run waiting on a question reads the same status and pending.
  // Its final answer whole (store-reads/journal.ts wholeAnswers), as main served a run's answer: a row's cut is no answer's.
  // A run that ended reads settled, and its usage row says its cost ("Cost: …"), never what it has cost so far.
  const timelineOptions = { settled: terminal, ended: terminal, redact: (text: string) => redacted(text, values) };
  const timeline = withAsks(await wholeAnswers(store, runId, context, await runTimeline(store, runId, context, timelineOptions), timelineOptions, wholeAnswerFor(values)));
  const revisions = await store.agents.revisions(row.agent);
  const version = revisions.findIndex((r) => r.id === row.revision) + 1;
  const ended = await runLearningEnd(store, runId);

  // Whether a runner holds the run now, and the time of its latest change: the live tick while it runs (store.live, the
  // runner's own tick), its end once ended, its start before either.
  const [liveRow] = await store.live.read([runId]);
  const live = liveOf(runRow, deps.now?.() ?? Date.now());
  const updatedAtMs = liveRow?.updatedAt ?? runRow.endedAt ?? runRow.startedAt;

  // The turns the run took, rebuilt from the journal the same way the file path's noteTurns fed Turns: the root's records
  // (a CLI session's own conversation skipped) and the input submissions, with the end-of-run turn's entries left out
  // (runReflect). progressAt reads the latest tick, so a working run's last_progress_at advances as today.
  const records = await journalRecords(store.readJournal(runId), context);
  const sdkCompletion = records.entries.findLast(entry => entry.kind === "agentrun.sdk.completion")?.data as import("./sdk/runs.js").SdkCompletion | undefined;
  const sdkSession = records.entries.findLast(entry => entry.kind === "agentrun.sdk.session")?.data as {session_id:string} | undefined;
  const sdk = launch?.sdk ? {runtime:launch.sdk.runtime,model:sdkCompletion?.model??launch.sdk.model??null,session_id:sdkCompletion?.session_id??sdkSession?.session_id??null,learning_revision:launch.learning?.seed??null,usage:sdkCompletion?.usage??null} : undefined;
  const nativeConfiguration = records.entries.findLast(e=>e.kind === "agentrun.native.configuration")?.data as Record<string,unknown>|undefined;
  const nativeEvents = records.entries.filter(e=>e.kind === "agentrun.native.usage").map(e=>e.data as {phase:string;model?:string;usage:import("./native/types.js").NativeUsage;session_id:string});
  const reflectRange = (await runReflect(store, runId, context)) as Reflect | undefined;
  const taskUsage = nativeEvents.filter(e=>e.phase==="task").map(e=>e.usage);
  // A native retry may fail before reporting usage. Do not present earlier attempts as the complete task total.
  // Reflection requests have their own usage and must not make otherwise complete task counters unknown.
  const taskRequests = records.entries.filter(e=>e.kind === "runner.request" && (e.data as {aggregate?:unknown})?.aggregate === true && !reflects(reflectRange,e.id)).length;
  const nativeTaskUsage = taskUsage.length ? Object.fromEntries(Object.keys(taskUsage[0]!).map(key=>{
    const counters=taskUsage.map(usage=>usage[key as keyof typeof usage]);
    return [key,taskUsage.length<taskRequests || counters.some(value=>value===null)?null:counters.reduce<number>((total,value)=>total+(value??0),0)];
  })) : null;
  const nativeSession = records.entries.findLast(e=>e.kind === "agentrun.native.session")?.data as {session_id:string}|undefined;
  const native = launch?.native ? {runtime:launch.native.runtime,project:launch.native.project,selector:launch.native.selector,machine_id:launch.native.machine_id,fingerprint:nativeConfiguration?.fingerprint ?? launch.native.fingerprint,session_id:nativeSession?.session_id??null,model:nativeEvents.at(-1)?.model??launch.native.model,learning_revision:launch.learning?.seed??null,usage:{task:nativeTaskUsage,reflection:nativeEvents.filter(e=>e.phase==="reflection").map(e=>e.usage)},model_requests:null} : undefined;
  const skip = reflectRange ? (id: number) => reflects(reflectRange, id) : undefined;
  // The run's learning end. Before its end, a run that learns is seeded, then looking back once its end-of-run turn starts
  // (main's seeded and reflecting).
  const started = launch ? learningStartOf(launch) : undefined;
  const under = !ended && started && started.use ? usedOnly(started, terminal, iso(runRow.endedAt ?? runRow.startedAt)) : !ended && started && !seedFailed(started) ? underWay(started, laidOf(records.entries), reflectRange, iso(runRow.startedAt)) : null;
  const shownEnd = ended ?? under;
  const turns = new Turns();
  turns.note(recordOf(records.entries), records.submissions ?? [], skip, liveRow?.updatedAt ?? deps.now?.() ?? Date.now());
  const working = live && turns.open > 0;
  const progress = terminal || row.kind === "workflow" ? undefined : turns.progressAt();
  const lastProgressAt = progress === undefined ? null : iso(progress);

  // The tool-call approvals the run waits (or waited) on, from its journal: each call the gate parked for a person, and
  // the answers given, which the status, pending and moment views read the same as the file path read them from the run's
  // store entries.
  const approvals = asksOf(records.entries);
  // The run's command rows, read once for what needs them: a stop or a cancel asked for, a hand-over's answers, and the
  // person's messages not yet taken.
  let commandRows: Awaited<ReturnType<Store["commands"]>> | undefined;
  const commandsNow = async () => (commandRows ??= await store.commands(runId, 0));
  // A person's stop of an agentic run (stoppedByPerson: its row reads running, readRun) is main's stop mark: the run is
  // stopped while no message is newer than the stop (statusOf: input_required and idle), and a message reopens it. A stop
  // asked for and not yet taken (stopAsked) is the mark too once nothing works: between the turn's cut and the end that
  // takes the stop, a read would otherwise see the cut turn's input_required with nothing pending; a run waiting (on an
  // approval, a person, a browser) reads stopped from the stop's answer on. While its turn still works it reads working:
  // the cut is what books the request it cuts (its cost unknown), so a run read stopped before the cut would say the known
  // sum as its cost. A turn that stands on a person (standsOnPerson) has no request in flight to book: the runner that takes
  // the stop claims the run with that turn still open, and it reads stopped under that claim too, never working between the
  // stop's answer and its end.
  const commands = terminal ? [] : await commandsNow();
  const asked = !terminal && stopAsked(row, runRow, commands) && (!working || standsOnPerson(approvals, records.entries, commands));
  // A call asked before an end in the journal reads withdrawn in that end's words; a stopped or failed run's (states no
  // reopen leaves) whose journal holds no end, by its row (answersOf `final`); every call still waiting once a stop is
  // asked (stopAsked).
  const answers = answersOf(records.entries, { final: runRow.state === "stopped" || runRow.state === "failed" ? runRow.state : asked ? "stopped" : undefined });
  // The rows a person reads: each call that waited for approval in order (held, your approval, what came of it), its
  // arguments and the person's notes through the run's redactor, as the file path's withApprovals served them.
  const rows = withApprovalRows(timeline, approvals, answers, redactorOf(values));

  // The run's cap as it stands, through the one reader the runner's gate reads too (capNowOf): a raise taken shows in the
  // run's cost.cap_usd and its budget card, never the old cap.
  const capUsd = capNowOf(launch?.maxCostUsd, records.entries);
  const meta: RunViewMeta = {
    ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}),
    ...(Object.keys(answers).length ? { approvals: answers } : {}),
    ...(stoppedByPerson(runRow, row.kind) || asked ? { stopped_after: usersOf(rows) } : {}),
  };
  // The budget card the run shows while it stands parked at its cap, from its journal's agentrun.budget park (none once a
  // raise clears it). Read over the same meta cap and rows the card's figures and time come from.
  const budget = budgetOf(records.entries, { meta, rows, updatedAt: iso(updatedAtMs) });
  const pause = activePauseOf(records.entries);
  // Whether a workflow run stands paused in its process now (its parked row with the pause's words, its newest pause not
  // resumed), the `paused` fact the status table reads for a paused workflow.
  const paused = pausedOf(runRow, records.entries);
  // The browser hand-over the agent waits on (E2c's reader over the run's hand-over entries and hand-back commands), read
  // against the server's clock. Only a run with a hand-over entry fetches its commands, so a run with none reads none and
  // makes no extra store read beyond the one a running run's stop and cancel already make.
  const browserAsk = records.entries.some((e) => e.kind === BROWSER_HANDOVER_KIND)
    ? browserAskOf(records.entries as unknown as Parameters<typeof browserAskOf>[0], await commandsNow(), deps.now?.() ?? Date.now())
    : undefined;
  // The agent's ask on its desktop or phone, read the same way (computer-commands.ts): only a run with one fetches its rows.
  const computerAsk = records.entries.some((e) => e.kind === COMPUTER_HANDOVER_KIND)
    ? computerAskOf(records.entries as unknown as Parameters<typeof computerAskOf>[0], await commandsNow(), deps.now?.() ?? Date.now())
    : undefined;
  // The person's messages its runner has not taken yet (steer rows neither taken nor refused): the file path's `submitted`.
  // A run that waits on its person (a parked question) and has just been answered reads as going on from the answer's
  // row, never input_required again until its runner places it, as main's run read once the message was submitted.
  // Read only for a run not working now (a working run reads working anyway), so a run list adds no read for those; and
  // only a message that may answer a person counts (a trigger's, answers: false, never does: it waits, untaken, for a turn of its own after the answer).
  // A run parked at its cap counts its raises not taken yet the same way: raised, it reads as going on from the raise's
  // row, never input_required again until its runner takes it (and parks it anew if the raise falls short).
  const pending = (command: { kind: string; takenAt: number | null; refused: string | null; body: unknown }) =>
    command.takenAt === null && command.refused === null &&
    ((command.kind === "steer" && (command.body as { answers?: unknown } | null)?.answers !== false) || (command.kind === "raise" && budget?.kind === "budget"));
  const submitted = terminal || row.kind !== "agentic" || working ? 0 : (await commandsNow()).filter(pending).length;
  const outcome = terminal ? STATUS_OF[row.state as Exclude<RunReadState, "running">] : undefined;
  // A cancel the person asked for reads cancelled from the 202 on, while the runner is still cutting the turn: its command
  // row (not refused) is the request, so a poll never reads working or completed between the request and the end.
  const cancelling = !terminal && (await commandsNow()).some((command) => command.kind === "cancel" && command.refused === null);
  const view: RunView = {
    id: row.id,
    agentId: row.agent,
    harness,
    ...(row.importedFrom ? { imported: { source: row.importedFrom.source, session: row.importedFrom.session } } : {}),
    kind: row.kind,
    ...(outcome ? { outcome } : {}),
    ...(cancelling ? { finishing: "cancelled" as const } : {}),
    // A cancel is the run's outcome 'cancelled', never its state alone: a person's stop is stopped too, and is no cancel.
    cancel: runRow.outcome === "cancelled" || cancelling,
    working,
    submitted,
    updatedAt: iso(updatedAtMs),
    rows,
    turns,
    ...(approvals.size ? { approvals } : {}),
    // The cap pause's words, so the moment reads paused for a store budget park (the write half's raiseCap/sendMessage read
    // moment.paused/pausedWords); the file path's turns-based pausedAt gives nothing over the store.
    ...(budget?.kind === "budget" ? { pausedWords: budget.said } : {}),
    // The park's own id: a raise's answer names the follow-up the runner sends for this pause (raiseFollowUpId).
    ...(budget?.kind === "budget" && pause !== undefined ? { pause } : {}),
    meta,
  };
  // A completed workflow run's output, from its end (the workflow loop keeps it there, as main kept it on the run).
  const end = row.kind === "workflow" ? records.entries.findLast((entry) => entry.kind === KINDS.end) : undefined;
  const output = (end?.data as EndData | undefined)?.output ?? null;
  // An escalated workflow run's review, as its end kept it (the escalate node's kind, label and summary).
  const review = (end?.data as EndData | undefined)?.review;
  // What its decisions booked (their own session, never on the usage row, which counts its model requests and paid tools).
  const booked = bookedSpend(records.entries as never, "decisions");
  const decisions = booked.requests ? booked : undefined;
  const onPlan = planSpend(records.entries as never);
  const plan = onPlan.requests ? onPlan : undefined;
  const model = bookedSpend(records.entries as never, "model");
  // An ended run's booking by the one rule its end stored its cost by (metrics.ts runCostOf), read in the same snapshot as
  // its state: its so-far figures beside a stored unknown (costOfView reads the figure itself from the stored column). A
  // workflow's end stores it by the same rule (workflow-spec.ts); a native run's end reads its own, so it keeps the
  // reading below.
  const bookedCost = terminal && (row.kind === "workflow" || (row.kind === "agentic" && !native)) && !row.importedFrom ? runCostOf(records.entries as never, { unbooked: isCliRecord(records.entries as never) && cliModelWorked(records.entries as never) }) : undefined;
  const endCost = bookedCost?.requests ? bookedCost : undefined;
  const endSaidCost = endCost ? ((records.entries.findLast((entry) => entry.kind === KINDS.end)?.data as EndData | undefined)?.costUsd !== undefined) : false;
  return { ...(sdk ? {sdk}:{}), ...(native ? {native}:{}), row, runRow, launch, rows, version, harness, learningEnd: shownEnd, shownEnd, view, unshown, values, live, updatedAtMs, lastProgressAt, budget, paused, browserAsk, computerAsk, approvalsMode, output, ...(review ? { review } : {}), structured, decisions, plan, model, ...(endCost ? { endCost, endSaidCost } : {}) };
}

/** A run's learning as the view shows it: its end from the store (what it held for the owner's OK as it reads now), in a
 *  person's words cut of the host's secrets now. */
function learningViewOf(learningEnd: Learning | null, shown: Shown): unknown {
  if (!learningEnd) return null;
  return learningView(learningEnd, shown);
}

/** A run's learning before its end: the corrections its # Learned section holds and the learned workflows its claims
 *  laid, until its end-of-run turn starts; then looking back. */
function underWay(started: NonNullable<RunLaunch["learning"]>, laid: ReturnType<typeof laidOf>, reflect: Reflect | undefined, at: string): Learning {
  return reflect ? { state: "reflecting", reason: null, detail: said.reflecting, at } : { state: "seeded", reason: null, detail: said.seeded(correctionCount(started.section), laid.workflows.length), at };
}

/** The cost a run's view shows (runs.ts cost): its rows' cost, else what the store kept, and its cap. */
function costOfView(run: StoreRun): Record<string, unknown> {
  const imported = Boolean(run.row.importedFrom);
  // The stored cost the view folds with the rows' usage: an ended run's is its row's column (number or null, so a run the
  // store kept no cost for reads null, not 0, as the file path's run.costUsd = row.costUsd ?? null did). A run still going has
  // no stored cost (its column is written only at the end), so it reads undefined, which costView turns into 0 before any
  // request — never null.
  const stored = run.row.state === "running" ? undefined : run.runRow.costUsd;
  // The most it can have cost, when that is what its end stored (RunRow.costAtMostUsd): the view is a reader that says
  // "at most", so it shows that figure, marked upper_bound.
  const storedAtMost = run.row.state === "running" ? null : run.runRow.costAtMostUsd;
  // Its decisions' booked cost joins its usage row's (costView), one unknown making it unknown.
  const decisions = run.decisions;
  // An ended run that booked its requests reads the cost its end stored by its booking (runCostOf), the answer the list,
  // usage and stats read too: one figure on every reader. Its end reads that cost again when a read fails
  // (loop.ts readAgain), so a null is kept only when the booking could not be read within the end's bound. The booking,
  // read in the snapshot that read its state, adds only what the stored figure agrees with: what is known so far when both
  // are unknown. An end that wrote no cost (a spec that reads none) left the column alone: the booking is the answer then.
  const booked = run.endCost;
  const said = booked !== undefined && run.endSaidCost === true;
  // Its cost in the Cost's words (CostWords), each figure by the one rule (costWordsOf): a hold is never spend, so while
  // the total is unknown each held request counts as not priced, and a bound says its exact part and held count beside it.
  // A run still going or ended unbooked: its usage row joined with its decisions' booking (costWordsOfView). An imported
  // run: what the import stored, exact, else the catalog's estimate it kept beside it (costOfRun). An ended run that
  // booked its requests: its booking's words, or, where its end stored a figure, that figure, with what the booking says
  // beside it only where the two agree (the same unknown, the same bound); a bound its end stored is said so
  // (cost_upper_bound), the bound the list and the column read too.
  const bookedWords = booked ? costWordsOf([booked]) : undefined;
  const words = !booked ? (imported ? { usd: costOfRun(run.runRow) } : costWordsOfView(run.rows, stored, decisions)) : !said ? bookedWords! : stored !== null && stored !== undefined ? { usd: stored } : storedAtMost !== null ? { ...(bookedWords!.upper_bound ? bookedWords : {}), usd: storedAtMost, upper_bound: true as const } : bookedWords!.usd === null ? bookedWords! : { usd: null };
  const usd = words.usd;
  const counted = words.so_far_usd !== undefined && words.unpriced !== undefined ? { so_far_usd: words.so_far_usd, unpriced: words.unpriced } : undefined;
  const upper = words.upper_bound ? { upper_bound: true as const } : undefined;
  // A request billed to a person's plan costs no dollars, however it ended (the kernel's turnCostOf): every reader counts it
  // $0, so it is in no unpriced count; what it used on the plan is said beside the figure, and which plan: a run on the
  // login's harness was on Claude Code's login (claude-login.ts), any other on the ChatGPT sign-in.
  const plan = run.plan;
  const on = run.harness === LOGIN_HARNESS ? "claude_code" : "chatgpt";
  // Beside its figure: while it is unknown, what is known so far; at $0 with every model request on a free model (and no
  // decision of its own), that it is free.
  const soFar = counted ?? (imported || decisions?.requests ? undefined : freeOf(run.rows, usd));
  // The run's cap as it stands (its view's meta: the newest raise's, else the launch's).
  const cap = run.view.meta.max_cost_usd;
  const tokens = tokensOfView(run);
  return { usd, basis: basisOfView(run, words), charge_state: null, cap_usd: cap ?? null, ...(soFar ?? {}), ...(upper ?? {}), ...(plan ? { plan: { requests: plan.requests, tokens: plan.tokens, on } } : {}), ...(tokens ? { tokens } : {}) };
}

/** How a run's cost was reached (metrics.ts CostBasis): by how its model requests were priced, as its booking says, while
 *  it booked one; else as its end stored it, or, where nothing says, an `estimate` when it cost anything (a native, SDK or
 *  imported run's figure is its harness's or the catalog's), `unpriced` when nothing was priced. */
function basisOfView(run: StoreRun, words: { readonly usd: number | null; readonly so_far_usd?: number }): CostBasis {
  if (run.model.requests > 0) return costBasisOf(run.model);
  return storedBasisOf(run.row.state === "running" ? undefined : run.runRow.metrics, words.usd ?? words.so_far_usd);
}

/** A run's tokens as its cost says them: its model requests' input (cached input apart), output, cache reads and writes,
 *  how many requests it booked, and how many of those reported no tokens (`unmetered`). From its booking while it booked a
 *  request; else from the metrics its end stored (an imported run's); undefined when neither says. A native or SDK run
 *  books one record for its whole task (`aggregate`), not one per request, so its tokens are its stored metrics' alone,
 *  with its request count unknown (left out), and none while any count is unknown (stored null), never a 0 for one. */
function tokensOfView(run: StoreRun): Record<string, number> | undefined {
  const booked = run.model;
  const aggregate = run.native !== undefined || run.sdk !== undefined;
  if (booked.requests > 0 && !aggregate) return { input: booked.tokens.input, output: booked.tokens.output, cache_read: booked.tokens.cacheRead, cache_write: booked.tokens.cacheWrite, requests: booked.requests, unmetered: booked.unmetered };
  const stored = (run.row.state === "running" ? undefined : run.runRow.metrics) as Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "requests" | "unmetered", unknown>> | null | undefined;
  if ([stored?.input, stored?.output, stored?.cacheRead, stored?.cacheWrite].some((value) => value === null)) return undefined;
  const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
  const [input, output] = [count(stored?.input), count(stored?.output)];
  if (input === undefined || output === undefined) return undefined;
  const requests = count(stored?.requests);
  if (requests === 0 && input + output === 0) return undefined;
  return { input, output, cache_read: count(stored?.cacheRead) ?? 0, cache_write: count(stored?.cacheWrite) ?? 0, ...(requests === undefined ? {} : { requests }), ...(count(stored?.unmetered) === undefined ? {} : { unmetered: count(stored?.unmetered)! }) };
}

/** GET /runs/{id}'s answer from the store, byte-identical to runs.ts's view for the same run. Undefined for an unknown run. */
export async function viewOverStore(store: Store, runId: string, deps: ViewDeps): Promise<Record<string, unknown> | undefined> {
  const run = await storeRunOf(store, runId, deps);
  return run && viewOfRun(store, runId, deps, run);
}

/** GET /runs/{id}'s answer for a run already read (storeRunOf). `read.withheld` is set to whether the answer withholds the
 *  run because this server could not read back the sign-in it was handed (its cut, or its error's words). */
async function viewOfRun(store: Store, runId: string, deps: ViewDeps, run: StoreRun, read?: { withheld: boolean }): Promise<Record<string, unknown>> {
  const { row, runRow, launch, view, unshown, values, output, review: kept, structured } = run;
  const { status, state } = statusOf(view, factsOf(run));
  const terminal = TERMINAL.has(status);
  // A cancel reads cancelled from its 202 (status terminal) while the runner is still cutting the turn: the run is settled
  // only once the store holds its end (its row no longer running), so its end time, poll hint, timeline `final` and learning
  // come from that end, never from the optimistic status. Later tool results, withdrawals and charges still stream in.
  const ended = row.state !== "running";
  const endedAtMs = terminal && ended ? (runRow.endedAt ?? runRow.startedAt) : null;
  const shownWords = (text: string): string => withoutLoopback(redacted(text, values));
  // The answer row's text is the answer as served (whole, through redactedAnswer, once per held value set, when the row
  // was cut; else the rows' redactor over what was never cut): served again through redactedAnswer once per that set.
  const servedAnswer = (text: string | null): string | null => (text ? servedOnce(store, runId, text, values) : text);

  const finalAnswer = row.kind === "workflow" || unshown ? null : answerOf(run.rows) ?? row.summary ?? null;
  // A workflow run's output, as its end kept it; an agentic run's, its final answer's structured part when its agent has
  // an output schema and the answer's last fenced json block meets it (storeRunOf's `structured`), else none. Served as
  // runs.ts serves it (servedOutput): each string in it cut of the values the run holds, its shape kept; none while the
  // run's sign-in can't be read back.
  const ownOutput = row.kind === "workflow" ? output : status === "completed" && structured && "value" in structured ? structured.value : null;
  const servedOutput = !unshown && ownOutput !== null && ownOutput !== undefined ? redactedOutput(ownOutput, values) : null;
  // A run its cap ended once its cost passed it (spend_cap_reached) keeps the answer it paid for, as main kept it: the
  // response that crossed the cap was answered and billed, so its text is the run's answer, cut as it came.
  // Its answer is the newest answer row, else (a response cut at its length) the newest text it said; never the row's
  // summary, which holds the cap's words.
  const overCap = status === "failed" && overCapMessage(row.summary ?? null) !== undefined;
  // A text the timeline cut at its cap is read whole from the journal and served as an answer row is (wholeAnswerFor).
  const capRow = overCap && !unshown ? (run.rows.findLast((r) => r.kind === "final_answer" && r.agent_label !== LEARNING_LABEL) ?? run.rows.findLast((r) => r.kind === "text_block" && r.agent_label !== LEARNING_LABEL)) : undefined;
  let capAnswer = capRow?.text ?? null;
  if (capRow?.kind === "text_block" && capAnswer !== null && (capAnswer.length >= CAPS.text || capAnswer.endsWith("...") || capAnswer === "[redacted]")) {
    const whole = (await runTimeline(store, runId, BACKGROUND_CONTEXT, { settled: true, caps: { text: Number.POSITIVE_INFINITY } })).find((r) => r.id === capRow.id)?.text;
    if (typeof whole === "string") capAnswer = wholeAnswerFor(values).serve(whole);
  }
  // Why a completed agentic run with an output schema has no output (its answer still missed the schema after the runner's
  // one retry), in shown words: a JSON parse error can quote the answer.
  const outputError = row.kind === "agentic" && !unshown && structured && "why" in structured ? { output_error: shownWords(structured.why) } : {};
  const result = status === "completed" ? { output: servedOutput, final_answer: servedAnswer(finalAnswer), ...outputError } : overCap ? { output: null, final_answer: servedAnswer(capAnswer) } : null;
  // A failed run's reason in the model's own words when the store holds them: the last model-error row's text (a provider's
  // refusal, rendered from its pi.assistant error entry), else the run row's summary (the runner's generic "gave no answer").
  // It reads as the run's Timeline error row does (run-cut.ts runErrorWordsOf, main's errorWords): a refused key in plain
  // words, else cut of every secret (the view's values) and of any loopback address, so a key or a pointer the provider
  // quoted never shows, as main serves the run's error.
  const failedReason = run.rows.findLast((r) => r.kind === "error")?.text ?? row.summary ?? null;
  const errorWords = status === "failed" && !unshown ? await runErrorWordsOf({ ...deps, keyEnv: deps.keyEnv ?? (() => process.env) }, store, runId, { workflow: row.kind === "workflow" }) : undefined;
  const withheld = unshown || errorWords === "unreadable";
  if (read) read.withheld = withheld;
  const error = status === "failed" ? (withheld ? { code: "run_failed", message: WITHHELD_SIGN_IN, retryable: false } : servedRunErrorWith(errorWords ?? shownWords, errorOfRow(failedReason))) : null;
  const review = endedAtMs === null ? null : servedReviewWith(shownWords, unshown, reviewAt(reviewOfRow(row.state, row.summary ?? null, kept), iso(endedAtMs)));
  // The card the run shows while it waits, in the order the file-backed view (runs.ts) picks them: a tool call parked for a
  // person's approval (approvalOf, its arguments shown through the run's redactor), else a run parked at its cap (the budget
  // card), else its agent waiting on a person in its browser (browserPending), else the question its turn ended on (pendingOf).
  // A turn a person stopped reads kind stopped (stoppedTurn, which the run.needs_input webhook reads through this field):
  // it holds none of the run's words, so a withheld run says it too.
  const redactor = redactorOf(values);
  const pending: Pending = !unshown && status === "input_required" && state === "waiting" ? (approvalOf(view, redactor) ?? run.budget ?? browserPending(run.browserAsk, redactor) ?? computerPending(run.computerAsk, redactor) ?? pendingOf(run.rows)) : stoppedTurn(view, { status, state }) ? { kind: "stopped" } : null;
  const settled = terminal && ended;

  return {
    ...(run.sdk && !unshown ? {sdk:redactedOutput(run.sdk,values)}:{}),
    ...(run.native && !unshown ? {native:redactedOutput(run.native,values)}:{}),
    run_id: row.id,
    agent_id: row.agent,
    agent_version: run.version,
    console_url: runLink(deps.origin, row.id),
    revision: row.revision,
    kind: row.kind,
    sha: null,
    status,
    state,
    // A withheld run's title is a short fixed line (WITHHELD_TITLE), never its stored title: the title can repeat the
    // sign-in this server can't read back to cut, so it is not served. The full withheld sentence is in error and review.
    title: unshown ? WITHHELD_TITLE : shownWords(launch?.title ?? ""),
    // The input the run was started with, as its launch keeps it, whole (never the first message the timeline caps): what
    // "Run again" sends again. Null when the cut a run's words get would change it (inputWhole: a held value, a long run
    // with no whitespace), for a withheld run, and for one whose launch holds no input object.
    input: !unshown && isObject(launch?.input) && inputWhole(store, runId, launch?.input, values) ? launch?.input : null,
    file_ids: [...(launch?.files ?? [])],
    place: launch?.place ?? { mode: "runner" },
    // The runner holding the run now, when one does (a running run with a live claim): its id, the claim's count (up one each
    // claim, carried on every write the runner makes), and when the claim runs out. Null when no runner holds the run, so a
    // reclaim shows a new runner and a higher epoch. Additive on the Run (openapi claim/1).
    claim: run.live ? { runner: runRow.runner!, epoch: runRow.epoch, until: iso(runRow.claimedUntil!) } : null,
    ...(launch?.effort ? { effort: launch.effort } : {}),
    created_at: iso(runRow.startedAt),
    updated_at: iso(run.updatedAtMs),
    ended_at: endedAtMs === null ? null : iso(endedAtMs),
    result,
    error,
    review,
    pending,
    // Its own spend: an audit's shadow run of it is learning (GET /runs/{id}'s cost.learning_usd), never its cost.usd.
    cost: costOfView(run),
    // The run an audit's shadow run audits (launch.audit, runner/audit.ts); null for any other run.
    audit_of: launch?.audit?.of ?? null,
    // The path it took and the learned workflow that served it, as its record keeps them: the read the cost per run makes
    // (store-reads/learning.ts pathViewOf).
    ...pathViewOf(runRow, row.kind, launch ? learningStartOf(launch) : undefined),
    // Whether it ran unattended (its revision's approvals, as it started): never, an ask allowed at its gate; ask, the default.
    approvals: run.approvalsMode,
    archived_at: row.archivedAt ?? null,
    // Only what an imported run shows: never the server's internal file stamp (importedFrom.file).
    imported_from: runRow.importedFrom ? { source: runRow.importedFrom.source, session: runRow.importedFrom.session } : null,
    trigger: launch?.trigger ? { id: launch.trigger.id, firing_key: launch.trigger.firing_key } : null,
    // The caller's labels, as given at the start ({} when none): its own strings, never cut.
    labels: runRow.labels,
    // Cut by the run's one cut (the pointers it was handed among them), and none for a withheld run, as its words.
    learning: unshown ? null : learningViewOf(run.learningEnd, secretsShown(values)),
    // Its screen recordings (computer.record), from the files on this machine, where its read asks for them; none for a
    // withheld run, whose files are refused. A run that left running with no end stamped (parked) ends now, each read: only
    // a file's trailer finishes it there.
    ...(deps.recordings ? { recordings: unshown ? [] : await deps.recordings(row.agent, row.id, ended ? (runRow.endedAt ?? Date.now()) : null) } : {}),
    poll_after_ms: settled ? 0 : 1000,
    last_progress_at: run.lastProgressAt,
  };
}

/** The run list's answer from the store, byte-identical to runs.ts's summary: the view's subset a list shows. */
export async function summaryOverStore(store: Store, runId: string, deps: ViewDeps): Promise<Record<string, unknown> | undefined> {
  const view = await viewOverStore(store, runId, deps);
  return view && summaryOfView(view);
}

/** What a list shows of a run's view (summaryOverStore). */
export function summaryOfView(view: Record<string, unknown>): Record<string, unknown> {
  const { run_id, agent_id, agent_version, console_url, revision, kind, sha, status, state, title, effort, created_at, ended_at, error, review, pending, cost, archived_at, imported_from, trigger, labels, learning } = view as Record<string, unknown>;
  return {
    run_id, agent_id, agent_version, console_url, revision, kind, sha, status, state, title,
    ...(view.sdk ? {sdk:view.sdk} : {}),
    ...(view.native ? {native:view.native} : {}),
    ...(effort ? { effort } : {}),
    created_at, ended_at, error, review, pending, cost, archived_at, imported_from, trigger, labels,
    learning: learning ? shortOf(learning as Parameters<typeof shortOf>[0]) : null,
    // Read off the run's record, so a list carries it with no read of the run's journal.
    path: view.path, workflow: view.workflow,
  };
}

/** A runs list's item for a run, as its listing keeps it on the run's row (store/schema.ts RUN_LISTING_COLUMNS), built from
 *  the run's view once per change and read by every list after: its list item (summaryOverStore's) with the parts a list
 *  fills in when it reads it (console_url: the origin the request reached; archived_at: the run's or its agent's archive
 *  now) kept empty; the digest of the server's secrets it was cut of (`cut`, so a list cuts it again of any saved since);
 *  its status; whether a runner held the run (its status reads otherwise once that claim runs out); when it goes stale by
 *  the clock alone (the ask it waits on expires, or LISTING_RETRY_MS after a build that withheld the run because the
 *  sign-in it was handed could not be read: that read may fail only for now, and the run reads whole once it recovers);
 *  and what outside the run it read (LISTING_HELD, LISTING_KEYED). Undefined for an unknown run. */
export async function listingOverStore(store: Store, runId: string, deps: ViewDeps): Promise<RunListing | undefined> {
  const cut = secretsDigest(deps.serverSecrets());
  const run = await storeRunOf(store, runId, deps);
  if (!run) return undefined;
  const read = { withheld: false };
  const summary = summaryOfView(await viewOfRun(store, runId, deps, run, read));
  const status = String(summary.status);
  const terminal = TERMINAL.has(status as Status);
  const asks = terminal ? [] : [run.browserAsk?.expires_at, run.computerAsk?.expires_at].map((at) => (typeof at === "string" ? Date.parse(at) : Number.NaN)).filter((at) => Number.isFinite(at));
  const expiries = read.withheld ? [...asks, (deps.now ?? Date.now)() + LISTING_RETRY_MS] : asks;
  const flags = (run.shownEnd && holdsForOk(run.shownEnd as Learning) ? LISTING_HELD : 0) | (status === "failed" && run.row.kind !== "workflow" ? LISTING_KEYED : 0);
  return {
    item: { ...summary, console_url: null, archived_at: null },
    cut,
    status,
    live: run.live,
    until: expiries.length ? Math.min(...expiries) : null,
    flags,
  };
}

/** Whether `listing` is cut of the server's secrets as they are now. A list builds any other again before it shows it
 *  (server.ts runsPage): the run's view cuts a value whole where it holds a secret (a note's name reads [redacted]), which
 *  cutting the built item again could not do. */
export function builtOfNow(listing: KeptListing, serverSecrets: readonly string[]): boolean {
  return listing.cut === secretsDigest(serverSecrets);
}

/** A listing's list item as a list serves it (listingOverStore): its console link at `origin`, its archive time now
 *  (`archivedAt`, ms, the run's or its agent's), and, when the server's secrets moved between its build and this (within
 *  one list), every string in it cut again of them (redactedOutput), so a secret saved since never shows. */
export function listedItem(listing: KeptListing, origin: string, archivedAt: number | null, serverSecrets: readonly string[]): Record<string, unknown> {
  const item = { ...listing.item, console_url: runLink(origin, String(listing.item.run_id)), archived_at: archivedAt === null ? null : iso(archivedAt) };
  return listing.cut === secretsDigest(serverSecrets) ? item : (redactedOutput(item, [...serverSecrets]) as Record<string, unknown>);
}

/** A set of secrets' digest, the same for the same set in any order: what a listing was cut of. */
const secretsDigest = (values: readonly string[]): string => createHash("sha256").update([...new Set(values)].sort().join("\0")).digest("hex");

/** A run's facts as its view states them, and none of its words: its kind, revision, agent, status and times, and whether
 *  its output is withheld (`unshown`). What a read that serves its own parts (the graph) needs of the run: read off the
 *  run as viewOverStore reads it, with nothing of it served, so nothing is redacted here. Undefined for an unknown run. */
export async function factsOverStore(store: Store, runId: string, deps: ViewDeps): Promise<RunStated | undefined> {
  const run = await storeRunOf(store, runId, deps);
  if (!run) return undefined;
  const { status } = statusOf(run.view, factsOf(run));
  const endedAtMs = TERMINAL.has(status) && run.row.state !== "running" ? (run.runRow.endedAt ?? run.runRow.startedAt) : null;
  return { kind: run.row.kind, revision: run.row.revision, agentId: run.row.agent, status, createdAt: iso(run.runRow.startedAt), endedAt: endedAtMs === null ? null : iso(endedAtMs), unshown: run.unshown };
}

/** A run's facts as its view states them (factsOverStore): no word of it, so nothing in it is redacted. */
export type RunStated = { readonly kind: string; readonly revision: string; readonly agentId: string; readonly status: string; readonly createdAt: string; readonly endedAt: string | null; readonly unshown: boolean };

/** A run's live moment from the store (momentOf), for the one acceptance each act a run takes reads. A run no runner holds
 *  (ended, or running with no live claim) reads live false. */
export async function momentOverStore(store: Store, runId: string, deps: ViewDeps = { origin: "", serverSecrets: () => [] }): Promise<RunMoment | undefined> {
  const run = await storeRunOf(store, runId, deps);
  if (!run) return undefined;
  // What is archived of it: its agent (whose archive holds its runs too, so it is said first: unarchiving the run alone would
  // not open it), else the run's own archive time.
  const archived = (await store.agents.get(run.row.agent))?.archivedAt ? "agent" : run.row.archivedAt ? "run" : undefined;
  return { ...momentOf(run.view, factsOf(run), run.live), ...(archived ? { archived } : {}) };
}

/** A run's timeline rows as the VIEW renders them (storeRunOf's view.rows: withAsks, so a run waiting on a question carries
 *  its `:waiting` row). The run-ended/run-needs-input follower reads these for its wait marker, main's marker and webhook-id.
 *  The served `/timeline` route uses run-timeline-served.ts (servedTimelineRows) instead; this is the internal view's rows.
 *  Undefined for an unknown run. */
export async function timelineOverStore(store: Store, runId: string, deps: ViewDeps): Promise<readonly TimelineEvent[] | undefined> {
  return (await storeRunOf(store, runId, deps))?.view.rows;
}

/** Whether a run's served output is withheld: this server can't read the browser sign-in it was handed, so nothing it said
 *  is shown (storeRunOf's `unshown`). The run read routes refuse a withheld run's graph, as the file-backed route did; a
 *  run with no such mark, or no such run, is not withheld. Reads anew on each call: a run withheld while its key was missing
 *  is shown once it opens, as the view is. */
export async function withheldOverStore(store: Store, runId: string, deps: ViewDeps): Promise<boolean> {
  const run = await storeRunOf(store, runId, deps);
  return run?.unshown ?? false;
}

/** Re-export so a caller need not reach into run-view for the type. */
export type { RunMoment } from "./run-view.js";
