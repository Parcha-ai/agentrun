// Sleep parking: an instance whose live work is only sleeping releases its claim instead of holding a host through the
// wait, and a deploy drains before it stops. After every commit the run's tasks are classified; when every task that
// could run is in a retry or poll wait longer than the threshold, the wake is recorded (run.json `sleeping` with
// `wakeAt`) and only then is the run released. The supervisor starts a sleeping run at its `wakeAt` (`ensureRunning`)
// and pi's own timer sleeps whatever is left of the wait. A run with no live work parks idle (`wakeAt` null) when the
// deployment has a waker for it (a request through serve). The lifecycle follows Rivet's pi actor, written for a claim.
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, HarnessInspection } from "@earendil-works/pi-durable";
import { FencedError } from "./errors.ts";
import type { DurableRun, RunLease } from "./run.ts";

/**
 * What parking and drain need of a run: its Harness, and the lease's status write and release. A `DurableRun` is one;
 * a host that owns its Harness over `openRunLease` gets one from `leaseParkTarget`.
 */
export type ParkTarget = Pick<DurableRun, "harness" | "fenced" | "setStatus" | "release">;

/**
 * The park target of a Harness the host opened over `lease`: the wake goes through `lease.setStatus`, and the release
 * closes the Harness (running work is aborted with no outcome recorded) and then releases the lease. A rejecting close
 * is a fence, as in `DurableRun.release`.
 */
export function leaseParkTarget(lease: RunLease, harness: Harness, context: Context = BACKGROUND_CONTEXT): ParkTarget {
  return {
    harness,
    get fenced() {
      return lease.fenced;
    },
    setStatus: (status, detail, options) => lease.setStatus(status, detail, options),
    async release() {
      try {
        await harness.close(context);
      } catch (error) {
        throw lease.fence(error instanceof FencedError ? error : new FencedError("closing the Harness failed, so the claim cannot be trusted", { cause: error }));
      }
      await lease.release();
    },
  };
}

/** localHost's threshold, far above twice its start (about 1.5 s); Cloudflare and Rivet park pi after 60 s too. */
export const LOCAL_PARK_THRESHOLD_MS = 60_000;

export type BusyState =
  | { readonly kind: "busy" }
  | { readonly kind: "idle" }
  /** Every task that could run sleeps until at least `until` (epoch ms, pi's clock), further away than the threshold. */
  | { readonly kind: "waiting"; readonly until: number };

/**
 * The deadline of a task that is only sleeping: `until` in pi's retry phase (generation and compaction), `pollAt` in
 * its deferred poll phase. This is pi-durable 1.0.4's internal checkpoint shape (harness/generation.js, compaction.js),
 * read here and nowhere else. Any other shape is no deadline, which counts as busy, so a pi that changes the shape keeps
 * instances up rather than parking them mid-work. pi#10325 asks for this as a contract.
 */
export function waitDeadline(checkpoint: JsonValue | undefined): number | undefined {
  if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint)) return undefined;
  const at = checkpoint.phase === "retry" ? checkpoint.until : checkpoint.phase === "poll" ? checkpoint.pollAt : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/**
 * Whether the run's live work needs this instance. A task that runs or is ready to run does, unless it only sleeps
 * until a deadline more than `thresholdMs` away. Waiting and completing tasks depend on other tasks, which decide; a
 * blocked task (no registered definition can take it) never runs, so it never keeps the instance up. A closing
 * Harness, a task state this code does not know, and unsettled submissions with no live task all count as busy.
 */
export function busyState(inspection: HarnessInspection, now: number, thresholdMs: number): BusyState {
  if (inspection.scheduling === "closing") return { kind: "busy" };
  let until: number | undefined;
  let live = false;
  for (const task of inspection.tasks) {
    const kind = task.state.kind as string;
    if (kind === "waiting" || kind === "completing" || kind === "blocked") continue;
    if (kind !== "running" && kind !== "ready") return { kind: "busy" };
    live = true;
    const deadline = waitDeadline(task.record.state.checkpoint);
    if (deadline === undefined || deadline - now <= thresholdMs) return { kind: "busy" };
    until = Math.min(until ?? deadline, deadline);
  }
  if (until !== undefined) return { kind: "waiting", until };
  if (!live && inspection.tasks.length === 0 && inspection.submissions.length > 0) return { kind: "busy" };
  return { kind: "idle" };
}

/** The default wake: run.json `sleeping` with `wakeAt` (null: idle, started on demand), written durably. */
export function recordWake(run: Pick<ParkTarget, "setStatus">, at: number | null): Promise<void> {
  return run.setStatus("sleeping", { reason: at === null ? "idle" : "waiting" }, { wakeAt: at === null ? null : new Date(at).toISOString() });
}

export interface ParkOptions {
  /** A wait no longer than this keeps the instance up: per driver, at least twice the time the driver takes to start one. */
  readonly thresholdMs: number;
  /** Park a run with no live work once it stayed so this long; default never (only a request can wake an idle run). */
  readonly idleMs?: number;
  /**
   * Record the wake before the release; default `recordWake`. A rejection that is not a fence keeps the instance up
   * and pi's own timer ends the wait. A failed run.json write is a fence, as every error writing the claim's own files
   * is: the instance exits 75 and the supervisor resumes the run after the lease.
   */
  readonly wake?: (run: ParkTarget, at: number | null) => Promise<void>;
  /** Something outside pi needs the instance (an open request): it never parks while this returns true. */
  readonly keepAwake?: () => boolean;
  /** Stop admitting new work before the last check; returns the undo for a park that is called off. */
  readonly quiesce?: () => () => void;
  /** pi's clock (HarnessOptions.now); default Date.now. */
  readonly now?: () => number;
  readonly log?: (event: string, detail: Record<string, JsonValue>) => void;
}

export type ParkResult = { readonly wakeAt: number | null; readonly blocked: number };

export interface Parking {
  /** Settles once the run parked and was released; stays pending while the instance stays up. */
  readonly parked: Promise<ParkResult>;
  /** Look again now (call it when `keepAwake` turns false). */
  check(): void;
  /** No new attempt; resolves with the park that was already under way, if any finished. */
  stop(): Promise<ParkResult | undefined>;
}

/**
 * Watch `run` and park it when its work allows. Checks after every commit (pi's listener must not call pi,
 * so the check runs after it returns), on `check()`, and when an idle period ends. Parking stops admission, checks
 * once more, records the wake, then releases: the wake is always written before the claim goes.
 */
export function watchParking(run: ParkTarget, options: ParkOptions): Parking {
  const now = options.now ?? Date.now;
  const wake = options.wake ?? recordWake;
  const log = options.log ?? (() => {});
  const idleMs = options.idleMs ?? Number.POSITIVE_INFINITY;
  let checking = false;
  let dirty = false;
  let stopped = false;
  let idleSince: number | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let attempt: Promise<ParkResult | undefined> | undefined;
  const settled = {} as { promise: Promise<ParkResult>; resolve(r: ParkResult): void; reject(e: unknown): void };
  settled.promise = new Promise<ParkResult>((resolve, reject) => Object.assign(settled, { resolve, reject }));

  const classify = async () => {
    const inspection = await run.harness.inspect(BACKGROUND_CONTEXT);
    const blocked = inspection.tasks.filter((t) => t.state.kind === "blocked");
    return { state: busyState(inspection, now(), options.thresholdMs), blocked };
  };

  const armIdle = (state: BusyState) => {
    if (state.kind !== "idle" || !Number.isFinite(idleMs)) {
      idleSince = undefined;
      clearTimeout(idleTimer);
      return false;
    }
    idleSince ??= now();
    const left = idleSince + idleMs - now();
    if (left <= 0) return true;
    clearTimeout(idleTimer);
    // Not unref'd: a park that is due is pending work, and nothing else may be keeping the process alive.
    idleTimer = setTimeout(check, left);
    return false;
  };

  const park = async (): Promise<ParkResult | undefined> => {
    const undo = options.quiesce?.() ?? (() => {});
    const { state, blocked } = await classify();
    const due = state.kind === "waiting" || (state.kind === "idle" && armIdle(state));
    if (stopped || !due || options.keepAwake?.()) {
      undo();
      return undefined;
    }
    for (const t of blocked) {
      log("blocked task does not keep the instance up", { task: t.record.id, kind: t.record.kind, reason: t.state.kind === "blocked" ? t.state.reason : null });
    }
    const at = state.kind === "waiting" ? state.until : null;
    try {
      await wake(run, at);
    } catch (error) {
      undo();
      // A fence already ends the instance; anything else leaves the wait to pi's own timer.
      if (!(error instanceof FencedError) && !run.fenced) log("wake not recorded; staying up through the wait", { wakeAt: at, error: (error as Error).message ?? String(error) });
      return undefined;
    }
    stopped = true;
    unsubscribe();
    clearTimeout(idleTimer);
    try {
      await run.release();
    } catch (error) {
      settled.reject(error);
      throw error;
    }
    const result = { wakeAt: at, blocked: blocked.length };
    settled.resolve(result);
    return result;
  };

  async function loop(): Promise<void> {
    if (checking) {
      dirty = true;
      return;
    }
    checking = true;
    try {
      do {
        dirty = false;
        if (stopped || run.fenced) return;
        if (options.keepAwake?.()) {
          // An open request is activity: an idle period starts again after it.
          armIdle({ kind: "busy" });
          return;
        }
        const { state } = await classify();
        if (stopped) return;
        if (state.kind === "waiting" || armIdle(state)) {
          attempt = park();
          if (await attempt) return;
        }
      } while (dirty && !stopped);
    } catch (error) {
      if (!run.fenced) log("park check failed", { error: (error as Error).message ?? String(error) });
    } finally {
      checking = false;
    }
  }

  function check(): void {
    queueMicrotask(() => void loop());
  }

  const unsubscribe = run.harness.subscribeCommits(() => check());
  settled.promise.catch(() => {});
  check();
  return {
    parked: settled.promise,
    check,
    async stop() {
      const inFlight = attempt;
      stopped = true;
      unsubscribe();
      clearTimeout(idleTimer);
      return inFlight ? inFlight.catch(() => undefined) : undefined;
    },
  };
}

export interface DrainOptions {
  /** Epoch ms after which the drain gives up and the run is released with its work interrupted. */
  readonly deadline: number;
  readonly now?: () => number;
}

/**
 * Wait until no task needs this instance, or until `deadline`, rechecking after every commit.
 * Any sleeping task counts as waiting here, however short its wait: closing ends the sleep and the next open resumes it.
 * Returns the last classification: `busy` means the deadline passed with work running, which the release interrupts
 * and the next open resumes (safe tools rerun, unsafe ones report the interruption).
 */
export async function drain(run: Pick<ParkTarget, "harness">, options: DrainOptions): Promise<BusyState> {
  const now = options.now ?? Date.now;
  let changed = () => {};
  let timedOut = false;
  const unsubscribe = run.harness.subscribeCommits(() => changed());
  const timer = setTimeout(() => {
    timedOut = true;
    changed();
  }, Math.max(0, options.deadline - Date.now()));
  try {
    for (;;) {
      // Armed before the check, so a commit during the check is not missed.
      const next = new Promise<void>((resolve) => (changed = resolve));
      const state = busyState(await run.harness.inspect(BACKGROUND_CONTEXT), now(), 0);
      if (state.kind !== "busy" || timedOut) return state;
      await next;
    }
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
