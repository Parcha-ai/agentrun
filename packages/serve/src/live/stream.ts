// One run's live view, read from the one store (design: the server reads everything from the store; a runner shares
// nothing with it but the store). The replacement for the door's GET /events: a snapshot, then the events of each
// stored commit (live/translate.ts), in commit order, each batch naming its commit's seq so a reader that comes back
// resumes from it; and beside them, never inside a commit's batch, what the runner holds before pi stores it (the run's
// run_live row: a running tool, a partial answer), in the same vocabulary.
import { RUN_RESUMED } from "@parcha/pi-durable-agent/timeline";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HeldState } from "../runner/loop-contract.js";
import { FINAL_STATES, type RunState, type Store } from "../store/store.js";
import { emptyState, type LiveEvent, type LiveState, snapshotOf, translate } from "./translate.js";

export type { LiveEvent } from "./translate.js";

/** The events delivered to a live reader, with a runner-lost resume note (RUN_RESUMED) dropped. The note joins the run's
 *  record — translate still appends it to the state the snapshot reads (snapshotOf), and the timeline renders its phase
 *  row — but it is not a live stream event: a takeover ends the door's watch, so a reader meets the note only in a
 *  reconnect's snapshot, never as a commit on the open stream. The live view polls across a takeover, so without this it
 *  would stream the note's entry_appended; dropping it keeps a run taken over mid-turn streaming the same events as one
 *  that was not. The note stays in state.entries (translate pushed it before returning), so the next snapshot carries it. */
const delivered = (events: LiveEvent[]): LiveEvent[] =>
  events.filter((event) => !(event.type === "entry_appended" && (event.entry as { readonly kind?: unknown } | undefined)?.kind === RUN_RESUMED));

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
type Journal = ReturnType<Store["journal"]>;
const PAGE = 500;

/** The journals each store's watches read, by (run, epoch), with how many watches hold each. store.journal hands out one
 *  journal per (run, epoch) and keeps it until it is closed: two watches of one run share it, and the last one to end
 *  closes it, so the store keeps no journal of a watch that ended. */
const watched = new WeakMap<LiveStore, Map<string, { journal: Journal; watches: number }>>();

/** `runId`'s journal at `epoch` for one watch, and its release: the last watch's closes the journal. */
function watchJournal(store: LiveStore, runId: string, epoch: number, from: RunState): { journal: Journal; release(): Promise<void> } {
  let byRun = watched.get(store);
  if (!byRun) watched.set(store, (byRun = new Map()));
  const key = `${runId}\u0000${epoch}`;
  let held = byRun.get(key);
  // A reader's view of the journal: reads only, so its claim fences nothing.
  if (!held) byRun.set(key, (held = { journal: store.journal({ runId, runner: "live-view", epoch, until: 0, from }), watches: 0 }));
  held.watches += 1;
  const it = held;
  let released = false;
  return {
    journal: it.journal,
    async release() {
      if (released) return;
      released = true;
      it.watches -= 1;
      if (it.watches > 0) return;
      if (byRun!.get(key) === it) byRun!.delete(key);
      await it.journal.close(BACKGROUND_CONTEXT);
    },
  };
}

/** Opens `runId`'s live view on `store`. */
export async function watchRun(store: LiveStore, runId: string, options: WatchRunOptions = {}): Promise<LiveStream> {
  const pollMs = options.pollMs ?? 250;
  const context = BACKGROUND_CONTEXT;
  const row = await store.runs.get(runId);
  if (!row) throw new Error(`run ${runId} does not exist`);
  const { journal, release } = watchJournal(store, runId, row.epoch, row.state);
  const state: LiveState = emptyState();
  let seq = 0;
  // The snapshot: every commit up to `fromSeq` (all of them when it is not given) folded into the state; their events
  // are the snapshot's, not sent.
  const upTo = options.fromSeq;
  try {
    fold: for (;;) {
      const page = await journal.commitsAfter(seq, PAGE, context);
      for (const commit of page.commits) {
        if (upTo !== undefined && commit.seq > upTo) break fold;
        translate(state, commit);
        seq = commit.seq;
      }
      if (page.next === undefined || page.commits.length === 0) break;
    }
  } catch (error) {
    await release();
    throw error;
  }
  if (upTo !== undefined) seq = upTo;

  let listener: ((events: LiveEvent[], meta: LiveBatchMeta) => void | Promise<void>) | undefined;
  let ended: LiveEnd | undefined;
  let endIt!: (end: LiveEnd) => void;
  const closed = new Promise<LiveEnd>((resolve) => (endIt = (end) => { if (!ended) { ended = end; resolve(end); } }));
  let timer: NodeJS.Timeout | undefined;
  let polling: Promise<void> = Promise.resolve();
  // However the watch ends (stopped, its run ended, a failed read), its journal is let go once its last poll settled.
  const released = closed.then(() => polling.catch(() => undefined)).then(release);

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
    // The row before the commits: a row final here was made final in its end commit's own transaction, so the drain
    // below reads that commit. Read after the drain, the row could be final from a commit the drain missed, and the
    // stream would end without what that commit holds (a CLI run's answer).
    const now = await store.runs.get(runId);
    const final = now !== undefined && FINAL_STATES.includes(now.state);
    for (;;) {
      const page = await journal.commitsAfter(seq, PAGE, context);
      for (const commit of page.commits) {
        // translate moves `state` (its entries feed the snapshot) and returns the commit's events; a resume note is dropped
        // from what the stream delivers, never from the state the snapshot reads.
        const events = delivered(translate(state, commit));
        seq = commit.seq;
        if (events.length > 0) await to(events, { seq: commit.seq });
        if (ended) return;
      }
      if (page.next === undefined || page.commits.length === 0) break;
    }
    if (!final) {
      const [held] = await store.live.read([runId]);
      const events = heldEvents(held?.state as HeldState | undefined);
      if (events.length > 0) await to(events, { held: true });
    } else {
      // Final, and its commits drained: nothing more can land (the end released the claim, and a released claim's commits
      // are refused). Ended whether or not pi settled its input: a run failed because its stop did not settle never does.
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
      await released;
      return ended!;
    },
    closed,
  };
}
