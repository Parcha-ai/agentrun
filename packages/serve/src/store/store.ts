// The one store (design 2.1): agents, their revisions and runs, the commands the server writes for a run, and every run's
// journal, in one database. The server writes run and command rows and reads everything; a runner claims a run, writes
// its journal and its row under the claim, and reads its commands. Nothing outside store/ knows SQL, a pragma or a file:
// SqliteStore today, PostgresStore later, both behind this interface.
//
// The claim is the one fence for a run: claim() moves the run's epoch up by one, and every write a runner makes for the
// run (its row, its journal commits, a command taken) carries the epoch it holds. A write under a lower epoch than the
// run's is refused (Fenced) and writes nothing.
import type { Storage } from "@earendil-works/pi-durable";

/** A run's state. queued: a row, no runner yet. running: a runner holds the claim. parked: waiting for a person (an
 *  approval, a raised cap). ended, stopped and failed are final. A run whose runner died stays running or parked until its
 *  claim runs out, when the next claim takes it (an orphan). */
export type RunState = "queued" | "running" | "parked" | "ended" | "stopped" | "failed";
export const FINAL_STATES: readonly RunState[] = ["ended", "stopped", "failed"];

/** A runner's hold on a run: the epoch every write it makes for the run carries, until `until` (ISO time) unless renewed. */
export interface Claim {
  readonly runId: string;
  readonly runner: string;
  readonly epoch: number;
  readonly until: string;
}

/** A command the server wrote for a run (stop, steer, approve, deny, raise): one row, read by the run's runner in id order
 *  and marked taken. `body` is JSON. */
export interface Command {
  readonly id: number;
  readonly runId: string;
  readonly kind: string;
  readonly body: unknown;
  readonly createdAt: string;
  readonly takenAt: string | null;
}

export interface AgentRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly currentRevision: string | null;
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

export interface RevisionRow {
  readonly id: string;
  readonly agentId: string;
  readonly kind: string;
  readonly body: unknown;
  readonly createdAt: string;
}

export interface RunRow {
  readonly id: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly state: RunState;
  readonly epoch: number;
  readonly runner: string | null;
  readonly claimedUntil: string | null;
  readonly costUsd: number | null;
  readonly metrics: unknown;
  readonly summary: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/** What a runner may change on its run's row, under its claim. An ended state with no `endedAt` is stamped now. */
export interface RunPatch {
  readonly state?: RunState;
  readonly costUsd?: number | null;
  readonly metrics?: unknown;
  readonly summary?: string | null;
  readonly endedAt?: string | null;
}

export interface Agents {
  /** Creates the agent, or renames it (name, description) when it exists. */
  put(agent: { id: string; name: string; description?: string | null }): Promise<void>;
  get(id: string): Promise<AgentRow | undefined>;
  list(options?: { archived?: boolean }): Promise<AgentRow[]>;
  archive(id: string, archived: boolean): Promise<void>;
  /** Adds a revision and makes it the agent's current one, in one commit. */
  addRevision(revision: { id: string; agentId: string; kind: string; body: unknown }): Promise<void>;
  revision(id: string): Promise<RevisionRow | undefined>;
  revisions(agentId: string): Promise<RevisionRow[]>;
}

export interface Runs {
  /** A queued run of `revisionId`, its row's only writer until a runner claims it. */
  create(run: { id: string; agentId: string; revisionId: string }): Promise<RunRow>;
  get(id: string): Promise<RunRow | undefined>;
  /** Newest first, at most `limit` (no limit: all). */
  list(filter: { agentId?: string; revisionId?: string; state?: RunState; limit?: number }): Promise<RunRow[]>;
  /** Changes the run's row under `claim`: refused (Fenced) and nothing written when the run's epoch is not the claim's. */
  update(claim: Claim, patch: RunPatch): Promise<RunRow>;
}

export interface Store {
  readonly agents: Agents;
  readonly runs: Runs;
  /** Claims the run for `runner` until now + `leaseMs`: the run's epoch + 1 when it is queued, or running or parked with
   *  its claim run out; null when another claim holds it or it is final. A queued run becomes running. */
  claim(runId: string, runner: string, options?: { leaseMs?: number }): Promise<Claim | null>;
  /** Moves the claim's end to now + `leaseMs`. Fenced when the run's epoch moved on. */
  renew(claim: Claim, options?: { leaseMs?: number }): Promise<Claim>;
  /** Gives the run back (no runner, no claimed_until), in a durable commit (as flush). Fenced when the epoch moved on. */
  release(claim: Claim): Promise<void>;
  /** The run's journal: pi-durable's Storage for this one run, every commit fenced by the claim (store/journal). */
  journal(claim: Claim): Storage;
  /** One durable commit: every commit before it, of every run, is on the disk when it resolves. Before a call that must
   *  not run twice, at a run's end and when a claim is released. */
  flush(): Promise<void>;
  /** Writes a command for the run. RunFinal when the run is final; unknown runs are refused the same way. */
  command(runId: string, command: { kind: string; body?: unknown }): Promise<Command>;
  /** The run's commands with an id above `after`, in id order. */
  commands(runId: string, after: number): Promise<Command[]>;
  /** Marks the command taken under the claim (once: a command already taken stays as it was). Fenced on a stale claim. */
  take(claim: Claim, commandId: number): Promise<void>;
  /** Waits for every write asked for before it, then closes. A call after it is refused (StoreClosed). */
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

/** A command for a run that is final, or that does not exist. */
export class RunFinal extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`run ${runId} is not running (it ended, or there is no such run): it takes no command`);
    this.name = "RunFinal";
    this.runId = runId;
  }
}

/** A row the store's constraints refuse (a duplicate id, a revision of an unknown agent). */
export class StoreConstraint extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConstraint";
  }
}
