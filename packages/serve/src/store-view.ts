// A run's served view, built from the one store (design 2.1): the same object GET /runs/{id} answered from the per-run
// files, now composed from the store's row (store-reads/runs.ts), its journal (store-reads/journal.ts) and its learning end
// (store-reads/learning.ts), fed through the run view's pure functions (run-view.ts) so the figures and words a person or a
// model sees do not change. runs.ts still answers the API from files; this is the store-backed path the server cut switches
// onto. viewOverStore answers the run read, summaryOverStore the run list, momentOverStore the one acceptance each act reads.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { runLink } from "./console-links.js";
import { redacted, redactedAnswer, redactedOutput, withoutLoopback } from "./key-refusal.js";
import { currentLearning, holdsForOk, type ItemStatus, type Learning, learningView, LEARNING_LABEL, secretsShown, shortOf, type Shown } from "./learning.js";
import { said } from "./learning-words.js";
import { MIN_SECRET } from "./learn/secrets.js";
import { handedValuesOf, launchOf } from "./handed-values.js";
import { learningStartOf, type RunLaunch, seedFailed } from "./run-launch.js";
import {
  momentOf,
  type Pending,
  pendingOf,
  type RunFacts,
  type RunMoment,
  type RunView,
  type RunViewMeta,
  type SignInReader,
  type State,
  type Status,
  approvalOf,
  asksOf,
  answersOf,
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
  costView,
  soFarOf,
  withAsks,
  withApprovalRows,
} from "./run-view.js";
import { reflects, type Reflect } from "./reflect-range.js";
import { journalRecords, recordOf } from "./runner/journal-reader.js";
import { type EndData, KINDS } from "./runner/journal-kinds.js";
import { notesReadOf, runLearningEnd, type RunLearning, withNotes } from "./store-reads/learning.js";
import { runReflect, runTimeline, wholeAnswerFor, wholeAnswers } from "./store-reads/journal.js";
import { type RunReadState, readRun } from "./store-reads/runs.js";
import { runCutValues, runErrorWordsOf } from "./run-cut.js";
import { Turns } from "./turns.js";
import { harnessOfBody } from "./harness.js";
import { browserAsk as browserAskOf, BROWSER_HANDOVER_KIND } from "./browser-commands.js";
import { computerAsk as computerAskOf, COMPUTER_HANDOVER_KIND } from "./computer-commands.js";
import type { PendingAsk } from "./browser-person.js";
import { approvalsOf, type Approvals } from "./approvals.js";
import { FINAL_STATES, type RunRow, type Store } from "./store/store.js";

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
}

/** A run that has ended reads one of these (the old RunRow state → the v2 status: an escalation is a completion with a
 *  review; a stopped run is a cancellation), as runs.ts's STATUS_OF mapped them. A running run reads its status from the
 *  journal. */
const STATUS_OF: Record<Exclude<RunReadState, "running">, Status> = { completed: "completed", failed: "failed", escalated: "completed", stopped: "cancelled" };
/** A run that has reached a last state (its view is its ended shape). */
const TERMINAL = new Set<Status>(["completed", "failed", "cancelled"]);

const iso = (ms: number): string => new Date(ms).toISOString();

/** What a view last served of each run's answer, by store and run: the answer it read (`input`), the digest of the values
 *  it was redacted of (`key`) and what that gave (`out`), so a second view of the same answer and values reads nothing
 *  again (main's runs.ts servedOnce: a console polls a run's view, and an answer can be large). Newest SERVED_KEPT runs of
 *  each store. */
const servedByStore = new WeakMap<Store, Map<string, { input: string; key: string; out: string }>>();
const SERVED_KEPT = 32;
function servedOnce(store: Store, runId: string, input: string, values: readonly string[]): string {
  let served = servedByStore.get(store);
  if (!served) servedByStore.set(store, (served = new Map()));
  const key = wholeAnswerFor(values).key;
  const last = served.get(runId);
  if (last && last.key === key && last.input === input) return last.out;
  const out = redactedAnswer(input, values);
  served.delete(runId);
  served.set(runId, { input, key, out });
  for (const oldest of served.keys()) {
    if (served.size <= SERVED_KEPT) break;
    served.delete(oldest);
  }
  return out;
}

/** A run's whole answer as answerOfRun read it from the rows: its newest final-answer row, never the learning turn's. */
const answerOf = (rows: readonly TimelineEvent[]): string | null => rows.findLast((r) => r.kind === "final_answer" && r.agent_label !== LEARNING_LABEL)?.text ?? null;

/** A failed run's error from its row (its own words are the summary; the store keeps no code or detail apart). */
const errorOfRow = (summary: string | null): { code: string; message: string; retryable: false; details?: unknown } => ({ code: "run_failed", message: summary ?? "The run failed.", retryable: false });

/** An escalated run's review from its row: its summary is the reason (the store keeps no kind or node apart). */
type SavedReview = { kind: string | null; node: string | null; reason: string };
const reviewOfRow = (state: RunReadState, summary: string | null): SavedReview | null => (state !== "escalated" ? null : { kind: null, node: null, reason: summary ?? "The workflow escalated." });
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
  readonly row: NonNullable<Awaited<ReturnType<typeof readRun>>>;
  readonly runRow: RunRow;
  readonly launch: RunLaunch | undefined;
  readonly rows: TimelineEvent[];
  readonly version: number;
  readonly harness: string;
  readonly learningEnd: RunLearning | null;
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
}

/** A runner holds the run's claim now: it is not in a final state, a runner is named on its row, and its lease has not run
 *  out (claimed_until >= now, the predicate the claimable query's `claimed_until < ?` is the negation of). `now` is the
 *  server's clock, so a test on a moved clock reads a fresh claim as live. */
function liveOf(runRow: RunRow, now: number): boolean {
  return !FINAL_STATES.includes(runRow.state) && runRow.runner !== null && runRow.claimedUntil !== null && runRow.claimedUntil >= now;
}

/** Reads the run from the store and builds the RunView the view functions read. */
async function storeRunOf(store: Store, runId: string, deps: ViewDeps): Promise<StoreRun | undefined> {
  const context = BACKGROUND_CONTEXT;
  const row = await readRun(store, runId, context);
  if (!row) return undefined;
  const runRow = await store.runs.get(runId);
  if (!runRow) return undefined;
  const launch = await launchOf(store, runId);
  // The run's one cut (run-cut.ts): the pointers it was handed read back and every secret this server never shows, so a
  // run whose words could repeat one is cut of it, rows and all, or withheld when this server cannot read back what it
  // was handed (rowShown's choke point).
  const cut = await runCutValues(deps, store, runId, { runRow, launch });
  const unshown = cut === "unreadable";
  const values = cut === "unreadable" ? [] : cut.values;
  const revision = await store.agents.revision(row.revision);
  const harness = launch?.harness ?? harnessOfBody((revision?.body ?? {}) as { harness?: string });
  // Whether the run ran unattended, from the revision it is pinned to (approvals "never"), else the default (ask).
  const approvalsMode = approvalsOf((revision?.body as { approvals?: unknown } | undefined)?.approvals);
  const terminal = row.state !== "running";
  // The timeline, then the waiting row a run asking a question shows (withAsks), as the file path's rows carried it, so a
  // run waiting on a question reads the same status and pending.
  // Its final answer whole (store-reads/journal.ts wholeAnswers), as main served a run's answer: a row's cut is no answer's.
  const timelineOptions = { settled: terminal, redact: (text: string) => redacted(text, values) };
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
  const reflectRange = (await runReflect(store, runId, context)) as Reflect | undefined;
  const skip = reflectRange ? (id: number) => reflects(reflectRange, id) : undefined;
  // The run's learning end with the notes its start gave it and those its job read (its own reads, keyed on the given, read
  // from its rows uncut: a note whose name holds a secret is cut where it is shown, after it is matched). Before its end, a
  // run that learns is seeded, then looking back once its end-of-run turn starts (main's seeded and reflecting).
  const started = launch ? learningStartOf(launch) : undefined;
  const read = started?.given.length ? notesReadOf(started.given, reflectRange, await runTimeline(store, runId, context, { settled: terminal })) : [];
  const under = !ended && started && !seedFailed(started) ? underWay(started, reflectRange, iso(runRow.startedAt)) : null;
  const sofar = ended ?? under;
  const shownEnd = sofar && withNotes(sofar, started, read);
  // What it held for its owner's OK as it reads now, on its agent's folder's main (learning.ts currentLearning); its record
  // stays as the merge wrote it.
  const learningEnd = shownEnd && holdsForOk(shownEnd as Learning) && deps.statuses ? (currentLearning(shownEnd as Learning, await deps.statuses(row.agent)) as RunLearning) : shownEnd;
  const turns = new Turns();
  turns.note(recordOf(records.entries), records.submissions ?? [], skip, liveRow?.updatedAt ?? deps.now?.() ?? Date.now());
  const working = live && turns.open > 0;
  const progress = terminal || row.kind === "workflow" ? undefined : turns.progressAt();
  const lastProgressAt = progress === undefined ? null : iso(progress);


  // The tool-call approvals the run waits (or waited) on, from its journal: each call the gate parked for a person, and
  // the answers given, which the status, pending and moment views read the same as the file path read them from the run's
  // store entries.
  const approvals = asksOf(records.entries);
  // A call asked before an end in the journal reads withdrawn in that end's words; a stopped or failed run's (states no
  // reopen leaves) whose journal holds no end, by its row (answersOf `final`).
  const answers = answersOf(records.entries, { final: runRow.state === "stopped" || runRow.state === "failed" ? runRow.state : undefined });
  // The rows a person reads: each call that waited for approval in order (held, your approval, what came of it), its
  // arguments and the person's notes through the run's redactor, as the file path's withApprovals served them.
  const rows = withApprovalRows(timeline, approvals, answers, redactorOf(values));

  // The run's cap as it stands: its newest raise's (the agentrun.raise entries the runner's loop holds it to, adapter-loop
  // capNow), else its launch's; a raise taken shows in the run's cost.cap_usd and its budget card, never the old cap.
  const raisedCapUsd = records.entries.findLast((entry) => entry.kind === KINDS.raise && typeof (entry.data as { capUsd?: unknown } | undefined)?.capUsd === "number" && (entry.data as { capUsd: number }).capUsd > 0)?.data as { capUsd: number } | undefined;
  const capUsd = launch?.maxCostUsd === undefined ? undefined : Math.max(launch.maxCostUsd, raisedCapUsd?.capUsd ?? 0);
  const meta: RunViewMeta = { ...(capUsd !== undefined ? { max_cost_usd: capUsd } : {}), ...(Object.keys(answers).length ? { approvals: answers } : {}) };
  // The budget card the run shows while it stands parked at its cap, from its journal's agentrun.budget park (none once a
  // raise clears it). Read over the same meta cap and rows the card's figures and time come from.
  const budget = budgetOf(records.entries, { meta, rows, updatedAt: iso(updatedAtMs) });
  // Whether a workflow run stands paused in its process now (its parked row with the pause's words, its newest pause not
  // resumed), the `paused` fact the status table reads for a paused workflow.
  const paused = pausedOf(runRow, records.entries);
  // The browser hand-over the agent waits on (E2c's reader over the run's hand-over entries and hand-back commands), read
  // against the server's clock. Only a run with a hand-over entry fetches its commands, so a run with none reads none and
  // makes no extra store read.
  // The run's command rows, read once for what needs them: a hand-over's answers, and the person's messages not yet taken.
  let commandRows: Awaited<ReturnType<Store["commands"]>> | undefined;
  const commandsNow = async () => (commandRows ??= await store.commands(runId, 0));
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
  // only a message that may answer a person counts (a trigger's, answers: false, never does, and is refused while it waits).
  // A run parked at its cap counts its raises not taken yet the same way: raised, it reads as going on from the raise's
  // row, never input_required again until its runner takes it (and parks it anew if the raise falls short).
  const pending = (command: { kind: string; takenAt: number | null; refused: string | null; body: unknown }) =>
    command.takenAt === null && command.refused === null &&
    ((command.kind === "steer" && (command.body as { answers?: unknown } | null)?.answers !== false) || (command.kind === "raise" && budget?.kind === "budget"));
  const submitted = terminal || row.kind !== "agentic" || working ? 0 : (await commandsNow()).filter(pending).length;
  const outcome = terminal ? STATUS_OF[row.state as Exclude<RunReadState, "running">] : undefined;
  const view: RunView = {
    id: row.id,
    agentId: row.agent,
    harness,
    ...(row.importedFrom ? { imported: { source: row.importedFrom.source, session: row.importedFrom.session } } : {}),
    kind: row.kind,
    ...(outcome ? { outcome } : {}),
    // The store's "stopped" state is a cancellation; its moment reads cancelled.
    cancel: row.state === "stopped",
    working,
    submitted,
    updatedAt: iso(updatedAtMs),
    rows,
    turns,
    ...(approvals.size ? { approvals } : {}),
    // The cap pause's words, so the moment reads paused for a store budget park (the write half's raiseCap/sendMessage read
    // moment.paused/pausedWords); the file path's turns-based pausedAt gives nothing over the store.
    ...(budget?.kind === "budget" ? { pausedWords: budget.said } : {}),
    meta,
  };
  // A completed workflow run's output, from its end (the workflow loop keeps it there, as main kept it on the run).
  const end = row.kind === "workflow" ? records.entries.findLast((entry) => entry.kind === KINDS.end) : undefined;
  const output = (end?.data as EndData | undefined)?.output ?? null;
  return { row, runRow, launch, rows, version, harness, learningEnd, view, unshown, values, live, updatedAtMs, lastProgressAt, budget, paused, browserAsk, computerAsk, approvalsMode, output };
}

/** A run's learning as the view shows it: its end from the store (what it held for the owner's OK as it reads now), in a
 *  person's words cut of the host's secrets now, and, for an ended run, the notes it read. */
function learningViewOf(learningEnd: RunLearning | null, shown: Shown, settled: boolean): unknown {
  if (!learningEnd) return null;
  return learningView(learningEnd as Learning, shown, settled);
}

/** A learning run's learning before its end (main's learning-run.ts onStart and its end-of-run turn): seeded, saying how
 *  many notes its seed held, until its end-of-run turn starts; then looking back. */
function underWay(started: NonNullable<RunLaunch["learning"]>, reflect: Reflect | undefined, at: string): RunLearning {
  return reflect ? { state: "reflecting", reason: null, detail: said.reflecting, at } : { state: "seeded", reason: null, detail: said.seeded(started.seedNotes ?? 0), at };
}

/** The cost a run's view shows (runs.ts cost): its rows' cost, else what the store kept; a cap's room noted when it has
 *  one. A terminal run holds no request in flight, so its overshoot bound is 0. */
function costOfView(run: StoreRun): Record<string, unknown> {
  const imported = Boolean(run.row.importedFrom);
  // The stored cost the view folds with the rows' usage: an ended run's is its row's column (number or null, so a run the
  // store kept no cost for reads null, not 0, as the file path's run.costUsd = row.costUsd ?? null did). A run still going has
  // no stored cost (its column is written only at the end), so it reads undefined, which costView turns into 0 before any
  // request — never null.
  const stored = run.row.state === "running" ? undefined : run.runRow.costUsd;
  const usd = imported ? (stored ?? null) : costView(run.rows, stored, undefined);
  const soFar = usd === null && !imported ? soFarOf(run.rows) : undefined;
  // The run's cap as it stands (its view's meta: the newest raise's, else the launch's).
  const cap = run.view.meta.max_cost_usd;
  const bound = cap === undefined ? {} : { overshoot_bound_usd: 0 };
  return { usd, basis: "estimate", charge_state: null, cap_usd: cap ?? null, ...bound, ...(soFar ?? {}) };
}

/** GET /runs/{id}'s answer from the store, byte-identical to runs.ts's view for the same run. Undefined for an unknown run. */
export async function viewOverStore(store: Store, runId: string, deps: ViewDeps): Promise<Record<string, unknown> | undefined> {
  const run = await storeRunOf(store, runId, deps);
  if (!run) return undefined;
  const { row, runRow, launch, view, unshown, values, output } = run;
  const { status, state } = statusOf(view, factsOf(run));
  const terminal = TERMINAL.has(status);
  const endedAtMs = terminal ? (runRow.endedAt ?? runRow.startedAt) : null;
  const shownWords = (text: string): string => withoutLoopback(redacted(text, values));
  // The answer row's text is the answer as served (whole, through redactedAnswer, once per held value set, when the row
  // was cut; else the rows' redactor over what was never cut): served again through redactedAnswer once per that set.
  const servedAnswer = (text: string | null): string | null => (text ? servedOnce(store, runId, text, values) : text);

  const finalAnswer = row.kind === "workflow" || unshown ? null : answerOf(run.rows) ?? row.summary ?? null;
  // A workflow run's output, as its end kept it, served as runs.ts serves it (servedOutput): each string in it cut of the
  // values the run holds, its shape kept; none while the run's sign-in can't be read back. An agentic run has none.
  const servedOutput = row.kind === "workflow" && !unshown && output !== null ? redactedOutput(output, values) : null;
  const result = status === "completed" ? { output: servedOutput, final_answer: servedAnswer(finalAnswer) } : null;
  // A failed run's reason in the model's own words when the store holds them: the last model-error row's text (a provider's
  // refusal, rendered from its pi.assistant error entry), else the run row's summary (the runner's generic "gave no answer").
  // It reads as the run's Timeline error row does (run-cut.ts runErrorWordsOf, main's errorWords): a refused key in plain
  // words, else cut of every secret (the view's values) and of any loopback address, so a key or a pointer the provider
  // quoted never shows, as main serves the run's error.
  const failedReason = run.rows.findLast((r) => r.kind === "error")?.text ?? row.summary ?? null;
  const errorWords = status === "failed" && !unshown ? await runErrorWordsOf({ ...deps, keyEnv: deps.keyEnv ?? (() => process.env) }, store, runId, { workflow: row.kind === "workflow" }) : undefined;
  const withheld = unshown || errorWords === "unreadable";
  const error = status === "failed" ? (withheld ? { code: "run_failed", message: WITHHELD_SIGN_IN, retryable: false } : servedRunErrorWith(errorWords ?? shownWords, errorOfRow(failedReason))) : null;
  const review = endedAtMs === null ? null : servedReviewWith(shownWords, unshown, reviewAt(reviewOfRow(row.state, row.summary ?? null), iso(endedAtMs)));
  // The card the run shows while it waits, in the order the file-backed view (runs.ts) picks them: a tool call parked for a
  // person's approval (approvalOf, its arguments shown through the run's redactor), else a run parked at its cap (the budget
  // card), else its agent waiting on a person in its browser (browserPending), else the question its turn ended on (pendingOf).
  const redactor = redactorOf(values);
  const pending: Pending = !unshown && status === "input_required" && state === "waiting" ? (approvalOf(view, redactor) ?? run.budget ?? browserPending(run.browserAsk, redactor) ?? computerPending(run.computerAsk, redactor) ?? pendingOf(run.rows)) : null;
  const settled = terminal;

  return {
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
    cost: costOfView(run),
    cap_mode: launch?.maxCostUsd === undefined ? null : (launch.capMode ?? "expected"),
    // Whether it ran unattended (its revision's approvals, as it started): never, an ask allowed at its gate; ask, the default.
    approvals: run.approvalsMode,
    archived_at: row.archivedAt ?? null,
    // Only what an imported run shows: never the server's internal file stamp (importedFrom.file).
    imported_from: runRow.importedFrom ? { source: runRow.importedFrom.source, session: runRow.importedFrom.session } : null,
    trigger: launch?.trigger ?? null,
    // Cut by the run's one cut (the pointers it was handed among them), and none for a withheld run, as its words.
    learning: unshown ? null : learningViewOf(run.learningEnd, secretsShown(values), terminal && settled),
    poll_after_ms: terminal && settled ? 0 : 1000,
    last_progress_at: run.lastProgressAt,
  };
}

/** The run list's answer from the store, byte-identical to runs.ts's summary: the view's subset a list shows. */
export async function summaryOverStore(store: Store, runId: string, deps: ViewDeps): Promise<Record<string, unknown> | undefined> {
  const view = await viewOverStore(store, runId, deps);
  if (!view) return undefined;
  const { run_id, agent_id, agent_version, console_url, revision, kind, sha, status, state, title, effort, created_at, ended_at, error, review, pending, cost, archived_at, imported_from, trigger, learning } = view as Record<string, unknown>;
  return {
    run_id, agent_id, agent_version, console_url, revision, kind, sha, status, state, title,
    ...(effort ? { effort } : {}),
    created_at, ended_at, error, review, pending, cost, archived_at, imported_from, trigger,
    learning: learning ? shortOf(learning as Parameters<typeof shortOf>[0]) : null,
  };
}

/** A run's live moment from the store (momentOf), for the one acceptance each act a run takes reads. A run no runner holds
 *  (ended, or running with no live claim) reads live false. */
export async function momentOverStore(store: Store, runId: string, deps: ViewDeps = { origin: "", serverSecrets: () => [] }): Promise<RunMoment | undefined> {
  const run = await storeRunOf(store, runId, deps);
  if (!run) return undefined;
  return momentOf(run.view, factsOf(run), run.live);
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
