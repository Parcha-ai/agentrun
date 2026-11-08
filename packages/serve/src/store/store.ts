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
import type { Storage } from "@earendil-works/pi-durable";

/** A run's state. queued: a row, no runner yet. running: a runner holds the claim. parked: waiting for a person (an
 *  approval, a raised cap) with no claim held; a command row or its wake_at makes it claimable again. ended, stopped and
 *  failed are final. A running run whose runner died is claimable once its claim runs out. */
export type RunState = "queued" | "running" | "parked" | "ended" | "stopped" | "failed";
export const FINAL_STATES: readonly RunState[] = ["ended", "stopped", "failed"];

/** A runner's hold on a run: the epoch every write it makes for the run carries, until `until` (ms) unless renewed. `from`:
 *  the run's state before this claim (queued; parked: woken by a command or its wake_at; running: released, or its last
 *  claim lapsed). */
export interface Claim {
  readonly runId: string;
  readonly runner: string;
  readonly epoch: number;
  readonly until: number;
  readonly from: RunState;
}

/** A command the server wrote for a run (stop, steer, approve, deny, raise): one row, read by the run's runner in id order
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
  readonly package?: TemplatePackage;
}

export interface RevisionRow {
  readonly id: string;
  readonly agentId: string;
  readonly kind: string;
  readonly body: unknown;
  readonly package: TemplatePackage | null;
  readonly createdAt: number;
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
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/** What a runner may change on its run's row, under its claim. A final state with no `endedAt` is stamped now. */
export interface RunPatch {
  readonly state?: RunState;
  readonly costUsd?: number | null;
  readonly metrics?: unknown;
  readonly summary?: string | null;
  readonly endedAt?: number | null;
}

/** Rows written in the same commit as a run's update (runs.update, or a journal commit's staged patch): a channel post the
 *  run's moment owes (the outbox), what a channel was told. A command consumed is Staged.take, refused when not untaken. */
export type AlsoRow =
  | { readonly table: "channel_posts"; readonly row: ChannelPost }
  | { readonly table: "channel_told"; readonly row: { channel: string; marker: string } };

/** What the run's next journal commit writes beside its batches, in its one transaction, under its fence: the run row's
 *  patch, rows beside it, and the commands it takes (each marked taken once, in the commit that carries its effect). */
export interface Staged {
  readonly run?: RunPatch;
  readonly also?: readonly AlsoRow[];
  readonly take?: readonly number[];
}

/** A run's journal: pi-durable's Storage for the one run, every commit fenced by the claim, and stage() for what its next
 *  commit writes beside its batches. Staged rows are cleared once a commit stores a batch and kept when it does not. */
export interface Journal extends Storage {
  readonly runId: string;
  stage(staged: Staged): void;
}

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

export interface Agents {
  /** Creates the agent, or renames it (name, description) when it exists. */
  put(agent: { id: string; name: string; description?: string | null }): Promise<void>;
  /** The agent row and its first revision, current, in one transaction: both or neither. */
  create(agent: { id: string; name: string; description?: string | null }, firstRevision: NewRevision): Promise<void>;
  get(id: string): Promise<AgentRow | undefined>;
  list(options?: { archived?: boolean }): Promise<AgentRow[]>;
  archive(id: string, archived: boolean): Promise<void>;
  /** Adds a revision and makes it the agent's current one, in one commit. */
  addRevision(revision: NewRevision & { agentId: string }): Promise<void>;
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
  /** Enables the trigger and writes its scope rows, in one transaction. */
  enable(triggerId: string, scopes: readonly TriggerScope[]): Promise<void>;
  /** Disables the trigger (with why, JSON) and deletes its scope rows, in one transaction. */
  disable(triggerId: string, why?: unknown): Promise<void>;
  /** The firing starts a run: the queued run, the `started` firing that names it and the trigger's last_run_id, in one
   *  transaction. */
  fire(firing: Firing, run: { id: string; agentId: string; revisionId: string }): Promise<RunRow>;
}

export interface Runs {
  /** A queued run of `revisionId`, its row's only writer until a runner claims it. */
  create(run: { id: string; agentId: string; revisionId: string }): Promise<RunRow>;
  get(id: string): Promise<RunRow | undefined>;
  /** Newest first, at most `limit` (no limit: all). */
  list(filter: { agentId?: string; revisionId?: string; state?: RunState; limit?: number }): Promise<RunRow[]>;
  /** The runs a runner may claim, oldest first: queued; parked with an untaken command or its wake_at passed; running with
   *  no runner (released at a runner's shutdown: it stays running, a run that started keeps that fact) or its claim run
   *  out. */
  claimable(options?: { limit?: number }): Promise<string[]>;
  /** Claims up to `k` claimable runs for `runner`, oldest first, in one transaction: each at its own epoch + 1, with its
   *  `from`. A runner fills its free loops with one call. */
  claimMany(runner: string, k: number, options?: { leaseMs?: number }): Promise<Claim[]>;
  /** Changes the run's row under `claim`, and writes `also` in the same commit: refused (Fenced) and nothing written when
   *  the run's epoch is not the claim's. */
  update(claim: Claim, patch: RunPatch, also?: readonly AlsoRow[]): Promise<RunRow>;
}

/** Who opens the store. The server sets the schema up at its start and holds the store's owner lock (one server per
 *  store); a runner never sets anything up, and refuses a schema version it does not know. */
export type StoreRole = "server" | "runner";

export interface Store {
  readonly agents: Agents;
  readonly templates: Templates;
  readonly triggers: Triggers;
  readonly runs: Runs;
  /** Claims the run for `runner` until now + `leaseMs`: the run's epoch + 1 when it is claimable (runs.claimable); null when
   *  another claim holds it, or it is final, or parked with nothing to wake it. A queued or parked run becomes running. */
  claim(runId: string, runner: string, options?: { leaseMs?: number }): Promise<Claim | null>;
  /** Moves the claim's end to now + `leaseMs`. Fenced when the run's epoch moved on. */
  renew(claim: Claim, options?: { leaseMs?: number }): Promise<Claim>;
  /** Gives the run back (no runner, no claimed_until; `state` when given; `wakeAt` and `backoffUntil` or none), in a
   *  durable commit (as flush). Fenced when the epoch moved on. */
  release(claim: Claim, options?: { state?: RunState; wakeAt?: number | null; backoffUntil?: number | null }): Promise<void>;
  /** The run's journal: pi-durable's Storage for this one run, every commit fenced by the claim (store/journal). Its commit
   *  holds the store's one connection while it runs, so it awaits nothing but its own statements, under a deadline. */
  journal(claim: Claim): Journal;
  /** One durable commit: every commit before it, of every run, is on the disk when it resolves. Before a call that must
   *  not run twice, at a run's end and when a claim is released. */
  flush(): Promise<void>;
  /** Writes a command for the run. RunFinal when the run is final; unknown runs are refused the same way. */
  command(runId: string, command: { kind: string; body?: unknown }): Promise<Command>;
  /** The run's commands with an id above `after`, in id order. */
  commands(runId: string, after: number): Promise<Command[]>;
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

/** A second server on a store another server holds (one server per store). */
export class StoreOwned extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreOwned";
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

/** A row the store's constraints refuse (a duplicate id or name, a revision of an unknown agent, a bad kind). */
export class StoreConstraint extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConstraint";
  }
}
