// A session's drive over its records: the kernel the copied harness code runs on. Written for AgentRun.
//
// An effect is an intent (`kernel.start`), then at most one outcome (`kernel.end`), both durable before the code that
// follows them goes on: a completed or failed key is answered from its records and never run again. One drive holds a
// session at a time (the run's lease), so when a drive opens, an intent with no outcome was cut off by the process that
// wrote it: a `safe` one is released to run again (`kernel.retry`), a `never` one is recorded failed and interrupted
// ("it may or may not have taken effect") and is never run again. Input is a `kernel.submission` record; an effect that
// names submissions in `placed` takes them out of `pending()` at its intent, and a withdraw written before that wins.
import type { SessionRecord, SessionStore } from "../types.js";
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
      // A placement a withdraw beat places nothing.
      const placed = data.placed.filter((id) => !state.withdrawn.has(id));
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
  store: SessionStore;
  /** The session's key in the store. */
  key: string;
  signal: AbortSignal;
  config?: unknown;
  attempt?: number;
  deadline?: number;
  live?: (event: unknown) => void;
  halt?: (reason: unknown) => void;
}

export interface Drive extends DriveContext {
  /** Record new input for the session (the door's accepted submission, or a withdraw). Resolves once it is durable. */
  submit(submission: Omit<Submission, "receivedAt"> & { receivedAt?: Date }): Promise<void>;
}

/** Open the session's drive: fold its records and resolve whatever a dead process left open. */
export async function openDrive(options: OpenDriveOptions): Promise<Drive> {
  const { store, key } = options;
  let records = await store.read(key);
  let state = foldSession(key, records);
  const append = async (written: SessionRecord[]) => {
    await store.append(key, written);
    records = [...records, ...written];
    state = foldSession(key, records);
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

  const drive: Drive = {
    runId: key,
    world: { store },
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
    async refresh() {
      records = await store.read(key);
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
      const { receivedAt, ...rest } = submission;
      await append([{ kind: KERNEL_RECORDS.submission, data: { ...rest, receivedAt: (receivedAt ?? new Date()).toISOString() } as never }]);
      for (const listener of [...hints]) listener({ eventType: "hook_received" });
    },
    async effect<T>(k: string, effectOptions: EffectOptions, fn: (io: EffectIO) => Promise<T>): Promise<T> {
      const known = state.effects.get(k);
      if (known?.status === "completed") return known.output as T;
      if (known?.status === "failed") throw new EffectFailure(known.error ?? { message: "failed" });
      if (known?.status === "running") throw new Fatal(`agentrun-adapters: effect ${k} is already running in this drive`);
      if (signal.aborted) throw signal.reason;
      const attempt = known ? known.attempt + 1 : 0;
      const stepId = `${k}#${attempt}`;
      await append([{ kind: KERNEL_RECORDS.start, data: { key: k, stepId, name: effectOptions.name, replay: effectOptions.replay, input: effectOptions.input as never, placed: effectOptions.placed ?? [], attempt, startedAt: new Date().toISOString() } }]);
      const partial: unknown[] = [];
      let output: T;
      try {
        output = await fn({ signal, stepId, progress: (chunk) => { partial.push(chunk); } });
      } catch (error) {
        // The drive is stopping, or must be rebuilt: no outcome is written; the next drive resolves the intent.
        if (signal.aborted || error instanceof Restart || error instanceof Fatal) throw error;
        const failed = { message: String((error as Error)?.message ?? error), ...(error instanceof EffectInterrupted ? { interrupted: true } : {}), ...(partial.length ? { partial } : {}) };
        await append([{ kind: KERNEL_RECORDS.end, data: { stepId, status: "failed", error: failed as never } }]);
        throw new EffectFailure(failed);
      }
      await append([{ kind: KERNEL_RECORDS.end, data: { stepId, status: "completed", output: (output === undefined ? null : output) as never } }]);
      return output;
    },
  };
  return drive;
}
