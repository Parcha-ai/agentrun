// One run's live view, read from the one store (design: the server reads everything from the store; a runner shares
// nothing with it but the store). The replacement for the door's GET /events: a snapshot, then the events of each
// stored commit (live/translate.ts), in commit order, each batch naming its commit's seq so a reader that comes back
// resumes from it; and beside them, never inside a commit's batch, what the runner holds before pi stores it (the run's
// run_live row: a running tool, a partial answer), in the same vocabulary.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HeldState } from "../runner/loop-contract.js";
import { FINAL_STATES, type Store } from "../store/store.js";
import { emptyState, type LiveEvent, type LiveState, snapshotOf, translate } from "./translate.js";

export type { LiveEvent } from "./translate.js";

/** Where a batch came from: a stored commit (its seq), or the run's held state. */
export type LiveBatchMeta = { readonly seq: number; readonly held?: undefined } | { readonly held: true; readonly seq?: undefined };
export type LiveEnd = { readonly reason: "stopped" | "ended" | "failed" };

export interface LiveStream {
  readonly snapshot: LiveEvent;
  start(listener: (events: LiveEvent[], meta: LiveBatchMeta) => void | Promise<void>): void;
  stop(): Promise<LiveEnd>;
  readonly closed: Promise<LiveEnd>;
}

export interface WatchRunOptions {
  /** Resume after this commit: the snapshot holds the run as of it, and only later commits follow. Default: the newest
   *  commit when the stream is opened. */
  readonly fromSeq?: number;
  /** How often the store is read. Default 250 ms. */
  readonly pollMs?: number;
}

type LiveStore = Pick<Store, "runs" | "journal" | "live">;
const PAGE = 500;

/** Opens `runId`'s live view on `store`. */
export async function watchRun(store: LiveStore, runId: string, options: WatchRunOptions = {}): Promise<LiveStream> {
  const pollMs = options.pollMs ?? 250;
  const context = BACKGROUND_CONTEXT;
  const row = await store.runs.get(runId);
  if (!row) throw new Error(`run ${runId} does not exist`);
  // A reader's view of the journal: reads only, so its claim fences nothing.
  const journal = store.journal({ runId, runner: "live-view", epoch: row.epoch, until: 0, from: row.state });
  const state: LiveState = emptyState();
  let seq = 0;
  // The snapshot: every commit up to `fromSeq` (all of them when it is not given) folded into the state; their events
  // are the snapshot's, not sent.
  const upTo = options.fromSeq;
  fold: for (;;) {
    const page = await journal.commitsAfter(seq, PAGE, context);
    for (const commit of page.commits) {
      if (upTo !== undefined && commit.seq > upTo) break fold;
      translate(state, commit);
      seq = commit.seq;
    }
    if (page.next === undefined || page.commits.length === 0) break;
  }
  if (upTo !== undefined) seq = upTo;

  let listener: ((events: LiveEvent[], meta: LiveBatchMeta) => void | Promise<void>) | undefined;
  let ended: LiveEnd | undefined;
  let endIt!: (end: LiveEnd) => void;
  const closed = new Promise<LiveEnd>((resolve) => (endIt = (end) => { if (!ended) { ended = end; resolve(end); } }));
  let timer: NodeJS.Timeout | undefined;
  let polling: Promise<void> = Promise.resolve();

  /** The held state's events the stored ones have not said yet: a running tool's start, a partial's update. */
  const heldEvents = (held: HeldState | undefined): LiveEvent[] => {
    if (!held || !state.run) return [];
    const events: LiveEvent[] = [];
    for (const tool of held.tools) {
      if (state.started_calls.has(tool.callId)) continue;
      state.started_calls.add(tool.callId);
      state.calls.set(tool.callId, { name: tool.name, ...(tool.args !== undefined ? { args: tool.args } : {}) });
      events.push({ type: "tool_execution_start", toolCallId: tool.callId, toolName: tool.name, ...(tool.args !== undefined ? { args: tool.args } : {}) });
    }
    if (held.partial?.text) {
      const message = { role: "assistant", content: [{ type: "text", text: held.partial.text }] };
      if (!state.partial) events.push({ type: "message_start", message });
      else events.push({ type: "message_update", changes: [{ type: "message", message }] });
      state.partial = true;
    }
    return events;
  };

  const poll = async () => {
    if (ended || !listener) return;
    const to = listener;
    for (;;) {
      const page = await journal.commitsAfter(seq, PAGE, context);
      for (const commit of page.commits) {
        const events = translate(state, commit);
        seq = commit.seq;
        if (events.length > 0) await to(events, { seq: commit.seq });
        if (ended) return;
      }
      if (page.next === undefined || page.commits.length === 0) break;
    }
    const now = await store.runs.get(runId);
    const final = now !== undefined && FINAL_STATES.includes(now.state);
    if (!final) {
      const [held] = await store.live.read([runId]);
      const events = heldEvents(held?.state as HeldState | undefined);
      if (events.length > 0) await to(events, { held: true });
    } else if (!state.run) {
      endIt({ reason: "ended" });
    }
  };
  const schedule = () => {
    if (ended) return;
    timer = setTimeout(() => {
      polling = poll()
        .catch(() => endIt({ reason: "failed" }))
        .finally(schedule);
    }, pollMs);
  };

  return {
    snapshot: snapshotOf(state),
    start(given) {
      listener = given;
      polling = poll().catch(() => endIt({ reason: "failed" })).finally(schedule);
    },
    async stop() {
      endIt({ reason: "stopped" });
      clearTimeout(timer);
      await polling.catch(() => undefined);
      return ended!;
    },
    closed,
  };
}
