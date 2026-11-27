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
import type { Context } from "@earendil-works/chord/context";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { Source } from "@parcha/agentrun-import";
import type { JournalPage } from "./journal/storage.js";
import type { MonidPinBody } from "./agent-body.js";
import type { LedgerRow, SpendRow } from "../learn/ledger.js";

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
  /** Which turn of the run this claim works and which attempt at it (run_attempts, RunAttemptRow): set by the claim that
   *  took the run, absent on a claim read back (claimsOf) and on a store that keeps none (a test's). */
  readonly turn?: number;
  readonly attempt?: number;
}

/** Why a claim let its run go while the run was still at work, so another claim does that work again: `drain`, its
 *  runner closed (a deploy, a scale-down) and handed the run back; `retry`, its loop ended interrupted on its own (or its
 *  end was refused) and the run was released to be tried again; `lease_lapse`, its runner was there but could not renew
 *  the claim before it ran out; `crash`, the claim's lease ran out with nothing said of it (its runner died). */
export type AttemptCause = "drain" | "crash" | "lease_lapse" | "retry";

/** One claim of a run (store schema `run_attempts`), written by the claim itself: the turn it works and its attempt at
 *  it. A turn is the work one claim starts afresh: the run's first, a follow-up's, a resume after a park. A claim that
 *  takes over a turn another claim was cut from (its run still running, and that claim let it go for `cut`, or its lease
 *  ran out) works the same turn again: its attempt is one more, and `cause` says why the one before was cut. Infra's
 *  work, not the run's: every request the cut attempt made is made again. `journalFrom`: the first journal entry id this
 *  claim could write (the run's next id when it claimed), so each entry of the run's journal is read as its claim's. */
export interface RunAttemptRow {
  readonly runId: string;
  readonly epoch: number;
  readonly turn: number;
  readonly attempt: number;
  /** Why the attempt before was cut; null on a turn's first attempt. */
  readonly cause: AttemptCause | null;
  /** Why this claim let the run go with its turn unfinished (`drain`, `retry`, `lease_lapse`); null while it holds the
   *  run, and when it ended the turn (an answer, a park, the run's end) or died without a word. */
  readonly cut: Exclude<AttemptCause, "crash"> | null;
  readonly runner: string;
  readonly from: RunState;
  readonly journalFrom: number;
  /** When the claim took the run, on the store's clock (ms). */
  readonly claimedAt: number;
}

/** Each claim of a run, its turn and attempt (RunAttemptRow): written in the claim's own transaction, its `cut` in its
 *  release's. The source-project recovery read also uses the actual claim identity and journal boundary to report a
 *  terminal attempt with no checkpoint; it never infers a completed capture or retries work from these rows. */
export interface RunAttempts {
  /** The claim at `epoch` lost its lease while its runner was there (runner.ts loseClaim): its cut, and the cause of the
   *  claim that took the run over from it if that one was read as a crash. Unfenced and idempotent: a cut already said, or
   *  a claim with no row, is left as it is. */
  lapsed(runId: string, epoch: number): Promise<void>;
  /** The run's claims, by epoch. */
  forRun(runId: string): Promise<RunAttemptRow[]>;
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
  /** The reference of the agent this one mirrors in another system ("<source>:<kind>:<id>"), or null for one made here. An
   *  agent with a reference is read-only from here: it is written on the first run that names it and never edited. */
  readonly externalRef: string | null;
  /** When the agent was purged (Agents.purge): its row is then a tombstone, its name and description blanked; null when it
   *  was not. */
  readonly purgedAt: number | null;
}

/** The template package an agent was applied from, kept on the revision the apply made (its first): the package's id
 *  (a bundled one's name, an imported one's `github:<owner>/<repo>[/<path>]`), its SemVer version, and the commit SHA it
 *  was imported at (null for a bundled one, which is the server's own build). */
export interface TemplatePackage {
  readonly id: string;
  readonly version: string;
  readonly sha: string | null;
  /** A keyed digest of the parameters the apply was given, as it checked them (seal-key.ts parametersDigest), never the
   *  parameters, one of which may be a credential: a later fresh apply of the same package whose parameters give the same
   *  digest warns of this agent. Absent on a revision applied before it was kept. */
  readonly parameters_digest?: string;
  /** The names of the keys the package declared (its `secrets`, and those of the model choice the apply took), sorted,
   *  never their values: what an export of the agent names, whatever version of the package the server holds later, and
   *  the tool keys a run of the revision may carry (run-keys.ts; under the run-keys setting one that does not is refused).
   *  Every apply writes it. */
  readonly secrets?: readonly string[];
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
  /** The version this revision maps in an externally owned agent, set only on an inline-agent run's revision. */
  readonly externalVersion?: string;
  /** The MCP tools the revision grants, pinned as their servers listed them when it was saved (mcp-gateway.ts McpPin), which
   *  every run of it calls; none when it grants none. */
  readonly mcpPin?: unknown;
  /** Its monid endpoints, pinned as monid listed them when it was saved (agent-body.ts MonidPinBody); none for none. */
  readonly monidPin?: MonidPinBody;
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
  /** The version this revision maps in the agent's owning system (one revision per version), or null for one committed here. */
  readonly externalVersion: string | null;
  /** Its MCP pin as its save made it (NewRevision.mcpPin), or null for a revision that grants no MCP tool. */
  readonly mcpPin: unknown;
  /** Its monid pin as its save made it (NewRevision.monidPin), or null for a revision that grants no monid endpoint. */
  readonly monidPin: MonidPinBody | null;
}

/** How a run ended, beside its state. An ended run (state 'ended'): 'escalated' (it finished its work and waits for a
 *  person, which the v2 status reads as completed with a review) or 'completed'. A stopped run (state 'stopped'): 'stopped'
 *  when a person stopped it (its turn ended, never the run: an agentic run reads input_required and idle, as main's
 *  statusOf reads a stopped run, and a person's message reopens it), 'cancelled' when it was cancelled (over for good). A
 *  failed run says so in its state. */
export type RunOutcome = "completed" | "escalated" | "stopped" | "cancelled";

/** A runs list's filter (Runs.listed). */
export interface ListedFilter {
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly labels?: RunLabels;
  /** Only runs imported from this source (imported_from.source), or with "live" the runs not imported. */
  readonly source?: string;
  /** Only runs started at or after this time (ms), and before `startedBefore` (ms): the window [startedFrom, startedBefore). */
  readonly startedFrom?: number;
  readonly startedBefore?: number;
  /** Only runs that sent at least one request to this model (`provider/model`), a key of their metrics' `models`, exactly. */
  readonly model?: string;
  readonly archived: boolean;
  readonly status?: string;
  /** Only runs still going (no settled status on the row) whose listing is behind. */
  readonly going?: boolean;
  /** Only rows after this one in the list's order (started earlier, or at the same time with a smaller id): a scan's
   *  place, which rows that leave the set between its reads (a listing built meanwhile) never shift, as they shift an
   *  offset. */
  readonly after?: { readonly startedAt: number; readonly id: string };
  readonly limit: number;
  readonly offset?: number;
  /** Only runs in this workspace (Runs.workspace: the run's own, else its agent's). */
  readonly workspace?: string;
}
/** A run as a list reads it (Runs.listed): its row, its agent's archive time, and its listing as kept (null: none built). */
export interface ListedRun {
  readonly row: RunRow;
  readonly agentArchivedAt: number | null;
  readonly listing: KeptListing | null;
  readonly listStatus: string | null;
  /** The run's list_mark now: the mark a listing built from here is written at. */
  readonly listMark: number;
  /** The listing is behind now (Runs.behind's three ways): a list builds it before it shows it. */
  readonly behind: boolean;
}
/** A run's listing as its row keeps it (Runs.putListing's item and cut, and what it kept for the Agent Factory). */
export interface KeptListing {
  readonly item: Record<string, unknown>;
  readonly cut: string;
  /** What the build kept for the Agent Factory beside the list item (RunListing.factory), or none for a listing an
   *  earlier server built. */
  readonly factory?: unknown;
}
/** Whether `run`, of a revision of `kind`, was stopped by a person and waits for them (state 'stopped', outcome 'stopped',
 *  an agentic run started here): its turn is over, the run is not. A workflow's stop, a cancel and an imported run's stop
 *  are over for good. */
/** A run's listing as the server writes it (Runs.putListing): its list item (`item`), its status, whether a runner held the
 *  run when it was built, when it goes stale by the clock alone (null: never), and what outside the run it read (flags). */
export interface RunListing {
  readonly item: Record<string, unknown>;
  /** The digest of the server's secrets the item was cut of. */
  readonly cut: string;
  readonly status: string;
  readonly live: boolean;
  readonly until: number | null;
  readonly flags: number;
  /** What a scoped list (the Agent Factory's) shows of the run beside its list item, as the same build read it (JSON, the
   *  server's own: store-view.ts KeptFactory). Kept with the item and cut of the same secrets; no runs list shows it. */
  readonly factory?: unknown;
}

export function stoppedByPerson(run: Pick<RunRow, "state" | "outcome" | "importedFrom">, kind: string): boolean {
  return run.state === "stopped" && run.outcome === "stopped" && kind === "agentic" && run.importedFrom === null;
}

/** The harness an imported run came from. */
export type ImportSource = Source;
/** Where an imported run came from: the harness that ran it, and its own session id. `file` is the server's own record of
 *  the session file an import read whole (the sha-256 of its path, never the path, with its size and mtime), so a later
 *  import does not read an unchanged file again; it is internal and never shown on an answer. The unique import index keys
 *  on source and session alone, so a re-import of the same session with a different `file` is still the same run. */
export interface ImportedFrom {
  readonly source: ImportSource;
  readonly session: string;
  readonly file?: { readonly path_sha256: string; readonly size: number; readonly mtime_ms: number };
}

/** What a run was started under: `key`, the caller's name for it (a create's idempotency key, a trigger's firing key),
 *  which starts one run only, and `fingerprint`, what was asked, kept to tell a retry from another request under the key. */
export interface RunOrigin {
  readonly key: string;
  readonly fingerprint?: string | null;
}

/** A run's labels: a small map of the caller's own strings, set once at its start, never read by the server (only
 *  filtered on). Bounds: run-labels.ts. */
export type RunLabels = Readonly<Record<string, string>>;

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
  /** What the run cost, exactly: null when that is unknown, and null when its stored cost is only the most it can have
   *  cost (`costAtMostUsd`). Every reader that sums, compares or shows spend reads this, so a bound never reads as spend. */
  readonly costUsd: number | null;
  /** The most the run can have cost, set only when that is all its stored cost says (runs.cost_upper_bound): it counts a
   *  request cut with no answer at what its cap held for it (runner.ts CUT_AT_HOLD). Read only where a figure can be said
   *  "at most" (the run's view, the runs list); null otherwise, `costUsd` then the stored figure or null. */
  readonly costAtMostUsd: number | null;
  readonly metrics: unknown;
  readonly summary: string | null;
  /** How the run ended beside its state (RunOutcome), null for a plain completion, a failure, or a run not ended. */
  readonly outcome: RunOutcome | null;
  /** When the run itself was archived (its agent's archive is read apart); null when it is not. */
  readonly archivedAt: number | null;
  /** The session an imported run came from; null for a run started here. */
  readonly importedFrom: ImportedFrom | null;
  /** The SHA-256 hashes of the browser sign-in pointers handed to the run at its launch (never the pointers), or null when
   *  it was handed none. A sign-in whose pointer hashes to one of these cannot be forgotten while the run runs. */
  readonly signInHanded: readonly string[] | null;
  /** The caller's labels, given at its start (RunLabels): opaque to the server, kept as given, {} when none. */
  readonly labels: RunLabels;
  /** The disk the run's launch named as its own (a customer's Archil disk: the launch body's `archil_disk` of kind "launch"),
   *  by its id, written once with the queued run; null for a run on the default disk (its launch named none, or its agent's
   *  own). A run on a named disk learns nothing, so learning reads only runs with none (learn/learning-of.ts). */
  readonly disk: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** When the run was purged (Runs.purge): its row is then a tombstone, its cost and times kept, everything else of it
   *  gone; null when it was not. */
  readonly purgedAt: number | null;
}

/** What a purge keeps of a run on its tombstone's metrics (`purged`), read from its journal before that goes: the reads of
 *  its spend that read the journal answer from it after (store-reads/cap.ts). `meters`: /usage's meter figures
 *  (metersOverStore); `spend`: what it spent as a run that reads running reads it (spendOverStore); `learning`: how its
 *  learning ended as GET /stats counts it (store-reads/learning.ts learningCountsOverStore), its state and reason alone,
 *  null for none. */
export interface PurgeKept {
  readonly meters: unknown;
  readonly spend: { readonly usd: number | null; readonly basis?: string };
  readonly learning: { readonly state: string; readonly reason: string | null } | null;
}

/** A run's metrics as its tombstone keeps them (Runs.purge): what the totals and the analytics read of them, never a
 *  call's arguments or results, a prompt, a URL or a grader's words. Each number (or an unknown one's null) at the top;
 *  each tool's calls and errors by its name (GET /stats' top tools); the effort (its analytics group) and the cost basis
 *  (metrics.ts storedBasisOf), each a code; and `purged`, `kept`. Everything else goes: its models, a grader's verdict, an
 *  audit's or a replay's link, a learned loop's nodes, the path it took (no reader of a tombstone reads it). */
export function tombstoneMetrics(metrics: unknown, kept: PurgeKept): Record<string, unknown> {
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const from = isObject(metrics) ? metrics : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(from)) if (value === null || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
  if (isObject(from.tools)) out.tools = Object.fromEntries(Object.entries(from.tools).map(([name, each]) => [name, { calls: count(isObject(each) ? each.calls : 0), errors: count(isObject(each) ? each.errors : 0) }]));
  // A code is a word with no space (an effort level, a cost basis).
  for (const key of ["effort", "costBasis"]) if (typeof from[key] === "string" && /^[\w-]{1,64}$/.test(from[key])) out[key] = from[key];
  out.purged = kept;
  return out;
}

/** What a runner may change on its run's row, under its claim. A final state with no `endedAt` is stamped now. */
export interface RunPatch {
  readonly state?: RunState;
  readonly costUsd?: number | null;
  /** Whether `costUsd` is the most the run can have cost (stored as runs.cost_upper_bound, read back as
   *  RunRow.costAtMostUsd): read only with `costUsd`, which always writes it (absent: false). */
  readonly costUpperBound?: boolean;
  readonly metrics?: unknown;
  readonly summary?: string | null;
  /** How the run ended (RunOutcome), set in its end commit; null clears it. */
  readonly outcome?: RunOutcome | null;
  /** The SHA-256 hashes of the sign-in pointers handed to the run, which the runner writes at its claim (under the epoch
   *  fence); null clears them. While the run runs, a sign-in hashing to one of these cannot be forgotten (sign-ins-store.ts). */
  readonly signInHanded?: readonly string[] | null;
  readonly endedAt?: number | null;
  /** A final patch that writes the end the run's job kept before its look-back (feedback-round.ts KeptEnd): a stop or a
   *  cancel waiting at its commit cut the look-back, never the job's end, and is refused (refuseLeftovers), unless a
   *  person's message waits too: that message's run is the one they stop or cancel. */
  readonly keepsEnd?: boolean;
  /** A final patch's census (run-census.ts): where in the run's files the secrets its launch holds sit, made under the
   *  launch's `sealed` bytes as they were then. The end that erases them writes it as the launch's census when its sealed
   *  bytes are still those, else the marker "unscanned" (refuseLeftovers), as it does for an end with none. */
  readonly census?: { readonly json: string; readonly sealed: Uint8Array };
}

/** The row runs.update answers. When the patch wrote `signInHanded` (the runner's bind at its claim), `save` rides with it:
 *  whether this run holds the sign-in's save lease — true unless another run already holds one of the handed pointers,
 *  decided in the same transaction as the sign_in_handed write so two binds of one sign-in never both save. Absent when the
 *  patch wrote no `signInHanded`. */
export type UpdatedRun = RunRow & { readonly save?: boolean };

/** A run's launch, as the server writes it at start: its JSON `body` (run-launch.ts: the first input, title, place, effort,
 *  cap, trigger and origin), and `sealed` ciphertext for any secret it carries (sealed with the server's key outside the
 *  store, AAD `run_launch|<run_id>|sealed`: the MCP credentials its caller handed it, store/seal.ts sealRunMcpAuth), or
 *  none. The body is written once, in the same transaction as the queued run. `sealed` is the run's for its life only: a
 *  message may replace it (runs.command and runs.reopen, `launchSealed`), and the write that ends the run erases it. */
export interface RunLaunchInput {
  readonly body: unknown;
  readonly sealed?: Uint8Array | null;
}

/** The census an end that erased a launch's sealed bytes writes when it has none made under them (RunLaunchRow.census): what
 *  the run was handed may be in its files, and nothing says where. */
export const CENSUS_UNSCANNED = JSON.stringify("unscanned");

/** A run's launch as the store holds it: the body the runner reads at its claim, and its sealed bytes, which the store never
 *  opens. `census`: null until an end erased its sealed bytes (none handed, none erased yet, or a run ended before the census
 *  was kept); then the JSON text the last end that erased them wrote (RunPatch.census, run-census.ts), or CENSUS_UNSCANNED when that end had none made under them. */
export interface RunLaunchRow {
  readonly runId: string;
  readonly body: unknown;
  readonly sealed: Uint8Array | null;
  readonly census: string | null;
  readonly createdAt: number;
}

/** A message's new launch secrets (runs.command, runs.reopen): `launchSealed` replaces the run's launch `sealed` in the
 *  command's own transaction, so the runner that takes the command reads them, and a run already final takes neither.
 *  Given as a function, it is called inside that transaction with the sealed bytes the launch holds then (null when none:
 *  a run whose end erased them), and its answer is written (null erases): a message that hands one secret keeps the
 *  others the run holds, with no read outside the write that could bring back what an end erased. */
export type LaunchSealed = Uint8Array | ((current: Uint8Array | null) => Uint8Array | null);
export interface LaunchSealedWrite {
  readonly launchSealed?: LaunchSealed;
}

/** Internal authorization fence: lock this settings row and compare its named JSON fields before a guarded write.
 * All guards are locked in key order before the agent row; a missing row or changed field refuses the whole write. */
export interface SettingsGuard {
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>>;
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
  /** Internal authorization fences for an outbound historical import. These settings rows are locked and their
   * named fields checked in the same transaction as the terminal run and journal, so a completed revocation or
   * disconnect cannot be followed by another imported run. Ordinary local imports leave this absent. */
  readonly settingsGuards?: readonly SettingsGuard[];
  /** Remote history is admitted only while its agent remains active. Lock and check the agent in the import's
   * transaction, ordering the write against archive; ordinary local imports leave this guard absent. */
  readonly requireActiveAgent?: true;
}

/** Private preparation fence for the MCP registry. Sealed bytes are compared in memory, never persisted in a revision
 *  or exposed to its readers. Exact bytes distinguish credential replacement within the same clock millisecond. */
export interface McpGuard {
  readonly name: string;
  readonly url: string;
  readonly auth: string;
  readonly credentialChangedAt: number | null;
  readonly tools: unknown;
  readonly sealed: Uint8Array | null;
}

/** Rows written in the same commit as a run's update (runs.update, or a journal commit's staged patch): a channel post the
 *  run's moment owes (the outbox), what a channel was told. A command consumed is Staged.take, refused when not untaken. */
export type AlsoRow =
  | { readonly table: "channel_posts"; readonly row: ChannelPost }
  | { readonly table: "channel_told"; readonly row: { channel: string; marker: string } }
  /** What the run's end-of-run step kept: the turn and how its learning ended (the run's agent is the row's), and its
   *  `round` (absent: 1): the run's first end is round 1, each end after a follow-up opened it again the next. */
  | { readonly table: "learning_proposals"; readonly row: { turn: unknown; proposal: unknown; round?: number } };

/** A run's kept learning (learning_proposals): what its end-of-run turn asked and answered, and the proposal checked from it. */
export interface LearningProposal {
  readonly runId: string;
  /** Which of the run's looks back: 1 for its first end, then one more for each end after a follow-up opened it again. */
  readonly round: number;
  readonly agentId: string;
  readonly turn: unknown;
  readonly proposal: unknown;
  /** The learning run its end queued with it, which grades and merges it; absent for a learning dropped before. */
  readonly learningRunId?: string;
  readonly createdAt: number;
}

/** Learning on the runner: the kept proposals, written only beside a run's end (AlsoRow learning_proposals). */
export interface Learning {
  /** The run's kept proposal of round `round`, else its newest round's; undefined when its end kept none. */
  proposal(runId: string, round?: number): Promise<LearningProposal | undefined>;
  /** The agent's kept proposals (each round of a run one), newest first. */
  proposals(agentId: string, options?: { limit?: number }): Promise<LearningProposal[]>;
  /** Everything agent `agentId`'s runs' learning kept, in two reads whatever the number of its runs: every round of every
   *  run's kept proposal (oldest round first within a run), and the rows of the learning runs they name (as runs.get
   *  reads one; a learning run named and never written has none). An agent-wide read's, never a read a run. */
  kept(agentId: string): Promise<{ proposals: LearningProposal[]; learningRuns: RunRow[] }>;
  /** What learning spent outside any run, in one read: each run (not imported) whose learning ended in [from, to) (ms),
   *  its agent, when its learning ended and what its grade cost (null: unknown; 0: nothing graded). A learning dropped
   *  before it was proposed ended when it was kept; a proposal ended when its learning run ended (ended or failed), whose
   *  row keeps the grade's spend as its cost. One still waiting for its grade is none of them. */
  spend(window: { from: number; to: number }): Promise<LearningSpend[]>;
  /** The agent's learning at its newest save, what a run starts from: its items there, and every version's facts (no
   *  bodies) up to it. An agent with no save yet is given its first, empty (an `init` save), so every seed names one. */
  seed(agentId: string): Promise<LearningAt>;
  /** The agent's learning at its newest save, as seed reads it; undefined before its first save (none is made). */
  newest(agentId: string): Promise<LearningAt | undefined>;
  /** The id of the agent's newest purge save (a run's purge, the host's save of kind `purged`), undefined when none: the
   *  one save that rewrites saves before it in place, so a read across two reads that this moved under reads again. */
  newestPurge(agentId: string): Promise<string | undefined>;
  /** The id of the agent's newest save of any kind (a purge's host save included), undefined before its first: in one
   *  read, none of its items, so a read keyed on the newest save (learning-routes.ts statusesOf) is checked cheaply. */
  newestSave(agentId: string): Promise<string | undefined>;
  /** The agent's learning as save `id` (a version id) left it, read now: a purged run's rows are gone from every
   *  version. Undefined when the agent's learning holds no such save (a reset removed it, or it never was). */
  itemsAt(agentId: string, id: string): Promise<LearningAt | undefined>;
  /** The agent's saves its log shows (a purged run's left out), newest first: at most `limit`, below version `before`
   *  when given; `total`, how many the log shows in all. */
  saves(agentId: string, options?: { limit?: number; before?: number }): Promise<{ saves: LearningSave[]; more: boolean; total: number }>;
  /** One save of the agent's, by its version id or by its merge key; undefined when there is none. */
  saveOf(agentId: string, by: { id: string } | { mergeKey: string }): Promise<LearningSave | undefined>;
  /** Every version of one item, newest first, bodies included (a gone version's body null), each with its save. */
  versions(agentId: string, kind: LearningItemKind, name: string): Promise<(LearningItem & { readonly save: LearningSave })[]>;
  /** What save `id` changed: each item it wrote, with its body just before the save and at it (null: none there). */
  diff(agentId: string, id: string): Promise<LearningDiff | undefined>;
  /** One save, in one transaction: refused as stale unless the agent's newest version is `base`, as already done when a
   *  save with its merge key is there, as refused when its seed is not held, and as purged when a run's purge came after
   *  a save it was read at (`readAt`). */
  save(agentId: string, save: LearningSaveInput): Promise<LearningSaved>;
  /** Run `runId`'s learning gone from its agent `agentId`'s (no other agent's row is touched): the item versions it
   *  wrote (a person's change of its text with them), its grades, its audits, and the promotions and audits of each
   *  workflow version it wrote. Its saves stay as facts with no text (their merge keys still taken). A purge that
   *  changed a row is a save too, the host's (kind `purged`, no item) at the newest version + 1, so every save computed
   *  before it is stale. Idempotent: a purge that finds nothing of the run's adds none. */
  purgeRun(agentId: string, runId: string): Promise<void>;
  /** The agent's learning gone: items, saves and records. Its runs and what they cost stay. Under the agent's learning
   *  lock, then its records' lock, as a purge takes them: a records write that began before it is in before it. */
  reset(agentId: string): Promise<void>;
  /** Every learning row of the agent gone, its reset's included: its delete. Locked as reset is. */
  erase(agentId: string): Promise<void>;
  /** The agent's records of `kind`, oldest first. */
  records(agentId: string, kind: LearningRecordKind): Promise<LearningRecord[]>;
  /** Adds one record of `kind`, after every other; refused as changeRecords refuses one it adds. */
  addRecord(agentId: string, kind: LearningRecordKind, record: LearningRecordWrite): Promise<LearningRecord>;
  /** The agent's records of `kind` changed in one transaction: `update` reads them all and answers the list they become
   *  (a record with its `seq` kept is that record, one without is added after the others), or undefined for no change.
   *  `update` reads too, in the same transaction, whether a version of a workflow holds a digest (`held`): a run's purge
   *  takes the records' lock before it changes a version, so none goes between the read and the write. Each record the
   *  write adds (or moves to another workflow, digest or run) is checked in that transaction: a promotion's or an
   *  audit's digest must be held by a version of its workflow (unless it is `anyDigest`, a failed draft's, which no
   *  version holds), and its run (the `runId` column) is not purged. Else the write throws LearningRecordRefused and
   *  writes nothing. A promotion written (added or changed) is kept with its `commit` a save that holds its digest, and
   *  with each purged run's copies its data names blanked (learn/promote.ts forgetRunIn). */
  changeRecords<T>(agentId: string, kind: LearningRecordKind, update: (records: readonly LearningRecord[], held?: (workflow: string, digest: string) => boolean) => { records: readonly LearningRecordWrite[]; result: T } | { result: T }, options?: { readonly anyDigest?: string }): Promise<T>;
  /** Agent `agentId`'s ledger (learn/ledger.ts), in one read (one snapshot of both tables): every run's row its end
   *  recorded, oldest first, and every spend row. With `runIds`, those runs' rows alone and the spend rows they booked or
   *  that audit them (none for none). Written only beside a run's end and a heal of its cost (run-patch.ts recordLedger);
   *  a purge or a delete of the run takes its row and its spend. */
  ledger(agentId: string, runIds?: readonly string[]): Promise<{ rows: LedgerRow[]; spend: SpendRow[] }>;
  /** Agent `agentId`'s newest `limit` ledger rows on the `agent` path at a known cost, of runs before run `before` in
   *  runs.list's order (started_at, then id), on no named disk, neither imported nor archived, newest first: the money
   *  rule's by-hand side read past its window (store-reads/learning.ts pastRunsRead). One read. */
  byHandBefore(agentId: string, before: { readonly id: string; readonly startedAt: number }, limit: number): Promise<{ readonly id: string; readonly startedAt: number; readonly jobUsd: number }[]>;
}

/** A learning item: one line of the owner's notes (corrections.md), or one learned workflow's folder. */
export type LearningItemKind = "note" | "workflow";
/** What a version of an item was: a run's merge, or a person's change. */
export type LearningChangeKind = "learned" | "approved" | "edited" | "created" | "retired" | "restored";
/** One version of an item. A note's body is its line; a workflow's is JSON, its files by path. */
export interface LearningItem {
  readonly kind: LearningItemKind;
  readonly name: string;
  readonly version: number;
  /** Null: the item is gone at this version. */
  readonly body: string | null;
  /** The run whose text it is: a note's, the run whose merge wrote it, kept by a person's change of it (null: a
   *  person's own); a workflow's, its workflow.json's writer (`writers`). */
  readonly byRun: string | null;
  /** A workflow's writer of each of its files, by path: the run whose merge changed the file to its text (a merge that
   *  gives it unchanged, and a person's edit of it, keep the writer before; null: a person's own file). Null for a note. */
  readonly writers: Readonly<Record<string, string | null>> | null;
  readonly change: LearningChangeKind;
  readonly person: boolean;
  /** A note's place among the notes. */
  readonly pos: number;
  /** A workflow's digest (its workflow.json's), which its promotions and audits name. */
  readonly digest: string | null;
  readonly at: number;
}
/** One save: a version of the agent's learning. `id` is the version id a run's seed names. */
export interface LearningSave {
  readonly version: number;
  readonly id: string;
  readonly at: number;
  readonly by: LearningSaveBy;
  readonly reason: string;
  /** The paths the save changed, as the folder names them. */
  readonly files: readonly string[];
  readonly mergeKey: string | null;
}
/** Who saved: a run's merge (its round past the first), a person's change, or the host: the empty first save of a run's
 *  seed (`init`), or a purged run's save with its words gone (`purged`). */
export type LearningSaveBy = { readonly run: string; readonly round?: number } | { readonly person: Exclude<LearningChangeKind, "learned">; readonly file: string; readonly approved?: boolean } | { readonly host: "init" | "purged" };
/** The agent's learning at one save: the save, its live items, and the facts of every item version up to it. */
export interface LearningAt {
  readonly save: LearningSave;
  readonly items: readonly LearningItem[];
  readonly history: readonly Omit<LearningItem, "body">[];
}
export type LearningItemWrite = Omit<LearningItem, "version" | "at">;
export interface LearningSaveInput {
  /** The version the save was computed on (0 before the first). */
  readonly base: number;
  readonly by: Exclude<LearningSaveBy, { host: string }>;
  readonly reason: string;
  readonly files: readonly string[];
  readonly items: readonly LearningItemWrite[];
  /** A run's merge: one save per key, ever (a purge keeps the key taken). */
  readonly mergeKey?: string;
  /** A version id the agent's learning must still hold (a run's seed). */
  readonly seed?: string;
  /** The saves the write's text was read at (a run's seed, and each save its compile turn read a workflow at): refused
   *  as purged when a run's purge came after any of them (its host save, kind `purged`, is newer), since that purge
   *  rewrote what was read in place and the write can't be told apart from the purged run's bytes. */
  readonly readAt?: readonly string[];
}
export type LearningSaved =
  | { readonly saved: LearningSave }
  | { readonly stale: number }
  | { readonly refused: { readonly seed: string } }
  | { readonly purged: { readonly readAt: string } }
  | { readonly already: LearningSave };
export interface LearningDiff {
  readonly save: LearningSave;
  readonly parent: LearningSave | undefined;
  readonly items: readonly { readonly kind: LearningItemKind; readonly name: string; readonly before: string | null; readonly after: string | null }[];
}
export type LearningRecordKind = "promotion" | "grade" | "audit";
export interface LearningRecord {
  readonly seq: number;
  readonly runId: string | null;
  readonly workflow: string | null;
  readonly digest: string | null;
  readonly data: unknown;
  readonly at: number;
}
export type LearningRecordWrite = Omit<LearningRecord, "seq" | "at"> & { readonly seq?: number };

/** One run's learning end as GET /usage's learning meter counts it (Learning.spend). */
export interface LearningSpend {
  readonly agentId: string;
  readonly at: number;
  readonly costUsd: number | null;
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
  /** What the command answers, JSON, written with its take (Store.answerOf reads it once). */
  readonly answer?: unknown;
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

/** A channel post as the store keeps it (store schema `channel_posts`): `body` its JSON text, byte for byte as it was
 *  given; `state` queued (still to send), sending, sent or dropped (given up, `reason` says why). */
export interface ChannelPostRow {
  readonly id: string;
  readonly channel: string;
  readonly runId: string | null;
  readonly moment: string;
  readonly body: string;
  readonly attempts: number;
  readonly nextAt: number;
  readonly state: "queued" | "sending" | "sent" | "dropped";
  readonly reason: string | null;
  /** Until when a sender's claim holds the post (state sending); null when none does. */
  readonly claimedUntil: number | null;
  /** The try whose claim took the post last, and whose settle may write it (Channels.settle's fence); null once a write
   *  outside every claim (a redelivery's landing, a drop, a start's release) took it from that try. */
  readonly claim: string | null;
  readonly createdAt: number;
}
/** One try of a channel's post (store schema `channel_attempts`): its HTTP status, or null when none came back. `tryId`
 *  names the try, once: a settle written again (its outcome unknown) logs it once. */
export interface ChannelAttemptRow {
  readonly tryId: string;
  readonly postId: string;
  readonly moment: string;
  readonly at: number;
  readonly statusCode: number | null;
  readonly latencyMs: number;
  readonly error: string | null;
  readonly retryAt: number | null;
  readonly redelivery: boolean;
}
/** What a channel was told of a run (store schema `channel_told`): a marker, and when. */
export interface ChannelToldRow {
  readonly runId: string;
  readonly marker: string;
  readonly at: number;
}

/** A channel's outbox (channel_posts), the tries of its posts (channel_attempts) and what it told each run
 *  (channel_told), for a channel the server sends itself (the outbound webhook). */
export interface Channels {
  /** Queues `post` (by its id: one already there is left as it is) and, in the same transaction, `told` (each marker of
   *  its run; `replacing`, a prefix, drops that run's markers with it first). Answers whether the post is new. */
  post(
    post: { id: string; channel: string; runId?: string | null; moment: string; body: string; nextAt: number },
    told?: { runId: string; marker: string; replacing?: string },
  ): Promise<boolean>;
  /** The post `id`, or undefined. */
  get(id: string): Promise<ChannelPostRow | undefined>;
  /** `channel`'s posts still to send (queued or sending), oldest first. */
  queued(channel: string): Promise<ChannelPostRow[]>;
  /** The post `id` claimed by the try `token` until `now + leaseMs` (state sending, `claim` the token), by
   *  compare-and-set: it is queued and due (`next_at` at or before `now`), or a claim on it ran out. The post as the claim
   *  took it, for the one caller that took it; undefined for any other at the same time, and for a post sent, dropped or
   *  held. */
  claim(id: string, now: number, leaseMs: number, token: string): Promise<ChannelPostRow | undefined>;
  /** Every claim on `channel`'s posts let go (sending back to queued, no try's claim): a server's start, when it is the
   *  store's one server and no try of an earlier one is still out. Answers how many. */
  release(channel: string): Promise<number>;
  /** A try's outcome: the post's new state (`to`, none for a try that leaves it as it is), with `attempt` added to its
   *  channel's tries in the same transaction, once by its tryId. Fenced by `claim`, the token of the claim that made the
   *  try: the state is written only while the post still holds that claim (compare-and-set), so a write that comes late,
   *  after a newer claim, a redelivery's landing or a drop, changes nothing; written again with the same fence (its
   *  outcome unknown), it writes the same row. With no `claim`, the state is written whatever holds the post, and the
   *  post's claim goes with it (a redelivery's landing: sent is final). Answers whether `to` was written; a try that
   *  wrote nothing is logged with no retry_at. The channel keeps its newest `kept` tries (50 by default), and of its sent
   *  or dropped posts only those a kept try names or `sending` lists (a try of it still in flight, which a redelivery may
   *  send again). */
  settle(
    id: string,
    to: { state: ChannelPostRow["state"]; attempts?: number; nextAt?: number; reason?: string | null } | undefined,
    attempt?: ChannelAttemptRow,
    options?: { kept?: number; sending?: readonly string[]; claim?: string },
  ): Promise<boolean>;
  /** Every queued or sending post of `channel` dropped, `reason` kept on each, no try's claim left on it: how many. */
  dropAll(channel: string, reason: string): Promise<number>;
  /** `channel`'s newest tries, newest first, at most `limit`. */
  attempts(channel: string, limit: number): Promise<ChannelAttemptRow[]>;
  /** What `channel` told: every run's markers, or `runId`'s. */
  told(channel: string, runId?: string): Promise<ChannelToldRow[]>;
  /** The told rows given go. */
  forget(channel: string, rows: readonly { runId: string; marker: string }[]): Promise<void>;
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
  /** Its package mark: the id of the template package whose apply made it or last kept it in place, which a later update
   *  of that package may remove once the package no longer lists it; null for one a person made, one a PATCH moved to
   *  another agent, and one made before the mark was kept. Written by the apply alone, never from an API body. */
  readonly templateId: string | null;
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
 *  for its key's day. `retryAt`: a due firing's next try; `waitsOn`: what a due firing waits behind for its trigger's
 *  room, a run's id, or a firing's key while the trigger has no run yet (triggers.ts busy).
 *  `startBy`: a firing its launch hook's host took with no run (sent), the time until which the host may still start
 *  its run (triggers.ts handedStart); null on any other. */
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
  readonly startBy: number | null;
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
  /** The package mark (TriggerRow.templateId) a template apply makes it with; none for a person's. */
  readonly templateId?: string | null;
}
/** A trigger's fields changed; the ones absent stay. */
/** `agentId`: the agent it belongs to, which follows its target (a PATCH may aim it at another agent's run or agent). */
/** A trigger update's options: a compare-and-set, written only while the row is still the read the patch was made from,
 *  undefined otherwise, as when there is no such trigger. `ifUpdatedAt`: the row's updatedAt is still this one.
 *  `ifSource`: its source is still this one, as the store keeps it; two writes in one millisecond share an updatedAt, so a
 *  write that must never land over another source write (a seal, an edit) gives both. */
/** `ifAgent`: it is still that agent's (a PATCH may move it to another meanwhile). */
export type TriggerUpdateOptions = { readonly ifUpdatedAt?: number; readonly ifSource?: unknown; readonly ifAgent?: string };
export type TriggerPatch = Partial<Pick<TriggerRow, "agentId" | "name" | "enabled" | "source" | "target" | "nextAt" | "catchupWindowS" | "failuresInARow" | "disabled" | "maxActiveRuns" | "templateId">>;
/** A firing's new state. Out of due, a firing keeps no retry, wait, payload, attrs (unless `keepAttrs`) nor the reason its
 *  last try gave (unless given), and no time but a sent firing's `startBy`. */
export interface FiringChange {
  readonly status?: FiringStatus;
  readonly runId?: string;
  readonly reason?: string | null;
  readonly error?: { code: string; message: string };
  readonly attempts?: number;
  readonly retryAt?: number | null;
  readonly waitsOn?: string | null;
  readonly notified?: boolean;
  /** Settled, the firing keeps its attrs: one its launch hook's host took with no run yet, whose run, started late
   *  (triggers.ts handedStart), is tagged and titled from them as one started first is. */
  readonly keepAttrs?: boolean;
  /** Settled `sent`: the time until which its launch hook's host may still start its run (FiringRow.startBy). It is kept
   *  in the firing's retry_at column, which only a due firing holds otherwise, and is never read back as a retry. Any
   *  other status keeps none. */
  readonly startBy?: number;
  /** Written only while the firing's status is this one, read in the settle's own transaction: a firing whose host's run
   *  started it meanwhile (triggers.ts handedRan) is left as it is, and nothing is written. */
  readonly from?: FiringStatus;
  /** Written only while the firing holds its trigger's room at this time (the triggers' clock): sent with no run, its
   *  startBy not passed. Read in the settle's own transaction: a host start that pushes a startBy out (triggers.ts
   *  handedStart) leaves a firing whose window closed, or whose run started, meanwhile as it is. */
  readonly holdsAt?: number;
  /** Written only while the firing is sent with no run and its startBy is still this one, read in the settle's own
   *  transaction: a host start that pushed a startBy out and wrote no run puts it back (triggers.ts handedStart), unless
   *  its run started, or another start moved it, meanwhile. */
  readonly startByWas?: number;
  /** Written only while the firing has no run, read in the settle's own transaction (with `from`, a firing's start by a
   *  run written apart from it, triggers.ts handedRan): one a release failed, or another run started, meanwhile is left
   *  as it is. */
  readonly noRun?: true;
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

/** A run of an agent being deleted, or a follow-up that would open one of its runs again: refused, nothing written. An
 *  agent another system owns is never archived here (its archive route is refused), so its archive time is the mark its
 *  delete leaves (DELETE /agents/{id}, agent-delete.ts): from that commit runs.create, runs.createInline, runs.reopen and
 *  triggers.fire refuse it, each in the transaction that would start the run, and a restart keeps the mark. */
export class AgentDeleting extends Error {
  override name = "AgentDeleting";
  constructor(readonly agentId: string) {
    super(`the agent ${agentId} is being deleted`);
  }
}

/** A write to a purged agent (Agents.purge): a revision, its current revision moved, its name or description, its archive,
 *  a run or a trigger of it. Refused, nothing written: its purge time is read under the agent row's lock, in the
 *  transaction that would write, so of a purge and such a write one commits first and the other sees it (the purge blanks
 *  what the write wrote, or the write is refused). A purged agent's row is its tombstone: nothing of it is written again. */
export class AgentPurged extends Error {
  override name = "AgentPurged";
  constructor(readonly agentId: string, readonly archivedAt: number | null, readonly purgedAt: number) {
    super(`the agent ${agentId} is purged`);
  }
}

/** An agent's removal refused while a trigger of it is left (Agents.remove): a trigger keeps things outside its row (its
 *  registration upstream, its adapter settings) that only the trigger engine removes, so its row never goes with the
 *  agent's. Nothing written. */
export class TriggersLeft extends Error {
  override name = "TriggersLeft";
  constructor(readonly agentId: string, readonly triggerIds: readonly string[]) {
    super(`agent ${agentId} still has triggers (${triggerIds.join(", ")}): each is removed first, by the trigger engine`);
  }
}

/** An inline-agent run whose body differs from the one already stored for its external reference and version: refused,
 *  nothing written (Runs.createInline). A version's body is immutable; a changed body needs a new version. */
export class ExternalBodyConflict extends Error {
  override name = "ExternalBodyConflict";
  constructor(readonly ref: string, readonly version: string) {
    super(`a different body is already stored for ${ref} version ${version}`);
  }
}

/** An agent's rows. Every write to an agent that exists (put, archive, addRevision, setCurrent; templates.upgrade; a run
 *  or a trigger of it) is refused once it is purged (AgentPurged), nothing written, and pinOnce writes no pin then. */
export interface Agents {
  /** Creates the agent, or renames it (name, description) when it exists. */
  put(agent: { id: string; name: string; description?: string | null }): Promise<void>;
  /** The agent row and its first revision, current, in one transaction: both or neither. `workspace`: the workspace a
   *  scoped request made it in (workspace-scope.ts), written with it; absent, none. */
  create(agent: { id: string; name: string; description?: string | null; workspace?: string }, firstRevision: NewRevision): Promise<void>;
  get(id: string): Promise<AgentRow | undefined>;
  /** The agent an external reference ("<source>:<kind>:<id>") maps to (Runs.createInline), or undefined before its first
   *  run. */
  byExternal(ref: string): Promise<AgentRow | undefined>;
  /** Whether the agent already has the revision that maps `version` of its owning system (one row looked up, no bodies read). */
  hasExternalVersion(agentId: string, version: string): Promise<boolean>;
  /** The revision that maps `version` of its owning system, or undefined before that version's first run. */
  externalRevision(agentId: string, version: string): Promise<RevisionRow | undefined>;
  /** The agents, by `archived` (default false). A purged agent (Agents.purge) only with `purged`: what a total counts. */
  list(options?: { archived?: boolean; purged?: boolean; workspace?: string }): Promise<AgentRow[]>;
  /** The agent's workspace (null: none, made unscoped), or undefined when there is no such agent. `workspace` given to
   *  `list`: only the agents in it. */
  workspace(id: string): Promise<string | null | undefined>;
  /** Puts the agent in `workspace` only while it is in none, and answers the workspace it is in after (`workspace` when it
   *  was put there or was there already; another when it was in that one, nothing written), or undefined when there is no
   *  such agent: an operator's backfill (workspace-backfill.ts). */
  adoptWorkspace(id: string, workspace: string): Promise<string | null | undefined>;
  /** Archives the agent, or unarchives it. Archived, every trigger of it that is on is turned off in the same transaction
   *  (`disabled` set to `why`, JSON; its scope rows dropped), and those are the answer: from its commit no firing starts a
   *  run of the agent (triggers.fire refuses it, AgentArchived), and none of its triggers is made on or turned on.
   *  Unarchived, none turns on again: the answer is empty. */
  archive(id: string, archived: boolean, why?: unknown): Promise<{ id: string; name: string }[]>;
  /** Adds a revision and makes it the agent's current one, in one commit. With `ifCurrent` (a revision id, or null for
   *  none), only while that is still the agent's current revision, compared in the same transaction under the agent row's
   *  lock: RevisionMoved, and nothing written, when another writer (this server's, or another server's on the same store)
   *  moved it first. `description` (a string, or null for none), when given, is the agent's new description, written in the
   *  same commit: a refused revision leaves it as it was. Absent, the description stays. `advance: false` appends a
   *  revision whose parent is current without moving current; the same guards and optional description still apply.
   *  `ifNoActiveRuns` refuses with ActiveRuns while any queued, running or parked run exists, checked under the agent
   *  lock. `settingsGuards` are locked first, then sorted `mcpGuards` registry rows, then the agent. Every guard must match before any revision or description is written. */
  addRevision(revision: NewRevision & { agentId: string; ifCurrent?: string | null; description?: string | null;
    advance?: false; ifNoActiveRuns?: true; settingsGuards?: readonly SettingsGuard[]; mcpGuards?: readonly McpGuard[] }): Promise<void>;
  /** Makes `revisionId`, one of the agent's own, its current one. StoreConstraint when it is not a revision of `agentId`. */
  setCurrent(agentId: string, revisionId: string): Promise<void>;
  revision(id: string): Promise<RevisionRow | undefined>;
  revisions(agentId: string): Promise<RevisionRow[]>;
  /** Pins a revision saved with no MCP pin (before pins were made at save) at its first run: `pin` is written only while
   *  the revision still has none, and the pin it has then is the answer, so two first runs at once agree on one. Null when
   *  there is no such revision, or its agent is purged (nothing written). */
  pinOnce(revisionId: string, pin: unknown): Promise<unknown>;
  /** The agent's own rows gone, in one transaction (the last write of DELETE /agents/{id}, agent-delete.ts): its learning
   *  rows and kept proposals, its sign-ins and their tombstones, its revisions and the agent. Only once it has no run and
   *  no trigger left (runs.remove and the trigger engine's remove each first): refused while a run is (StoreConstraint)
   *  or a trigger is (TriggersLeft), read under the agent row's lock, nothing written. An agent with no row is no write. */
  remove(agentId: string): Promise<void>;
  /** The last write of DELETE /agents/{id} for an archived agent made here (agent-delete.ts purgeAgent), in one
   *  transaction under the agent row's lock: its learning rows, its sign-ins and their tombstones, the answer a template
   *  apply kept naming it, its revisions' content (body, skills, package, note, pins) and its own name and description
   *  blanked, and its purge time set last. Only once each of its runs is purged (Runs.purge) and no trigger is left:
   *  refused while a run is not (StoreConstraint) or a trigger is (TriggersLeft), nothing written. Its row and its
   *  revisions' ids stay, so its runs' tombstones and every total over them read as before. In the same write, each
   *  uploaded package (`upload:<name>`, imported_templates) a revision of it was applied from is removed when no revision
   *  of another agent not purged (an archived one too) was, each read and removed holding its id; a package imported from
   *  GitHub stays. The server stops serving what it removed (template-import.ts dropRemovedUploads). An agent with no
   *  row, or one purged already, is no write. On SQLite, the scrub's marker first and a WAL checkpoint once it commits
   *  (Runs.purge). */
  purge(agentId: string): Promise<void>;
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
   *  (AgentArchived), and one made at all, off too, for an agent being deleted (AgentDeleting). */
  create(trigger: NewTrigger, scopes?: readonly TriggerScope[]): Promise<TriggerRow>;
  /** The fields given changed, `updatedAt` set: undefined when there is no such trigger. With `scopes`, its scope rows
   *  rewritten in the same transaction (none while it is off); a patch that turns it off drops them. One that leaves it
   *  on for an archived agent, turned on or moved there, is refused (AgentArchived), nothing written; one that turns it
   *  on, or moves it at all, to an agent being deleted, too (AgentDeleting). */
  update(id: string, patch: TriggerPatch, scopes?: readonly TriggerScope[], options?: TriggerUpdateOptions): Promise<TriggerRow | undefined>;
  /** The trigger, its scope rows and its firings gone: whether there was one to remove. With `ifAgent`, only while it is
   *  still that agent's, compared in the same statement: one moved to another agent is left, and the answer is false. */
  remove(id: string, options?: { readonly ifAgent?: string }): Promise<boolean>;
  /** Enables the trigger and writes its scope rows, in one transaction; refused for an archived agent's (AgentArchived). */
  enable(triggerId: string, scopes: readonly TriggerScope[]): Promise<void>;
  /** Disables the trigger (with why, JSON) and deletes its scope rows, in one transaction. */
  disable(triggerId: string, why?: unknown): Promise<void>;
  /** The firing starts a run: the queued run, the `started` firing that names it (the due firing's row, or a new one) and
   *  the trigger's last_run_id, with its failure streak reset, in one transaction; with `launch`, the run's launch row in
   *  that same transaction (the store's one writeLaunch). A run of an archived agent is refused in it (AgentArchived),
   *  nothing written: a firing claimed before the archive committed starts no run after it. Settings guards are locked
   *  before the agent, then the trigger. The locked trigger must still belong to the prepared run's agent.
   *  `expectedCurrent` is checked under the agent lock (RevisionMoved on mismatch), independently of revisionId. */
  fire(firing: Firing, run: { id: string; agentId: string; revisionId: string; expectedCurrent?: string | null;
    settingsGuards?: readonly SettingsGuard[] }, options?: { launch?: RunLaunchInput }): Promise<RunRow>;
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
   *  undefined when the firing is gone (its trigger deleted), or is no longer the change's `from`. `paused`: this failure
   *  turned the trigger off. */
  settle(triggerId: string, key: string, change: FiringChange, streak?: FiringStreak): Promise<{ firing: FiringRow; paused: boolean } | undefined>;
  /** Every due firing, and every failed one whose trigger.failed is not marked queued, oldest first. */
  pending(): Promise<FiringRow[]>;
  /** A message_run firing's message queued for run `runId` as a command row (its body's origin names the trigger), with
   *  the firing marked sent and the trigger's streak reset, in one transaction; unless the run already holds `bound.max`
   *  untaken command rows from this trigger, read in that same transaction: then the firing is skipped with
   *  `bound.reason` and nothing is queued. Undefined when the firing is gone or no longer due. A run that has ended takes no
   *  message (RunFinal, as command()), and nothing is written. */
  message(firing: { triggerId: string; key: string }, runId: string, command: { kind: string; body: unknown }, bound: { max: number; reason: string }): Promise<{ sent: true; commandId: number } | { skipped: string } | undefined>;
  /** Every due firing waiting for its trigger's room (waits_on), oldest first, each with whether the room is there at
   *  `now` (the triggers' clock): fewer of its trigger's runs in progress (activeKeys) than its max_active_runs, or no
   *  max_active_runs (cleared while the firing waited: the engine's own check decides). One read for all of them. */
  waiting(now: number): Promise<(FiringRow & { readonly free: boolean })[]>;
  /** The soonest next time of an enabled trigger, or null. */
  soonest(): Promise<number | null>;
  /** The keys of the trigger's firings in progress at `now` (the triggers' clock), in no order: started with a run not
   *  ended (a run reopened later does not count), or held, a firing its launch hook's host took with no run yet up to its
   *  startBy. max_active_runs counts them. */
  activeKeys(triggerId: string, now: number): Promise<string[]>;
  /** The newest of the trigger's firings that hold its room at `now` (taken by its launch hook's host with no run yet, its
   *  startBy not passed): its key, or undefined. */
  held(triggerId: string, now: number): Promise<string | undefined>;
  /** The history kept to `history` shown firings: older ones a sender's key names (manual, pushed) are kept for their day
   *  (shown 0), others removed; shown-0 rows past `dayMs` removed, then the oldest past `kept` of them. Never a due
   *  firing, a failure not yet told, a started firing whose run has not ended, nor a sent one whose startBy is not before
   *  `now` (the triggers' clock, which stamped it). Answers how many went past `kept`. */
  prune(triggerId: string, options: { history: number; dayMs: number; keepByKey: (by: string) => boolean; kept?: number; now: number }): Promise<number>;
}

export interface Runs {
  /** A queued run of `revisionId`, its row's only writer until a runner claims it. With `origin`, the origin row is written
   *  in the same transaction, so a retry under the same key finds this run (runOfOrigin); a key already used is refused
   *  (StoreConstraint), and nothing is written. With `launch`, its launch row is written in the same transaction too (all
   *  or nothing). A launch made from another run (its body's `replay.of`, `audit.of`) takes that run's row lock and
   *  reads it in the same transaction: made from a purged run, it is refused (RunPurged), nothing written.
   *  `expectedCurrent` checks the agent's current revision under its lock (RevisionMoved on mismatch); this is separate
   *  from the pinned revisionId. Settings guards are locked before the agent. Refusal writes no run, origin or launch.
   *  `startedAt` (ms) is when the run began, for one reported after it began elsewhere (a backend SDK run's
   *  `started_at`); absent, now. With `firing` (a launch hook's host starting the firing it was handed), that firing is
   *  started with the run in the same transaction, its trigger's last run and failure streak as a started firing's
   *  are, only while it has no run and is still due or sent with a start_by: any other (released, failed, settled) is
   *  refused (FiringMoved), and nothing is written. `workspace`: the run's own, written only when given. The server's
   *  start gives none: a run is its agent's workspace's (Runs.workspace), never the request's that started it. */
  create(run:{ id: string; agentId: string; revisionId: string; origin?: RunOrigin; labels?: RunLabels;
    expectedCurrent?: string | null; settingsGuards?: readonly SettingsGuard[]; startedAt?: number; firing?: { triggerId: string; key: string }; workspace?: string }, launch?: RunLaunchInput): Promise<RunRow>;
  /** A run whose agent is given inline and mapped to a source system by `agent.ref` and `revision.version`. In one
   *  transaction: the agent (one per `ref`, written on its first run, its name and description brought up to the version
   *  whose first use this is) and the revision (one per `version`, made current on its first use) are written or read, then
   *  the run, its origin and its launch. Idempotent — a later run under the same (`ref`, `version`) reuses that revision and
   *  changes nothing; a different body under an existing version is refused (ExternalBodyConflict), nothing written. The
   *  revision's `note` is kept by its first use, as an edit's note is; it is not part of its body. */
  createInline(input: {
    agent: { id: string; name: string; description?: string | null; ref: string };
    revision: { id: string; version: string; kind: string; body: unknown; skills?: unknown; note?: string; mcpPin?: unknown; monidPin?: MonidPinBody };
    run: { id: string; origin?: RunOrigin; labels?: RunLabels };
    launch: RunLaunchInput;
  }): Promise<RunRow>;
  get(id: string): Promise<RunRow | undefined>;
  /** The run's workspace: its own, else its agent's (null: neither has one), or undefined when there is no such run. A run
   *  started unscoped of an agent in a workspace is in that workspace. */
  workspace(id: string): Promise<string | null | undefined>;
  /** The run's launch row (the runner reads it at its claim; the server for views). StoreLaunchMissing when the run has
   *  none (it was not started with one), never a default. */
  launch(runId: string): Promise<RunLaunchRow>;
  /** Writes `learning` as run `runId`'s learning start, in place of the one its launch body named (the body's `learning`
   *  member; nothing else of the launch changes): a claim that read its seed again once its agent's open rounds ended
   *  (runner/learning-reseed.ts), before the run's spec reads its launch. Fenced by that claim (fence.ts claimFence):
   *  written only while the run's epoch is still `epoch` and its lease has not run out, else nothing (false: the claim
   *  was lost or lapsed). StoreLaunchMissing when the run has no launch. */
  reseedLearning(runId: string, learning: unknown, epoch: number): Promise<boolean>;
  /** The learning deadlines (ms) of those of `runIds` that are learning children (a check's replay run, an audit's shadow
   *  run): its launch's replay or audit `deadline_at` (run-launch.ts Replay.deadlineAt). One read for every id, projecting
   *  that member alone: what a runner reads for a whole batch of claims before any loop starts on them. A run that is no
   *  learning child, or has no launch row, is absent. */
  learningDeadlines(runIds: readonly string[]): Promise<Map<string, number>>;
  /** Only the immutable CLI accounting identity/turn and (when requested) SDK completion usage. Projects these JSON
   *  members in the database: no launch input, policy, sealed bytes, completion answer or replay events are returned.
   *  Undefined for an absent run; absent members stay undefined. Historical identity may be read without completion.
   *  An ordinary-store analytics read, not for Store.snapshot: PostgreSQL's specific NUL/surrogate extraction refusal falls back
   *  to JS parsing that row's text at the prior full-row cost (never sealed bytes); other database failures propagate. */
  usageMetadata(runId: string, options: { completion: boolean }): Promise<{
    cli: Readonly<Record<string, unknown>>; completionUsage?: unknown;
  } | undefined>;
  /** Source-project recovery fields in run/id order: committed terminal root entries, including an absent checkpoint
   *  for a placed run. A terminal placed run's latest actual claim with no terminal root entry follows its real rows
   *  with entryId:null and attemptEpoch, never an invented journal ID. Active/queued/parked and unclaimed runs gain no
   *  synthetic row. A real row's optional attemptEpoch is its owning claim, derived from persisted journal boundaries,
   *  never trusted from its receipt; absent attempt metadata cannot prove a placed receipt. A run may have reopened
   *  since an earlier terminal receipt; its immutable candidate remains discoverable and cannot conceal a later claimed
   *  attempt lacking its end. Purged content is excluded.
   *  Projects only named checkpoint fields; no model output, replay, input or sealed launch content. Ordinary-store
   *  scope: the PostgreSQL Unicode compatibility fallback cannot run inside an already failed snapshot transaction. */
  projectCheckpoints(filter: { agentId: string; runId?: string }): Promise<{ runId: string; revisionId: string; entryId: number | null; attemptEpoch?: number; checkpoint: unknown }[]>;
  /** The learning start (the launch body's `learning` member, as stored: undefined when the body names none) of every run of
   *  agent `agentId` (no built-in learning run's) that has a launch row, in one read: what an agent-wide read (its cost per
   *  run, its learning view) needs of its runs at once, never a read a run. Only that member is read: no run's input, no
   *  sealed bytes. A run with no launch row has no entry. */
  learningStarts(agentId: string): Promise<{ runId: string; learning: unknown }[]>;
  /** The ids of agent `agentId`'s runs started after `at` whose learning seed was read at or before it (the launch body's
   *  `learning.seededAt`): a reset's watermark (learn/compile.ts sinceReset). Reads that one number of the runs started
   *  after `at` alone. */
  seededBefore(agentId: string, at: number): Promise<string[]>;
  /** Newest first, at most `limit` (no limit: all). `archived` filters on the run's own archive time (true: archived,
   *  false: not); its agent's archive is read apart. A built-in learning run (one a kept learning names) is never listed. `labels`: only runs holding every one of these labels, key and value.
   *  `disk`: only the runs on that disk (RunRow.disk), null for the default disk's; not given, every disk's.
   *  A purged run (Runs.purge) only with `purged`: the readers of money and counts (usage, stats, analytics) and an
   *  import's read of the sessions it holds, never a reader of a run's content.
   *  `scope` selects, before the limit, the runs the Agent Factory shows, never an imported one: `active`, every
   *  execution still going (a resumable agentic stop and a built-in learning run included); `review`, unarchived ended
   *  escalations and failures. `before` is an exclusive keyset boundary in descending (startedAt, id) order. `workspace`:
   *  only the runs in it (Runs.workspace: the run's own, else its agent's). */
  list(filter: { agentId?: string; revisionId?: string; state?: RunState; archived?: boolean; labels?: RunLabels; disk?: string | null; limit?: number; purged?: boolean; scope?: "active" | "review"; before?: { startedAt: number; id: string }; workspace?: string }): Promise<RunRow[]>;
  /** A page of a runs list, in one read: newest first, `offset` rows on, at most `limit`, and whether more follow (`more`).
   *  Each with its listing as its row keeps it (RUN_LISTING_COLUMNS: null while none has been built), whether that is
   *  behind, and its agent's archive time. `archived` filters on the run's archive or its agent's (true: either; false:
   *  neither); `status` on the row's status (`list_status`: a settled run's from its row, in the write that settled it;
   *  another's from its listing); `going` keeps only runs still going whose listing is behind. A built-in learning run and
   *  an audit's shadow run are never listed. */
  listed(filter: ListedFilter): Promise<{ readonly rows: readonly ListedRun[]; readonly more: boolean }>;
  /** The listings of the runs `runIds`, in one read: each run there is that is not purged, with its listing as its row
   *  keeps it, its mark, whether it is behind and its agent's archive time, as `listed` gives them. Whatever the run
   *  otherwise: a built-in learning run and an audit's shadow run too, which the Agent Factory's active scope shows
   *  (`list`'s `scope`). In no order. */
  listings(runIds: readonly string[]): Promise<readonly (Pick<ListedRun, "agentArchivedAt" | "listing" | "listMark" | "behind"> & { readonly id: string })[]>;
  /** Agent `agentId`'s runs counted in one read (an agent's view): every run it has (`count`), and those still going
   *  (`live`: queued, running or parked, or an agentic run a person stopped, which a message continues). A built-in learning
   *  run and an audit's shadow run are none of them. */
  counts(agentId: string): Promise<{ readonly count: number; readonly live: number }>;
  /** Up to `limit` runs whose listing is behind, the runs no runner holds first, then newest first: built never, or before
   *  the latest write that moved what the run's view shows (listing_mark < list_mark), or built while a runner held it and
   *  that claim has run out on the store's clock, or past the time it goes stale by the clock (listing_until). `mark`:
   *  the run's list_mark now, the mark its listing is built at. `held`: a runner holds its claim now. `offset`: that many
   *  of them passed over first (those the caller chose not to build yet). */
  behind(options: { limit: number; offset?: number }): Promise<{ readonly id: string; readonly mark: number; readonly held: boolean }[]>;
  /** Writes run `runId`'s listing as built at `mark` (behind's or listed's, read before the build read the view): only
   *  while the row's list_mark is still `mark`. A write that moved the mark meanwhile (a run settled, its list_status set
   *  by that write) keeps the row as that write left it, behind, so the next build writes what the run shows now. True
   *  when it was written. */
  putListing(runId: string, mark: number, listing: RunListing): Promise<boolean>;
  /** Run `runId`'s list_mark now (the mark a build of its listing starts from), or undefined when there is no such run. */
  listMark(runId: string): Promise<number | undefined>;
  /** Moves the mark of every run whose listing read something outside the run (`flags`, RUN_LISTING_COLUMNS' listing_flags),
   *  of agent `agentId` when given: the server's keys changed, or an agent's learning did. The number of runs moved. */
  relist(options: { flags: number; agentId?: string }): Promise<number>;
  /** Writes `cost`, what its booking gives by the end's own rule (metrics.ts endCostOf: a figure, the most the run can
   *  have cost when `costUpperBound`), as ended run `runId`'s stored cost, as its end would have, only while that cost is
   *  still unknown (null, no bound) and the run is the end it was read at (`epoch`, `endedAt`): one conditional write, so a
   *  stored figure is never overwritten, a run reopened or ended again since keeps what its end wrote, and a second heal
   *  writes nothing. True when it was written. */
  healCost(runId: string, at: { readonly epoch: number; readonly endedAt: number }, cost: { readonly costUsd: number; readonly costUpperBound: boolean }): Promise<boolean>;
  /** Ended runs, not imported, whose stored cost is unknown (null, no bound), by id after `after`, at most `limit`: what
   *  the server's start sweep reads to heal (cost-heal.ts). Left out are those the heal's rule refuses by what the store
   *  holds alone: a person's stop of an agentic run, a native run, a run with no booked answer (sqlite/store.ts says
   *  which are kept, and why). */
  costUnknown(options: { limit: number; after?: string }): Promise<string[]>;
  /** Archives the run (its own archive time), or unarchives it: idempotent. */
  archive(runId: string, archived: boolean): Promise<void>;
  /** Every run of agent `agentId` with its state, oldest first, its built-in learning runs and purged runs included
   *  (which list leaves out): what deleting the agent stops and removes, with the runner that holds each (null: none),
   *  its purge time and its disk (RunRow.disk). */
  every(agentId: string): Promise<{ id: string; state: RunState; runner: string | null; purgedAt: number | null; disk: string | null }[]>;
  /** The runs made from run `runId` that hold what it was given or did, by id: each run whose launch replays its input
   *  (the launch body's `replay.of`) or audits it (`audit.of`: its audit's shadow run), and each learning run its kept
   *  learning names (learning_proposals' learning_run_id). What purging the run purges with it. */
  madeFrom(runId: string): Promise<string[]>;
  /** A run purged, in one transaction under its row's lock (DELETE /runs/{id}, agent-delete.ts): every row of its content
   *  gone or blanked, what names it let go, and its kept learning's rows kept with their proposal's state alone. Its row
   *  stays as a tombstone (id, agent, revision, state, outcome, times, cost, metrics with `kept` folded in), its purge
   *  time set last, which every total sums as before. Refused (StoreConstraint), nothing written, while it is not final
   *  or a runner holds it, and while a run made from it is not purged (RunsMadeFromLeft); Runs.create makes none under
   *  the same lock once it is purged. A run with no row, or purged already, is no write. On SQLite the scrub's marker
   *  comes first (one that can't be written, a full disk, throws with nothing purged), and a WAL checkpoint (TRUNCATE)
   *  follows the commit, so with secure_delete neither the file nor its WAL keeps the bytes; a checkpoint another
   *  connection holds back keeps the marker for the next start's scrub. Postgres keeps old row versions until its
   *  VACUUM. The run's learning rows go in the same transaction (Learning.purgeRun): its saves' words, its notes and
   *  workflow files, its records. */
  purge(runId: string, kept: PurgeKept): Promise<void>;
  /** The run's rows gone, in one transaction: its journal, commands, origin, launch, live view and viewers, its channel
   *  posts with their tries and what each channel was told of it, its kept learning, its changes in the run-change feed,
   *  a trigger's conversation that names it, and the run (a firing or trigger that names it keeps no run: ON DELETE SET
   *  NULL). Only a final run: one that is not is refused (StoreConstraint), nothing written, so no runner's claim is ever
   *  on a run that goes. A run with no row is no write. From then a late write under an old claim of it is Fenced and
   *  writes nothing (its row is gone), and a command for it is RunFinal. */
  remove(runId: string): Promise<void>;
  /** A person's follow-up to a run that ended completed, or that a person stopped: in one transaction, the run goes back to running with no runner
   *  (released, so a runner claims it at once by the claimable rule's released branch), its end's own fields cleared
   *  (ended_at, summary, outcome, its waits) and everything it did kept (its epoch, its journal, its cost and metrics,
   *  so its next turn is booked on top of what it spent), and `command` (the follow-up's steer) is written untaken for it.
   *  Only an agentic run that ended completed (state 'ended') or that a person stopped (state 'stopped', outcome
   *  'stopped'), not imported and not a learning run, reopens: a workflow, a failed or cancelled run, any other, or none
   *  is RunFinal, and nothing is written. With `endedAt`, only the run whose end is at that time (a grade's round opens
   *  the end it read, never a later one): any other is RunFinal too. */
  reopen(runId: string, command: { kind: string; body?: unknown }, options?: LaunchSealedWrite & { readonly endedAt?: number }): Promise<Command>;
  /** Wakes a parked run: its wake_at set to now on the deadlines' clock, so a runner claims it at its next poll (the
   *  claimable rule's wake branch) and its loop reads what it waits on again. True when the run was parked; a run in any
   *  other state (or none) is left as it is, false. Its claim, if one holds it while it parks, is let go as before: the
   *  release sets wake_at as the loop's end says. */
  wake(runId: string): Promise<boolean>;
  /** Ends `failed`, its summary `summary`, every run still queued that no runner ever claimed (epoch 0), each in a
   *  transaction of its own, as an end does: its untaken commands refused and its launch's secrets erased in the same
   *  write. A run a runner claimed (at any epoch since) is left as it is, and so is one a claim takes meanwhile: the
   *  write is fenced on epoch 0. Answers the runs it ended. What the server does with runs no runner here can claim
   *  (runner/presence.ts). */
  failUnclaimed(summary: string): Promise<string[]>;
  /** The runs a runner may claim, oldest first: queued; parked with an untaken command or its wake_at passed; running with
   *  no runner (released at a runner's shutdown: it stays running, a run that started keeps that fact) or its claim run
   *  out. A parked run whose computer is kept for another runner that is still there (its pin, KEPT_PREFIX) is that
   *  runner's alone: with `runner`, the claimer, such a run is left out; without it every run is counted. */
  claimable(options?: { limit?: number; runner?: string }): Promise<string[]>;
  /** The epoch a runner's claim holds run `runId` at now, judged by the store's own clock (the one claims are stamped
   *  and fenced by), never a reader's; undefined when no claim holds it (none, released, or run out) or there is no
   *  such run. */
  heldAt(runId: string): Promise<number | undefined>;
  /** The claims `runner` holds now (its name on the run's row, its lease not run out on the store's clock), each with the
   *  epoch it holds at: what a runner reads back when a claim or release commit was answered Unanswered, to learn
   *  whether it landed. `from` is "running" (the claim's own `from` is not kept). */
  claimsOf(runner: string): Promise<Claim[]>;
  /** Claims up to `k` claimable runs for `runner`, oldest first, in one transaction: each at its own epoch + 1, with its
   *  `from`. A runner fills its free loops with one call. */
  claimMany(runner: string, k: number, options?: { leaseMs?: number }): Promise<Claim[]>;
  /** Changes the run's row under `claim`, and in the same commit writes `also` and marks `take`'s command rows taken (a
   *  stop the runner applies itself ends the run with its stop row taken, or neither). Refused, nothing written: Fenced when
   *  the run's epoch is not the claim's; CommandTaken when a command in `take` is taken already, or not the run's. When the
   *  patch writes `signInHanded` (the runner's bind), the answer carries `save`: whether this run holds the sign-in's save
   *  lease, decided in this same transaction so two binds of one sign-in never both save — no other run holds a handed
   *  pointer, counting a running run and (within `signInSettleMs` of leaving running, a vendor's settle window) one that
   *  recently left running. `signInSettleMs` defaults to 0 (other vendors free the lease the instant a run leaves running). */
  update(claim: Claim, patch: RunPatch, rows?: { readonly also?: readonly AlsoRow[]; readonly take?: readonly number[]; readonly signInSettleMs?: number }): Promise<UpdatedRun>;
  /** The run changes after `cursor` (undefined: from the feed's start), oldest first, at most `limit` (default
   *  RUN_CHANGES_PAGE), and the cursor to read on from (`next`; the one given when nothing is new). A change is a run
   *  reaching a final state, or its runner letting it go (parked, or running with no runner), recorded by the write that
   *  made it, in that write's own transaction, with the row as that write left it.
   *
   *  The guarantee: every change is read exactly once by a reader that reads on from each `next` it was handed. None is
   *  skipped, even one committed after a change numbered above it was already read (concurrent writers): `next` never
   *  passes a change a transaction still in flight may yet commit (a watermark; a store with one writer commits in the
   *  order it numbers, so its watermark is its last change). None is read twice from a later cursor. The cursor is the
   *  store's own: never a time, so writes in one millisecond are each read. */
  changedSince(cursor: RunChangeCursor | undefined, options?: { limit?: number }): Promise<RunChanges>;
  /** The feed's head, in one read: the cursor a reader holds once it has read on until a page comes back empty, so one
   *  that starts here reads only the changes made after. It keeps changedSince's watermark: never past a change a
   *  transaction still in flight may yet commit. */
  changesHead(): Promise<RunChangeCursor>;
}

/** A position in the run-change feed (Runs.changedSince): opaque, the store's own; only one it handed back is valid. */
export type RunChangeCursor = string;

/** The most run changes one read returns unless asked for fewer. */
export const RUN_CHANGES_PAGE = 200;

/** A run change (Runs.changedSince): the run, and its row as the write that made the change left it. */
export interface RunChange {
  readonly id: string;
  readonly state: RunState;
  /** When it ended (ms): set for a final state, null otherwise. */
  readonly endedAt: number | null;
  readonly epoch: number;
  readonly runner: string | null;
}

/** One read of the run-change feed: its changes, oldest first, and the cursor to read on from. */
export interface RunChanges {
  readonly changes: readonly RunChange[];
  readonly next: RunChangeCursor;
}

/** A saved MCP server: its listed tools (each with whether it can be granted, and why not), the owner's prices, and its
 *  credential sealed (store/seal.ts): bytes the store never opens. `tools` and `prices` are JSON. */
export interface McpServerRow {
  readonly name: string;
  /** The row's key in the store when a view shows it under another name (a workspace's server, mcp-workspace.ts): its
   *  credential is sealed at that key. Absent on a row as the store reads it, whose name is its key. */
  readonly sealedAs?: string;
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
  /** Whether that lease has run out, judged by the store's own clock when the row was read: the clock leaseRefresh writes
   *  and grants it by. A reader judges the lease by this, never by its own clock against refreshUntil: on another machine
   *  its clock may run ahead of the store's, and a live lease would read as lapsed. False with no lease. */
  readonly refreshLapsed: boolean;
  /** How much of the credential's access token is left (ms; negative once run out), by the store's own clock when the row
   *  was read: the store stamps its end when the credential is written (token_until). A claim judges the token by this,
   *  never by its own clock against the set's expires_at, which the writer stamped on its clock. Null when the writer
   *  gave no measure of the token's life. */
  readonly tokenLeftMs: number | null;
  /** The token's end as the store stamped it (token_until), read in the same snapshot as `sealed`: the end of the very
   *  token the sealed set holds. A refresh by any claim moves it. Null as tokenLeftMs. */
  readonly tokenUntil: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When the tools were last listed (ms): a refresh moves this, not updatedAt, so a refresh is not read as an owner edit.
   *  Null for a row written before this column. */
  readonly listedAt: number | null;
  /** When the sealed credential was last set (ms): a new credential's save or a sign-in, never a token refresh. Null with
   *  no credential. */
  readonly credentialChangedAt: number | null;
}

/** A saved MCP server's stamp (Mcp.stamp): its url and auth, when its credential last changed (credentialChangedAt), and
 *  its access token's time left by the store's own clock (tokenLeftMs), as on its row. */
export interface McpServerStamp {
  readonly url: string;
  readonly auth: string;
  readonly credentialChangedAt: number | null;
  readonly tokenLeftMs: number | null;
  /** Its access token's end as the store stamped it (token_until, the store's clock): a refresh by any claim moves it, so a
   *  claim that opened the row at one end knows the token it holds is not the row's once this differs. */
  readonly tokenUntil: number | null;
}

/** A run's MCP pin: what it may call, per granted server (url, tools, prices), as its revision's save pinned it
 *  (RevisionRow.mcpPin); `pinnedAt` is when that revision was saved. */
export interface McpPinRow {
  readonly runId: string;
  readonly body: unknown;
  readonly pinnedAt: number;
}

/** The longest an MCP token refresh may take: two tries of 4 s each. The runner's claim step gives its call up by then. */
export const MCP_REFRESH_CALL_MS = 2 * 4_000;
/** The most one bounded store write may take, counted from its call: its wait behind its connection (SQLite's queue, a
 *  Postgres pool's connect), for the database's lock, its statement and its commit (keepRefreshed's on both stores). */
export const STORE_WRITE_DEADLINE_MS = 10_000;
/** A refresh lease's length by default: it covers the holder's whole custody of the refresh token, the refresh call
 *  (MCP_REFRESH_CALL_MS) and then the keep of its new set (STORE_WRITE_DEADLINE_MS, from the keep's call), with 2 s to
 *  spare (a Postgres commit sent at the deadline is given 1 s of it to answer). A lease shorter than both lapses while a
 *  slow commit is still landing a set whose token the provider already spent, and a waiter then takes over and refreshes
 *  with the spent one. Made from the two bounds so it cannot drift. */
export const MCP_REFRESH_LEASE_MS = MCP_REFRESH_CALL_MS + STORE_WRITE_DEADLINE_MS + 2_000;

/** A saved server's credential as a writer read it: its auth type, whether one is sealed, and when that was set (a token
 *  refresh keeps the time; a new credential or a sign-in moves it). Null: no server by that name. */
export type McpCredentialMark = { readonly auth: string; readonly sealed: boolean; readonly changedAt: number | null } | null;

/** The row a removal deleted, as the statement that deleted it saw it: the address and the sealed credential as they were
 *  at that instant (a token refresh landing earlier is in it, one landing later finds no row to keep). */
export type McpRemoved = { readonly url: string; readonly sealed: Uint8Array | null };

/** The fields of a server's write (Mcp.put). */
export type McpServerWrite = { name: string; url: string; auth: string; protocol?: string | null; tools: unknown; prices?: unknown; serverInfo?: unknown; instructions?: string | null; sealed?: Uint8Array | null; listedAt?: number; updatedAt?: number; credentialChangedAt?: number | null; tokenLeftMs?: number | null };

/** The API token's mark a write over a saved server's row needs, compared in the statement that writes or removes the row:
 *  the setting at `record` (the server's source record, mcp-sources.ts) still says `by: "token"` for that very row (its
 *  `of` is the row's created_at). An owner's save drops the mark in the transaction that writes its row (McpOwnersMark),
 *  so a write that needs the mark never lands over the owner's save, whenever that save lands. The write that needs it
 *  takes the server's lock first, so on Postgres its statement reads the record as the owner's committed transaction left
 *  it. `made`: the token's first save of the name, whose record (`made` of the row written) is written at `record` in the
 *  transaction that writes the row, so no reader ever finds the token's new row without its mark. */
export type McpTokensMark = { readonly record: string; readonly made?: (row: { createdAt: number }) => unknown };

/** The owner's write over a saved server's row: in the transaction that writes the row, and only once the row is written,
 *  the setting at `record` (the server's source record) loses the API token's mark (`by`) when it still says the token
 *  saved that very row. A write refused (no row) leaves the record as it was, so a refused owner's save never takes the
 *  server from the token; one that lands makes it the owner's with no moment between its row and its record. */
export type McpOwnersMark = { readonly record: string };

/** A row as a rewrite read it (Mcp.rewrite): its sealed credential, its address, its auth type and its last edit
 *  (updatedAt). The rewrite lands only while the row still has all four, so it never writes back anything it read (an
 *  address, an auth type, prices) over a save made since, even one that kept the address, auth type and credential. Every
 *  save moves updatedAt past the row's own, even within its millisecond; a write that passes updatedAt (a refresh) keeps
 *  the one it read. */
export type McpRewriteSeen = { readonly sealed: Uint8Array | null; readonly url: string; readonly auth: string; readonly updatedAt: number };

export interface Mcp {
  /** The server's write: the server's row, inserted or replaced by name (its first save's time kept). An owner's save
   *  clears any refresh lease and changes the credential, so a refresh in flight is dropped (keepRefreshed's `kept: false`)
   *  and never overwrites it. `tokenLeftMs`: the writer's measure of the credential's access token's remaining life (a
   *  duration, on its own clock); the store stamps the token's end on its clock from it (token_until), none without it. */
  put(server: McpServerWrite): Promise<McpServerRow>;
  /** put(), only while the server's credential is still `expected` (its mark as the writer read it; null: no server by
   *  that name), compared and written in one statement: no other write lands between. Undefined, writing nothing, when
   *  it is not. `tokens`: the API token's write over a saved row, which lands only while the row still carries the
   *  token's mark (McpTokensMark), in the same statement. `owns`: the owner's write, which drops the token's mark in the
   *  same transaction once the row is written (McpOwnersMark). */
  putIfCredential(server: McpServerWrite, expected: McpCredentialMark, tokens?: McpTokensMark, owns?: McpOwnersMark): Promise<McpServerRow | undefined>;
  /** A rewrite of a row it read, its credential kept as it is (a tools refresh, a save that sends no new credential): the
   *  listing, prices, url and times written by a compare-and-set on the row as `seen` (McpRewriteSeen), iff the row is
   *  still saved, its sealed value is still the one read, it is still at the address and of the auth type read, and no
   *  save has edited it since (its updated_at the one read). The credential's columns (sealed, token_until,
   *  credential_changed_at) and any refresh lease are left as they are, so a runner's refresh in flight still keeps its
   *  set. undefined, writing nothing, when the credential changed meanwhile (a refresh kept a rotated set), a save landed
   *  (one with no credential leaves the sealed column as it was, and may keep the address and auth type too), or the row
   *  went: the caller reads it again and re-applies its change onto the fresh row while it still holds, a bounded few
   *  times. `owns`: as putIfCredential's, the token's mark dropped in the same transaction once the row is written. */
  rewrite(server: { name: string; url: string; auth: string; protocol?: string | null; tools: unknown; prices?: unknown; serverInfo?: unknown; instructions?: string | null; listedAt?: number; updatedAt?: number }, seen: McpRewriteSeen, owns?: McpOwnersMark): Promise<McpServerRow | undefined>;
  /** Deletes the row, answering what it held as it went (McpRemoved); undefined when there was none. */
  remove(name: string): Promise<McpRemoved | undefined>;
  /** remove(), only while the server's credential is still `expected` (its mark as the remover read it), compared and
   *  deleted in one statement. Undefined, deleting nothing, when it is not (or the server is gone). `tokens`: the API
   *  token's removal, which lands only while the row still carries the token's mark (McpTokensMark), in the same
   *  statement. */
  removeIfCredential(name: string, expected: NonNullable<McpCredentialMark>, tokens?: McpTokensMark): Promise<McpRemoved | undefined>;
  /** The registry's rows, by name. */
  servers(): Promise<McpServerRow[]>;
  server(name: string): Promise<McpServerRow | undefined>;
  /** The server's stamp, read cheaply (no tools, no sealed bytes): what a claimed run checks before each call
   *  (runner/mcp-claim.ts) to see its credential removed, replaced or moved, or its access token near its end. Undefined
   *  when it is no longer saved. */
  stamp(name: string): Promise<McpServerStamp | undefined>;
  /** The run's pin: its revision's, as the revision's save made it; none for a run whose revision grants no MCP tool. */
  pin(runId: string): Promise<McpPinRow | undefined>;
  /** One refresh at a time per server (a provider that rotates refresh tokens spends the old one at each refresh): the lease
   *  is granted to `holder` for `ms` (MCP_REFRESH_LEASE_MS by default) only while the credential is still the one it read
   *  (`seen`: the sealed bytes, null for none) and no live lease is held. Not granted: the current row comes back, and the
   *  caller waits for the holder's set (re-reading) or the lease's end. A lease whose holder died runs out; the next claim
   *  may take it. `ms` must be longer than the refresh call's own deadline (MCP_REFRESH_CALL_MS: the holder gives its call
   *  up by then), so a lease never lapses while its holder's call may still spend the token; a shorter one is refused. */
  leaseRefresh(name: string, lease: { seen: Uint8Array | null; holder: string; ms?: number }): Promise<{ leased: boolean; row: McpServerRow }>;
  /** A refresh's new credential, kept by a compare-and-set on the CREDENTIAL in one statement: written iff the server's
   *  sealed value is still `seen` (the one the refresh started from, its lease's), whoever holds the lease now, so a
   *  token already spent at the provider is never lost to a lease that lapsed; the lease cleared only when `holder` still
   *  holds it. `kept: false` (nothing written) when the credential changed meanwhile (a newer set landed, or the owner saved
   *  one): ours is dropped, and no refresh is tried again with any token. Under one deadline from its call
   *  (STORE_WRITE_DEADLINE_MS). `row`: the server as it is after, undefined when it is no longer saved. */
  keepRefreshed(name: string, keep: { seen: Uint8Array | null; sealed: Uint8Array; holder: string; tokenLeftMs?: number | null }): Promise<{ kept: boolean; row: McpServerRow | undefined }>;
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
  /** Saves `value` under `key` only when the key has no row yet; the value saved after (this one, or the one there before).
   *  With `capacity`, count and insert share a namespace lock and transaction across store handles. Every raw key under
   *  the exact prefix counts, without decoding values. An existing key wins even at capacity; undefined means a new key
   *  was refused. The nonempty prefix must contain the key, and limit must be a positive safe integer. With `claim`,
   *  holds the run's shared row lock and checks its epoch/lease in the same transaction as the insert, as replaceIf
   *  does: a stale claim throws Fenced and nothing is written. */
  putIfAbsent(key: string, value: unknown, capacity?: { readonly prefix: string; readonly limit: number }, claim?: Claim): Promise<unknown>;
  /** Saves `value` under `key` only while its row still holds `was` (as get read it), in one statement: a compare-and-set,
   *  so of two writers that read one row only one replaces it. True when it was replaced; false, with nothing written,
   *  when the row changed since or is gone. With `claim`, holds the run's shared row lock and checks its epoch/lease in
   *  the same transaction as the setting update; a stale claim throws Fenced without changing the setting.
   *  With source guards, lock their keys and this destination key in sorted order, compare the guards, then perform
   *  the same CAS. A changed/missing guard refuses the transaction; a stale destination still answers false. */
  replaceIf(key: string, was: unknown, value: unknown, claim?: Claim, guards?: readonly SettingsGuard[]): Promise<boolean>;
  /** The key's row goes only while it still holds `was`, in one statement: true when it went. */
  removeIf(key: string, was: unknown): Promise<boolean>;
  /** The key's row goes; a key with no row is left as it is. */
  remove(key: string): Promise<void>;
  /** Settings by key, optionally selecting a namespace and native connector owner before values are read. */
  all(filter?: { readonly prefix: string; readonly connectorId?: string }): Promise<SettingRow[]>;
}

/** A sealed key as a row (store schema `sealed_keys`): its name and the bytes the server sealed (store/seal.ts, AAD
 *  sealed_keys|<name>|sealed), which the store never opens. */
export interface SealedKeyRow {
  readonly name: string;
  readonly sealed: Uint8Array;
  readonly updatedAt: number;
}

/** The tables the store keeps a sealed value in: each a plane of the server's secrets. */
export type SealedPlane = "sealed_keys" | "mcp_servers" | "mcp_oauth_pending" | "trigger_settings" | "sign_ins" | "sign_in_tombstones" | "computer_viewers" | "run_launch";

/** One sealed value the store keeps: its plane, where in it (its row's key, by column), the AAD it was sealed under (the
 *  store's documented one for that table: store/seal.ts aadOf, or trigger_settings|<adapter>|<scope>|<field>), and its
 *  sealed bytes. The store never opens it. */
export interface SealedSecretRow {
  readonly plane: SealedPlane;
  readonly where: Readonly<Record<string, string>>;
  readonly aad: string;
  readonly sealed: Uint8Array;
}

/** Every sealed value the store keeps, across all its planes, in one read: what a runner's redaction set holds at each
 *  claim (runner/store-secrets.ts), so a run's text that quotes any secret the server keeps is cut when it is written. */
export interface SealedSecrets {
  all(): Promise<SealedSecretRow[]>;
}

export interface SealedKeys {
  /** The sealed bytes saved under `name`, or undefined when none is. */
  get(name: string): Promise<Uint8Array | undefined>;
  /** Saves `sealed` under `name`, inserted or replaced in place. */
  put(name: string, sealed: Uint8Array): Promise<void>;
  /** Saves `sealed` under `name` only where no row is, in one statement: of two writers racing on one name, one's bytes
   *  are kept. True when it was written; false, writing nothing, when a row was there. */
  putIfAbsent(name: string, sealed: Uint8Array): Promise<boolean>;
  /** Saves `sealed` under `name` only while its row still holds `was` (the bytes as get read them), in one statement: a
   *  compare-and-set, so of two writers that read one row only one replaces it. Each seal is fresh bytes, so a row any
   *  writer saved since reads as changed. True when it was replaced; false, writing nothing, when it changed or is gone. */
  replaceIf(name: string, was: Uint8Array, sealed: Uint8Array): Promise<boolean>;
  /** The key's row goes. */
  remove(name: string): Promise<void>;
  /** The key's row goes only while it still holds `was` (the bytes as get read them), in one statement: true when it
   *  went; false, removing nothing, when it changed since or is gone. */
  removeIf(name: string, was: Uint8Array): Promise<boolean>;
  /** The deadlines' clock now, in ms: the database's on Postgres, the store's own on SQLite (fence.ts storeNow). A lease
   *  kept inside a sealed key's bytes (the ChatGPT sign-in's renewal) is stamped and judged by it, so every process
   *  sharing the store judges it by one clock, whatever its own says. */
  clock(): Promise<number>;
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

/** One computer a run's claim made through its provider (store schema `computer_intervals`): by the provider's own id
 *  for it (`providerId`), what its create asked for (null where it asked none), when it was made, whether the run's park
 *  kept it past its claim, and when the provider's delete of it answered ok (`endedAt`; null while none did). */
export interface ComputerIntervalRow {
  readonly runId: string;
  /** The provider's id in this server's registry (its setting's provider: "docker", "e2b", ...). */
  readonly provider: string;
  /** The provider's own id for the computer: what its invoice and console name it by. */
  readonly providerId: string;
  /** sandbox, desktop or phone; null when not known. */
  readonly kind: string | null;
  readonly gpuType: string | null;
  readonly gpuCount: number | null;
  readonly cpus: number | null;
  readonly memoryMb: number | null;
  /** Its disk in GB, where its provider said it; null else. */
  readonly diskGb: number | null;
  readonly startedAt: number;
  readonly kept: boolean;
  readonly endedAt: number | null;
  /** How much of its time a claim of its run booked on the run's ledger (compute-cost.ts), in ms; 0 for none. */
  readonly bookedMs: number;
}

/** Each computer a run made, from its create to its proven delete: how long it lived for its run, and one left running
 *  after its run (no `endedAt`). Every write is idempotent. */
export interface ComputerIntervals {
  /** The computer's row, made: a second call for the same provider and id changes nothing (a retried create answers the
   *  computer it made). */
  opened(row: Omit<ComputerIntervalRow, "kept" | "endedAt" | "bookedMs">): Promise<void>;
  /** The computer was kept past its claim (the run's park). */
  kept(provider: string, providerId: string): Promise<void>;
  /** The provider's delete of the computer answered ok at `at`: its end, written only while none is (a later delete of
   *  one already ended never moves it). A computer with no row is left without one. */
  ended(provider: string, providerId: string, at: number): Promise<void>;
  /** A claim booked `ms` more of the computer's time on its run's ledger: added to its booked time (a figure that is not
   *  a whole number of ms above 0 adds nothing). A computer with no row is left without one. */
  booked(provider: string, providerId: string, ms: number): Promise<void>;
  /** The run's computers, by when each was made. */
  forRun(runId: string): Promise<ComputerIntervalRow[]>;
}

/** The labels of the sessions a provider runs with none of its own (a phone provider's), so its list, an attach by
 *  labels and the janitor outlive a restart. */
export interface ComputerLedger {
  /** Saves `labels` and `detail` for `provider`'s session `sessionId`, inserted or replaced in place. */
  put(provider: string, sessionId: string, labels: Readonly<Record<string, string>>, detail: Readonly<Record<string, unknown>>): Promise<void>;
  /** Saves `labels` and `detail` for the session only while no row is kept for it, in one statement (two writers never
   *  both claim it): true when it was saved; false, with nothing written, when a row was there. */
  claim(provider: string, sessionId: string, labels: Readonly<Record<string, string>>, detail: Readonly<Record<string, unknown>>): Promise<boolean>;
  /** The session's row, or undefined when none is kept. */
  get(provider: string, sessionId: string): Promise<ComputerLedgerRow | undefined>;
  /** Every session of `provider`, by its id. */
  list(provider: string): Promise<ComputerLedgerRow[]>;
  /** The session's row goes. */
  remove(provider: string, sessionId: string): Promise<void>;
  /** Replaces the session's `labels` and `detail` only while its row still holds `was`'s, in one statement (a
   *  compare-and-set, so two writers that read one row never both write it): true when it was replaced; false, with
   *  nothing written, when the row changed since or is gone. */
  swap(provider: string, sessionId: string, was: { readonly labels: Readonly<Record<string, string>>; readonly detail: Readonly<Record<string, unknown>> }, labels: Readonly<Record<string, string>>, detail: Readonly<Record<string, unknown>>): Promise<boolean>;
}

/** A person's own machine paired with this server (spec/computer/attach.md, store schema `paired_computers`): its driver
 *  dials the attach socket with the token pairing gave it, of which the store keeps only the SHA-256. */
export interface PairedComputerRow {
  readonly id: string;
  /** What the person calls it. */
  readonly name: string;
  /** Its driver's last hello: at pairing, then each socket's (kind, os, groups, features). Kind and os stay what it
   *  paired as, since a socket that says others is refused at hello; groups follow its driver, so an updated driver's
   *  new groups serve the kinds they make. */
  readonly hello: Readonly<Record<string, unknown>>;
  /** The driver build its last hello named. */
  readonly driver: string;
  readonly labels: Readonly<Record<string, string>>;
  /** The pairing (addCode's id) whose code made it. */
  readonly pairingId: string;
  readonly createdAt: number;
  /** When its last socket said hello; null before its first. */
  readonly seenAt: number | null;
  /** When it was removed: its token no longer dials. Null while it is paired. */
  readonly revokedAt: number | null;
}

/** What pairing records for a new computer: its row's own fields, and its token's SHA-256. */
export interface NewPairedComputer {
  readonly id: string;
  readonly name: string;
  readonly hello: Readonly<Record<string, unknown>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly tokenSha256: string;
}

/** Paired computers and the pairing codes that make them (store schema `paired_computers`, `pairing_codes`). A code is
 *  kept by its SHA-256 alone, good once until its expiry; a computer by its token's SHA-256. */
export interface PairedComputers {
  /** Keeps a new code's SHA-256 until `expiresAt`, under the pairing `id` the computer it makes keeps. Codes past their
   *  expiry go in the same write. */
  addCode(id: string, codeSha256: string, expiresAt: number): Promise<void>;
  /** Burns the code and records `computer`, in one transaction: false, with nothing written, when no unexpired code has
   *  that SHA-256 (wrong, used or expired alike). */
  pair(codeSha256: string, computer: NewPairedComputer): Promise<boolean>;
  /** The computer's row, removed or not; undefined when no computer has that id. */
  get(id: string): Promise<PairedComputerRow | undefined>;
  /** The paired (not removed) computer whose token has this SHA-256. */
  byToken(tokenSha256: string): Promise<PairedComputerRow | undefined>;
  /** Every paired computer not removed, oldest first. */
  list(): Promise<PairedComputerRow[]>;
  /** A socket of the computer said `hello` now: kept as its hello, and its build (`hello.version`) as its driver. */
  seen(id: string, hello: Readonly<Record<string, unknown>>): Promise<void>;
  /** Removes the computer: its token dials no more. False when it was not paired (unknown, or removed already). */
  revoke(id: string): Promise<boolean>;
}

/** A hosted machine's minted token (store schema `minted_tokens`): what the machine must say it is at hello, and the
 *  token's life. The token is not here: the store keeps its SHA-256 alone. */
export interface MintedTokenRow {
  /** The machine's name (from its create's request id): its id in the attach hub. */
  readonly machine: string;
  readonly kind: string;
  readonly os: string;
  readonly arch: string;
  /** When the token ends: the machine's backstop. */
  readonly expiresAt: number;
  /** When it was revoked (the machine's delete); null while it is good. */
  readonly revokedAt: number | null;
  readonly createdAt: number;
  /** The runner in a process of its own that minted it, whose attach listener takes the machine's socket (dial-relay.ts),
   *  and that runner's incarnation then; both null for a token the server's own process minted. */
  readonly runner: string | null;
  readonly incarnation: string | null;
  /** The run the machine works for, as its create named it: what the words about its dial say. Null for a machine of
   *  no run. */
  readonly run: string | null;
  /** Why the server refused to relay this token's dial to the runner that minted it (computer-attach.ts relayDial), in
   *  the words its 503 said, which name the run and the machine and never the token; null while none was refused. The
   *  runner's create reads it (MachineTokens.refused) and ends its wait in these words. */
  readonly refused: string | null;
}

/** The tokens minted for hosted machines that dial this server (a dial provider's create, spec/computer/attach.md). */
export interface MintedTokens {
  /** Keeps the token's SHA-256 for `machine`, replacing one minted for it before. Rows past their end go in the same write.
   *  `runner` and `incarnation`: a runner in a process of its own minting it (dial-relay.ts); `run`: the run its machine
   *  works for. */
  mint(token: Pick<MintedTokenRow, "machine" | "kind" | "os" | "arch" | "expiresAt"> & { readonly tokenSha256: string; readonly runner?: string; readonly incarnation?: string; readonly run?: string }): Promise<void>;  /** The row whose token has this SHA-256, while it is good: neither revoked nor past its end. */
  byToken(tokenSha256: string): Promise<MintedTokenRow | undefined>;
  /** The machine's row, good or not; undefined when it has none (never minted, or gone past its end). */
  get(machine: string): Promise<MintedTokenRow | undefined>;
  /** Revokes the machine's token. False when it had none good. */
  revoke(machine: string): Promise<boolean>;
  /** Keeps `words` as why the dial of the token with this SHA-256 was refused (its row's `refused`); a mint again for
   *  its machine clears it. Nothing when no row has that token. */
  refuse(tokenSha256: string, words: string): Promise<void>;
}

/** A runner's word that it is there (store schema `runners`, runner/presence.ts): its name, its incarnation (its process
 *  since its start: the one its relay's minted tokens and proofs name), why it refused to claim any run (its words; null
 *  for one that claims), where its relay's attach listener takes the dials the server relays to it (dial-relay.ts; null
 *  for a runner with no relay) and when it last said it was there. */
export interface RunnerRow {
  readonly runner: string;
  readonly incarnation: string;
  readonly refused: string | null;
  /** The host the server reaches its relay at: loopback, or the runner's live host (live-reach.ts). Null with no relay. */
  readonly host: string | null;
  readonly port: number | null;
  readonly seenAt: number;
  /** The runner's build (the serve package's version), and the most runs it holds at once (its loops): each null on a
   *  row a runner of an earlier build wrote, or one that said neither (a refusing runner says no slots). */
  readonly version: string | null;
  readonly slots: number | null;
  /** The store's schema version the runner's build knows (Runners.knows, which keepPresence writes): null on a row a
   *  runner of a build before this column wrote. A live row whose `knows` is null or below the store's runner floor is a
   *  runner of an earlier build, which holds the reopened runs' mark, as its claims do once a later build's runner took
   *  its name (run-patch.ts backfillLedger). Not the package
   *  version, which a build says the same before and after a breaking change until its release. */
  readonly knows: number | null;
}

/** The store's runs and hand-backs as the capacity read counts them (GET /v2/capacity, capacity.ts), on the deadlines'
 *  clock (fence.ts storeNow), read once for the whole answer. Counts and runner names only. */
export interface RunCapacity {
  /** The deadlines' clock when it was read. */
  readonly at: number;
  /** Runs a runner may claim now, by the claim's own rule (queued; handed back or its claim run out, past any backoff; a
   *  parked run something wakes). */
  readonly queued: number;
  /** Runs a claim holds now (its lease not run out), by the runner that holds them. */
  readonly held: ReadonlyMap<string, number>;
  /** The hand-backs (hand_backs) within the window asked for. */
  readonly handBacks: number;
}

/** How long a runner's row is kept once it stopped saying it is there (a runner that died without its close): its next
 *  put removes every row older than this. */
export const RUNNER_ROWS_KEPT_MS = 24 * 60 * 60_000;

/** How old a runner's row can be and still count as there, on the store's clock: three of its renewals missed
 *  (runner/presence.ts PRESENCE_RENEW_MS). Every reader of who is there uses it, the claim rule's kept computer pin
 *  included. */
export const RUNNER_STALE_MS = 30_000;

/** The settings key prefix of the computers kept at a run's park, one row per run (workspace/computer-kept.ts). A row
 *  whose computer is pinned to the runner that kept it (its `runner` and `incarnation`) holds the run for that runner in
 *  the claim rule, while that runner is there under that incarnation and the keep lasts.
 *
 *  "There", for a pinned row's runner, means one thing everywhere: its runners row seen within RUNNER_STALE_MS on the
 *  store's clock, under the incarnation the row names, refusing claims or not. That runner holds the machine: no other
 *  runner's janitor ends its row (computer-kept.ts heldElsewhere, in sweepKept), and a claim that took the row and could
 *  not reach the machine puts the row back (computer-for-claim.ts reattach), so that runner's own end finds it.
 *  The claim rule (sqlite/store.ts keptElsewhere) alone asks one thing more, that it is claiming (`refused` null): a
 *  refusing runner would make the answer wait the whole keep for nothing, and its row is given back marked ending, so it
 *  still ends its machine. */
export const KEPT_PREFIX = "computer_kept:";

/** Every runner's word that it is there (runner/presence.ts). */
export interface Runners {
  /** The store's schema version this build knows (its newest migration on Postgres, SCHEMA_VERSION on SQLite: what a
   *  runner's open checks the store against), which keepPresence says on each row it keeps (RunnerRow.knows). */
  readonly knows: number;
  /** Keeps `row` for its runner, replacing any earlier incarnation's, seen now; rows no runner renewed for
   *  RUNNER_ROWS_KEPT_MS go in the same write. Its host and port go together: both absent (or null) for no relay. With
   *  `unlessLiveMs`, not over another incarnation's row of the same name seen within that: a process's put again of a row
   *  that went (pruned, a store restored) never takes back a later process's live one. False when such a row is there and
   *  nothing was written. */
  put(row: Omit<RunnerRow, "seenAt" | "host" | "port" | "version" | "slots" | "knows"> & { readonly host?: string | null; readonly port?: number | null; readonly version?: string | null; readonly slots?: number | null; readonly knows?: number | null }, options?: { readonly unlessLiveMs?: number }): Promise<boolean>;
  /** Marks the runner's row seen now and says on it where its relay answers (`at`, or null for nowhere), while the row is
   *  still this incarnation's. False when it is not (or there is none), and nothing was written. */
  renew(runner: string, incarnation: string, at: { readonly host: string; readonly port: number } | null): Promise<boolean>;
  /** Every runner's row, by name. */
  list(): Promise<RunnerRow[]>;
  /** The rows seen within `staleMs`, by name. Every row's time (a put's, a seen's) and this "now" are the deadlines'
   *  clock (fence.ts storeNow: the database's on Postgres), never one process's: runners on other hosts are judged alike. */
  live(staleMs: number): Promise<RunnerRow[]>;
  /** The runner's row gone, while it is still this incarnation's. */
  remove(runner: string, incarnation: string): Promise<void>;
  /** The runs waiting for a runner and held by one, and the hand-backs within the last `windowMs` (RunCapacity). */
  capacity(windowMs: number): Promise<RunCapacity>;
}

/** The id prefix of a package uploaded whole (POST /v2/templates/import {files}): `upload:<name>`. */
export const UPLOAD_PREFIX = "upload:";

/** A template package imported from GitHub (store schema `imported_templates`, POST /v2/templates/import): its id
 *  (`github:<owner>/<repo>[/<path>]`), its source as given, the commit SHA read, its publisher (the GitHub account), and
 *  its files as they were read, by path, base64. An uploaded one's id and source are `upload:<name>`, its sha the
 *  package's sha256, its publisher empty; it goes with the last agent applied from it (Agents.purge). The server checks
 *  them again (templates.ts readPackage) as it loads them at its start, so a package this build no longer takes is never
 *  served. */
export interface ImportedTemplateRow {
  readonly id: string;
  readonly source: string;
  readonly sha: string;
  readonly publisher: string;
  readonly files: Readonly<Record<string, string>>;
  /** When it was last imported (stamped by the store). */
  readonly importedAt: number;
}

export interface ImportedTemplates {
  /** Every imported package, by id. */
  list(): Promise<ImportedTemplateRow[]>;
  /** Every imported package's id, sorted, with none of its files read. */
  ids(): Promise<string[]>;
  /** Keeps the package under its id, in place of the one there (a re-import at a new SHA replaces it): true. `workspace`:
   *  the workspace a scoped request imported it in (workspace-scope.ts), written with it; absent, none. The one there is
   *  replaced only while it is in that same workspace (or none): one of another is kept, nothing is written, and the
   *  answer is false. */
  put(row: Omit<ImportedTemplateRow, "importedAt">, workspace?: string): Promise<boolean>;
  /** Every imported package's workspace by id (null: none), with none of its files read. */
  workspaces(): Promise<ReadonlyMap<string, string | null>>;
  /** Removes the package: false when none had that id. */
  remove(id: string): Promise<boolean>;
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
  /** This save's number: 1 when the row was first saved, one more on every save of it since. A verify is guarded by it
   *  (verify's ifSave), never by savedAt, which two saves in one millisecond share. */
  readonly save: number;
  /** When a run last verified this sign-in (saved a live session back to the vendor), ms; null when none has since it was
   *  saved. The v2 view's verified_at. */
  readonly verifiedAt: number | null;
}

/** A forgotten sign-in's pointer, kept sealed byte for byte as its live row held it (so it still opens under the same
 *  binding), only so a server started later can cut it from what a run it was handed shows and from what its agent
 *  learned. Every one is kept, never only the newest: a note may quote the agent's first pointer, and a shorter list
 *  would show it. */
export interface SignInTombstoneRow {
  readonly agentId: string;
  readonly provider: string;
  readonly pointerSealed: Uint8Array;
  readonly forgottenAt: number;
}

export interface SignIns {
  /** Saves the one live sign-in for the agent and provider, its pointer already sealed by the caller: inserted, or replaced
   *  in place when one is saved already (one per agent and provider). */
  save(signIn: { agentId: string; provider: string; name: string; pointerSealed: Uint8Array }): Promise<SignInRow>;
  /** Saves the agent's first sign-in for the provider only when it has none, in one atomic step: `saved` true with the row
   *  it inserted, or false with the live row a save before it left (never the one asked for), so a caller that made a
   *  vendor object for it lets its own go and uses the winner's. Two first creates at once: exactly one wins. */
  saveIfAbsent(signIn: { agentId: string; provider: string; name: string; pointerSealed: Uint8Array }): Promise<{ saved: boolean; row: SignInRow }>;
  /** The agent's live sign-ins, by provider (their pointers stay sealed). */
  list(agentId: string): Promise<SignInRow[]>;
  /** The agent's live sign-in for the provider, or undefined. */
  get(agentId: string, provider: string): Promise<SignInRow | undefined>;
  /** Marks the agent's sign-in for the provider verified at `at` (a run saved a live session back): sets verified_at, for
   *  the v2 view, and answers whether it stamped a row. With `ifSave`, it stamps only while the sign-in is still that save
   *  (SignInRow.save; WHERE save = ?), so a save that landed since the caller checked (allowed while held; it clears
   *  verified_at), in the same millisecond or not, is never re-stamped stale: the answer is false then, and nothing is
   *  written. The run path (E2) calls it at a run's save; a missing sign-in is left as it is (false). */
  verify(agentId: string, provider: string, at: number, options?: { ifSave?: number }): Promise<boolean>;
  /** The agent's forgotten pointers for the provider, newest first (kept sealed, never opened here). */
  tombstones(agentId: string, provider: string): Promise<SignInTombstoneRow[]>;
  /** Forgets the agent's live sign-in for the provider, in the one transaction a launch shares as its lock: when a running
   *  run holds `hash` in its sign_in_handed (or, with `heldUnreadable`, when any running run was handed a sign-in at all),
   *  the forget is refused (SignInHandedTo, naming the run) and nothing is written; otherwise the live row's sealed pointer
   *  moves to a tombstone (every one kept) and the live row goes. SignInMissing when the agent has
   *  no live sign-in for the provider. */
  forget(agentId: string, provider: string, held: { hash?: string; heldUnreadable?: boolean }): Promise<SignInTombstoneRow>;
  /** The id of a running run whose sign_in_handed holds `hash`, if one does; undefined otherwise. The check the runner
   *  makes before it serves a run's output, and forget makes before it removes a sign-in. With `settleMs` (a vendor's settle
   *  window, from the store clock or `at`), a run that left running (ended or parked) less than that ago also counts as
   *  holding it, so a new run does not save over a context write-back still in flight. */
  handedHolder(hash: string, options?: { settleMs?: number; at?: number }): Promise<string | undefined>;
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
/** `host`: where the viewer answers when its runner is on another host than the server (live-reach.ts); none, the
 *  server's own machine (loopback). */
export type LiveViewerRow = { kind: ViewerKind; tag: string; host?: string; port: number; id: string; sealed: Uint8Array; at: number; runner: string };

/** The computer sessions' viewer hand-overs (browser-live.ts): the runner puts and drops them under its claim, the server
 *  reads them. The rows go with the run's end (its end commit), a take or reclaim of the run (a newer epoch, in the
 *  claim's transaction), and the run's delete (on delete cascade). */
export interface LiveViewers {
  /** The runner's put under its claim, upsert on (run_id, kind, tag), `at` stamped by the store: false when the claim is
   *  stale (its epoch moved on, or its lease ran out), and nothing written. */
  put(claim: Claim, viewer: { kind: ViewerKind; tag: string; host?: string; port: number; id: string; sealed: Uint8Array }): Promise<boolean>;
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

/** What Store.secureRewrite did: how many rows `work` rewrote and, when old bytes may still be in the store's files (the
 *  marker kept for the next start), why: "busy", a reader in another connection held the log back from the checkpoint, or
 *  a write of another connection held the VACUUM off through its busy wait and its one retry; "failed", the VACUUM or
 *  the checkpoint failed otherwise; "deferred", the rewrite was asked with no VACUUM (a server already serving), so the
 *  next start's scrub finishes it. */
export interface SecureRewrite {
  readonly rewritten: number;
  readonly left?: "busy" | "failed" | "deferred";
}
/** secureRewrite's options: `vacuum: false` rewrites with secure_delete on and leaves the marker, with no VACUUM or
 *  checkpoint: for a server already serving, where a VACUUM would hold every store call (and another process's writes)
 *  while it rebuilds the whole file, and needs about its size again on disk. The next start's scrub runs it. */
export type SecureRewriteOptions = { readonly vacuum?: boolean };

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
  /** Each computer a run made, from its create to its proven delete. */
  readonly computerIntervals: ComputerIntervals;
  /** Each claim of a run: the turn it works and its attempt at it, and why it let the run go unfinished. */
  readonly runAttempts: RunAttempts;
  /** The people's own machines paired with this server, and the codes that pair them (spec/computer/attach.md). */
  readonly pairedComputers: PairedComputers;
  /** The tokens minted for hosted machines that dial this server, each kept as its SHA-256. */
  readonly mintedTokens: MintedTokens;
  /** Every runner's word that it is there, whether it refused to claim, and where its relay takes the dials relayed to it. */
  readonly runners: Runners;
  /** The template packages imported from GitHub, their files kept as read. */
  readonly importedTemplates: ImportedTemplates;
  /** Each trigger source's sealed settings (design 2.1): a value per adapter, scope and field. */
  readonly triggerSettings: TriggerSettings;
  /** The outbox of a channel the server sends itself, its tries and what it told each run. */
  readonly channels: Channels;
  /** MCP OAuth sign-ins in flight (design 2.1): one row per pending sign-in, its verifier sealed. */
  readonly mcpOauth: McpOauth;
  /** Each agent's saved browser sign-ins (design 2.1): one live row per agent and provider, its pointer sealed, with the
   *  forgotten pointers kept as tombstones. */
  readonly signIns: SignIns;
  /** Every sealed value the store keeps, across all its planes, in one read (a runner's redaction set at each claim). */
  readonly sealedSecrets: SealedSecrets;
  /** Runs `work`, writes that replace a secret the store kept in the clear (it answers how many rows it rewrote), so the
   *  bytes they replace are not left in the store's files. SQLite: a marker file beside the database is written first;
   *  secure_delete is on in every connection from its open, so a rewritten row's old bytes are zeroed in its page; then,
   *  when a row was rewritten or an earlier start left the marker, a VACUUM (no free page or free block keeps a copy an
   *  update left before secure_delete was on) and a WAL checkpoint (TRUNCATE: the log keeps no older frame). The marker is removed once the checkpoint is
   *  done; `left` says why it was kept, for the next start to finish. Postgres: `work` alone (a replaced row version is
   *  the database's until its vacuum). */
  secureRewrite?(work: () => Promise<number>, options?: SecureRewriteOptions): Promise<SecureRewrite>;
  /** Reads the store's schema version and its runner floor now, without a lock or a write: a runner reads it at each
   *  renewal (runner/main.ts), and stops once the floor is above the version its build knows. */
  schemaState?(): Promise<StoreSchemaState>;
  /** The server's pass over the ledger (run-patch.ts backfillLedger), as its open runs it: true once the reopened runs are
   *  marked recorded again under this build's split (store_meta.ledger_rerecorded), which only a pass that started with
   *  no runner of an earlier build there and no run held by a claim taken before the open and RUNNER_STALE_MS marks
   *  (run-patch.ts ledgerPasses). The server tries again every RUNNER_STALE_MS until it is true (server.ts).
   *  On a store opened as the server. */
  rerecordReopened?(): Promise<boolean>;
  /** The clock a claim's lease is judged and stamped on (its `until`), when it is this process's own: the store's clock on
   *  SQLite (one host), or a test's. A runner reckons a claim's deadline from its `until` on it, so a claim or renew that
   *  waited for the writer lock keeps the lease the store granted from the lock. Absent when the lease is the database's
   *  clock (Postgres), which this process cannot read: the runner reckons from when it asked. */
  readonly leaseClock?: () => number;
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
  release(claim: Claim, options?: { state?: ReleasedState; wakeAt?: number | null; backoffUntil?: number | null; cut?: "drain" | "retry" }): Promise<void>;
  /** The run's journal: pi-durable's Storage for this one run, every commit fenced by the claim (store/journal). Its commit
   *  holds the store's one connection while it runs, so it awaits nothing but its own statements, under a deadline. */
  journal(claim: Claim): Journal;
  /** The store this one reads from: itself, but for the store a snapshot hands its callback, which is a new object at each
   *  snapshot and gives the store it was taken of. What a reader keeps per store (a served answer's cache) is kept by this. */
  readonly origin: Store;
  /** `read` against this store as it stood at one moment: every read it makes sees one snapshot (one read-only transaction),
   *  so a write that lands meanwhile, a runner's commit among them, is in all of its reads or in none. The store it is given
   *  only reads. On SQLite the transaction holds this process's one connection until `read` settles, so `read` awaits the
   *  store it is given and nothing else: never this store (that waits for the snapshot, which waits for it), and no
   *  network or disk. Its deadline is the transaction's (StoreDeadline). */
  snapshot<T>(read: (store: Store) => Promise<T>): Promise<T>;
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
  command(runId: string, command: { kind: string; body?: unknown }, options?: LaunchSealedWrite): Promise<Command>;
  /** The run's commands with an id above `after`, in id order. */
  commands(runId: string, after: number): Promise<Command[]>;
  /** Every run's commands with an id above its own cursor, in id order, in one read: a runner's poll of all it holds. A run
   *  with none is absent from the map. */
  commandsOf(cursors: readonly { runId: string; after: number }[]): Promise<Map<string, Command[]>>;
  /** Marks the command taken (or refused, with `reason`) under the claim, once: a command already taken stays as it was.
   *  Fenced on a stale claim. */
  take(claim: Claim, commandId: number, outcome?: "taken" | "refused", reason?: string): Promise<void>;
  /** What the run's command answered, read once: the row's answer is cleared in the same transaction, so its bytes do not
   *  stay in the store. Undefined when the row is untaken, refused, taken with no answer, already read, or not the run's. */
  answerOf(runId: string, commandId: number): Promise<{ readonly value: unknown } | undefined>;
  /** Tells `listener` when a command of a run in this store is written ("written", after command() commits) or taken,
   *  refused or answered ("answered": a take, a run update that takes, a journal commit that takes or ends the run), and
   *  when a run is queued ("queued": runs.create, runs.createInline or a trigger's fire committed it, claimable now).
   *  A hint to read now, for handles in this process only: a row another process writes wakes nothing here, the reader's
   *  poll finds it. Called after the commit, asynchronously; a listener's throw is swallowed. Answers the unsubscribe. */
  watchCommands(listener: (event: { readonly runId: string; readonly what: "written" | "answered" | "queued" }) => void): () => void;
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
  /** `message`: words of its own (a connection the store's database never gave, StoreConnect's); by default a transaction's. */
  constructor(deadlineMs: number, message?: string) {
    super(message ?? `the store's transaction was still open after ${deadlineMs} ms, so it was rolled back and nothing of it was written`);
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


/** A data directory an earlier version wrote (its store, agent homes, run databases or settings files): this version
 *  neither reads nor moves it, and its words give the two ways on: keep the directory with the earlier version, or start
 *  this one on a new directory and add the agents again. `found`: what was found, relative to the directory. */
export class StoreFromEarlierVersion extends Error {
  readonly found: readonly string[];
  constructor(dataDir: string, found: readonly string[]) {
    super(
      `${dataDir} holds an earlier version's data (${found.join(", ")}), which this version does not read or move. ` +
        "Keep this directory with the earlier version, or start this version on a new, empty directory and add your " +
        "agents, MCP servers, keys and sign-ins there again.",
    );
    this.name = "StoreFromEarlierVersion";
    this.found = found;
  }
}

/** A store this release's server upgrades in place at its start, which a runner never does: the runner waits for that
 *  start. `what`: what the server does to it. */
export class StoreAwaitsServer extends Error {
  constructor(what: string) {
    super(`Start the AgentRun server to ${what} before opening a runner. The runner does not upgrade this store.`);
    this.name = "StoreAwaitsServer";
  }
}

/** A store whose schema version this build does not know (or one the server has not set up yet). */
export class SchemaVersionUnknown extends Error {
  readonly found: number | null;
  readonly known: number;
  constructor(file: string, found: number | null, known: number) {
    // `file` is a path (SQLite) or already a phrase (Postgres: "the Postgres schema x").
    const store = file.startsWith("the ") ? file : `the store at ${file}`;
    super(
      found === null
        ? `${store} has no schema yet: the server sets it up at its start`
        : found < known
          ? `${store} is schema version ${found}, and this release (version ${known}) can't open a store an earlier release set up.\n` +
            "Start the server on a new, empty data folder with --data <new folder> (docker run or compose arguments: --data /data/<new folder> --listen 0.0.0.0 --port 7340 --drain-timeout 6s), then add your agents, MCP servers, keys and sign-ins again.\n" +
            'On Render the Docker Command replaces the image\'s entrypoint too, so it must be the whole start command shown in "Before you upgrade" in the release notes.\n' +
            "Keep the old folder as it is: the earlier release still opens it."
          : `${store} is schema version ${found}, set up by a later release than this one (this release knows version ${known}). Run that release or a later one.`,
    );
    this.name = "SchemaVersionUnknown";
    this.found = found;
    this.known = known;
  }
}

/** A learning record write refused in its own transaction, nothing written (Store.learning changeRecords, addRecord): a
 *  promotion or audit of a digest no version of its workflow holds (a run's purge took it since the write read it), or
 *  a record of a run that was purged. */
export class LearningRecordRefused extends Error {
  readonly records: readonly LearningRecordWrite[];
  constructor(agentId: string, records: readonly LearningRecordWrite[], why: "unheld" | "purged") {
    super(why === "unheld"
      ? `agent ${agentId}'s learning holds no version of ${records.map((one) => `${one.workflow}@${one.digest}`).join(", ")}: a run's purge took it, so no record of it is written`
      : `run ${records.map((one) => one.runId).join(", ")} was purged, so no learning record of it is written`);
    this.name = "LearningRecordRefused";
    this.records = records;
  }
}

/** A store a later build migrated past what this runner can run beside: its schema is ahead of the version this build
 *  knows, and its runner floor (a breaking migration's version) is above it. Run a runner of the server's release. A
 *  SchemaVersionUnknown, so every caller that refuses an unknown schema refuses this one the same way (a runner's exit 3). */
export class RunnerBelowFloor extends SchemaVersionUnknown {
  readonly floor: number;
  constructor(place: string, found: number, known: number, floor: number) {
    super(place, found, known);
    const store = place.startsWith("the ") ? place : `the store at ${place}`;
    this.message = `${store} is schema version ${found}, and a runner on it must know version ${floor} or later (its runner floor: a later release changed the schema in a way an earlier runner cannot run beside); this runner knows ${known}. Run a runner of the server's release.`;
    this.name = "RunnerBelowFloor";
    this.floor = floor;
  }
}

/** A store's schema version and its runner floor (Store.schemaState). */
export interface StoreSchemaState {
  /** The store's schema version; null when none is set up. */
  readonly version: number | null;
  /** The oldest schema version a runner's build must know to run on this store: a runner whose build knows less stops
   *  claiming, hands its runs back and exits. On SQLite the version itself (a SQLite runner opens only its own version). */
  readonly runnerFloor: number | null;
  /** The version this build knows (its newest migration on Postgres, SCHEMA_VERSION on SQLite). */
  readonly known: number;
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
 *  taken already (a primary key's or a UNIQUE's), so a caller tells "the name is taken" from any other refusal. `index`:
 *  the unique index (or constraint) the database named, when it named one: an index on an expression (one answer per
 *  approval, schema.ts ONE_ANSWER_INDEX) has no plain columns to name, only its name. */
export class StoreConstraint extends Error {
  readonly rule?: ConstraintRule;
  readonly unique?: { readonly table: string; readonly columns: readonly string[] };
  readonly index?: string;
  constructor(message: string, details: { rule?: ConstraintRule; unique?: { table: string; columns: readonly string[] }; index?: string } = {}) {
    super(message);
    this.name = "StoreConstraint";
    if (details.rule) this.rule = details.rule;
    if (details.unique) this.unique = details.unique;
    if (details.index) this.index = details.index;
  }
}

/** An approve or deny command refused because its approval is answered already: an unrefused answer naming it was
 *  written first (the one-answer index, schema.ts ONE_ANSWER_INDEX), so this one lost. Both stores raise it from that
 *  index's unique violation alone, at the command's insert; any other refusal stays a plain StoreConstraint. Its caller
 *  reads the answer that won: approve's 409 already_answered, or nothing to do. */
export class AnswerTaken extends StoreConstraint {
  constructor(message: string, index: string) {
    super(message, { rule: "unique", index });
    this.name = "AnswerTaken";
  }
}

/** A run's purge refused while a run made from it (a replay of its input, its audit's shadow run: Runs.madeFrom) is not
 *  purged: one was made after the purge read them (a claim that read the run's launch before). `runs`: those runs. A
 *  StoreConstraint, so the caller answers it as a run not final; nothing written. */
export class RunsMadeFromLeft extends StoreConstraint {
  constructor(readonly runId: string, readonly runs: readonly string[]) {
    super(`run ${runId} has runs made from it not purged (${runs.join(", ")}): each is purged first`);
    this.name = "RunsMadeFromLeft";
  }
}

/** A run's firing (Runs.create `firing`) that no longer takes it: no longer due or sent with a start_by, or it has a run. */
export class FiringMoved extends Error {
  constructor(readonly triggerId: string, readonly key: string) {
    super(`firing ${key} of trigger ${triggerId} no longer takes a run: nothing was written`);
    this.name = "FiringMoved";
  }
}

/** A run made from a purged run (its launch's `replay.of` or `audit.of` names it): refused, nothing written. Its source's
 *  input is gone, and a copy of it is never made again (Runs.create). `runId`: the purged run. */
export class RunPurged extends Error {
  constructor(readonly runId: string, readonly made: string) {
    super(`run ${made} is made from run ${runId}, which is purged: it is not started`);
    this.name = "RunPurged";
  }
}

/** An agent's current revision is not the one a conditional revision or run admission expected: another write
 *  moved it first. `current` is the agent's current revision now. Nothing was written. */
export class RevisionMoved extends Error {
  constructor(readonly agentId: string, readonly current: string | null) {
    super(`the current revision of agent ${agentId} moved (now ${current ?? "none"})`);
    this.name = "RevisionMoved";
  }
}

/** A conditional revision refused while the agent has queued, running or parked runs. Nothing was written. */
export class ActiveRuns extends Error {
  constructor(readonly agentId: string, readonly runIds: readonly string[]) {
    super(`agent ${agentId} has active runs (${runIds.join(", ")})`);
    this.name = "ActiveRuns";
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
