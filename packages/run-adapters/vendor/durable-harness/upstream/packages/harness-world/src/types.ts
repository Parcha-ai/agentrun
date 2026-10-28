import type { World } from '@workflow/world';
import type { Anchor } from './anchor.ts';
import type { ChaosKind, ChaosSpec, Drill, DrillTarget } from './chaos.ts';
import type { Capability, LaneOptions } from './lanes.ts';
import type { Mark, MarkName } from './marks.ts';
import type { Hint } from './hints.ts';
import type { DocEffect, DocsIO, DocsReader, DocState } from './docs.ts';

/**
 * What to do with an effect whose intent is committed (`step_started`) but
 * whose outcome is not, because the process running it died.
 *
 * - `safe`: run it again. Reads, idempotent writes, model calls.
 * - `never`: do not rerun. The harness gets an *interrupted* result carrying
 *   whatever partial output reached the log, and decides what to do.
 *
 * Same vocabulary as Pi's `AgentTool.replay` and.
 */
export type ReplayPolicy = 'safe' | 'never';

export type SubmissionKind = 'prompt' | 'steer' | 'followUp' | 'withdraw' | 'chaos';

/** One inbox item: a `hook_received` on the session's inbox hook. */
export interface Submission {
  /** The `hook_received` event id. Stable, and the id a withdraw targets. */
  id: string;
  kind: SubmissionKind;
  text?: string;
  /** For `withdraw`: the submission it withdraws. */
  target?: string;
  /** For `chaos`: the crash to inject (see chaos.ts). */
  chaos?: ChaosSpec;
  /** The sender's id (see `SubmissionPayload.nonce`). */
  nonce?: string;
  receivedAt: Date;
}

export type EffectStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface EffectError {
  message: string;
  /** The effect's intent was committed but its outcome was lost. */
  interrupted?: boolean;
  /** Progress the effect reported before it was interrupted. */
  partial?: unknown[];
}

/** A step, seen through the memo key the harness asked for it by. */
export interface EffectRecord {
  key: string;
  stepId: string;
  name: string;
  replay: ReplayPolicy;
  input: unknown;
  status: EffectStatus;
  output?: unknown;
  error?: EffectError;
  attempt: number;
  startedAt?: Date;
  /**
   * The epoch (see `SessionState.epoch`) the latest accepted `step_started`
   * was written in: which lane's driver owns this intent. Once the epoch
   * moves past it (by another writer), its driver must write nothing more.
   */
  startedEpoch?: number;
  /** Submissions this effect placed into the transcript (model effects). */
  placed: string[];
  /** The lane the effect required (`EffectOptions.requires`), if any. */
  requires?: Lane;
  /** The capabilities the effect needs (`EffectOptions.needs`), if any. */
  needs?: Capability[];
  /** The step this one retries (a released `pending` record it replaced). */
  retryOf?: string;
  /**
   * The drive (`drv_…`, one per delivery) that wrote this intent. A chaos
   * crash names the drive it killed, which proves every intent that drive
   * left open dead at once (see `crashedByChaos`).
   */
  driver?: string;
  /**
   * What holds the drive that wrote this step (anchor.ts): its queue message,
   * its deadline, its tab, its sandbox daemon. Written once, with the step.
   */
  anchor?: Anchor;
  /**
   * Set by an accepted `park` step: something outside any drive (a command
   * in a sandbox VM) owns this running intent now. No drive runs it, no
   * recovery interrupts it; its owner's result arrives as a `settlement`.
   */
  park?: ParkOwner;
  /** Set by an accepted `settle` step: the parked work's outcome, to be committed on re-entry. */
  settlement?: Settlement;
  /**
   * Set by an accepted `detach` step: the drive that parked this step let go
   * of it (its inline grace ran out, or it died and a recovery detached it).
   * Until then the parker takes a settlement itself; from then on a settler
   * wakes a drive for it.
   */
  detached?: boolean;
  /**
   * What this effect's outcome did to documents (docs.ts), when it changed
   * any: the edits rode on its `step_completed`. Values are in
   * `SessionState.docs`.
   */
  docs?: DocEffect[];
}

/** Who owns a parked intent. `kind` picks the `OwnerPolicy` that polices it. */
export type ParkOwner = { kind: string } & Record<string, unknown>;

/**
 * The outcome of parked work, recorded by whoever collected it (the drive
 * itself if the work finished within its grace, a push from the sandbox, an
 * owner check; `backstop` in logs written before the backstop was retired).
 * Harness-neutral: the harness commits the
 * tool's own outcome when it re-enters the effect and sees this.
 */
export type Settlement = {
  by: 'inline' | 'push' | 'check' | 'backstop' | 'tether';
  /** Server clock, for display only. */
  at: number;
  cmdId?: string;
  exitCode?: number;
  /** Workspace files the work changed (applied in log order, like an `fs` step). */
  files?: Record<string, string | null>;
  skipped?: string[];
} & ({ ok: true; value: string } | { ok: false; error: EffectError });

/** Returned by `EffectIO.park`: settle the parked intent from the drive that parked it. */
export interface ParkHandle {
  /** The `park` step's id. */
  stepId: string;
  /** Commit `settlement` (first writer wins). `false`: someone else settled it first. */
  settle(settlement: Settlement): Promise<boolean>;
}

export interface ParkOptions {
  /** Arm an owner check this many seconds after the park commits (see owners.ts). Omit for none. */
  checkAfterSeconds?: number;
}

export interface SessionState {
  runId: string;
  workflowName?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  config?: unknown;
  inbox?: { hookId: string; token: string };
  /** Every submission, in log order. */
  submissions: Submission[];
  /** Submission ids placed by a committed effect. */
  placed: Set<string>;
  /** Submission ids withdrawn before they were placed. */
  withdrawn: Set<string>;
  /** Memo key → the first committed step for it. */
  effects: Map<string, EffectRecord>;
  /** Effects in the order their steps were created. */
  effectOrder: EffectRecord[];
  /** Steps that lost a first-writer-wins race for their key. */
  superseded: Set<string>;
  /**
   * The session's fencing token: how many `handoff` steps were accepted. A
   * step whose envelope carries another epoch was written by a driver that
   * read the log before a handoff took the session away from it, so every
   * reader ignores it (`fenced`, also in `superseded`).
   */
  epoch: number;
  /** Steps written with a stale epoch. */
  fenced: Set<string>;
  /**
   * Run-ahead chains (`StepEnvelope.chain`) with an ineffective intent:
   * every later intent of the chain is inert (pipelined-log.ts, chain fence).
   */
  fencedChains: Set<string>;
  /** Number of events folded, which is also the last event's slot. */
  eventCount: number;
  /**
   * Drives (`drv_…`) that committed a `close` fact: they wrote everything
   * they will ever write, so an intent of theirs still running (one that
   * landed late, after its drive gave up on the write) is abandoned.
   */
  closed: Set<string>;
  /** Why the run failed (`run_failed`), when it did. */
  failure?: { message: string };
  /**
   * Documents (docs.ts) by kind: what the log's edits made of them, at the
   * schema their writers wrote. Raw: read one through its definition
   * (`readDoc`, `sessions.doc`), which migrates.
   */
  docs: Map<string, DocState>;
  /** The hook out-of-band document edits arrive on (`harness:<runId>:docs`), once one was made. */
  docsHook?: { hookId: string; token: string };
  /** Out-of-band edits by id: whether each applied (what `updateDoc` checks, and how a resend is told apart). */
  docEdits: Map<string, { applied: boolean; slot: number }>;
}

/** Everything a harness adapter gets from the kernel while it drives a session. */
export interface DriveContext {
  /** Agent Runs tracing, when durable-harness's `agentRuns()` is registered. */
  readonly tracing?: import('./agent-runs.ts').DriveTracing;
  readonly runId: string;
  readonly world: World;
  /** The fold of everything read so far. */
  state(): SessionState;
  /** Harness config recorded on `run_created`. */
  readonly config: unknown;
  /**
   * The effect sandwich. Returns the committed outcome for `key` if there is
   * one (replay), otherwise commits the intent, runs `fn`, and commits its
   * outcome. Throws `EffectFailure` for a committed failure.
   */
  effect<T>(
    key: string,
    options: EffectOptions,
    fn: (io: EffectIO) => Promise<T>
  ): Promise<T>;
  /** Whether `key` already has a committed outcome (so `effect` will not run it). */
  isMemoized(key: string): boolean;
  /** Submissions not yet placed and not withdrawn, in order. */
  pending(): Submission[];
  /** Read events written since the last read (new inbox items, other writers). */
  refresh(): Promise<void>;
  /** Publish a UI event to the session's `live` stream. Best effort. */
  live(event: unknown): void;
  /**
   * Subscribe to live hints (hints.ts): called when some process commits a
   * submission or moves the session, i.e. when a `refresh()` would find
   * something. Undefined when the driver runs without hints; a harness then
   * polls. Returns the unsubscribe (also done when the drive ends).
   */
  onHint?(listener: (hint: Hint) => void): () => void;
  /**
   * Publish a timing mark (marks.ts), e.g. `model.first_token`. A no-op when
   * the driver runs without marks. Optional so hand-written contexts need not
   * provide it.
   */
  mark?(name: MarkName, fields?: Partial<Omit<Mark, 'type' | 'name' | 'runId'>>): void;
  /**
   * Aborted when this invocation must yield: out of budget, or preempted
   * (another lane took the session; the reason is `Yield('preempted')`, and
   * the drive must stop at once and write nothing more).
   */
  readonly signal: AbortSignal;
  /**
   * Stop this drive from outside an effect. For an in-band write that failed
   * or was refused inside a harness callback the harness's own runtime does
   * not propagate (a session store's `append`, a journal flush running in
   * the background): the drive must stop, and the adapter must kill whatever
   * it runs, since that runtime would otherwise carry on past a log that no
   * longer agrees with it.
   *
   * Aborts `signal` with `reason` (a `Yield('preempted')` preempts the drive
   * the way a refresh that saw a new owner does), and every later `effect()`
   * of this drive throws it without writing. The driver then treats `reason`
   * as if the drive had thrown it, whatever the harness throws on its way
   * out: a `Restart` rebuilds the drive from the log, a `Yield` yields, a
   * `Fatal` fails the run, and anything else ends the delivery with that
   * error (the queue redelivers). A no-op once the drive is already stopped.
   * Optional so hand-written contexts need not provide it.
   */
  halt?(reason: unknown): void;
  /**
   * How many times this delivery has already restarted the drive
   * (`Restart`). A harness can tell a divergence that a fresh read of the
   * log might resolve (attempt 0) from one that a rebuilt drive hit again,
   * and throw `Fatal` instead of looping.
   */
  readonly attempt: number;
  /** The lane this drive runs in, for sessions that move between lanes. */
  readonly lane?: Lane;
  /**
   * Documents (docs.ts) in this drive's current view, for harness code
   * outside effects (prompts, display). Not pinned: a later read can see an
   * app's edit. Never let what you write into the log (memo keys, effect
   * inputs) depend on such a read; read inside an effect (`io.docs`)
   * instead. Optional so hand-written contexts need not provide it; the
   * kernel always does.
   */
  readonly docs?: DocsReader;
  /**
   * This drive's fencing token, for a machine outside the World that must
   * never let an older drive's commands win over a newer one's (a Vercel
   * Sandbox's relay, armed with it: docs/workspaces.md §5.4). Undefined
   * until the World accepted an in-band write of this drive (`SessionLog.arm`),
   * and always on a World without the in-band fence: the drive then has no
   * token, only its session's log.
   *
   * The token is the count of this drive's first accepted in-band write, so
   * it stays the same for the whole drive (a re-attach shows the relay the
   * same token) and only rises across owners: a drive that writes in-band
   * after another gets a higher one, a drive the World refused keeps its
   * own, lower than the drive that took over, and two drives never hold the
   * same one.
   *
   * When to read it: inside the body of an effect whose replay is not
   * `safe` (`never`, `unsafe`), such as the fact that owns the session for
   * the machine (`sandbox.attach`). Such an intent is a barrier, durable
   * before its body starts, in strict and run-ahead drives alike. Not after
   * a `safe` effect: a run-ahead drive starts a `safe` body before its intent
   * is durable, and `await ctx.effect(...)` returns before its outcome is, so
   * a drive whose first effect is `safe` can still read undefined there.
   * Read it once per attach and reuse it for every arm of that attach.
   *
   * Check `fenced` before anything that must not run for a stale drive.
   *
   * Optional so hand-written contexts need not provide it.
   */
  fence?(): DriveFence | undefined;
  /**
   * When this drive's budget ends (epoch ms): `signal` aborts with
   * `Yield('budget')` then, and no new effect should start after it. For
   * what the drive starts outside the log that must end before it does (a
   * command in a sandbox, a VM's timeout: docs/workspaces.md §5.6
   * "Deadlines"). Optional so hand-written contexts need not provide it.
   */
  readonly deadline?: number;
  /**
   * Register what carries out the drills on the session's own sandbox for
   * this drive (chaos.ts `DrillTarget`: `sandbox-vm` at a tool, `relay-drop`):
   * from now on an armed one of its kinds is fired `afterMs` into the next
   * matching step, like a Kill Function, but the drive goes on. Undefined
   * when the driver runs without chaos, or fires none (`chaos: { fire:
   * false }`). Returns the unregister (also done when the drive ends).
   * Optional so hand-written contexts need not provide it.
   */
  drills?(target: DrillTarget): () => void;
}

/**
 * A drive's fencing token (`DriveContext.fence`): the World's in-band count
 * its first accepted in-band write was checked against. Compare `count`: a
 * higher one is a later owner of the session.
 *
 * Not the count a drive armed with: two deliveries can decide from the same
 * view and arm at one count (only the first to write keeps the session), and
 * the epoch does not tell them apart either (a recovery keeps it). The
 * World accepts an in-band write only at its current count and then counts
 * it, so the counts of accepted writes are unique and in log order, and a
 * later owner's first accepted write comes after every accepted write of
 * the owner before it.
 */
export interface DriveFence {
  readonly count: number;
  /**
   * Whether this drive's writes are still in-band, so the World would refuse
   * them once another drive took over. False once one of its in-band writes
   * had an unknown outcome (the log lost the World's count, and the rest of
   * the drive writes out of band, never refused), once the World refused one
   * (the drive is superseded), and once the drive let go (`disarm`). A drive
   * whose token is not `fenced` can still commit intents another owner
   * cannot stop, so a machine it arms gets nothing that must not run for a
   * stale drive: no fresh VM armed, no WIPE, FILES or mutating command
   * (docs/workspaces.md §5.4). The count stays what it was.
   */
  readonly fenced: boolean;
}

export interface EffectOptions {
  /** Step name shown in the dashboards, e.g. `model` or `tool.bash`. */
  name: string;
  replay: ReplayPolicy;
  input: unknown;
  /** Submission ids this effect places into the transcript. */
  placed?: string[];
  /**
   * The least capable lane that can run this effect. If the session's
   * current lane is less capable, `effect()` commits a handoff instead of
   * the intent and stops this drive (see `DriverOptions.lanes`); every
   * later `effect()` in the same drive that is not already memoized then
   * throws `Yield('handoff')` too, so nothing else is written in a lane the
   * session has left.
   */
  requires?: Lane;
  /**
   * What the effect needs: routed by `route()` from the
   * session's current lane. Wins over `requires` (`'function'` →
   * `['secrets']`, `'sandbox'` → `['machine']`).
   */
  needs?: Capability[];
  /** The handoff's `reason` when `requires` escalates. Default: `<name> needs the <lane> lane`. */
  reason?: string;
}

export interface EffectIO {
  signal: AbortSignal;
  /** Report progress. Streamed to `step:<id>`; replayed as `partial` on interruption. */
  progress(chunk: unknown): void;
  /** The intent's step id. */
  stepId: string;
  /**
   * Hand this running intent to an owner outside the drive (a detached
   * command). After it commits, the work can outlive this drive: throw
   * `Parked` to stop the drive without releasing the intent, and whoever
   * collects the result settles it (`settleParked`); the next drive then
   * re-enters the effect with `settlement` set.
   */
  park(owner: ParkOwner, options?: ParkOptions): Promise<ParkHandle>;
  /** Set when the effect is re-entered after its parked work settled. Return its value. */
  settlement?: Settlement;
  /**
   * An in-process crash (Kill Function) is armed for this effect and fires
   * this many ms after it started. Parked work that would otherwise stop
   * its drive earlier can stay attached long enough to be killed.
   */
  chaosArmedMs?: number;
  /**
   * Documents (docs.ts), for this call: read them, and update them with the
   * call's outcome (a call that throws or never reports changed nothing).
   * Set by the kernel and by raw sessions.
   */
  docs?: DocsIO;
  /**
   * Fire, now, an armed drill on the session's own sandbox of one of `kinds`
   * that targets this step (the attach drills, chaos.ts `ATTACH_DRILLS`, in
   * the `sandbox.attach` fact): its chaos step is committed against this
   * step, and the drill returned for the caller to carry out. Undefined when
   * none is armed, the driver fires none, or the log refused it (the step no
   * longer runs). Set by the kernel when the driver runs with chaos.
   */
  drill?(kinds: readonly ChaosKind[]): Promise<Drill | undefined>;
}

/** A harness adapter: Pi, fx, or anything else that can be driven from a fold. */
export interface Harness {
  /** The last part of its sessions' run name: `workflow//durable-harness@<version>//<name>`. */
  name: string;
  /**
   * Drive the session forward from `ctx.state()` until it is idle on its
   * inbox. Everything that must survive a crash goes through `ctx.effect`.
   * In-memory state is disposable: the next invocation rebuilds from the log.
   */
  drive(ctx: DriveContext): Promise<void>;
  /**
   * How Agent Runs learns this harness's model calls (durable-harness's
   * `agentRuns()`). `effects` (the default): each `model` effect is one model
   * call, recorded from its input (`model`: `provider/id`) and output. `self`:
   * the harness records each call with `ctx.tracing.modelCall`, inside its
   * `model` effect when it has one (the effect is then the call's step), or
   * wherever it learns of the request (a CLI behind the Gateway proxy).
   */
  modelCalls?: 'effects' | 'self';
  /**
   * Lanes for this harness's sessions only, overriding the driver's
   * `lanes`. Lets one flow route host lane-hopping sessions (a hybrid
   * harness) next to sessions that never move.
   */
  lanes?: LaneOptions;
}

/**
 * A harness-neutral tool. The Pi and fx adapters both accept these, so one
 * set of tools (see `harness-world-hands`) runs under either harness.
 */
export interface HostTool<Input = any> {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema for the input. TypeBox schemas work as-is. */
  inputSchema: object;
  replay: ReplayPolicy;
  /**
   * The least capable lane that can run this tool, for sessions that move
   * between lanes (`'browser' < 'function' < 'sandbox'`). Omitted: anywhere.
   * Prefer `needs`.
   */
  requires?: Lane;
  /** What the tool needs (`'secrets'`, `'machine'`, …): where it may run. */
  needs?: Capability[];
  execute(input: Input, io: HostToolIO): Promise<string>;
}

/** Where a hybrid session is driven, from least to most capable. */
export type Lane = 'browser' | 'function' | 'sandbox';

export interface HostToolIO {
  signal: AbortSignal;
  progress(chunk: unknown): void;
  /** The drive this call belongs to, for tools that record their own effects. */
  ctx: DriveContext;
  /** See `EffectIO`: present when the harness passes the effect's io through. */
  stepId?: string;
  park?: EffectIO['park'];
  settlement?: Settlement;
  chaosArmedMs?: number;
  /** See `EffectIO.docs`: present when the harness passes the effect's io through (`hostToolIO`). */
  docs?: DocsIO;
}
