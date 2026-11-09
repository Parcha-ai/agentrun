// What a claimed run's loop shares, whatever harness it drives (design: "Runners carry many loops"; kernel page: the loop
// is the run driver). The loop itself is runner/adapter-loop.ts, for every harness on the adapter contract, pi included
// (runner/adapters/pi.ts): it opens pi-durable's Harness on the run's journal (store.journal(claim), behind the runner's
// fence), so the session's tasks, entries and submissions ARE the run's journal and the kernel's one reader reads them.
//
// What the loop commits, each in one commit with what it stages there (the run row's patch, the command rows it takes),
// matched to that commit by Gate below:
// - a steer: the harness's own submission commit for it takes its row;
// - an ask: an `agentrun.ask` entry with the run parked; the answer: an `agentrun.answer` entry taking its row;
// - the end: an `agentrun.end` entry with the run's final state (ended, stopped with why, failed with why), taking a
//   stop's row.
// A park ends the loop with the asked call before its intent: the journal is sealed (every later commit refused) and the
// Harness closed, so nothing moves the call on; the next claim's recovery reruns it from the start, and the gate finds
// the answer. A lost claim or a shutdown seals the journal and ends the loop interrupted, writing nothing more, so the
// next claim resumes where the journal stands.
import type { Context } from "@earendil-works/chord";
import type { CommitResult, ConversationId, EntryRecord, StorageWrite } from "@earendil-works/pi-durable";
import type { KernelHooks, ToolCall } from "./conformance/subject.js";
import { type Command, cutAtLimit, type HeldState, type Journal, type LoopDeps } from "./loop-contract.js";
import { PI_STOP } from "./pi-stop.js";
import type { Staged } from "../store/store.js";

/** pi's own default restart limit (pi-durable 1.5.0 agent settings). */
export const DEFAULT_RESTART_LIMIT = 5;

/** The first input's request id: pi answers a repeat of it from its submission, so a resumed run never asks twice. */
export const INPUT_REQUEST = "agentrun:input";
export const commandRequest = (id: number) => `agentrun:command:${id}`;
/** The approval an approve or deny row names (commands.ts requires it): the asked call's id. */
export const approvalOf = (command: Command): string | undefined => {
  const approval = (command.body as { approval?: unknown } | null)?.approval;
  return typeof approval === "string" ? approval : undefined;
};
export const quiet: KernelHooks = { beforeIntent: async () => {}, beforeResult: async () => {} };
/** How long a loop waits for pi to close a Session it no longer writes through. */
export const CLOSE_MS = 2_000;
/** How long a person's stop waits for the turn to settle, by default. */
export const STOP_SETTLE_MS = 30_000;

/** Where a commit's batches hold what an expectation waits for: the batch's index and the matched record's id. */
type Matched = { readonly index: number; readonly id: number };
/** Finds the record an expectation waits for in a commit's batches. */
type Match = (batches: readonly (readonly StorageWrite[])[]) => Matched | undefined;
/** What an expectation stages: the run patch and rows, and the commands it takes (by id; each keyed to the matched record). */
type Expected = { readonly run?: Staged["run"]; readonly also?: Staged["also"]; readonly take?: readonly number[] };

/**
 * The run's journal with the loop's staging matched to commits. stage() replaces what was staged, so the loop never
 * calls it directly: `expect(match, expected)` stages `expected` on the first commit whose batches `match`, merged with
 * any other match of that commit, its takes keyed to the matched record (the store writes a take only with that
 * record's batch, so a command is taken with its effect or not at all), and resolves once that batch is stored. seal()
 * refuses every later commit.
 */
export class Gate {
  readonly journal: Journal;
  #sealed: Error | undefined;
  #pending: { match: Match; expected: Expected; landed: () => void; failed: (error: unknown) => void }[] = [];

  constructor(inner: Journal) {
    const gate = this;
    this.journal = new Proxy(inner, {
      get(target, key) {
        if (key === "commit") return (batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: never) => void, context: Context) => gate.#commit(target, batches, receive, context);
        if (key === "stage") return () => {
          throw new Error("the loop stages only through its Gate");
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  async #commit(target: Journal, batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: never) => void, context: Context): Promise<CommitResult> {
    if (this.#sealed) throw this.#sealed;
    const hits = this.#pending.flatMap((pending) => {
      const at = pending.match(batches);
      return at ? [{ pending, at }] : [];
    });
    if (hits.length > 0) target.stage(merge(hits.map((hit) => ({ expected: hit.pending.expected, at: hit.at }))));
    let result: CommitResult;
    try {
      result = await target.commit(batches, receive as never, context);
    } catch (error) {
      for (const hit of hits) this.#drop(hit.pending).failed(error);
      throw error;
    }
    // Landed when its own batch was stored; one refused (or after a refused one) waits for a later commit.
    for (const hit of hits) if (result.stored > hit.at.index) this.#drop(hit.pending).landed();
    return result;
  }

  #drop<T>(pending: T): T {
    this.#pending = this.#pending.filter((each) => each !== (pending as never));
    return pending;
  }

  /** Stages `expected` on the first commit whose batches `match`; resolves when the matched batch is stored. */
  expect(match: Match, expected: Expected): Promise<void> {
    return new Promise((landed, failed) => this.#pending.push({ match, expected, landed, failed }));
  }

  /** Every later commit is refused with `error`; a pending expectation fails with it. */
  seal(error: Error): void {
    this.#sealed ??= error;
    for (const pending of this.#pending.splice(0)) pending.failed(error);
  }

  get sealed(): boolean {
    return this.#sealed !== undefined;
  }
}

function merge(all: readonly { expected: Expected; at: Matched }[]): Staged {
  const run = all.reduce<Staged["run"]>((patch, { expected }) => (expected.run ? { ...patch, ...expected.run } : patch), undefined);
  const also = all.flatMap(({ expected }) => expected.also ?? []);
  // The patch and rows land with the record their expectation matched (the first that stages any): never on a storage
  // call where that record's batch was refused.
  const effect = all.find(({ expected }) => expected.run !== undefined || (expected.also ?? []).length > 0)?.at.id;
  // Each take keyed to the record its expectation matched: the store writes it only with that record's batch.
  const take = all.flatMap(({ expected, at }) => (expected.take ?? []).map((command) => ({ command, effect: at.id })));
  return { ...(run ? { run } : {}), ...(also.length ? { also } : {}), ...(effect !== undefined && (run || also.length) ? { effect } : {}), ...(take.length ? { take } : {}) };
}

/** Whether `batches` write an entry of `kind` whose data `test` accepts. */
export const writesEntry = (kind: string, test: (data: Record<string, unknown>) => boolean = () => true): Match => (batches) =>
  firstMatch(batches, (write) => write.type === "entry" && write.value.kind === kind && test((write.value.data ?? {}) as Record<string, unknown>));
/** Where `batches` write the submission with request id `requestId`. */
export const writesSubmission = (requestId: string): Match => (batches) => firstMatch(batches, (write) => write.type === "submission" && write.value.requestId === requestId);
/** The first write of `batches` that `test` takes: its batch's index and its record's id. */
function firstMatch(batches: readonly (readonly StorageWrite[])[], test: (write: StorageWrite) => boolean): Matched | undefined {
  for (const [index, batch] of batches.entries()) {
    for (const write of batch) {
      if (test(write) && (write.type === "entry" || write.type === "submission")) return { index, id: write.value.id as unknown as number };
    }
  }
  return undefined;
}

export class Parked extends Error {
  constructor() {
    super("the run parked on an ask: this loop writes nothing more");
  }
}
export class Interrupted extends Error {
  constructor(reason: string) {
    super(`the loop stopped (${reason}): it writes nothing more`);
  }
}
/** The kernel's own fault between a call and its result: the Session restarts, the call before its result. */
export class KernelFault extends Error {
  constructor(call: ToolCall, cause: unknown) {
    super(`the kernel faulted on ${call.tool} (${call.callId}) before its result: ${(cause as Error)?.message ?? String(cause)}`, { cause });
  }
}

/** Where each pi.live value the loop observes goes: `live`, as a reader of the run's held state, computed only when the
 *  ticker reads it (once per tick), so an advance costs the same however long the partial answer has grown. */
export function heldReporter(live: NonNullable<LoopDeps["live"]>): (value: unknown) => void {
  return (value) => live(() => heldStateOf(value));
}

/** A run's held state from its pi.live document: the tools running now and the answer streaming so far. */
export function heldStateOf(value: unknown): HeldState | undefined {
  const live = (value ?? {}) as { tools?: { callId: string; name: string; status: string; arguments?: unknown; output?: string }[]; generation?: { message?: { content?: { type: string; text?: string }[] } } };
  const tools = (live.tools ?? []).filter((slot) => slot.status === "running").map((slot) => ({ callId: slot.callId, name: slot.name, ...(slot.arguments !== undefined ? { args: slot.arguments } : {}), ...(slot.output ? { output: slot.output } : {}) }));
  const text = (live.generation?.message?.content ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
  if (tools.length === 0 && !text) return undefined;
  return { tools, ...(text ? { partial: { text } } : {}) };
}

/** Why the run fails, when the answer it would end on (the root's last pi.assistant) was cut at the model's output limit
 *  (stopReason "length"): unfinished, so never ended. A cut answer the run went on from (a later turn answered after it)
 *  is not its last, and changes nothing. */
export function cutLast(entries: readonly EntryRecord[]): string | undefined {
  const last = [...entries].reverse().find((entry) => entry.kind === "pi.assistant");
  const message = (last as { model?: { stopReason?: string; usage?: { output?: number } }[] } | undefined)?.model?.[0];
  return message?.stopReason === PI_STOP.length ? cutAtLimit(message.usage?.output) : undefined;
}

/** A tool result pi wrote for a call it cut off at its restart limit, as its message, if any. */
export function restartLimited(entries: readonly EntryRecord[]): string | undefined {
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result") continue;
    const diagnostics = (entry.data as { diagnostics?: { code?: string; message?: string }[] } | undefined)?.diagnostics ?? [];
    const cut = diagnostics.find((diagnostic) => diagnostic.code === "restart_limit");
    if (cut) return cut.message ?? "restart_limit";
  }
  return undefined;
}

/** The root conversation's entries, oldest first. */
export async function entriesOf(journal: Journal, conversationId: ConversationId, context: Context): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  for (let cursor: unknown = undefined; ; ) {
    const page = await journal.scanEntries({ conversationId, order: "ascending" } as never, 500, cursor as never, context);
    out.push(...page.items);
    if (page.next === undefined) return out;
    cursor = page.next;
  }
}

export function findData<T>(entries: readonly EntryRecord[], kind: string, test: (data: T) => boolean): T | undefined {
  for (const entry of entries) if (entry.kind === kind && test(entry.data as unknown as T)) return entry.data as unknown as T;
  return undefined;
}
