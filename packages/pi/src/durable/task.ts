// A workflow run as one pi-durable task: `agentrun.workflow`, version 1, one phase `run`. The phase opens the recovery
// driver on the document store, runs the interpreter to its end inside one invocation, and makes one terminal commit;
// every journal commit in between leaves the task's own state unchanged. The journal is what resumes: a process that
// dies leaves the task pending, and the next process's `resume()` runs the phase again, which answers what committed
// from the journal. Three rules from the task spike hold here:
//   - a typed failure is a committed outcome (`failed`, with the code in `error.detail`), never a throw, so pi records
//     it whole instead of faulting the task with a message;
//   - a pause is taken at a seam: the driver stops admitting, an effect in flight completes and commits, the journal
//     commits `paused`, and the task stays pending until the host closes the Harness; reopening continues it;
//   - a cancel is pi's `abortTask`, which returns once the task is marked, before it is terminal: pi ends the run
//     invocation and the conversations the task owns first, then the abort handler commits `cancelled` in the journal
//     and an `aborted` outcome. A cancelled run never resumes.
// A host that continues an escalated run (its ladder) does so inside the same invocation, through `escalated`, so the
// continuation it opens is a conversation the task owns: the run's stops reach it the way they reach the run's steps.
import { defineDocFamily, defineExtension, defineTask } from "@earendil-works/pi-durable";
import type { Extension, Harness, SettledTask, TaskId, TaskRecord, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import { runWorkflow, type Workflow, type WorkflowDeps } from "@parcha/agentrun-dsl";
import { bindingDigests, bindingMismatch, canonicalHash, isRecoveryError, openRecovery, recoveryBound, RecoveryError, withRecovery, type EscalationRow, type RecoveryAdapters, type RecoveryDriver, type RecoveryOptions } from "@parcha/agentrun-dsl/recovery";
import { storageError } from "./pi-versions.js";
import { documentStore, type DocumentStoreHost } from "./store.js";

type Context = Parameters<Harness["commit"]>[1];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** What one run is: its key (the same key reaches the same task and journal), the workflow as authored, its input, and
 *  what else must not change between two opens of it. */
export type WorkflowRequest = { key: string; workflow: Workflow; input: Record<string, unknown>; bind?: Record<string, unknown> };

/** How a run ended, as the host reads it. A pause is not an outcome: a paused run's task stays pending. */
export type WorkflowOutcome =
  | { status: "complete"; output: unknown; state: unknown }
  | { status: "escalated"; escalation: unknown; state: unknown; continuation?: unknown }
  | { status: "refused"; code: string; message: string; detail?: unknown }
  | { status: "stopped"; stop: "cancelled"; source?: string };

/** One invocation of a run's phase, as the host's adapters see it: a node runner that opens conversations owns them by
 *  `runtime.taskId`, so a cancel aborts them before the task. */
export type WorkflowInvocation = { key: string; taskId: TaskId; runtime: TaskRuntime<WorkflowRequest, TaskCheckpoint, WorkflowResult, object>; context: Context };

/** The host's part, asked once per invocation. */
export type WorkflowTaskHost = {
  /** The driver's host options, beside the run's key and binding: asked before the driver opens, by the run's phase and
   *  by its abort handler. A host settles an effect a killed process left unknown with `reconcile`: the driver calls it
   *  once, through its own open of the run, with the unknown effects and a `complete` that records one's result. An
   *  effect it completes is answered from that result and not dispatched again; one it leaves is refused at resume. Do not
   *  open the run's journal here: that open is a generation of its own. The task's abort handler opens the driver too, to
   *  record a cancel, so `reconcile` also runs then; `phase` is `"abort"` there and `"run"` for the run's own open, and a
   *  host that wants no reconcile during a cancel returns none for `"abort"`. */
  options?(invocation: WorkflowInvocation & { phase: "run" | "abort" }): Omit<RecoveryOptions, "key" | "bind"> | Promise<Omit<RecoveryOptions, "key" | "bind">>;
  /** What the interpreter runs with, asked once the driver is open, so a host that composes its own couplings over the
   *  driver (its spend, its sessions, its escalation rows) builds them here. */
  run(invocation: WorkflowInvocation & { driver: RecoveryDriver }): WorkflowHostParts | Promise<WorkflowHostParts>;
  /** The host's ladder: a run that did not complete and was not refused continues here, inside the task's invocation,
   *  so what the host opens (its continuation) is owned by the task, and a cancel aborts it before the task. The host
   *  commits the escalation row through `invocation.driver.escalate` before anything acts on it; a run reopened after
   *  that commit comes here again with the row, and the interpreter does not run. `invocation.signal` ends with the
   *  run's stops: a pause leaves the task pending, and the next open comes here again with the row. What it returns
   *  rides on the escalated outcome as `continuation`; a throw is the run's failure. Absent, an escalated run ends with
   *  the interpreter's escalation and any failure is the run's. */
  escalated?(ending: WorkflowEnding, invocation: WorkflowInvocation & { driver: RecoveryDriver; signal: AbortSignal }): Promise<unknown>;
};
/** Why a run continues on the host's ladder: a gate that fired (`escalation`), a failure that is not a refusal
 *  (`error`), a refusal found before any step (`refusal`), or an escalation an earlier invocation committed (`row`).
 *  `state` is the run's state at that point. */
export type WorkflowEnding = {
  escalation?: unknown; error?: unknown; refusal?: NonNullable<RecoveryDriver["preStepRefusal"]>; row?: EscalationRow; state: Record<string, unknown>;
};
/** The host's adapters, which the task wraps with `withRecovery` (`durableNodes`: the node runner answers a delivered step
 *  again from its own record), or the dependencies the host built over `invocation.driver` itself, which the task runs as
 *  they are, stopped by the run's signal too, with the host's own `interpret` when it runs its documents under its own
 *  policy (its view of the document, its lint): it is called as `runWorkflow` would be, and answers as it does. */
export type WorkflowHostParts =
  | { adapters: RecoveryAdapters; durableNodes?: boolean }
  | { deps: WorkflowDeps; interpret?: (workflow: Workflow, input: Record<string, unknown>, deps: WorkflowDeps) => ReturnType<typeof runWorkflow> };

/** A started run. `wait` resolves with the run's outcome once its task is terminal, and rejects with the storage's error
 *  when the Session failed at one. */
export type WorkflowRun = {
  key: string;
  taskId: TaskId<WorkflowResult>;
  /** `created`: this start made the task; `attached`: it was live; `settled`: it was terminal and is returned as it is. */
  started: "created" | "attached" | "settled";
  wait(context: Context): Promise<WorkflowOutcome>;
};

/** What a stop reached. A pause reaches a run only where it is live, in this process: `paused` once the run's work has
 *  stopped with the pause in its journal, `ended` when the run ended otherwise, `not-live` when it is not running here. A cancel is `abortTask`'s
 *  answer: `marked` (the task ends aborted later) or `terminal` (it already was). */
export type WorkflowStop = "paused" | "ended" | "not-live" | "marked" | "terminal";

type TaskCheckpoint = { phase: "run" };
/** A completed task's result: the outcomes that end a run without a refusal. */
type WorkflowResult = Extract<WorkflowOutcome, { status: "complete" | "escalated" }>;
/** A run's key and the task that runs it. A run started by an older build has a journal and no entry; its next start
 *  creates the task. */
type RunRecord = { task: number | null; stop: { action: "pause" | "cancel"; source: string | null } | null };
const RunDoc = defineDocFamily<RunRecord, null>({ kind: "agentrun.task", version: 1, scope: "session", family: true, initial: () => ({ task: null, stop: null }) });
/** Records a stop on a run's entry. A recorded cancel stands, so the first cancel names the run's source; a recorded
 *  pause is replaced by the stop that follows it. */
const recordStop = (run: RunRecord, stop: NonNullable<RunRecord["stop"]>) => { if (run.stop?.action !== "cancel") run.stop = stop; };
/** The source of the cancel a run's entry records. */
const cancelSource = (run: RunRecord | undefined) => (run?.stop?.action === "cancel" ? run.stop.source ?? undefined : undefined);
const cancelled = (source: string | undefined) => ({ status: "aborted" as const, reason: source ? `cancelled by ${source}` : "cancelled" });

const json = (value: unknown): Json => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
/** Why a request is not the run a task holds, or undefined when it is: the same binding (the workflow as authored and
 *  what the host binds beside it, as the driver binds its journal) and the same input, each by its canonical digest, so
 *  key order does not matter. The refusal is the driver's binding mismatch and names what moved: the workflow's parts,
 *  what the host binds, or the input's fields (`input.<field>`). Each part is compared over its own digests, so a bound
 *  key named like the input (`input`) hides neither; when both moved, the refusal holds both parts' messages and names. */
const requestMoved = (held: WorkflowRequest, asked: WorkflowRequest): RecoveryError | undefined => {
  const was = recoveryBound(held.workflow, held.bind), is = recoveryBound(asked.workflow, asked.bind);
  const parts = [
    was.binding !== is.binding && bindingMismatch(JSON.stringify(was.inputs), is.inputs),
    canonicalHash(held.input) !== canonicalHash(asked.input) && bindingMismatch(JSON.stringify(bindingDigests({ input: held.input })), bindingDigests({ input: asked.input })),
  ].filter((part): part is RecoveryError & { moved: string[] | null } => Boolean(part));
  if (parts.length < 2) return parts[0];
  return Object.assign(new RecoveryError(parts.map((part) => part.message).join("; "), "RUN_STORE_BINDING_MISMATCH"), { moved: parts.flatMap((part) => part.moved ?? []) });
};
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "WORKFLOW_FAILED";
};
const messageOf = (error: unknown): string => String((error as { message?: unknown } | null)?.message ?? error);
/** A failure's own fields that are plain JSON (a host's typed failure: its stage, its node, its cost), so the host can
 *  read back the failure it raised. The stack and the cause stay out. */
const ownFields = (error: unknown): Record<string, Json> => {
  const out: Record<string, Json> = {};
  if (!error || typeof error !== "object") return out;
  for (const [key, value] of Object.entries(error)) {
    if (key === "stack" || key === "cause" || value === undefined) continue;
    try { out[key] = json(value); } catch { /* not plain JSON: left out */ }
  }
  return out;
};

/** The document store over one invocation's commits: a commit after the task was aborted or the Harness closed is
 *  refused by pi, so the driver can never write past its run's end. The task is the journal's one owner across its
 *  invocations: its abort handler takes the journal over from a run invocation that never closed it. */
function invocationStore(runtime: WorkflowInvocation["runtime"], context: Context, key: string) {
  const host: DocumentStoreHost = {
    commit: async <T>(change: (tx: Tx) => T | Promise<T>): Promise<T> => {
      let result!: T;
      await runtime.commit(async (tx) => { result = await change(tx); return undefined; }, context);
      return result;
    },
  };
  return documentStore(host, key, { owner: `agentrun.workflow:${runtime.taskId}`, context });
}

/** Runs whose outcome this process could not commit (the Session refused the commit, as it does once a failed commit has
 *  poisoned it): nothing durable will ever end their task, so their waiters in this process get the run's own failure.
 *  One entry per run key and task, shared by every waiter of that task and by the invocation that fails. It is kept
 *  while a wait holds it, so a run that ended (or whose waits ended) leaves none; a failed one stays, so a later wait
 *  on the task fails too, until a start reaches the task again. */
type Uncommitted = { promise: Promise<never>; fail(error: unknown): void; failed: boolean; waits: number };
const uncommitted = new Map<string, Uncommitted>();
const uncommittedId = (key: string, taskId: unknown) => JSON.stringify([key, taskId]);
const uncommittedOf = (key: string, taskId: unknown) => {
  const id = uncommittedId(key, taskId);
  let entry = uncommitted.get(id);
  if (!entry) {
    let reject!: (error: unknown) => void;
    const promise = new Promise<never>((_, fail) => { reject = fail; });
    promise.catch(() => undefined);
    const made: Uncommitted = { promise, failed: false, waits: 0, fail: (error) => { made.failed = true; reject(error); } };
    entry = made;
    uncommitted.set(id, entry);
  }
  return entry;
};

/** Runs where this process holds them, by key: the driver a pause is handed to, and when the run ended. */
const live = new Map<string, { driver: RecoveryDriver; ended: Promise<void> }>();

/** The task definition, the extension that carries it, and the host's three operations on a run. */
export function createWorkflowExtension(host: WorkflowTaskHost): {
  extension: Extension;
  start(harness: Harness, request: WorkflowRequest, context: Context, options?: { conversationId?: number; background?: boolean; stop?: { action: "pause" | "cancel"; source?: string } }): Promise<WorkflowRun>;
  read(harness: Harness, key: string, context: Context): Promise<{ taskId: TaskId<WorkflowResult>; status: string; outcome?: WorkflowOutcome } | undefined>;
  stop(harness: Harness, key: string, action: "pause" | "cancel", context: Context, source?: string): Promise<WorkflowStop>;
} {
  /** The run's driver over its journal, with the host's options. */
  const openDriver = async (task: { id: TaskId; input: WorkflowRequest }, runtime: WorkflowInvocation["runtime"], context: Context, phase: "run" | "abort") => {
    const { key, workflow, bind } = task.input;
    const options = await host.options?.({ key, taskId: task.id, runtime, context, phase });
    return openRecovery(invocationStore(runtime, context, key), workflow, { ...options, key, ...(bind ? { bind } : {}) });
  };
  /** The driver, then what the interpreter runs with: a host that fails to give it lets the driver go. */
  const open = async (task: { id: TaskId; input: WorkflowRequest }, runtime: WorkflowInvocation["runtime"], context: Context) => {
    const driver = await openDriver(task, runtime, context, "run");
    try {
      const parts = await host.run({ key: task.input.key, taskId: task.id, runtime, context, driver });
      const deps: WorkflowDeps = "deps" in parts
        ? { ...parts.deps, signal: AbortSignal.any([driver.signal, runtime.signal, ...(parts.deps.signal ? [parts.deps.signal] : [])]) }
        : withRecovery(driver, { ...parts.adapters, signal: runtime.signal }, { durableNodes: parts.durableNodes });
      return { deps, driver, interpret: ("deps" in parts && parts.interpret) || runWorkflow };
    } catch (error) { await driver.close().catch(() => undefined); throw error; }
  };
  const failed = (error: unknown) => ({ status: "failed" as const, error: { message: messageOf(error), detail: { ...ownFields(error), code: codeOf(error) } } });
  type NextOutcome = ReturnType<typeof failed> | ReturnType<typeof cancelled> | { status: "completed"; result: WorkflowResult };

  const Workflow = defineTask<WorkflowRequest, TaskCheckpoint, WorkflowResult>({
    name: "agentrun.workflow", version: 1, initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const { key, workflow, input } = task.input;
        /** The run's one terminal commit. One the Session refuses (not an abort's) hands this process's waiters the run's
         *  own failure, or the refusal. */
        const commitEnd = async (outcome: NextOutcome, cause?: unknown) => {
          try { await runtime.commit(() => ({ status: "terminal", outcome }), context); }
          catch (error) { if (!runtime.signal.aborted) uncommittedOf(key, task.id).fail(cause ?? error); throw error; }
        };
        /** The invocation ends when the host closes the Harness, and the task stays pending. */
        const untilClosed = () => new Promise<void>((resolve) => { if (runtime.signal.aborted) resolve(); else runtime.signal.addEventListener("abort", () => resolve(), { once: true }); });
        let opened: Awaited<ReturnType<typeof open>>;
        try { opened = await open(task, runtime, context); }
        catch (error) {
          if (runtime.signal.aborted) throw error;
          // A run a later build stored in a schema this build does not know is left for that build: the task stays
          // pending, and this process's waiters get the refusal. Any other failure to open ends the run.
          if (codeOf(error) === "RECOVERY_SCHEMA_NEWER") {
            uncommittedOf(key, task.id).fail(error);
            await untilClosed();
            throw runtime.signal.reason;
          }
          await commitEnd(failed(error), error);
          return;
        }
        const { deps, driver, interpret } = opened;
        // A stop the run's entry records is the driver's before anything runs. The entry lets go of a pause once the
        // journal holds it, so the next start runs again. A failure here lets the driver go and is the run's failure,
        // as a failure to open is.
        let early: RunRecord["stop"];
        try {
          early = (await runtime.snapshot(RunDoc, key, context))?.stop ?? null;
          if (early?.action === "pause") {
            driver.stop({ action: "pause", ...(early.source ? { source: early.source } : {}) });
            await driver.flush().catch(() => undefined);
            await runtime.commit(async (tx) => { const run = await tx.doc(RunDoc, key, null); if (run.stop?.action === "pause") run.stop = null; return undefined; }, context);
          }
        } catch (error) {
          await driver.close().catch(() => undefined);
          if (runtime.signal.aborted) throw error;
          await commitEnd(failed(error), error);
          return;
        }
        let end!: () => void;
        live.set(key, { driver, ended: new Promise<void>((resolve) => { end = resolve; }) });
        let outcome: NextOutcome | undefined;
        let cause: unknown;
        const ladder = host.escalated;
        /** The run continues on the host's ladder; the row the host committed rides on the outcome. */
        const handOff = async (ending: WorkflowEnding) => {
          const continuation = await ladder!(ending, { key, taskId: task.id, runtime, context, driver, signal: AbortSignal.any([runtime.signal, driver.signal]) });
          await driver.flush();
          const row = driver.escalation();
          if (!row) throw Object.assign(new Error("The host continued the run without committing its escalation"), { code: "ESCALATION_NOT_COMMITTED" });
          return { status: "completed" as const, result: { status: "escalated" as const, escalation: json(row), state: json(ending.state), continuation: json(continuation) } };
        };
        /** A pause the driver took: the task stays pending until the host closes the Harness. */
        const paused = () => driver.signal.aborted && (driver.signal.reason as { code?: unknown } | undefined)?.code === "FROZEN_PAUSED";
        try {
          const prior = ladder ? driver.escalation() : undefined;
          if (early?.action === "cancel") {
            // A cancel recorded before pi marked the task (the process died between the two) is taken before any step
            // and before the host's ladder on a run reopened after its escalation: this invocation ends the run as the
            // abort handler would have.
            driver.stop({ action: "cancel", ...(early.source ? { source: early.source } : {}) });
            await driver.flush();
            outcome = cancelled(early.source ?? undefined);
          } else if (prior) { driver.checkStop(); outcome = await handOff({ row: prior, state: prior.state }); }
          else if (driver.preStepRefusal) {
            // A refusal found before any step: nothing runs. With a ladder, the host continues the run from it.
            if (!ladder) throw driver.preStepRefusal;
            outcome = await handOff({ refusal: driver.preStepRefusal, state: { ...input } });
          } else {
            let run: Awaited<ReturnType<typeof runWorkflow>> | undefined;
            try { run = await interpret(workflow, input, deps); }
            catch (error) {
              // A refusal, a stop or an abort never ladders.
              if (!ladder || runtime.signal.aborted || driver.signal.aborted || isRecoveryError(error)) throw error;
              outcome = await handOff({ error, state: driver.lastState() });
            }
            if (run) outcome = run.status === "complete"
              ? { status: "completed", result: { status: "complete", output: json(run.output), state: json(run.state) } }
              : ladder ? await handOff({ escalation: run.escalation, state: run.state })
                : { status: "completed", result: { status: "escalated", escalation: json(run.escalation), state: json(run.state) } };
          }
        } catch (error) {
          // An abort or a close: this invocation may not decide the outcome (its commits are refused), so it only ends.
          if (runtime.signal.aborted) throw error;
          if (!paused()) { outcome = failed(error); cause = error; }
        } finally {
          // A paused run stays live here until its invocation ends, so a pause handed over meanwhile is answered.
          if (!paused()) live.delete(key);
          await driver.close().catch(() => undefined);
          end();
        }
        if (paused() || !outcome) {
          // The pause is in the journal once the driver's commits have landed; the task stays pending, and its
          // invocation ends when the host closes the Harness.
          await new Promise<void>((resolve) => { if (runtime.signal.aborted) resolve(); else runtime.signal.addEventListener("abort", () => resolve(), { once: true }); });
          if (live.get(key)?.driver === driver) live.delete(key);
          throw runtime.signal.reason;
        }
        await commitEnd(outcome, cause);
      },
    },
    abort: async (task, runtime, context) => {
      const { key } = task.input;
      const source = cancelSource(await runtime.snapshot(RunDoc, key, context).catch(() => undefined));
      // The journal records the cancel, so no later open of it resumes. A journal the driver refuses (a binding that
      // moved, a checkpoint it cannot read) is left as it is; the task still ends aborted.
      try {
        const driver = await openDriver(task, runtime, context, "abort");
        driver.stop({ action: "cancel", ...(source ? { source } : {}) });
        await driver.close();
      } catch { /* the outcome below is committed whatever the journal said */ }
      await runtime.commit(() => ({ status: "terminal", outcome: cancelled(source) }), context);
    },
  });

  const outcomeOf = async (harness: Harness, settled: TaskRecord<unknown, unknown, WorkflowResult> | SettledTask<WorkflowResult>, key: string, context: Context): Promise<WorkflowOutcome | undefined> => {
    if (settled.state.status !== "terminal") return undefined;
    const outcome = settled.state.outcome;
    if (outcome.status === "completed") return outcome.result;
    if (outcome.status === "aborted") {
      const source = cancelSource(await harness.snapshot(RunDoc, key, context));
      return { status: "stopped", stop: "cancelled", ...(source ? { source } : {}) };
    }
    const error = (outcome as { error?: { message?: string; detail?: { code?: string } } }).error;
    return { status: "refused", code: error?.detail?.code ?? String(outcome.status).toUpperCase(), message: error?.message ?? String((outcome as { reason?: unknown }).reason ?? outcome.status), ...(error?.detail ? { detail: error.detail } : {}) };
  };
  const handle = (harness: Harness, key: string, taskId: TaskId<WorkflowResult>, started: WorkflowRun["started"]): WorkflowRun => ({
    key, taskId, started,
    wait: async (context) => {
      const failure = uncommittedOf(key, taskId);
      failure.waits += 1;
      try {
        const settled = await Promise.race([harness.waitForTask(taskId, context), failure.promise]);
        return (await outcomeOf(harness, settled, key, context))!;
      } catch (error) {
        // A Session that failed at a storage error rejects its waits with `SessionFailed` (pi-durable 1.2): the
        // waiters get the storage's error, as 1.1 gave it.
        throw storageError(error);
      } finally {
        // The last wait to end releases the entry, whether the task ended or the wait did; a failure keeps it.
        failure.waits -= 1;
        const id = uncommittedId(key, taskId);
        if (failure.waits === 0 && !failure.failed && uncommitted.get(id) === failure) uncommitted.delete(id);
      }
    },
  });

  return {
    extension: defineExtension({ name: "agentrun.workflow", tasks: [Workflow] }),
    /** Start the run `request.key` names, or reach the task that already runs it. The run's entry and its task are
     *  created in one commit, so two starts of one key make one task. A start that reaches a task asks for the run it
     *  holds: its workflow, what the host binds and its input are the task's, by canonical digest, so key order does not
     *  matter. One that asks for another run is refused with the driver's binding mismatch (`RUN_STORE_BINDING_MISMATCH`,
     *  its `moved` naming the workflow's parts, what the host binds, or the input's fields as `input.<field>`) and
     *  commits nothing: no task, no stop, no cancel. Another run takes another key. A live task is attached to; a task
     *  that ended complete, escalated or cancelled is returned as it is; one that ended refused, failed or faulted is
     *  replaced by a new task over the same journal, which refuses again until the host reconciles it. A journal an
     *  older build started, with no task, gets one here, and its driver checks the binding as it opens. A stop the host
     *  gave before the run started (`options.stop`) is recorded in the commit that creates or reaches the task, and is
     *  taken before anything runs. A cancel aborts the task before the scheduler runs it, so its abort handler commits
     *  it; one a process recorded and died before pi marked the task is taken by the run's next invocation, before any
     *  step and before the host's ladder. A pause is handed to the driver by the run's phase as it opens, before any
     *  step. So a pause given with a start that attaches to a run already running in this process is not taken now: it
     *  is recorded, and taken when the run's next invocation opens. `stop` pauses a run that is running here. */
    async start(harness, request, context, options = {}) {
      const conversationId = options.conversationId ?? (await harness.root(context)).id;
      const stop = options.stop ? { action: options.stop.action, source: options.stop.source ?? null } : null;
      const asked = json(request) as unknown as WorkflowRequest;
      const [taskId, started] = await harness.commit(async (tx) => {
        const run = await tx.doc(RunDoc, request.key, null);
        if (run.task !== null) {
          const prior = await tx.task(run.task as TaskId);
          // A request for another run than the task holds is refused, and the throw discards this commit.
          const moved = prior && requestMoved(prior.input as unknown as WorkflowRequest, asked);
          if (moved) throw moved;
          if (prior && prior.state.status !== "terminal") { if (stop) recordStop(run, stop); return [run.task, "attached"] as const; }
          const kept = prior?.state.status === "terminal" && (prior.state.outcome.status === "completed" || prior.state.outcome.status === "aborted");
          if (kept) return [run.task, "settled"] as const;
        }
        const id = await tx.createTask(Workflow, asked, { ownership: { kind: "conversation" }, conversationId: conversationId as never, ...(options.background ? { background: true } : {}) });
        run.task = id as number;
        run.stop = stop;
        return [id, "created"] as const;
      }, context);
      // A failure an earlier invocation of this task left in this process is not this one's; one still awaited is kept,
      // so the waiters it has and the invocation that may yet fail share it.
      const earlier = uncommittedId(request.key, taskId);
      if (uncommitted.get(earlier)?.failed) uncommitted.delete(earlier);
      if (stop?.action === "cancel" && started !== "settled") await harness.abortTask(taskId as TaskId, context);
      harness.resume();
      return handle(harness, request.key, taskId as TaskId<WorkflowResult>, started);
    },
    /** The run's task and, once it is terminal, its outcome; undefined when no start named the key. */
    async read(harness, key, context) {
      const run = await harness.snapshot(RunDoc, key, context);
      if (!run || run.task === null) return undefined;
      const record = await harness.getTask(run.task as TaskId<WorkflowResult>, context);
      if (!record) return undefined;
      const outcome = await outcomeOf(harness, record, key, context);
      return { taskId: record.id as TaskId<WorkflowResult>, status: record.state.status, ...(outcome ? { outcome } : {}) };
    },
    /** Pause or cancel the run. A pause resolves once the journal holds it (an effect in flight completes and commits
     *  first) or the run ended; the host then closes the Harness, and the task stays pending. A cancel resolves when pi
     *  has marked the task, before it is terminal; `wait` gives the aborted outcome. */
    async stop(harness, key, action, context, source) {
      if (action === "pause") {
        const running = live.get(key);
        if (!running) return "not-live";
        running.driver.stop({ action: "pause", ...(source ? { source } : {}) });
        // The run is paused once its work has stopped, not when the journal first holds the pause: a continuation the
        // host's ladder runs stops through the run's signal and may take a while, and the host lets go of the run only
        // after it has. Its driver's commits have landed by then.
        await running.ended;
        await running.driver.flush().catch(() => undefined);
        return running.driver.signal.aborted ? "paused" : "ended";
      }
      const taskId = await harness.commit(async (tx) => {
        const run = await tx.doc(RunDoc, key, null);
        if (run.task === null) return null;
        // A finished run keeps what ended it, and the first cancel of a live one names its source.
        if ((await tx.task(run.task as TaskId))?.state.status !== "terminal") recordStop(run, { action: "cancel", source: source ?? null });
        return run.task;
      }, context);
      if (taskId === null) return "not-live";
      return harness.abortTask(taskId as TaskId, context);
    },
  };
}
