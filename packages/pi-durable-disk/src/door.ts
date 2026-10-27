// The serve door's hook (`AppOptions.door`): a harness of the app's own takes the door's input instead of pi's root
// conversation. The door keeps one journal per requestId in the root conversation: a `door.input` entry admits the
// input, through the run's fenced commit, before the hook sees it; `door.status` entries settle it. A requestId reaches
// `hook.submit` at most once, across incarnations: a retry answers the record's current status. Each entry is indexed by
// a done write submission whose requestId is the door's key, so a lookup is pi's `submissionByRequest`, not a scan.
import type { ConversationId, Tx, UserInput } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { processTable } from "./process-table.ts";
import type { DurableRun } from "./run.ts";

export type DoorStatus = "ADMITTED" | "ACCEPTED" | "REJECTED_BUSY" | "FAILED" | "UNKNOWN";

export interface DoorInput {
  readonly requestId: string;
  readonly content: UserInput;
  readonly whenBusy: "steer" | "followUp" | "reject";
}

export type DoorEvent = { readonly type: "run_start" } | { readonly type: "run_end" };

export interface DoorContext {
  readonly run: DurableRun;
  /** Aborted when the door stops waiting: at the submit bound, or at the abort bound. */
  readonly signal: AbortSignal;
  /** A turn's start and end, merged into `GET /events` in order with the conversation's entries. */
  emit(event: DoorEvent): void;
  /** A child the harness runs in, started as its own process group (`detached`): a drain kills the group before the exit. */
  adopt(pid: number): void;
}

/**
 * A harness behind the door. Its duty besides the three calls: emit `run_end` when its turn ends in any way, above all
 * the ways the door cannot see (its child dies, its turn errors inside the harness). The door pairs a `run_start` itself
 * only at the points it controls: `submit` throwing after it, a second `run_start`, an abort that leaves the hook idle,
 * the door's stop (a drain, a fence, a park) and a stream's end.
 */
export interface DoorHook {
  /** Resolves when the input is TAKEN, not when the turn ends; the turn runs after, reported through `ctx.emit` and the conversation's entries. */
  submit(input: DoorInput, ctx: DoorContext): Promise<{ accepted: true } | { accepted: false; reason: "busy" }>;
  abort(ctx: DoorContext): Promise<"aborted" | "idle">;
  busy(): boolean;
}

export type DoorRecord = { readonly status: DoorStatus; readonly message?: string };

export interface DoorTimeouts {
  /** How long `hook.submit` may take to take an input before its outcome is UNKNOWN; default 30 s. */
  readonly submitMs?: number;
  /** How long `hook.abort` may take, on `POST /abort`, at the submit bound and in a drain; default 5 s. */
  readonly abortMs?: number;
}

/** The event the door writes for an emitted one: pi's run event, with no pi submissions. */
export type DoorRunEvent = { readonly type: "run_start" | "run_end"; readonly inputs: readonly [] };

const TIMEOUT = Symbol("timeout");
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<typeof TIMEOUT>((resolve) => (timer = setTimeout(() => resolve(TIMEOUT), ms).unref()))]).finally(() => clearTimeout(timer));
}

// 0: the admission; 1: the outcome; 2: the late outcome of an UNKNOWN. A requestId has no space, so no key collides.
const key = (requestId: string, n: 0 | 1 | 2) => (n === 0 ? `door ${requestId}` : `door ${requestId} ${n}`);

/** The record's current status: its last entry. */
async function recordOf(tx: Tx, root: ConversationId, requestId: string): Promise<DoorRecord | undefined> {
  const admitted = await tx.submissionByRequest(root, key(requestId, 0));
  if (admitted === undefined) return undefined;
  const last = (await tx.submissionByRequest(root, key(requestId, 2))) ?? (await tx.submissionByRequest(root, key(requestId, 1))) ?? admitted;
  const { status, message } = (await tx.entry(last.entry!))!.data as DoorRecord;
  return message === undefined ? { status } : { status, message };
}

async function append(tx: Tx, root: ConversationId, requestId: string, n: 0 | 1 | 2, kind: string, data: Record<string, unknown>): Promise<void> {
  const entry = await tx.appendEntry(root, { kind, data: data as never });
  await tx.createSubmission({ conversationId: root, requestId: key(requestId, n), type: "write", status: "done", entry: entry.id });
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const startOf = (pid: number): number | undefined => {
  try {
    return processTable().snapshot().info(pid)?.start;
  } catch {
    return undefined;
  }
};

/**
 * SIGKILL an adopted child's process group, or the process when it leads none, while it is the process that was adopted
 * (its start tells it from a later one with its pid); then wait, bounded, until it is gone.
 */
async function killGroup(pid: number, start: number | undefined): Promise<void> {
  if (start === undefined || startOf(pid) !== start) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
      break;
    } catch {
      // no such group: try the process
    }
  }
  // The process table lists no zombie: a killed child of this process is gone before node reaps it.
  for (const deadline = Date.now() + 2_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (startOf(pid) !== start) return;
  }
}

export interface Door {
  /** Admit `input` in the root conversation and hand it to the hook once; the record's status, now. */
  submit(root: ConversationId, input: DoorInput, context: Context): Promise<DoorRecord>;
  abort(): Promise<"aborted" | "idle" | typeof TIMEOUT>;
  busy(): boolean;
  /** A hook call in flight or a busy hook: keeps the instance up. */
  readonly working: boolean;
  /** A run_start not yet paired. */
  readonly turnOpen: boolean;
  /** Receive the door's run events; returns the unsubscribe. */
  watch(listener: (event: DoorRunEvent) => void): () => void;
  /** When the instance ends (a drain, a fence, a park): abort the hook (bounded), pair an open run_start, kill every adopted child's process group. */
  stop(): Promise<void>;
}

export { TIMEOUT as DOOR_TIMEOUT };

export function openDoor(hook: DoorHook, run: DurableRun, base: Context, timeouts: DoorTimeouts = {}): Door {
  const submitMs = timeouts.submitMs ?? 30_000;
  const abortMs = timeouts.abortMs ?? 5_000;
  const listeners = new Set<(event: DoorRunEvent) => void>();
  const adopted = new Map<number, number | undefined>();
  let turnOpen = false;
  let pending = 0;
  const send = (type: DoorRunEvent["type"]) => {
    for (const listener of listeners) listener({ type, inputs: [] });
  };
  // run_end always pairs run_start: a second start ends the open turn first, an unpaired end is dropped.
  const emit = (event: DoorEvent) => {
    if (event.type === "run_start") {
      if (turnOpen) send("run_end");
      turnOpen = true;
      send("run_start");
    } else if (turnOpen) {
      turnOpen = false;
      send("run_end");
    }
  };
  const closeTurn = () => emit({ type: "run_end" });
  const contextOf = (signal: AbortSignal): DoorContext => ({ run, signal, emit, adopt: (pid) => void adopted.set(pid, startOf(pid)) });
  const settle = (root: ConversationId, requestId: string, n: 1 | 2, record: DoorRecord) =>
    run.harness.commit((tx) => append(tx, root, requestId, n, "door.status", { requestId, ...record }), base);
  const abortHook = () => {
    const stop = new AbortController();
    return within(
      Promise.resolve().then(() => hook.abort(contextOf(stop.signal))),
      abortMs,
    ).finally(() => stop.abort());
  };

  return {
    async submit(root, input, context) {
      const seen = await run.harness.commit(async (tx) => {
        const record = await recordOf(tx, root, input.requestId);
        if (record) return record;
        await append(tx, root, input.requestId, 0, "door.input", { requestId: input.requestId, content: input.content as never, whenBusy: input.whenBusy, status: "ADMITTED" });
        return undefined;
      }, context);
      if (seen) return seen;
      // Nothing reaches the hook once the lease is gone: the record stays ADMITTED, as a crash here leaves it.
      if (run.fenced || run.releasing) throw new Error("the run lost its lease after the admission");
      pending++;
      const stop = new AbortController();
      const taken = Promise.resolve()
        .then(() => hook.submit(input, contextOf(stop.signal)))
        .then(
          (r): DoorRecord => (r.accepted ? { status: "ACCEPTED" } : { status: "REJECTED_BUSY", message: "the harness is busy" }),
          (error: unknown): DoorRecord => {
            closeTurn();
            return { status: "FAILED", message: messageOf(error) };
          },
        )
        .finally(() => pending--);
      const first = await within(taken, submitMs);
      if (first !== TIMEOUT) {
        await settle(root, input.requestId, 1, first);
        return first;
      }
      stop.abort(new Error(`the hook did not take the input in ${submitMs} ms`));
      await abortHook().catch(() => undefined);
      const unknown: DoorRecord = { status: "UNKNOWN", message: `the hook did not take the input in ${submitMs} ms; its outcome is unknown` };
      const written = settle(root, input.requestId, 1, unknown);
      // A late outcome is never dropped: it settles the same record, unless the lease is gone (the fenced commit fails).
      void written.then(() => taken.then((late) => settle(root, input.requestId, 2, late))).catch(() => undefined);
      await written;
      return unknown;
    },
    async abort() {
      const result = await abortHook();
      if (result !== TIMEOUT && !hook.busy()) closeTurn();
      return result;
    },
    busy: () => hook.busy(),
    get working() {
      return pending > 0 || hook.busy();
    },
    get turnOpen() {
      return turnOpen;
    },
    watch(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async stop() {
      if (pending > 0 || hook.busy()) await abortHook().catch(() => undefined);
      closeTurn();
      await Promise.all([...adopted].map(([pid, start]) => killGroup(pid, start)));
    },
  };
}
