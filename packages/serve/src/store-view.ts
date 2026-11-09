// A run's served view, built from the one store (design 2.1): the same object GET /runs/{id} answered from the per-run
// files, now composed from the store's row (store-reads/runs.ts), its journal (store-reads/journal.ts) and its learning end
// (store-reads/learning.ts), fed through the run view's pure functions (run-view.ts) so the figures and words a person or a
// model sees do not change. runs.ts still answers the API from files; this is the store-backed path the server cut switches
// onto. viewOverStore answers the run read, summaryOverStore the run list, momentOverStore the one acceptance each act reads.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { runLink } from "./console-links.js";
import { redacted, redactedAnswer, withoutLoopback } from "./key-refusal.js";
import { currentLearning, holdsForOk, type Learning, learningView, LEARNING_LABEL, secretsShown, shortOf, type Shown } from "./learning.js";
import { MIN_SECRET } from "./learn/secrets.js";
import { type RunLaunch, readLaunchBody } from "./run-launch.js";
import {
  type Handed,
  handedPointers,
  momentOf,
  type Pending,
  pendingOf,
  type RunFacts,
  type RunMoment,
  type RunView,
  type RunViewMeta,
  type State,
  type Status,
  approvalOf,
  asksOf,
  answersOf,
  redactorOf,
  servedRunErrorWith,
  servedReviewWith,
  statusOf,
  WITHHELD_SIGN_IN,
  costView,
  soFarOf,
  withAsks,
} from "./run-view.js";
import { reflects, type Reflect } from "./learning-run.js";
import { journalRecords, recordOf } from "./runner/journal-reader.js";
import { runLearningEnd } from "./store-reads/learning.js";
import { runReflect, runTimeline } from "./store-reads/journal.js";
import { type RunReadState, readRun } from "./store-reads/runs.js";
import { keptVendor, type Plane } from "./tool-plane.js";
import { Turns } from "./turns.js";
import { harnessOfBody } from "./harness.js";
import type { SignIns } from "./sign-ins.js";
import { FINAL_STATES, type RunRow, type Store } from "./store/store.js";

/** What the store-backed view needs beside the store: where its console lives, every secret it never shows (read now, so
 *  one rotated is cut at once), and the agents' saved sign-ins (for the handed-pointer cut). The server passes the same it
 *  passes the file path. */
export interface ViewDeps {
  readonly origin: string;
  readonly serverSecrets: () => string[];
  readonly signIns?: SignIns;
  /** The server's clock (ms), for the claim-lease check that decides a run is live; defaults to Date.now. The server
   *  passes the same clock the store uses, so a test on a moved clock reads a fresh claim as live. */
  readonly now?: () => number;
}

/** A run that has ended reads one of these (the old RunRow state → the v2 status: an escalation is a completion with a
 *  review; a stopped run is a cancellation), as runs.ts's STATUS_OF mapped them. A running run reads its status from the
 *  journal. */
const STATUS_OF: Record<Exclude<RunReadState, "running">, Status> = { completed: "completed", failed: "failed", escalated: "completed", stopped: "cancelled" };
/** A run that has reached a last state (its view is its ended shape). */
const TERMINAL = new Set<Status>(["completed", "failed", "cancelled"]);

const iso = (ms: number): string => new Date(ms).toISOString();

/** A run's whole answer as answerOfRun read it from the rows: its newest final-answer row, never the learning turn's. */
const answerOf = (rows: readonly TimelineEvent[]): string | null => rows.findLast((r) => r.kind === "final_answer" && r.agent_label !== LEARNING_LABEL)?.text ?? null;

/** A failed run's error from its row (its own words are the summary; the store keeps no code or detail apart). */
const errorOfRow = (summary: string | null): { code: string; message: string; retryable: false; details?: unknown } => ({ code: "run_failed", message: summary ?? "The run failed.", retryable: false });

/** An escalated run's review from its row: its summary is the reason (the store keeps no kind or node apart). */
type SavedReview = { kind: string | null; node: string | null; reason: string };
const reviewOfRow = (state: RunReadState, summary: string | null): SavedReview | null => (state !== "escalated" ? null : { kind: null, node: null, reason: summary ?? "The workflow escalated." });
const reviewAt = (review: SavedReview | null, endedAt: string): (SavedReview & { at: string }) | null => (review ? { kind: review.kind, node: review.node, reason: review.reason, at: endedAt } : null);

/** A run's facts as statusOf reads them from the store. A terminal run reaches none of them (its outcome answers first);
 *  the running statuses fill these from the journal. */
const terminalFacts: RunFacts = { budgetWaiting: () => false, paused: () => false, browserAsk: () => undefined };

/** The run read from the store: the row, its launch, its timeline, its agent's revision count for the version, its
 *  learning end, and the sign-in cut it serves through. Undefined for an unknown run. */
interface StoreRun {
  readonly row: NonNullable<Awaited<ReturnType<typeof readRun>>>;
  readonly runRow: RunRow;
  readonly launch: RunLaunch | undefined;
  readonly rows: TimelineEvent[];
  readonly version: number;
  readonly harness: string;
  readonly learningEnd: Awaited<ReturnType<typeof runLearningEnd>>;
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
}

/** A runner holds the run's claim now: it is not in a final state, a runner is named on its row, and its lease has not run
 *  out (claimed_until >= now, the predicate the claimable query's `claimed_until < ?` is the negation of). `now` is the
 *  server's clock, so a test on a moved clock reads a fresh claim as live. */
function liveOf(runRow: RunRow, now: number): boolean {
  return !FINAL_STATES.includes(runRow.state) && runRow.runner !== null && runRow.claimedUntil !== null && runRow.claimedUntil >= now;
}

/** The run's launch body read back, or undefined when it has none (an old run, or one not started with one). */
async function launchOf(store: Store, runId: string): Promise<RunLaunch | undefined> {
  try {
    const row = await store.runs.launch(runId);
    return readLaunchBody(row.body);
  } catch {
    return undefined;
  }
}

/** The pointers a run was handed, as its row kept them (never the pointers, their SHA-256). */
const handedOf = (runRow: RunRow): Handed | undefined => (runRow.signInHanded && runRow.signInHanded.length > 0 ? [...runRow.signInHanded] : undefined);

/** Reads the run from the store and builds the RunView the view functions read. */
async function storeRunOf(store: Store, runId: string, deps: ViewDeps): Promise<StoreRun | undefined> {
  const context = BACKGROUND_CONTEXT;
  const row = await readRun(store, runId, context);
  if (!row) return undefined;
  const runRow = await store.runs.get(runId);
  if (!runRow) return undefined;
  const launch = await launchOf(store, runId);
  const revision = await store.agents.revision(row.revision);
  const harness = launch?.harness ?? harnessOfBody((revision?.body ?? {}) as { harness?: string });
  const terminal = row.state !== "running";
  // The timeline, then the waiting row a run asking a question shows (withAsks), as the file path's rows carried it, so a
  // run waiting on a question reads the same status and pending.
  const rows = withAsks(await runTimeline(store, runId, context, { settled: terminal }));
  const revisions = await store.agents.revisions(row.agent);
  const version = revisions.findIndex((r) => r.id === row.revision) + 1;
  const learningEnd = await runLearningEnd(store, runId);

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
  const turns = new Turns();
  turns.note(recordOf(records.entries), records.submissions ?? [], skip, liveRow?.updatedAt ?? deps.now?.() ?? Date.now());
  const working = live && turns.open > 0;
  const progress = terminal || row.kind === "workflow" ? undefined : turns.progressAt();
  const lastProgressAt = progress === undefined ? null : iso(progress);

  // The sign-in cut: the pointers the run was handed read back, so a run whose words could repeat one is cut of it, or
  // withheld when this server cannot read back what it was handed (rowShown's choke point). A run with no mark is cut of
  // the server's secrets alone.
  const browser = launch?.plane ? keptVendor(launch.plane as Plane).browser : undefined;
  const pointers = await handedPointers(deps.signIns, row.agent, browser, handedOf(runRow));
  const unshown = pointers === "unreadable";
  const values = unshown ? [] : [...deps.serverSecrets(), ...pointers.refs.filter((ref) => ref.length >= MIN_SECRET)];

  // The tool-call approvals the run waits (or waited) on, from its journal: each call the gate parked for a person, and
  // the answers given, which the status, pending and moment views read the same as the file path read them from the run's
  // store entries.
  const approvals = asksOf(records.entries);
  const answers = answersOf(records.entries);

  const meta: RunViewMeta = { ...(launch?.maxCostUsd !== undefined ? { max_cost_usd: launch.maxCostUsd } : {}), ...(Object.keys(answers).length ? { approvals: answers } : {}) };
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
    submitted: 0,
    updatedAt: iso(updatedAtMs),
    rows,
    turns,
    ...(approvals.size ? { approvals } : {}),
    meta,
  };
  return { row, runRow, launch, rows, version, harness, learningEnd, view, unshown, values, live, updatedAtMs, lastProgressAt };
}

/** A run's learning as the view shows it: its end from the store, in a person's words cut of the host's secrets now, and,
 *  for an ended run, the notes it read. A learning still held for the owner's OK reads as it stands; an ended one (merged,
 *  dropped) reads as it was written. */
function learningViewOf(learningEnd: Awaited<ReturnType<typeof runLearningEnd>>, shown: Shown, settled: boolean): unknown {
  if (!learningEnd) return null;
  const learning = holdsForOk(learningEnd as Learning) ? currentLearning(learningEnd as Learning, undefined) : (learningEnd as Learning);
  return learningView(learning, shown, settled);
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
  const cap = run.launch?.maxCostUsd;
  const bound = cap === undefined ? {} : { overshoot_bound_usd: 0 };
  return { usd, basis: "estimate", charge_state: null, cap_usd: cap ?? null, ...bound, ...(soFar ?? {}) };
}

/** GET /runs/{id}'s answer from the store, byte-identical to runs.ts's view for the same run. Undefined for an unknown run. */
export async function viewOverStore(store: Store, runId: string, deps: ViewDeps): Promise<Record<string, unknown> | undefined> {
  const run = await storeRunOf(store, runId, deps);
  if (!run) return undefined;
  const { row, runRow, launch, view, unshown, values } = run;
  const { status, state } = statusOf(view, terminalFacts);
  const terminal = TERMINAL.has(status);
  const endedAtMs = terminal ? (runRow.endedAt ?? runRow.startedAt) : null;
  const shownWords = (text: string): string => withoutLoopback(redacted(text, values));
  const servedAnswer = (text: string | null): string | null => (text ? redactedAnswer(text, values) : text);

  const finalAnswer = row.kind === "workflow" || unshown ? null : answerOf(run.rows) ?? row.summary ?? null;
  // A workflow run's output reads from its journal (a separate reader); an agentic run has none. Wired with the workflow
  // status.
  const result = status === "completed" ? { output: null, final_answer: servedAnswer(finalAnswer) } : null;
  const error = status === "failed" ? (unshown ? { code: "run_failed", message: WITHHELD_SIGN_IN, retryable: false } : servedRunErrorWith(shownWords, errorOfRow(row.summary ?? null))) : null;
  const review = endedAtMs === null ? null : servedReviewWith(shownWords, unshown, reviewAt(reviewOfRow(row.state, row.summary ?? null), iso(endedAtMs)));
  // The card the run shows while it waits: a tool call parked for a person's approval (approvalOf, its arguments shown
  // through the run's redactor), else the question its turn ended on (pendingOf). The budget and browser cards join this
  // chain next, in the order the file-backed view (runs.ts) picks them.
  const redactor = redactorOf(values);
  const pending: Pending = status === "input_required" && state === "waiting" ? (approvalOf(view, redactor) ?? pendingOf(run.rows)) : null;
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
    title: launch?.title ?? "",
    place: launch?.place ?? { mode: "runner" },
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
    archived_at: row.archivedAt ?? null,
    imported_from: runRow.importedFrom ?? null,
    trigger: launch?.trigger ?? null,
    learning: learningViewOf(run.learningEnd, secretsShown(deps.serverSecrets()), terminal && settled),
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
  return momentOf(run.view, terminalFacts, run.live);
}

/** Re-export so a caller need not reach into run-view for the type. */
export type { RunMoment } from "./run-view.js";
