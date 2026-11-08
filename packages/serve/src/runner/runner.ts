// A runner: one long-lived process that carries many loops (design: "Runners carry many loops and hold the whole
// kernel"). It polls the store for claimable runs and claims up to `loops` of them, renews its claims on one timer,
// hands each run's command rows to its loop, and at a run's end flushes and then releases the claim.
//
// Two guards keep a runner that lost a claim from writing (Solid Queue's rule, then the store's fence):
// - a claim that cannot be renewed before it runs out (less a margin) is lost here: the loop is told to stop, its
//   signal aborted, and the journal handed to it refuses every later commit (ClaimLost) before it reaches the store;
// - the store refuses any write under an epoch another claim moved past (Fenced): the backstop for a runner that froze.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, StorageWrite } from "@earendil-works/pi-durable";
import { COMMAND_KINDS, endedReason } from "./commands.js";
import { KINDS } from "./journal-kinds.js";
import type { Claim, Command, Journal, Loop, LoopEnd, LoopFactory, StopReason } from "./loop-contract.js";
import { isFenced, type RunnerStore } from "./store-port.js";

/** A commit by a loop whose claim this runner gave up: refused before it reaches the store. */
export class ClaimLost extends Error {
  override name = "ClaimLost";
}

export interface RunnerOptions {
  store: RunnerStore;
  createLoop: LoopFactory;
  /** This runner's name in the runs it claims (runs.runner). Default: host, pid and a random part. */
  name?: string;
  /** Most runs held at once. */
  loops?: number;
  /** How long a claim lasts unless renewed. */
  leaseMs?: number;
  renewEveryMs?: number;
  /** A claim not renewed by its until less this margin is lost here, and its loop stopped. */
  stopMarginMs?: number;
  /** How often the store is asked for claimable runs while a loop is free. */
  pollMs?: number;
  /** How often each held run's command rows are read: a command reaches its loop within one of these. */
  commandPollMs?: number;
  /** How many times a parked run brought back by a row is tried when its loop cannot start, before that row is refused. */
  resumeTries?: number;
  /** The wait after a resume's first failed try; each later one waits twice the one before. */
  resumeBackoffMs?: number;
  /** The wait before a run whose loop ended interrupted on its own (no stop asked of it: its Session closed itself) is
   *  claimable again; each such end of the run in a row waits twice the one before, up to 64 times this. */
  interruptBackoffMs?: number;
  /** How long a run's end waits for a command still with its loop before it writes its end; an answer after that is
   *  dropped (nothing written, nothing said). */
  endWaitMs?: number;
  onEvent?: (event: RunnerEvent) => void;
}

export type RunnerEvent =
  | { type: "claimed"; claim: Claim }
  | { type: "claim-lost"; runId: string; epoch: number; why: "fenced" | "not-renewed" }
  | { type: "released"; runId: string; epoch: number; end: LoopEnd["state"] }
  | { type: "refused"; runId: string; commandId: number; reason: string }
  | { type: "error"; runId?: string; step: string; message: string };

export interface Runner {
  readonly name: string;
  /** The claims this runner holds and has not lost. */
  held(): Claim[];
  /** Stops claiming, stops every loop where it can resume, flushes and releases their runs. */
  close(): Promise<void>;
  /** As if the process froze or died: every timer stops, nothing is stopped, flushed or released (a test's crash). */
  kill(): void;
}

interface Held {
  claim: Claim;
  loop: Loop;
  fence: { lost: boolean };
  abort: AbortController;
  /** Rows above this id have not been read for this claim. */
  cursor: number;
  /** A stop is on its way to the loop, or the loop's start() has returned. */
  stopping: boolean;
  /** start() has returned: the run's end (its sweep, flush and release) is under way. A Fenced answer now is no lost claim. */
  ending: boolean;
  /** No more of the claim is written: set once the end stops waiting for an in-flight delivery, before its sweep. */
  sealed: boolean;
  renewing: boolean;
  delivering: boolean;
  /** The delivery under way, which the end waits for (up to endWaitMs) before it writes. */
  inFlight?: Promise<void>;
  deadline?: NodeJS.Timeout;
  done?: Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function startRunner(options: RunnerOptions): Runner {
  const {
    store,
    createLoop,
    name = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    loops = 300,
    leaseMs = 30_000,
    renewEveryMs = 10_000,
    stopMarginMs = 5_000,
    pollMs = 1_000,
    commandPollMs = 500,
    resumeTries = 3,
    resumeBackoffMs = 5_000,
    interruptBackoffMs = 1_000,
    endWaitMs = 5_000,
    onEvent = () => {},
  } = options;
  if (!(stopMarginMs < leaseMs && renewEveryMs < leaseMs - stopMarginMs)) {
    throw new RangeError(`a claim of ${leaseMs} ms must be renewed (every ${renewEveryMs} ms) before its stop margin (${stopMarginMs} ms)`);
  }
  const emit = (event: RunnerEvent) => {
    try {
      onEvent(event);
    } catch {
      // A listener's throw is its own.
    }
  };
  /** Every run this runner claimed whose loop has not settled, lost ones included (they still take a loop's place). */
  const runs = new Map<string, Held>();
  /** A lost claim's loop that had not settled when its run was claimed again (its place in `runs` taken by the new one):
   *  still counted against `loops` until it settles, so a loop that ignores its stop never lets the runner hold more. */
  const replaced = new Set<Held>();
  /** Each run's ends in a row, on this runner, as interrupted on its own: its next release's backoff doubles with them. */
  const interruptedInARow = new Map<string, number>();
  let closed = false;
  let killed = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let commandTimer: NodeJS.Timeout | undefined;
  let polling = false;

  /** The run's journal with this runner's fence on its one write: after the claim is lost, commit throws ClaimLost. */
  const fenced = (journal: Journal, fence: { lost: boolean }, runId: string): Journal =>
    new Proxy(journal, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property !== "commit") return value.bind(target);
        // pi's commit is async and pi chains on it (group commit, the publish queue): the refusal is a rejected promise,
        // so it fails that commit on the path pi already handles, never a throw out of a caller that is not async.
        return (...args: unknown[]) =>
          fence.lost
            ? Promise.reject(new ClaimLost(`run ${runId}: this runner lost its claim; the commit is not written`))
            : value.apply(target, args);
      },
    });

  const armDeadline = (held: Held, at: number) => {
    clearTimeout(held.deadline);
    held.deadline = setTimeout(() => loseClaim(held, "not-renewed"), Math.max(0, at - Date.now()));
  };

  /** The claim is gone (fenced) or about to run out unrenewed: write nothing more, and stop the loop. */
  const loseClaim = (held: Held, why: "fenced" | "not-renewed") => {
    // A run that is ending gave its claim up itself (or is about to): a Fenced answer to a call that was in flight then
    // is no lost claim, and its loop has already stopped.
    if (held.fence.lost || held.ending || killed) return;
    held.fence.lost = true;
    clearTimeout(held.deadline);
    emit({ type: "claim-lost", runId: held.claim.runId, epoch: held.claim.epoch, why });
    stopLoop(held, { kind: "claim-lost" });
    held.abort.abort(new ClaimLost(`run ${held.claim.runId}: claim lost (${why})`));
  };

  const stopLoop = (held: Held, reason: StopReason) => {
    held.stopping = true;
    held.loop.stop(reason).catch((error: unknown) => emit({ type: "error", runId: held.claim.runId, step: "stop", message: message(error) }));
  };

  /** Every held claim renewed in one transaction (store.renewMany), never one per run: a claim answered Fenced is lost,
   *  the others move on. Any other failure (a busy store) is tried at the next renew; each run's deadline stops its loop
   *  if none lands. */
  const renewAll = async () => {
    if (killed) return;
    const due = [...runs.values()].filter((held) => !held.renewing && !held.fence.lost && !held.ending);
    if (due.length === 0) return;
    for (const held of due) held.renewing = true;
    const sentAt = Date.now();
    try {
      const results = await store.renewMany(due.map((held) => held.claim), { leaseMs });
      results.forEach((result, i) => {
        const held = due[i]!;
        if (held.fence.lost || held.ending || killed) return;
        if (isFenced(result)) loseClaim(held, "fenced");
        else {
          held.claim = result as Claim;
          armDeadline(held, sentAt + leaseMs - stopMarginMs);
        }
      });
    } catch (error) {
      for (const held of due) emit({ type: "error", runId: held.claim.runId, step: "renew", message: message(error) });
    } finally {
      for (const held of due) held.renewing = false;
    }
  };
  const renewTimer = setInterval(() => void renewAll(), renewEveryMs);

  /** Hands the run's new command rows to its loop: stop as stop(), the other kinds as command(); refusals are taken. The
   *  run's end waits for it (finish), so a refusal of a command the loop had when it ended is written before the release;
   *  once the end has sealed the claim, an answer still to come is dropped: nothing written, nothing said. `given`: the
   *  rows the runner's one read of every run found for it (deliverAll), else it reads its own. */
  const deliver = (held: Held, given?: readonly Command[]): Promise<void> => {
    if (held.delivering || held.stopping || held.ending || held.fence.lost || killed) return Promise.resolve();
    held.delivering = true;
    // Declared before it is assigned: its own finally reads it.
    let delivery: Promise<void> | undefined;
    delivery = (async () => {
      try {
        const rows = given ?? (await store.commands(held.claim.runId, held.cursor));
        for (const row of rows) {
          if (held.stopping || held.ending || held.fence.lost || killed) break;
          // A row another delivery handed on since the runner's read is not handed on again.
          if (row.id <= held.cursor) continue;
          held.cursor = Math.max(held.cursor, row.id);
          if (row.takenAt !== null) continue;
          if (row.kind === "stop") {
            stopLoop(held, { kind: "command", commandId: row.id });
            break;
          }
          const outcome = COMMAND_KINDS.has(row.kind) ? await held.loop.command(row) : { refused: `no command is of kind ${JSON.stringify(row.kind)}` };
          if (held.sealed || killed) return;
          if ("refused" in outcome) {
            await store.take(held.claim, row.id, "refused", outcome.refused);
            emit({ type: "refused", runId: held.claim.runId, commandId: row.id, reason: outcome.refused });
          }
        }
      } catch (error) {
        if (held.sealed || killed) return;
        if (isFenced(error)) loseClaim(held, "fenced");
        else emit({ type: "error", runId: held.claim.runId, step: "commands", message: message(error) });
      } finally {
        held.delivering = false;
        if (held.inFlight === delivery) held.inFlight = undefined;
      }
    })();
    held.inFlight = delivery;
    return delivery;
  };
  /** One read of every held run's new command rows a tick (store.commandsOf), never one per run, each run's then handed
   *  to its loop; the next tick is set once this read is done. */
  const deliverAll = () => {
    if (closed || killed) return;
    void (async () => {
      const due = [...runs.values()].filter((held) => !(held.delivering || held.stopping || held.ending || held.fence.lost));
      if (due.length === 0) return;
      try {
        const rows = await store.commandsOf(due.map((held) => ({ runId: held.claim.runId, after: held.cursor })));
        for (const held of due) void deliver(held, rows.get(held.claim.runId) ?? []);
      } catch (error) {
        for (const held of due) emit({ type: "error", runId: held.claim.runId, step: "commands", message: message(error) });
      }
    })().finally(() => {
      if (!closed && !killed) commandTimer = setTimeout(deliverAll, commandPollMs);
    });
  };

  /** After start() settles: a final run's leftover rows refused, then one flush, then the release. A lost claim writes
   *  nothing; a killed runner does nothing. */
  /**
   * Ends the run under `claim` in its journal, for a loop that could not write its own end: an agentrun.end entry on the
   * run's root conversation (one made for it when the run has none yet), with the run row's patch and the commands in
   * `take` keyed to that entry, so they land in its one commit or not at all. When the journal cannot take that commit,
   * the run row alone (runs.update, the same take in its one transaction). A lost claim (Fenced) writes neither.
   */
  const endRun = async (claim: Claim, data: { state: "stopped" | "failed"; summary: string }, take: readonly number[]) => {
    try {
      const journal = store.journal(claim);
      const [root] = (await journal.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items;
      const writes: StorageWrite[] = [];
      let conversationId = root?.id;
      if (conversationId === undefined) {
        conversationId = (await journal.mintId()) as unknown as ConversationId;
        writes.push({ type: "conversation", value: { id: conversationId } } as StorageWrite);
      }
      const id = (await journal.mintId()) as unknown as EntryId;
      writes.push({ type: "entry", value: { id, conversationId, kind: KINDS.end, data: data as unknown as JsonValue } } as StorageWrite);
      journal.stage({ run: { state: data.state, summary: data.summary }, effect: id as unknown as number, ...(take.length ? { take: take.map((command) => ({ command, effect: id as unknown as number })) } : {}) });
      const result = await journal.commit([writes], () => {}, BACKGROUND_CONTEXT);
      if (result.stored !== 1) throw result.refused ?? new Error("the run's end was not stored");
    } catch (error) {
      if (isFenced(error)) throw error;
      await store.runs.update(claim, { state: data.state, summary: data.summary }, take.length ? { take } : undefined);
    }
  };

  const finish = async (held: Held, end: LoopEnd, threw: boolean) => {
    // Whether the runner asked the loop to stop before it ended (only stopLoop sets this).
    const stoppedBefore = held.stopping;
    held.ending = true;
    clearTimeout(held.deadline);
    const { claim } = held;
    // A command still with the loop: its refusal is written before anything of the end, never after the release. A loop
    // that does not answer within endWaitMs has its answer dropped (the claim is sealed first).
    if (held.inFlight) {
      let waited: NodeJS.Timeout | undefined;
      await Promise.race([held.inFlight, new Promise<void>((resolve) => (waited = setTimeout(resolve, endWaitMs)))]);
      clearTimeout(waited);
    }
    held.sealed = true;
    try {
      if (killed || held.fence.lost) return;
      // A parked run brought back (a raise, an approval) whose loop could not start stays parked: its waking row keeps
      // one more try, and the run is claimable again after a backoff; after the last try that row is refused with why.
      // Never failed: a person can raise again or stop it (#1944-5, the lead's keep list).
      if (threw && end.state === "failed" && claim.from === "parked") return await resumeFailed(held, end.error.message);
      if (threw && end.state === "failed") {
        // A loop that failed with no end written: a person's stop waiting now is the run's end (stopped, its row taken),
        // never refused as a failed run's; else the run ends failed with why. Either way its end is in the journal.
        const stop = (await store.commands(claim.runId, 0)).find((row) => row.takenAt === null && row.kind === "stop");
        if (stop) {
          await endRun(claim, { state: "stopped", summary: "stopped by a person" }, [stop.id]);
          end = { state: "stopped" };
        } else {
          await endRun(claim, { state: "failed", summary: end.error.message }, []);
        }
      }
      if (end.state === "ended" || end.state === "stopped" || end.state === "failed") {
        const reason = endedReason(end.state);
        for (const row of await store.commands(claim.runId, 0)) {
          if (row.takenAt !== null) continue;
          await store.take(claim, row.id, "refused", reason);
          emit({ type: "refused", runId: claim.runId, commandId: row.id, reason });
        }
      }
      await store.flush();
      // A loop that ended interrupted with no stop asked of it (its Session closed itself) is released with a backoff that
      // doubles each time in a row, so a Harness that keeps closing is not claimed again every poll. A stopped loop (a
      // shutdown, a lost claim) is released at once, for another runner to take over.
      const closedItself = end.state === "interrupted" && !stoppedBefore;
      const inARow = closedItself ? (interruptedInARow.get(claim.runId) ?? 0) + 1 : 0;
      if (inARow > 0) interruptedInARow.set(claim.runId, inARow);
      else interruptedInARow.delete(claim.runId);
      await store.release(claim,
        end.state === "parked" && end.wakeAt !== undefined ? { wakeAt: end.wakeAt }
        : inARow > 0 ? { backoffUntil: Date.now() + interruptBackoffMs * 2 ** Math.min(inARow - 1, 6) }
        : {});
      emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: end.state });
    } catch (error) {
      emit({ type: "error", runId: claim.runId, step: isFenced(error) ? "release (fenced)" : "release", message: message(error) });
    } finally {
      // Only its own entry: a run this runner lost and claimed again holds a new one under the same id.
      if (runs.get(claim.runId) === held) runs.delete(claim.runId);
    }
  };

  /** A parked run's resume that threw: one more try on the row that woke it, released parked with a backoff; after
   *  `resumeTries`, that row refused with why and the run released parked with nothing to wake it. */
  const resumeFailed = async (held: Held, why: string) => {
    const { claim } = held;
    const untaken = (await store.commands(claim.runId, 0)).filter((row) => row.takenAt === null);
    const stop = untaken.find((row) => row.kind === "stop");
    const woke = untaken[0];
    if (stop) {
      // A stop never waits on a loop that cannot start: the run ends stopped here, its stop row taken, and every other
      // untaken row refused as a stopped run's.
      // One write: the run ends stopped with its stop row taken, or neither (a final run never keeps its stop untaken).
      await endRun(claim, { state: "stopped", summary: "stopped by a person" }, [stop.id]);
      const reason = endedReason("stopped");
      for (const row of untaken) {
        if (row.id === stop.id) continue;
        await store.take(claim, row.id, "refused", reason);
        emit({ type: "refused", runId: claim.runId, commandId: row.id, reason });
      }
      await store.flush();
      await store.release(claim, {});
      emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: "stopped" });
      return;
    }
    if (woke) {
      const tries = await store.retry(claim, woke.id);
      if (tries >= resumeTries) {
        const reason = `the run could not go on after ${tries} tries; the last: ${why}`;
        await store.take(claim, woke.id, "refused", reason);
        emit({ type: "refused", runId: claim.runId, commandId: woke.id, reason });
        await store.flush();
        await store.release(claim, { state: "parked" });
      } else {
        await store.flush();
        await store.release(claim, { state: "parked", backoffUntil: Date.now() + resumeBackoffMs * 2 ** (tries - 1) });
      }
    } else {
      await store.flush();
      await store.release(claim, { state: "parked" });
    }
    emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: "parked" });
  };

  const hold = (claim: Claim, sentAt: number) => {
    const fence = { lost: false };
    const abort = new AbortController();
    const loop = createLoop({
      journal: (forClaim) => fenced(store.journal(forClaim), fence, forClaim.runId),
      flush: () => store.flush(),
      signal: abort.signal,
    });
    const held: Held = { claim, loop, fence, abort, cursor: 0, stopping: false, ending: false, sealed: false, renewing: false, delivering: false };
    runs.set(claim.runId, held);
    armDeadline(held, sentAt + leaseMs - stopMarginMs);
    emit({ type: "claimed", claim });
    held.done = (async () => {
      let end: LoopEnd;
      let threw = false;
      try {
        end = await loop.start(claim);
      } catch (error) {
        threw = true;
        end = { state: "failed", error: { code: "loop-threw", message: message(error) } };
      }
      await finish(held, end, threw);
    })();
    void deliver(held);
  };

  const claimMore = async () => {
    if (polling || closed || killed) return;
    polling = true;
    try {
      const free = loops - runs.size - replaced.size;
      if (free <= 0) return;
      // One store call claims the batch, each run at its own epoch + 1 (store.runs.claimMany): filling 300 loops, or
      // taking a dead runner's runs over, is one transaction, not 300.
      const sentAt = Date.now();
      const claims = await store.runs.claimMany(name, free, { leaseMs });
      for (const claim of claims) {
        const before = runs.get(claim.runId);
        if (closed || killed || (before && !before.fence.lost)) {
          // Closed while the batch was claimed (or a run this runner still holds, which a claim cannot be): given back.
          if (before && !before.fence.lost) emit({ type: "error", runId: claim.runId, step: "claim", message: "claimed a run this runner still holds" });
          await store.release(claim, {}).catch(() => {});
          continue;
        }
        try {
          // A lost claim's loop still running keeps its place until it settles.
          if (before?.done) {
            replaced.add(before);
            void before.done.finally(() => replaced.delete(before));
          }
          hold(claim, sentAt);
        } catch (error) {
          // The loop could not be made: the run fails here, so it is not claimed again and again.
          emit({ type: "error", runId: claim.runId, step: "create loop", message: message(error) });
          await store.runs.update(claim, { state: "failed", summary: message(error) }).catch(() => {});
          await store.flush().catch(() => {});
          await store.release(claim, {}).catch(() => {});
        }
      }
    } catch (error) {
      emit({ type: "error", step: "poll", message: message(error) });
    } finally {
      polling = false;
    }
  };
  const poll = () => {
    if (closed || killed) return;
    void claimMore().finally(() => {
      if (!closed && !killed) pollTimer = setTimeout(poll, pollMs);
    });
  };

  poll();
  commandTimer = setTimeout(deliverAll, commandPollMs);

  const stopTimers = () => {
    clearTimeout(pollTimer);
    clearTimeout(commandTimer);
    clearInterval(renewTimer);
    for (const held of runs.values()) clearTimeout(held.deadline);
  };

  return {
    name,
    held: () => [...runs.values()].filter((held) => !held.fence.lost && !held.ending).map((held) => held.claim),
    async close() {
      if (closed || killed) return;
      closed = true;
      clearTimeout(pollTimer);
      clearTimeout(commandTimer);
      const live = [...runs.values()].filter((held) => !held.fence.lost);
      for (const held of live) {
        if (!held.ending) {
          stopLoop(held, { kind: "shutdown" });
          held.abort.abort(new Error("the runner is closing"));
        }
      }
      // Claims are renewed while the loops stop; a loop that never stops is given up when its claim would run out.
      let timeout: NodeJS.Timeout | undefined;
      const late = new Promise<void>((resolve) => (timeout = setTimeout(resolve, leaseMs - stopMarginMs)));
      await Promise.race([Promise.all(live.map((held) => held.done)), late]);
      clearTimeout(timeout);
      for (const held of runs.values()) held.fence.lost = true;
      stopTimers();
    },
    kill() {
      killed = true;
      closed = true;
      stopTimers();
    },
  };
}
