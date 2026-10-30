// A session's drive over its records: the kernel the copied harness code runs on. Written for AgentRun.
//
// An effect is an intent (`kernel.start`), then at most one outcome (`kernel.end`), both durable before the code that
// follows them goes on: a completed or failed key is answered from its records and never run again. One drive holds a
// session at a time, and the store enforces it: a drive writes through the session's writer, which a newer open of the
// session fences, so a stale drive's next write is refused and it gets a `Restart`, never a result. So when a drive
// opens, an intent with no outcome was cut off by the process that wrote it: a `safe` one is released to run again (`kernel.retry`), a `never` one is recorded failed and interrupted
// ("it may or may not have taken effect") and is never run again. Input is a `kernel.submission` record; an effect that
// names submissions in `placed` takes them out of `pending()` at its intent, and a withdraw written before that wins:
// that placement places nothing and its effect throws `Restart`.
import { SessionFenced } from "../errors.js";
import type { SessionRecord, SessionWriter } from "../types.js";
import { EffectFailure, EffectInterrupted, Fatal, Restart } from "./errors.js";
import type { DriveContext, EffectIO, EffectOptions, EffectRecord, HostToolIO, SessionState, Submission } from "./types.js";

export const KERNEL_RECORDS = {
  submission: "kernel.submission",
  start: "kernel.start",
  end: "kernel.end",
  retry: "kernel.retry",
} as const;

/** What an interrupted `never` effect's error says. */
export const INTERRUPTED_TEXT = "interrupted: the process running it stopped before it reported an outcome; it may or may not have taken effect";

type StartData = { key: string; stepId: string; name: string; replay: EffectRecord["replay"]; input: unknown; placed: string[]; attempt: number; startedAt: string };
type EndData = { stepId: string; status: "completed" | "failed"; output?: unknown; error?: EffectRecord["error"] };
type SubmissionData = Omit<Submission, "receivedAt"> & { receivedAt: string };
type SubmissionInput = Omit<Submission, "receivedAt"> & { receivedAt?: Date };

/** A record-only effect: its outcome is known before it is written, so its intent and its outcome land together. It
 *  places nothing. */
export interface RecordOnlyEffect {
  key: string;
  options: Omit<EffectOptions, "placed">;
  output: unknown;
}

const submissionRecord = ({ receivedAt, ...rest }: SubmissionInput): SessionRecord => ({ kind: KERNEL_RECORDS.submission, data: { ...rest, receivedAt: (receivedAt ?? new Date()).toISOString() } as never });
/** An effect's intent, under its key's next attempt. */
function intentRecord(state: SessionState, k: string, options: EffectOptions): { stepId: string; record: SessionRecord } {
  const known = state.effects.get(k);
  const attempt = known ? known.attempt + 1 : 0;
  const stepId = `${k}#${attempt}`;
  return { stepId, record: { kind: KERNEL_RECORDS.start, data: { key: k, stepId, name: options.name, replay: options.replay, input: options.input as never, placed: options.placed ?? [], attempt, startedAt: new Date().toISOString() } } };
}
const outcomeRecord = (stepId: string, outcome: Omit<EndData, "stepId">): SessionRecord => ({ kind: KERNEL_RECORDS.end, data: { stepId, ...outcome } as never });
const completedRecord = (stepId: string, output: unknown) => outcomeRecord(stepId, { status: "completed", output: output === undefined ? null : output });

/** A record-only effect's records, as `effect` writes an effect's: its intent, then its outcome. */
function effectRecords(state: SessionState, effect: RecordOnlyEffect): SessionRecord[] {
  const { stepId, record } = intentRecord(state, effect.key, effect.options);
  return [record, completedRecord(stepId, effect.output)];
}

/** The state a session's records fold to. */
export function foldSession(runId: string, records: readonly SessionRecord[]): SessionState {
  const state: SessionState = { runId, status: "running", submissions: [], placed: new Set(), withdrawn: new Set(), effects: new Map(), effectOrder: [] };
  const byStep = new Map<string, EffectRecord>();
  for (const record of records) {
    if (record.kind === KERNEL_RECORDS.submission) {
      const data = record.data as unknown as SubmissionData;
      if (state.submissions.some((s) => s.id === data.id)) continue;
      state.submissions.push({ ...data, receivedAt: new Date(data.receivedAt) });
      // A withdraw lands only while its target is not placed yet.
      if (data.kind === "withdraw" && data.target && !state.placed.has(data.target)) state.withdrawn.add(data.target);
    } else if (record.kind === KERNEL_RECORDS.start) {
      const data = record.data as unknown as StartData;
      const existing = state.effects.get(data.key);
      // A key's first intent wins; a later one is the same key run again after a release.
      if (existing && existing.status !== "pending") continue;
      // A placement a withdraw beat places nothing, not even its other submissions: the effect that wrote it is
      // refused (`Restart`), and the next drive places what is still pending.
      const placed = data.placed.some((id) => state.withdrawn.has(id)) ? [] : data.placed;
      const effect: EffectRecord = { key: data.key, stepId: data.stepId, name: data.name, replay: data.replay, input: data.input, status: "running", attempt: data.attempt, startedAt: new Date(data.startedAt), placed };
      if (existing) Object.assign(existing, effect, { output: undefined, error: undefined });
      else { state.effects.set(data.key, effect); state.effectOrder.push(effect); }
      byStep.set(data.stepId, existing ?? effect);
      for (const id of placed) state.placed.add(id);
    } else if (record.kind === KERNEL_RECORDS.end) {
      const data = record.data as unknown as EndData;
      const effect = byStep.get(data.stepId);
      // An outcome applies only to an effect that is running under that step.
      if (!effect || effect.status !== "running" || effect.stepId !== data.stepId) continue;
      effect.status = data.status;
      if (data.status === "completed") effect.output = data.output;
      else effect.error = data.error ?? { message: "failed" };
    } else if (record.kind === KERNEL_RECORDS.retry) {
      const effect = byStep.get((record.data as { stepId: string }).stepId);
      if (effect && effect.status === "running") effect.status = "pending";
    }
  }
  return state;
}

export function pendingSubmissions(state: SessionState): Submission[] {
  return state.submissions.filter((s) => s.kind !== "withdraw" && !state.placed.has(s.id) && !state.withdrawn.has(s.id));
}

export function hostToolIO(io: EffectIO, ctx: DriveContext, overrides: { signal?: AbortSignal; progress?: (chunk: unknown) => void } = {}): HostToolIO {
  return { signal: overrides.signal ?? io.signal, progress: overrides.progress ?? io.progress, ctx, stepId: io.stepId };
}

export interface OpenDriveOptions {
  /** The session's writer (`SessionStore.open`): the drive writes only through it, and its key is the session's. */
  writer: SessionWriter;
  signal: AbortSignal;
  config?: unknown;
  attempt?: number;
  deadline?: number;
  live?: (event: unknown) => void;
  halt?: (reason: unknown) => void;
}

export interface Drive extends DriveContext {
  /** Record new input for the session (the door's accepted submission, or a withdraw). Resolves once it is durable. */
  submit(submission: SubmissionInput): Promise<void>;
  /** Write record-only effects whole, after `before` (input that must land with them), in one append, under `effect`'s
   *  guards: a halted drive writes nothing; a key running or in flight in this drive is `Fatal`; a key another write
   *  took first is a `Restart`. */
  recordOnly(effects: readonly RecordOnlyEffect[], options?: { before?: readonly SubmissionInput[] }): Promise<void>;
}

/** Open the session's drive: fold its records and resolve whatever a dead process left open. */
export async function openDrive(options: OpenDriveOptions): Promise<Drive> {
  const { writer } = options;
  const key = writer.key;
  let records = await writer.read();
  let state = foldSession(key, records);
  const appendNow = async (written: SessionRecord[]) => {
    try {
      await writer.append(written);
    } catch (error) {
      // A newer drive holds the session: this one must rebuild from the log, and nothing it was writing counts.
      if (error instanceof SessionFenced) throw new Restart(`agentrun-kernel: ${error.message}`);
      throw error;
    }
    records = [...records, ...written];
    state = foldSession(key, records);
  };
  // Appends go to the writer one at a time, in call order, so the state folds records in the order the log holds
  // them even when a submit's input and an effect's intent are written at once and a writer resolves them out of order.
  let queue: Promise<unknown> = Promise.resolve();
  const append = (written: SessionRecord[]): Promise<void> => {
    const run = queue.then(() => appendNow(written));
    queue = run.catch(() => undefined);
    return run;
  };
  // One drive holds the session: an intent with no outcome belongs to a process that is gone.
  const abandoned = state.effectOrder.filter((e) => e.status === "running");
  if (abandoned.length) {
    await append(abandoned.map((e): SessionRecord => e.replay === "safe"
      ? { kind: KERNEL_RECORDS.retry, data: { stepId: e.stepId } }
      : { kind: KERNEL_RECORDS.end, data: { stepId: e.stepId, status: "failed", error: { message: INTERRUPTED_TEXT, interrupted: true } } }));
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const hints = new Set<(hint: { eventType: "hook_received" | "reconnect" }) => void>();

  // Keys this drive has begun and not finished, reserved before the first await: two calls issued together cannot both
  // pass the checks below and dispatch one effect twice.
  const inflight = new Set<string>();
  const drive: Drive = {
    runId: key,
    // The copied code's own writes (a journal's blobs) go through the same queue as the drive's.
    world: { store: { key: writer.key, read: () => writer.read(), append: (written) => append([...written]) } },
    config: options.config,
    attempt: options.attempt ?? 0,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    signal,
    state: () => state,
    isMemoized: (k) => {
      const status = state.effects.get(k)?.status;
      return status === "completed" || status === "failed";
    },
    pending: () => pendingSubmissions(state),
    // No read: this drive is the session's only writer, so its records are the whole log, and a read that resolved
    // after a newer append would put older state back.
    async refresh() {
      state = foldSession(key, records);
    },
    live: (event) => options.live?.(event),
    onHint(listener) {
      hints.add(listener);
      return () => { hints.delete(listener); };
    },
    halt(reason) {
      if (!controller.signal.aborted) controller.abort(reason);
      options.halt?.(reason);
    },
    async submit(submission) {
      await append([submissionRecord(submission)]);
      for (const listener of [...hints]) listener({ eventType: "hook_received" });
    },
    async recordOnly(effects, recordOptions = {}) {
      if (signal.aborted) throw signal.reason;
      for (const { key: k } of effects) {
        const known = state.effects.get(k);
        if (known?.status === "running" || inflight.has(k)) throw new Fatal(`agentrun-kernel: effect ${k} is already running in this drive`);
        if (known && known.status !== "pending") throw new Restart(`agentrun-kernel: effect ${k} was written first by another write; the drive must be rebuilt`);
      }
      // Reserved before the first await, as `effect` reserves its key: no other write of these keys can begin meanwhile.
      for (const { key: k } of effects) inflight.add(k);
      try {
        const before = recordOptions.before ?? [];
        await append([...before.map(submissionRecord), ...effects.flatMap((effect) => effectRecords(state, effect))]);
        if (before.length) for (const listener of [...hints]) listener({ eventType: "hook_received" });
      } finally {
        for (const { key: k } of effects) inflight.delete(k);
      }
    },
    async effect<T>(k: string, effectOptions: EffectOptions, fn: (io: EffectIO) => Promise<T>): Promise<T> {
      const known = state.effects.get(k);
      if (known?.status === "completed") return known.output as T;
      if (known?.status === "failed") throw new EffectFailure(known.error ?? { message: "failed" });
      if (known?.status === "running" || inflight.has(k)) throw new Fatal(`agentrun-kernel: effect ${k} is already running in this drive`);
      if (signal.aborted) throw signal.reason;
      const placing = effectOptions.placed ?? [];
      // A withdraw already in the log beat this placement: refuse before writing anything, so no intent is left for
      // recovery to report. One appended but not folded yet is caught after the intent, below.
      if (placing.some((id) => state.withdrawn.has(id))) throw new Restart(`agentrun-kernel: effect ${k} would place a withdrawn submission; the drive must be rebuilt`);
      inflight.add(k);
      try {
        const { stepId, record } = intentRecord(state, k, { ...effectOptions, placed: placing });
        await append([record]);
        // A withdraw appended while this intent was being written beat the placement: what the caller would send next
        // is not what the log placed, so it must rebuild instead of running.
        if (placing.length && state.effects.get(k)?.placed.length !== placing.length) throw new Restart(`agentrun-kernel: effect ${k} placed a withdrawn submission; the drive must be rebuilt`);
        const partial: unknown[] = [];
        let output: T;
        try {
          output = await fn({ signal, stepId, progress: (chunk) => { partial.push(chunk); } });
        } catch (error) {
          // The drive is stopping, or must be rebuilt: no outcome is written; the next drive resolves the intent.
          if (signal.aborted || error instanceof Restart || error instanceof Fatal) throw error;
          const failed = { message: String((error as Error)?.message ?? error), ...(error instanceof EffectInterrupted ? { interrupted: true } : {}), ...(partial.length ? { partial } : {}) };
          await append([outcomeRecord(stepId, { status: "failed", error: failed })]);
          throw new EffectFailure(failed);
        }
        await append([completedRecord(stepId, output)]);
        return output;
      } finally {
        inflight.delete(k);
      }
    },
  };
  return drive;
}
