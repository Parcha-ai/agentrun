// The one store (design 2.1): agents, their revisions and runs, the commands the server writes for a run, triggers and the
// channel outbox, and every run's journal, in one database. The server writes run and command rows and reads everything;
// a runner claims a run, writes its journal and its row under the claim, and reads its commands. Nothing outside store/
// knows SQL, a pragma or a file: SqliteStore today, PostgresStore later, both behind this interface. Units of work are
// domain methods here (agents.create, templates.apply, triggers.fire …), never a generic transaction handed out, so the
// SQL stays in store/. Every time is epoch milliseconds.
//
// The claim is the one fence for a run: claim() moves the run's epoch up by one, and every write a runner makes for the
// run (its row, its journal commits, a command taken) carries the epoch it holds. A write under a lower epoch than the
// run's is refused (Fenced) and writes nothing.
import type { Context } from "@earendil-works/chord";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { JournalPage } from "./journal/storage.js";

/** A run's state. queued: a row, no runner yet. running: a runner holds the claim. parked: waiting for a person (an
 *  approval, a raised cap) with no claim held; a command row or its wake_at makes it claimable again. ended, stopped and
 *  failed are final. A running run whose runner died is claimable once its claim runs out. */
export type RunState = "queued" | "running" | "parked" | "ended" | "stopped" | "failed";
export const FINAL_STATES: readonly RunState[] = ["ended", "stopped", "failed"];
/** A state a release may leave a run in: never a final one (Store.release). */
export type ReleasedState = Exclude<RunState, "ended" | "stopped" | "failed">;

/** Why a command row still untaken when its run went final is refused: the write that makes a run final refuses each
 *  such row with these words, in that same transaction (a final run takes no new row, so none is left for good). */
export function endedReason(state: "ended" | "stopped" | "failed"): string {
  const how = state === "ended" ? "ended" : state === "stopped" ? "was stopped" : "failed";
  return `the run ${how} before this command was taken`;
}

/** A runner's hold on a run: the epoch every write it makes for the run carries, until `until` (ms) unless renewed. `from`:
 *  the run's state before this claim (queued; parked: woken by a command or its wake_at; running: released, or its last
 *  claim lapsed). */
export interface Claim {
  readonly runId: string;
  readonly runner: string;
  readonly epoch: number;
  readonly until: number;
  readonly from: RunState;
  /** The runner that held the run when this claim took it over: its lease ran out with the run still running (that
   *  runner was lost, or lost its claim). Its loop says so on the run's timeline. Absent for any other claim. */
  readonly lost?: { readonly runner: string };
}

/** A command the server wrote for a run (stop, cancel, steer, approve, deny, raise): one row, read by the run's runner in id order
 *  and marked taken, or refused with why. `body` is JSON. */
export interface Command {
  readonly id: number;
  readonly runId: string;
  readonly kind: string;
  readonly body: unknown;
  readonly createdAt: number;
  readonly takenAt: number | null;
  readonly refused: string | null;
  /** The resumes it woke that failed (retry), across runners and restarts. */
  readonly tries: number;
}

export interface AgentRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly currentRevision: string | null;
  readonly createdAt: number;
  readonly archivedAt: number | null;
}

/** A template's package, kept on the revision made from it. */
export interface TemplatePackage {
  readonly name: string;
  readonly version: string;
  readonly source: "builtin" | "git";
  readonly ref?: string;
  readonly sha?: string;
  readonly parameters?: unknown;
}

export interface NewRevision {
  readonly id: string;
  readonly kind: string;
  readonly body: unknown;
  /** The revision's skill files, a JSON object keyed by the skill's path to its text, or none. The body's own `skills`
   *  map keeps each path to its text's SHA-256; this is the texts, kept on the revision's row (store schema `revisions`). */
  readonly skills?: unknown;
  /** The optional note the revision is committed with (the v2 note), or none. */
  readonly note?: string;
  readonly package?: TemplatePackage;
}

export interface RevisionRow {
  readonly id: string;
  readonly agentId: string;
  /** The revision that was the agent's current one when this one was committed (null for its first): the v2 revisions
   *  view's parent. */
  readonly parent: string | null;
  readonly kind: string;
  readonly body: unknown;
  /** The revision's skill files as it was written (path to text), or null for a revision with none. */
  readonly skills: unknown;
  /** The note the revision was committed with, or null. */
  readonly note: string | null;
  readonly package: TemplatePackage | null;
  readonly createdAt: number;
}

/** How an ended run (state 'ended') ended apart from being done: 'escalated' (it finished its work and waits for a person,
 *  which the v2 status reads as completed with a review) or 'completed'. A failed or stopped run says so in its state. */
export type RunOutcome = "completed" | "escalated";

/** The harness an imported run came from. */
export type ImportSource = "claude-code" | "codex" | "pi";
/** Where an imported run came from: the harness that ran it, and its own session id. */
export interface ImportedFrom {
  readonly source: ImportSource;
  readonly session: string;
}

/** What a run was started under: `key`, the caller's name for it (a create's idempotency key, a trigger's firing key),
 *  which starts one run only, and `fingerprint`, what was asked, kept to tell a retry from another request under the key. */
export interface RunOrigin {
  readonly key: string;
  readonly fingerprint?: string | null;
}

export interface RunRow {
  readonly id: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly state: RunState;
  readonly epoch: number;
  readonly runner: string | null;
  readonly claimedUntil: number | null;
  readonly wakeAt: number | null;
  /** A parked run's backoff after a failed resume: its untaken commands wait for it, a stop and its wake_at do not. */
  readonly backoffUntil: number | null;
  readonly costUsd: number | null;
  readonly metrics: unknown;
  readonly summary: string | null;
  /** An ended run's outcome (RunOutcome), null for a plain completion or a run not ended this way. */
  readonly outcome: RunOutcome | null;
  /** When the run itself was archived (its agent's archive is read apart); null when it is not. */
  readonly archivedAt: number | null;
  /** The session an imported run came from; null for a run started here. */
  readonly importedFrom: ImportedFrom | null;
  /** The SHA-256 hashes of the browser sign-in pointers handed to the run at its launch (never the pointers), or null when
   *  it was handed none. A sign-in whose pointer hashes to one of these cannot be forgotten while the run runs. */
  readonly signInHanded: readonly string[] | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/** What a runner may change on its run's row, under its claim. A final state with no `endedAt` is stamped now. */
export interface RunPatch {
  readonly state?: RunState;
  readonly costUsd?: number | null;
  readonly metrics?: unknown;
  readonly summary?: string | null;
  /** An ended run's outcome, set in its end commit; null clears it. */
  readonly outcome?: RunOutcome | null;
  /** The SHA-256 hashes of the sign-in pointers handed to the run, which the runner writes at its claim (under the epoch
   *  fence); null clears them. While the run runs, a sign-in hashing to one of these cannot be forgotten (sign-ins-store.ts). */
  readonly signInHanded?: readonly string[] | null;
  readonly endedAt?: number | null;
}

/** A run's launch, as the server writes it at start: its JSON `body` (run-launch.ts: the first input, title, place, effort,
 *  cap, trigger and origin), and `sealed` ciphertext for any secret it carries (sealed with the server's key outside the
 *  store, AAD `run_launch|<run_id>|sealed`), or none. Written once, in the same transaction as the queued run. */
export interface RunLaunchInput {
  readonly body: unknown;
  readonly sealed?: Uint8Array | null;
}

/** A run's launch as the store holds it: the body the runner reads at its claim, and its sealed bytes, which the store never
 *  opens. */
export interface RunLaunchRow {
  readonly runId: string;
  readonly body: unknown;
  readonly sealed: Uint8Array | null;
  readonly createdAt: number;
}

/** A run imported from another harness's session: an ended run with where it came from, its launch (built from the
 *  session), its cost and metrics, and its transcript as journal batches — the whole thing written in one transaction.
 *  `transcript` is the session as pi-durable write batches (a root conversation and its entries), each batch a commit. */
export interface ImportRunInput {
  readonly id: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly importedFrom: ImportedFrom;
  readonly launch: RunLaunchInput;
  /** How the imported run ended (default 'ended'); `outcome` an ended run's (completed is the default). */
  readonly state?: "ended" | "failed" | "stopped";
  readonly outcome?: RunOutcome | null;
  readonly costUsd?: number | null;
  readonly summary?: string | null;
  readonly metrics?: unknown;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly transcript: readonly (readonly StorageWrite[])[];
}

/** Rows written in the same commit as a run's update (runs.update, or a journal commit's staged patch): a channel post the
 *  run's moment owes (the outbox), what a channel was told. A command consumed is Staged.take, refused when not untaken. */
export type AlsoRow =
  | { readonly table: "channel_posts"; readonly row: ChannelPost }
  | { readonly table: "channel_told"; readonly row: { channel: string; marker: string } }
  /** What the run's end-of-run turn kept: the turn and the proposal checked from it (the run's agent is the row's). */
  | { readonly table: "learning_proposals"; readonly row: { turn: unknown; proposal: unknown } }
  /** The learning run that grades and merges the kept proposal: a queued run `id` of the run's agent and revision. Started
   *  once: the same id staged again (an end replayed after a crash) adds nothing. */
  /** `model`: the grade model (gradeModelOf, as the server resolves it), on the learning run's launch; none, the agent's own. */
  | { readonly table: "learning_run"; readonly row: { id: string; model?: string } };

/** A run's kept learning (learning_proposals): what its end-of-run turn asked and answered, and the proposal checked from it. */
export interface LearningProposal {
  readonly runId: string;
  readonly agentId: string;
  readonly turn: unknown;
  readonly proposal: unknown;
  /** The learning run its end queued with it, which grades and merges it; absent for a learning dropped before. */
  readonly learningRunId?: string;
  readonly createdAt: number;
}

/** Learning on the runner: the kept proposals, written only beside a run's end (AlsoRow learning_proposals). */
export interface Learning {
  /** The run's kept proposal; undefined when its end kept none. */
  proposal(runId: string): Promise<LearningProposal | undefined>;
  /** The agent's kept proposals, newest first. */
  proposals(agentId: string, options?: { limit?: number }): Promise<LearningProposal[]>;
}

/** A command a journal commit takes, with the id of the record that is its effect, an id the effect's batch newly
 *  allocates (an entry, a created document, a new task): written only by the commit that newly writes that record, in its
 *  transaction, so the command is taken with its own effect or not at all. An effect that updates an existing record (a
 *  document change or retire, a task update) carries a marker entry minted for it in the same batch: an entry of kind
 *  `agentrun.command` on the run's root conversation, data `{ command }`, which the runner's reader and live view skip.
 *  The effect must be an id the journal minted and has not yet written: stage() refuses any other. */
export interface StagedTake {
  readonly command: number;
  readonly effect: number;
}

/** What a journal commit writes beside its batches, in its one transaction, under its fence: the run row's patch and rows
 *  beside it, landing with the record `effect` names (required with either: a park's ask, an end's entry), and the
 *  commands it takes (each with its own effect). Each is written only by the commit that stores its effect. */
export interface Staged {
  readonly run?: RunPatch;
  readonly also?: readonly AlsoRow[];
  readonly effect?: number;
  readonly take?: readonly StagedTake[];
}

/** A run's journal: pi-durable's Storage for the one run, every commit fenced by the claim, and stage() for what its next
 *  commit writes beside its batches. Staged rows are cleared once a commit stores a batch and kept when it does not. */
export interface Journal extends Storage {
  readonly runId: string;
  stage(staged: Staged): void;
  /** The run's commits after `afterSeq`, at most `limit`, each with only what it wrote (store/journal JournalPage). */
  commitsAfter(afterSeq: number, limit: number, context: Context): Promise<JournalPage>;
}

/** A run's journal opened for reading only: the read half of its Storage — its scans and lookups and commitsAfter, with no
 *  commit, stage or mintId, and no claim. The server reads a run this way (its timeline, the records analytics sums), where
 *  it holds no claim; a writer uses journal(claim) instead. A read never fences (only a commit does), so the view needs no
 *  epoch; a run with no journal yet reads as empty. close() lets its admitted reads drain, and leaves the store's
 *  connection open: the store owns it. */
export type JournalReads = Pick<
  Journal,
  "runId" | "conversation" | "scanConversations" | "entry" | "findLatestHeadMarker" | "scanEntries" | "task" | "scanTasks" | "submission" | "scanSubmissions" | "submissionByRequest" | "findDocument" | "document" | "scanDocuments" | "commitsAfter" | "close"
>;

export interface ChannelPost {
  readonly id: string;
  readonly channel: string;
  readonly conversation?: string | null;
  readonly wait?: string | null;
  readonly moment: string;
  readonly body: unknown;
  readonly nextAt?: number;
}

/** A trigger as a template or an upgrade gives it. `scopes`: the (kind, scope) keys it answers, rows only while enabled. */
export interface TriggerDef {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly source: unknown;
  readonly target: unknown;
  readonly nextAt?: number | null;
  readonly catchupWindowS?: number | null;
  readonly scopes?: readonly TriggerScope[];
}
export interface TriggerScope {
  readonly kind: string;
  readonly scope: string;
}
export interface TriggerRow {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly source: unknown;
  readonly target: unknown;
  readonly nextAt: number | null;
  readonly lastRunId: string | null;
  readonly catchupWindowS: number | null;
  readonly failuresInARow: number;
  /** Why it is off, when a failure streak or its source turned it off (JSON); null once it is on again. */
  readonly disabled: unknown;
  readonly maxActiveRuns: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
/** A trigger's firing that starts a run. */
export interface Firing {
  readonly triggerId: string;
  readonly key: string;
  readonly by?: string | null;
  readonly nominalAt?: number | null;
  readonly catchUp?: boolean;
  readonly payload?: string | null;
}

export type FiringStatus = "due" | "started" | "sent" | "skipped" | "failed" | "missed" | "ignored";
/** A trigger's firing as its row keeps it. `shown`: in the trigger's history (the newest HISTORY_KEPT); false, kept only
 *  for its key's day. `retryAt`: a due firing's next try; `waitsOn`: the run whose turn end wakes a due firing. */
export interface FiringRow {
  readonly triggerId: string;
  readonly key: string;
  readonly by: string;
  readonly nominalAt: number;
  readonly status: FiringStatus;
  readonly at: number;
  readonly runId: string | null;
  readonly reason: string | null;
  readonly error: { code: string; message: string } | null;
  readonly count: number | null;
  readonly attempts: number;
  readonly retryAt: number | null;
  readonly payload: string | null;
  readonly attrs: unknown;
  readonly notified: boolean;
  readonly catchUp: boolean;
  readonly paused: boolean;
  readonly shown: boolean;
  readonly waitsOn: string | null;
}
/** A firing recorded: due (to be driven), or settled at once (skipped, missed, ignored). */
export interface NewFiring {
  readonly key: string;
  readonly by: string;
  readonly nominalAt: number;
  readonly status: "due" | "skipped" | "missed" | "ignored";
  readonly reason?: string;
  readonly count?: number;
  readonly catchUp?: boolean;
  readonly payload?: string;
  readonly attrs?: unknown;
  /** False: kept only for its key's day, never in the history (an ignored delivery's key). */
  readonly shown?: boolean;
}
/** A trigger made, as POST /triggers keeps it. */
export interface NewTrigger {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly source: unknown;
  readonly target: unknown;
  readonly nextAt: number | null;
  readonly catchupWindowS: number;
  readonly maxActiveRuns?: number | null;
}
/** A trigger's fields changed; the ones absent stay. */
/** `agentId`: the agent it belongs to, which follows its target (a PATCH may aim it at another agent's run or agent). */
export type TriggerPatch = Partial<Pick<TriggerRow, "agentId" | "name" | "enabled" | "source" | "target" | "nextAt" | "catchupWindowS" | "failuresInARow" | "disabled" | "maxActiveRuns">>;
/** A firing's new state. Out of due, a firing keeps no retry, wait, payload nor the reason its last try gave (unless given). */
export interface FiringChange {
  readonly status?: FiringStatus;
  readonly runId?: string;
  readonly reason?: string | null;
  readonly error?: { code: string; message: string };
  readonly attempts?: number;
  readonly retryAt?: number | null;
  readonly waitsOn?: string | null;
  readonly notified?: boolean;
}
/** What a settle does to the firing's trigger besides: `reset` its failure streak (a run started, a message sent), or
 *  count a `failure` toward it, turning it off at `pauseAt` in a row (auto-pause, the firing marked paused). */
export type FiringStreak = { readonly reset: true } | { readonly failure: true; readonly pauseAt: number };
/** A firing a trigger has no room for: `due` firings are DUE_KEPT already. Nothing was written. */
export class TriggerFull extends Error {
  override name = "TriggerFull";
  constructor(readonly triggerId: string, readonly due: number) {
    super(`trigger ${triggerId} holds ${due} firings due`);
  }
}

/** A run of an archived agent, or a trigger of it made on or turned on: refused, nothing written (Agents.archive). */
export class AgentArchived extends Error {
  override name = "AgentArchived";
  constructor(readonly agentId: string) {
    super(`the agent ${agentId} is archived`);
  }
}

export interface Agents {
  /** Creates the agent, or renames it (name, description) when it exists. */
  put(agent: { id: string; name: string; description?: string | null }): Promise<void>;
  /** The agent row and its first revision, current, in one transaction: both or neither. */
  create(agent: { id: string; name: string; description?: string | null }, firstRevision: NewRevision): Promise<void>;
  get(id: string): Promise<AgentRow | undefined>;
  list(options?: { archived?: boolean }): Promise<AgentRow[]>;
  /** Archives the agent, or unarchives it. Archived, every trigger of it that is on is turned off in the same transaction
   *  (`disabled` set to `why`, JSON; its scope rows dropped), and those are the answer: from its commit no firing starts a
   *  run of the agent (triggers.fire refuses it, AgentArchived), and none of its triggers is made on or turned on.
   *  Unarchived, none turns on again: the answer is empty. */
  archive(id: string, archived: boolean, why?: unknown): Promise<{ id: string; name: string }[]>;
  /** Adds a revision and makes it the agent's current one, in one commit. */
  addRevision(revision: NewRevision & { agentId: string }): Promise<void>;
  /** Makes `revisionId`, one of the agent's own, its current one. StoreConstraint when it is not a revision of `agentId`. */
  setCurrent(agentId: string, revisionId: string): Promise<void>;
  revision(id: string): Promise<RevisionRow | undefined>;
  revisions(agentId: string): Promise<RevisionRow[]>;
}

export interface Templates {
  /** A template applied: the agent, its first revision (with the package) and its triggers, in one transaction, all or
   *  nothing. The triggers are checked before it; inside it the only failures are the store's. With `idempotencyKey`, the
   *  same key again answers the first apply's result and writes nothing. */
  apply(agent: { id: string; name: string; description?: string | null }, revision: NewRevision, triggers: readonly TriggerDef[], idempotencyKey?: string): Promise<{ agentId: string; revisionId: string }>;
  /** A template upgraded: revision n+1 made current, and the triggers changed by name (upsert, remove), in one transaction.
   *  The agent's learning is untouched. */
  upgrade(agentId: string, revision: NewRevision, triggers: { upsert: readonly TriggerDef[]; remove: readonly string[] }): Promise<void>;
}

export interface Triggers {
  get(id: string): Promise<TriggerRow | undefined>;
  list(agentId: string): Promise<TriggerRow[]>;
  /** Every trigger, oldest first. */
  all(): Promise<TriggerRow[]>;
  /** The trigger and, while it is enabled, its scope rows (`scopes`), in one transaction: a scope another enabled trigger
   *  holds is refused (StoreConstraint on trigger_scopes), nothing written; one made on for an archived agent too
   *  (AgentArchived). */
  create(trigger: NewTrigger, scopes?: readonly TriggerScope[]): Promise<TriggerRow>;
  /** The fields given changed, `updatedAt` set: undefined when there is no such trigger. With `scopes`, its scope rows
   *  rewritten in the same transaction (none while it is off); a patch that turns it off drops them. One that leaves it
   *  on for an archived agent, turned on or moved there, is refused (AgentArchived), nothing written. */
  update(id: string, patch: TriggerPatch, scopes?: readonly TriggerScope[]): Promise<TriggerRow | undefined>;
  /** The trigger, its scope rows and its firings gone. */
  remove(id: string): Promise<void>;
  /** Enables the trigger and writes its scope rows, in one transaction; refused for an archived agent's (AgentArchived). */
  enable(triggerId: string, scopes: readonly TriggerScope[]): Promise<void>;
  /** Disables the trigger (with why, JSON) and deletes its scope rows, in one transaction. */
  disable(triggerId: string, why?: unknown): Promise<void>;
  /** The firing starts a run: the queued run, the `started` firing that names it (the due firing's row, or a new one) and
   *  the trigger's last_run_id, with its failure streak reset, in one transaction; with `launch`, the run's launch row in
   *  that same transaction (the store's one writeLaunch). A run of an archived agent is refused in it (AgentArchived),
   *  nothing written: a firing claimed before the archive committed starts no run after it. */
  fire(firing: Firing, run: { id: string; agentId: string; revisionId: string }, options?: { launch?: RunLaunchInput }): Promise<RunRow>;
  /** The enabled triggers listening on (`kind`, `scope`): its scope rows. */
  scoped(kind: string, scope: string): Promise<string[]>;
  /** `firings` recorded and the trigger's `patch` applied, in one transaction; a key already there is not recorded again
   *  (`created` false for it). With `room`, a due firing is refused (TriggerFull, nothing written) while the trigger holds
   *  `room` due already. Undefined when there is no such trigger. */
  record(triggerId: string, firings: readonly NewFiring[], options?: { patch?: TriggerPatch; room?: number }): Promise<{ created: boolean[] } | undefined>;
  /** The firing's row, shown or kept for its day. */
  firing(triggerId: string, key: string): Promise<FiringRow | undefined>;
  /** The trigger's history, newest first: its shown firings. */
  firings(triggerId: string): Promise<FiringRow[]>;
  /** The firing changed (with its trigger's last_run_id moved to a newer run it names, and `streak`), in one transaction:
   *  undefined when the firing is gone (its trigger deleted). `paused`: this failure turned the trigger off. */
  settle(triggerId: string, key: string, change: FiringChange, streak?: FiringStreak): Promise<{ firing: FiringRow; paused: boolean } | undefined>;
  /** Every due firing, and every failed one whose trigger.failed is not marked queued, oldest first. */
  pending(): Promise<FiringRow[]>;
  /** A message_run firing's message queued for run `runId` as a command row (its body's origin names the trigger), with
   *  the firing marked sent and the trigger's streak reset, in one transaction; unless the run already holds `bound.max`
   *  untaken command rows from this trigger, read in that same transaction: then the firing is skipped with
   *  `bound.reason` and nothing is queued. Undefined when the firing is gone or no longer due. */
  message(firing: { triggerId: string; key: string }, runId: string, command: { kind: string; body: unknown }, bound: { max: number; reason: string }): Promise<{ sent: true; commandId: number } | { skipped: string } | undefined>;
  /** Every due firing waiting for its trigger's room (waits_on), oldest first, each with whether the room is there now
   *  (fewer of its trigger's started runs not ended than its max_active_runs): one read for all of them. */
  waiting(): Promise<(FiringRow & { readonly free: boolean })[]>;
  /** The soonest next time of an enabled trigger, or null. */
  soonest(): Promise<number | null>;
  /** How many of the trigger's started runs have not ended (a run reopened later does not count). */
  activeRuns(triggerId: string): Promise<number>;
  /** The history kept to `history` shown firings: older ones a sender's key names (manual, pushed) are kept for their day
   *  (shown 0), others removed; shown-0 rows past `dayMs` removed, then the oldest past `kept` of them. Never a due
   *  firing, a failure not yet told, nor a started firing whose run has not ended. Answers how many went past `kept`. */
  prune(triggerId: string, options: { history: number; dayMs: number; keepByKey: (by: string) => boolean; kept?: number }): Promise<number>;
}

export interface Runs {
  /** A queued run of `revisionId`, its row's only writer until a runner claims it. With `origin`, the origin row is written
   *  in the same transaction, so a retry under the same key finds this run (runOfOrigin); a key already used is refused
   *  (StoreConstraint), and nothing is written. With `launch`, its launch row is written in the same transaction too (all
   *  or nothing). */
  create(run: { id: string; agentId: string; revisionId: string; origin?: RunOrigin }, launch?: RunLaunchInput): Promise<RunRow>;
  get(id: string): Promise<RunRow | undefined>;
  /** The run's launch row (the runner reads it at its claim; the server for views). StoreLaunchMissing when the run has
   *  none (it was not started with one), never a default. */
  launch(runId: string): Promise<RunLaunchRow>;
  /** Newest first, at most `limit` (no limit: all). `archived` filters on the run's own archive time (true: archived,
   *  false: not); its agent's archive is read apart. */
  list(filter: { agentId?: string; revisionId?: string; state?: RunState; archived?: boolean; limit?: number }): Promise<RunRow[]>;
  /** Archives the run (its own archive time), or unarchives it: idempotent. */
  archive(runId: string, archived: boolean): Promise<void>;
  /** The runs a runner may claim, oldest first: queued; parked with an untaken command or its wake_at passed; running with
   *  no runner (released at a runner's shutdown: it stays running, a run that started keeps that fact) or its claim run
   *  out. */
  claimable(options?: { limit?: number }): Promise<string[]>;
  /** Claims up to `k` claimable runs for `runner`, oldest first, in one transaction: each at its own epoch + 1, with its
   *  `from`. A runner fills its free loops with one call. */
  claimMany(runner: string, k: number, options?: { leaseMs?: number }): Promise<Claim[]>;
  /** Changes the run's row under `claim`, and in the same commit writes `also` and marks `take`'s command rows taken (a
   *  stop the runner applies itself ends the run with its stop row taken, or neither). Refused, nothing written: Fenced when
   *  the run's epoch is not the claim's; CommandTaken when a command in `take` is taken already, or not the run's. */
  update(claim: Claim, patch: RunPatch, rows?: { readonly also?: readonly AlsoRow[]; readonly take?: readonly number[] }): Promise<RunRow>;
}

/** A saved MCP server: its listed tools (each with whether it can be granted, and why not), the owner's prices, and its
 *  credential sealed (store/seal.ts): bytes the store never opens. `tools` and `prices` are JSON. */
export interface McpServerRow {
  readonly name: string;
  readonly url: string;
  readonly auth: string;
  readonly protocol: string | null;
  readonly tools: unknown;
  readonly prices: unknown;
  /** The remote server's reported info (its name and version) and its instructions, as it gave them, bounded at save: JSON
   *  and TEXT, or null when the server gave none. Shown on a read; `instructions` is never handed to the model. */
  readonly serverInfo: unknown;
  readonly instructions: string | null;
  readonly sealed: Uint8Array | null;
  /** A refresh in flight: its holder and the lease's end (ms), or null. */
  readonly refreshHolder: string | null;
  readonly refreshUntil: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When the tools were last listed (ms): a refresh moves this, not updatedAt, so a refresh is not read as an owner edit.
   *  Null for a row written before this column. */
  readonly listedAt: number | null;
  /** When the sealed credential was last set (ms): a new credential's save or a sign-in, never a token refresh. Null with
   *  no credential. */
  readonly credentialChangedAt: number | null;
}

/** A run's MCP pin: what it may call, per granted server (url, tools, prices), written once at its first claim. */
export interface McpPinRow {
  readonly runId: string;
  readonly body: unknown;
  readonly pinnedAt: number;
}

/** The longest an MCP token refresh may take: two tries of 4 s each. The runner's claim step gives its call up by then. */
export const MCP_REFRESH_CALL_MS = 2 * 4_000;
/** A refresh lease's length by default: the call's deadline and room to write its result. */
export const MCP_REFRESH_LEASE_MS = MCP_REFRESH_CALL_MS + 4_000;

export interface Mcp {
  /** The server's write: the server's row, inserted or replaced by name (its first save's time kept). An owner's save
   *  clears any refresh lease, so a refresh in flight is refused (RefreshLeaseLost) and never overwrites it. */
  put(server: { name: string; url: string; auth: string; protocol?: string | null; tools: unknown; prices?: unknown; serverInfo?: unknown; instructions?: string | null; sealed?: Uint8Array | null; listedAt?: number; updatedAt?: number; credentialChangedAt?: number | null }): Promise<McpServerRow>;
  remove(name: string): Promise<void>;
  /** The registry's rows, by name. */
  servers(): Promise<McpServerRow[]>;
  server(name: string): Promise<McpServerRow | undefined>;
  /** The run's pin, or none (a run that grants no MCP tool has none). */
  pin(runId: string): Promise<McpPinRow | undefined>;
  /** Writes the run's pin under `claim` unless it has one, in one transaction with the claim's epoch fence, and answers the
   *  pin as stored: never rewritten, so a second call (or a later claim's) reads the first. Fenced, writing nothing, on a
   *  stale claim. */
  pinOnce(claim: Claim, body: unknown): Promise<McpPinRow>;
  /** One refresh at a time per server (a provider that rotates refresh tokens spends the old one at each refresh): the lease
   *  is granted to `holder` for `ms` (MCP_REFRESH_LEASE_MS by default) only while the credential is still the one it read
   *  (`seen`: the sealed bytes, null for none) and no live lease is held. Not granted: the current row comes back, and the
   *  caller waits for the holder's set (re-reading) or the lease's end. A lease whose holder died runs out; the next claim
   *  may take it. `ms` must be longer than the refresh call's own deadline (MCP_REFRESH_CALL_MS: the holder gives its call
   *  up by then), so a lease never lapses while its holder's call may still spend the token; a shorter one is refused. */
  leaseRefresh(name: string, lease: { seen: Uint8Array | null; holder: string; ms?: number }): Promise<{ leased: boolean; row: McpServerRow }>;
  /** The lease holder's refreshed credential: written, and the lease cleared, in one transaction. RefreshLeaseLost (nothing
   *  written) when `holder` no longer holds the lease (it ran out and another claim took it, or the server was removed). */
  refreshToken(name: string, refresh: { holder: string; sealed: Uint8Array }): Promise<McpServerRow>;
  /** Gives the lease back without a new credential (the refresh failed or got no answer), so the next claim may try at once. */
  releaseRefresh(name: string, holder: string): Promise<void>;
}

/** A server setting as a row (store schema `settings`): its key, its value (JSON) and when it was last written. */
export interface SettingRow {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
}

export interface Settings {
  /** The value saved under `key`, or undefined when none is (a value saved as null reads as null, told apart from none). */
  get(key: string): Promise<unknown | undefined>;
  /** Saves `value` (JSON) under `key`, inserted or replaced in place. */
  put(key: string, value: unknown): Promise<void>;
  /** The key's row goes; a key with no row is left as it is. */
  remove(key: string): Promise<void>;
  /** Every setting, by key. */
  all(): Promise<SettingRow[]>;
}

/** A sealed key as a row (store schema `sealed_keys`): its name and the bytes the server sealed (store/seal.ts, AAD
 *  sealed_keys|<name>|sealed), which the store never opens. */
export interface SealedKeyRow {
  readonly name: string;
  readonly sealed: Uint8Array;
  readonly updatedAt: number;
}

export interface SealedKeys {
  /** The sealed bytes saved under `name`, or undefined when none is. */
  get(name: string): Promise<Uint8Array | undefined>;
  /** Saves `sealed` under `name`, inserted or replaced in place. */
  put(name: string, sealed: Uint8Array): Promise<void>;
  /** The key's row goes. */
  remove(name: string): Promise<void>;
  /** Every saved key, by name (its bytes never opened here). */
  all(): Promise<SealedKeyRow[]>;
}

/** One session a provider runs, with the labels we gave it and the rest of the provider's entry for it (store schema
 *  `computer_ledger`). */
export interface ComputerLedgerRow {
  readonly provider: string;
  readonly sessionId: string;
  readonly labels: Readonly<Record<string, string>>;
  /** The provider's other fields for the session, as it gave them (a phone's image and deadline). */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly updatedAt: number;
}

/** The labels of the sessions a provider runs with none of its own (a phone provider's), so its list, an attach by
 *  labels and the janitor outlive a restart. */
export interface ComputerLedger {
  /** Saves `labels` and `detail` for `provider`'s session `sessionId`, inserted or replaced in place. */
  put(provider: string, sessionId: string, labels: Readonly<Record<string, string>>, detail: Readonly<Record<string, unknown>>): Promise<void>;
  /** The session's row, or undefined when none is kept. */
  get(provider: string, sessionId: string): Promise<ComputerLedgerRow | undefined>;
  /** Every session of `provider`, by its id. */
  list(provider: string): Promise<ComputerLedgerRow[]>;
  /** The session's row goes. */
  remove(provider: string, sessionId: string): Promise<void>;
}

/** A trigger source's sealed setting as a row (store schema `trigger_settings`): its adapter, scope ("server" for the one
 *  server-wide set, or a trigger's id for its own), field, and the value sealed (store/seal.ts) under AAD
 *  trigger_settings|<adapter>|<scope>|<field>: TEXT the store never opens. */
export interface TriggerSettingRow {
  readonly adapter: string;
  readonly scope: string;
  readonly field: string;
  readonly sealed: string;
  readonly updatedAt: number;
}

export interface TriggerSettings {
  /** Every (scope, field) the adapter has, by scope then field. */
  get(adapter: string): Promise<TriggerSettingRow[]>;
  /** Saves (inserts or replaces in place) the sealed value for the adapter's scope and field. */
  put(setting: { adapter: string; scope: string; field: string; sealed: string }): Promise<void>;
  /** A scope's fields go (a deleted trigger's). */
  removeScope(adapter: string, scope: string): Promise<void>;
}

/** An MCP OAuth sign-in in flight (store schema `mcp_oauth_pending`): its state the key, the server it is for, its secret
 *  parts (the PKCE verifier and the OAuth client, with its secret) sealed together (store/seal.ts, AAD
 *  mcp_oauth_pending|<state>|sealed) as bytes the store never opens, the non-secret working state the callback needs
 *  (`working`: discovery, kind, scope, resource and url, plain JSON — no secret), and when it expires (ms). */
export interface McpOauthPendingRow {
  readonly state: string;
  readonly server: string;
  readonly sealed: Uint8Array;
  readonly working: unknown;
  readonly expiresAt: number;
}

export interface McpOauth {
  /** Saves a pending sign-in, inserted or replaced by its state. */
  put(pending: McpOauthPendingRow): Promise<void>;
  /** Deletes the pending sign-in `state` and returns it, in one statement (atomic, single-use): the row if it was there and
   *  is not past its expiry (`now`, else the store's clock), else undefined. The row is deleted whether or not it had
   *  expired, so a replay and an expired state both read as gone and cannot be retried. The one way to read a pending
   *  sign-in: two concurrent takes of one state can never both get the row, which a get()+remove() split could not
   *  promise. The secret parts come back sealed; the caller opens them at their own AAD, so the store opens nothing. */
  take(state: string, now?: number): Promise<McpOauthPendingRow | undefined>;
  /** Removes every pending sign-in whose expiry is at or before `now`; answers how many went. */
  sweepExpired(now: number): Promise<number>;
  /** How many pending sign-ins are still live (expiry after `now`): the server caps the rows in flight by it. */
  count(now: number): Promise<number>;
}

/** A saved browser sign-in as the store holds it (store schema `sign_ins`): one live row per agent and provider, its
 *  pointer sealed (store/seal.ts, AAD sign_ins|<agent>:<provider>|pointer), which the store never opens. `name` is the
 *  owner's label for it ("default"). */
export interface SignInRow {
  readonly agentId: string;
  readonly provider: string;
  readonly name: string;
  readonly pointerSealed: Uint8Array;
  readonly savedAt: number;
  /** When a run last verified this sign-in (saved a live session back to the vendor), ms; null when none has since it was
   *  saved. The v2 view's verified_at. */
  readonly verifiedAt: number | null;
}

/** A forgotten sign-in's pointer, kept sealed byte for byte as its live row held it (so it still opens under the same
 *  binding), only so a server started later can cut it from what a run it was handed shows. */
export interface SignInTombstoneRow {
  readonly agentId: string;
  readonly provider: string;
  readonly pointerSealed: Uint8Array;
  readonly forgottenAt: number;
}

/** How many forgotten pointers an agent keeps per store, the oldest dropped first. */
export const SIGN_IN_TOMBSTONES_KEPT = 32;

export interface SignIns {
  /** Saves the one live sign-in for the agent and provider, its pointer already sealed by the caller: inserted, or replaced
   *  in place when one is saved already (one per agent and provider). */
  save(signIn: { agentId: string; provider: string; name: string; pointerSealed: Uint8Array }): Promise<SignInRow>;
  /** The agent's live sign-ins, by provider (their pointers stay sealed). */
  list(agentId: string): Promise<SignInRow[]>;
  /** The agent's live sign-in for the provider, or undefined. */
  get(agentId: string, provider: string): Promise<SignInRow | undefined>;
  /** Marks the agent's sign-in for the provider verified at `at` (a run saved a live session back): sets verified_at, for
   *  the v2 view. The run path (E2) calls it at a run's save; a missing sign-in is left as it is. */
  verify(agentId: string, provider: string, at: number): Promise<void>;
  /** The agent's forgotten pointers for the provider, newest first (kept sealed, never opened here). */
  tombstones(agentId: string, provider: string): Promise<SignInTombstoneRow[]>;
  /** Forgets the agent's live sign-in for the provider, in the one transaction a launch shares as its lock: when a running
   *  run holds `hash` in its sign_in_handed (or, with `heldUnreadable`, when any running run was handed a sign-in at all),
   *  the forget is refused (SignInHandedTo, naming the run) and nothing is written; otherwise the live row's sealed pointer
   *  moves to a tombstone (the newest SIGN_IN_TOMBSTONES_KEPT kept) and the live row goes. SignInMissing when the agent has
   *  no live sign-in for the provider. */
  forget(agentId: string, provider: string, held: { hash?: string; heldUnreadable?: boolean }): Promise<SignInTombstoneRow>;
  /** The id of a running run whose sign_in_handed holds `hash`, if one does; undefined otherwise. The check the runner
   *  makes before it serves a run's output, and forget makes before it removes a sign-in. */
  handedHolder(hash: string): Promise<string | undefined>;
  /** The id of a running run that was handed any sign-in (a non-empty sign_in_handed), if one was: for a pointer that does
   *  not open here, which any such run may hold. */
  handedAny(): Promise<string | undefined>;
}

/** A running run's live view as the store keeps it: `state` is JSON (the tool it runs now, its partial text). */
export interface LiveRow {
  readonly runId: string;
  readonly state: unknown;
  readonly updatedAt: number;
}

export interface Live {
  /** A runner's tick: every changed run's row, written in ONE transaction, each fenced by its claim's epoch. A row whose
   *  claim is stale is skipped (never written); the rest are written, overwriting each run's last. */
  put(rows: readonly { readonly claim: Claim; readonly state: unknown }[]): Promise<{ written: string[]; fenced: string[] }>;
  /** The rows of `runIds` that have one, in one query: the server's read. */
  read(runIds: readonly string[]): Promise<LiveRow[]>;
  /** The run's row goes, at its end, under `claim`: fenced by its epoch like a put, so a loop that ends after its claim
   *  was lost drops nothing of the row a later claim wrote. */
  drop(claim: Claim): Promise<void>;
}

/** A live view's computer kind: the live view is proxy-only for each (browser, desktop, phone). (Distinct from
 *  @parcha/computer's ComputerKind, which names a provider's OS family.) */
export type ViewerKind = "browser" | "desktop" | "phone";

/** One open computer session's viewer as the store keeps it: one row per (run, computer kind, session tag), its token
 *  sealed (sealedAt.liveViewer), `at` the store's clock when it was put, `runner` the claim's holder. */
export type LiveViewerRow = { kind: ViewerKind; tag: string; port: number; id: string; sealed: Uint8Array; at: number; runner: string };

/** The computer sessions' viewer hand-overs (browser-live.ts): the runner puts and drops them under its claim, the server
 *  reads them. The rows go with the run's end (its end commit), a take or reclaim of the run (a newer epoch, in the
 *  claim's transaction), and the run's delete (on delete cascade). */
export interface LiveViewers {
  /** The runner's put under its claim, upsert on (run_id, kind, tag), `at` stamped by the store: false when the claim is
   *  stale (its epoch moved on, or its lease ran out), and nothing written. */
  put(claim: Claim, viewer: { kind: ViewerKind; tag: string; port: number; id: string; sealed: Uint8Array }): Promise<boolean>;
  /** The runner's drop, fenced by its claim's epoch: with no kind every row of the run; a kind with no tag that kind's
   *  rows; a kind and a tag that one row. */
  drop(claim: Claim, kind?: ViewerKind, tag?: string): Promise<void>;
  /** The server's read: the run's rows, newest first, only those of its epoch, under a live claim, by its runner (a runner
   *  that died, or a claim lost, names no viewer), each carrying its kind. */
  of(runId: string): Promise<LiveViewerRow[]>;
}

/** Who opens the store. The server sets the schema up at its start and holds the store's owner lock (one server per
 *  store); a runner never sets anything up, and refuses a schema version it does not know. */
export type StoreRole = "server" | "runner";

export interface Store {
  /** Where this store's data is, as an identity two instances over the same data share and two over different data never
   *  do: "sqlite:" and the database file's real path, or "sqlite:memory:<n>" for an in-memory one (each its own data);
   *  a store over a database server names its host, database and schema, never a user, a password or a credential.
   *  What waits on another claim's work in this process keys on it (mcp-claim.ts), not on an object. */
  readonly where: string;
  readonly agents: Agents;
  readonly templates: Templates;
  readonly triggers: Triggers;
  readonly runs: Runs;
  readonly mcp: Mcp;
  readonly live: Live;
  readonly liveViewers: LiveViewers;
  readonly learning: Learning;
  /** The server's tool settings and any other server setting it keeps (design 2.1): one JSON value per key. */
  readonly settings: Settings;
  /** The model and provider keys the server holds, sealed (store/seal.ts): bytes the store never opens. */
  readonly sealedKeys: SealedKeys;
  /** The labels of the sessions a provider runs with none of its own (a phone provider's). */
  readonly computerLedger: ComputerLedger;
  /** Each trigger source's sealed settings (design 2.1): a value per adapter, scope and field. */
  readonly triggerSettings: TriggerSettings;
  /** MCP OAuth sign-ins in flight (design 2.1): one row per pending sign-in, its verifier sealed. */
  readonly mcpOauth: McpOauth;
  /** Each agent's saved browser sign-ins (design 2.1): one live row per agent and provider, its pointer sealed, with the
   *  forgotten pointers kept as tombstones. */
  readonly signIns: SignIns;
  /** Claims the run for `runner` until now + `leaseMs`: the run's epoch + 1 when it is claimable (runs.claimable); null when
   *  another claim holds it, or it is final, or parked with nothing to wake it. A queued or parked run becomes running. */
  claim(runId: string, runner: string, options?: { leaseMs?: number }): Promise<Claim | null>;
  /** Moves the claim's end to now + `leaseMs`. Fenced when the run's epoch moved on. */
  renew(claim: Claim, options?: { leaseMs?: number }): Promise<Claim>;
  /** Renews every claim in one transaction, each to now + `leaseMs`: a runner's renew of all it holds. Each answer is the
   *  renewed claim, or Fenced for one whose epoch moved on (nothing written to it; the others renew). */
  renewMany(claims: readonly Claim[], options?: { leaseMs?: number }): Promise<(Claim | Fenced)[]>;
  /** Gives the run back (no runner, no claimed_until; `state` when given; `wakeAt` and `backoffUntil` or none), in a
   *  durable commit (as flush). Fenced when the epoch moved on. Never a final state: the run's end commit is the one write
   *  that makes it final (a release asked for one is refused with a TypeError). */
  release(claim: Claim, options?: { state?: ReleasedState; wakeAt?: number | null; backoffUntil?: number | null }): Promise<void>;
  /** The run's journal: pi-durable's Storage for this one run, every commit fenced by the claim (store/journal). Its commit
   *  holds the store's one connection while it runs, so it awaits nothing but its own statements, under a deadline. */
  journal(claim: Claim): Journal;
  /** A run's journal opened for reading only (JournalReads): the server's reads of a run, which hold no claim. Its reads
   *  alone, never a commit; a read never fences, so it needs no claim. A run with no journal yet reads as empty. */
  readJournal(runId: string): JournalReads;
  /** The run started under origin `key` (runs.create's origin), with the fingerprint recorded then; undefined when no run
   *  was started under it. The one read a retry under a key makes to find the run its first request started. */
  runOfOrigin(key: string): Promise<{ runId: string; fingerprint: string | null } | undefined>;
  /** Imports a run that has already ended: its row (ended, imported_from, cost, summary, metrics, outcome), its launch row
   *  and its transcript's journal, all in one transaction — the server's own writer, no second writer and no throwaway
   *  database. The run is created at epoch 0 in the same transaction, so the journal's fence passes; a crash mid-import
   *  leaves nothing. StoreConstraint on a duplicate run id or import (source, session). */
  importRun(run: ImportRunInput): Promise<RunRow>;
  /** One durable commit: every commit before it, of every run, is on the disk when it resolves. Before a call that must
   *  not run twice, at a run's end and when a claim is released. */
  flush(): Promise<void>;
  /** Writes a command for the run. RunFinal when the run is final; unknown runs are refused the same way. */
  command(runId: string, command: { kind: string; body?: unknown }): Promise<Command>;
  /** The run's commands with an id above `after`, in id order. */
  commands(runId: string, after: number): Promise<Command[]>;
  /** Every run's commands with an id above its own cursor, in id order, in one read: a runner's poll of all it holds. A run
   *  with none is absent from the map. */
  commandsOf(cursors: readonly { runId: string; after: number }[]): Promise<Map<string, Command[]>>;
  /** Marks the command taken (or refused, with `reason`) under the claim, once: a command already taken stays as it was.
   *  Fenced on a stale claim. */
  take(claim: Claim, commandId: number, outcome?: "taken" | "refused", reason?: string): Promise<void>;
  /** Counts a failed resume on the untaken command that woke the run, under the claim, and answers its tries; the command
   *  stays untaken. Fenced on a stale claim; StoreConstraint when the command is taken or not the run's. */
  retry(claim: Claim, commandId: number): Promise<number>;
  /** Waits for every write asked for before it, then closes (and lets the owner lock go). A call after it is refused
   *  (StoreClosed). */
  close(): Promise<void>;
}

/** A write under a claim whose epoch is no longer the run's: refused, and nothing written. */
export class Fenced extends Error {
  readonly runId: string;
  readonly epoch: number;
  constructor(runId: string, epoch: number) {
    super(`run ${runId}: the claim at epoch ${epoch} is no longer the run's, so nothing was written`);
    this.name = "Fenced";
    this.runId = runId;
    this.epoch = epoch;
  }
}

/**
 * A journal commit that takes a command which is not the run's untaken command (already taken, or another run's): the
 * whole commit is refused and nothing of it written, so a command's effect never applies twice. Like Fenced, it fails the
 * run's Session (pi: any commit error is final).
 */
export class CommandTaken extends Error {
  readonly runId: string;
  readonly commandId: number;
  constructor(runId: string, commandId: number) {
    super(`run ${runId}: command ${commandId} is not the run's untaken command, so the commit was refused and nothing was written`);
    this.name = "CommandTaken";
    this.runId = runId;
    this.commandId = commandId;
  }
}

/** An interactive transaction still open at its deadline: rolled back, nothing of it written, and the calls behind it go on. */
export class StoreDeadline extends Error {
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`the store's transaction was still open after ${deadlineMs} ms, so it was rolled back and nothing of it was written`);
    this.name = "StoreDeadline";
    this.deadlineMs = deadlineMs;
  }
}

/** The database stayed locked past the store's busy wait. */
export class StoreBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreBusy";
  }
}

/** A call after close(). */
export class StoreClosed extends Error {
  constructor() {
    super("the store is closed");
    this.name = "StoreClosed";
  }
}

/** The store's worker thread failed or exited: every call after it is refused in these words, never left waiting. */
export class StoreWorkerLost extends Error {
  constructor(why: string) {
    super(`the store's worker ${why}: the store takes no more calls in this process`);
    this.name = "StoreWorkerLost";
  }
}

/** A second server on a store another server holds (one server per store). */
export class StoreOwned extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreOwned";
  }
}

/** A refreshed MCP credential from a claim that no longer holds the server's refresh lease: nothing is written. */
export class RefreshLeaseLost extends Error {
  readonly server: string;
  readonly holder: string;
  constructor(server: string, holder: string) {
    super(`the MCP server ${server}'s refresh lease is not ${holder}'s any more: its token set is not written`);
    this.name = "RefreshLeaseLost";
    this.server = server;
    this.holder = holder;
  }
}

/** A data directory an earlier version wrote (its store, agent homes, run databases or settings files): this version
 *  neither reads nor moves it. `found`: what was found, relative to the directory. */
export class StoreFromEarlierVersion extends Error {
  readonly found: readonly string[];
  constructor(dataDir: string, found: readonly string[]) {
    super(
      `${dataDir} holds an earlier version's data (${found.join(", ")}), which this version does not read or move: ` +
        "start with a new, empty directory, and add your MCP servers, keys and sign-ins there again.",
    );
    this.name = "StoreFromEarlierVersion";
    this.found = found;
  }
}

/** A store whose schema version this build does not know (or one the server has not set up yet). */
export class SchemaVersionUnknown extends Error {
  readonly found: number | null;
  readonly known: number;
  constructor(file: string, found: number | null, known: number) {
    super(found === null ? `the store at ${file} has no schema yet: the server sets it up at its start` : `the store at ${file} is schema version ${found}; this build knows version ${known}`);
    this.name = "SchemaVersionUnknown";
    this.found = found;
    this.known = known;
  }
}

/** A command for a run that is final, or that does not exist. */
export class RunFinal extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`run ${runId} is not running (it ended, or there is no such run): it takes no command`);
    this.name = "RunFinal";
    this.runId = runId;
  }
}

/** A run with no launch row: it was not started with one (an unknown run reads the same way). The runner's claim needs it to
 *  build the run's spec, so its absence is this named refusal, never a default. */
export class StoreLaunchMissing extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`run ${runId} has no launch record: it was not started with one, or there is no such run`);
    this.name = "StoreLaunchMissing";
    this.runId = runId;
  }
}

/** Which of a table's rules refused a row, as both databases report it by code (never by its message's words). */
export type ConstraintRule = "check" | "unique" | "foreign_key" | "not_null";

/** A row the store's constraints refuse (a duplicate id or name, a revision of an unknown agent, a bad kind). When the
 *  database said which rule refused it, `rule`; for a duplicate, `unique`: the table and the columns whose values were
 *  taken already (a primary key's or a UNIQUE's), so a caller tells "the name is taken" from any other refusal. */
export class StoreConstraint extends Error {
  readonly rule?: ConstraintRule;
  readonly unique?: { readonly table: string; readonly columns: readonly string[] };
  constructor(message: string, details: { rule?: ConstraintRule; unique?: { table: string; columns: readonly string[] } } = {}) {
    super(message);
    this.name = "StoreConstraint";
    if (details.rule) this.rule = details.rule;
    if (details.unique) this.unique = details.unique;
  }
}

/** Forgetting a sign-in a running run was handed: refused, nothing written. `runId` is the run that holds it. */
export class SignInHandedTo extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`a running run (${runId}) was handed this sign-in, so it is not forgotten while that run runs`);
    this.name = "SignInHandedTo";
    this.runId = runId;
  }
}

/** Forgetting a sign-in the agent does not have for the provider. */
export class SignInMissing extends Error {
  constructor(agentId: string, provider: string) {
    super(`the agent ${agentId} has no ${provider} sign-in to forget`);
    this.name = "SignInMissing";
  }
}
