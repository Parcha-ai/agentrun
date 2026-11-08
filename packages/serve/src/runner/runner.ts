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
import { COMMAND_KINDS, endedReason } from "./commands.js";
import type { Claim, Loop, LoopEnd, LoopFactory, StopReason } from "./loop-contract.js";
import { isFenced, type RunnerStore } from "./store-port.js";

/** A commit by a loop whose claim this runner gave up: refused before it reaches the store. */
export class ClaimLost extends Error {
  override name = "ClaimLost";
}

export interface RunnerOptions<Journal extends object> {
  store: RunnerStore<Journal>;
  createLoop: LoopFactory<Journal>;
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
  ending: boolean;
  renewing: boolean;
  delivering: boolean;
  deadline?: NodeJS.Timeout;
  done?: Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function startRunner<Journal extends object>(options: RunnerOptions<Journal>): Runner {
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
        return (...args: unknown[]) => {
          if (fence.lost) throw new ClaimLost(`run ${runId}: this runner lost its claim; the commit is not written`);
          return value.apply(target, args);
        };
      },
    });

  const armDeadline = (held: Held, at: number) => {
    clearTimeout(held.deadline);
    held.deadline = setTimeout(() => loseClaim(held, "not-renewed"), Math.max(0, at - Date.now()));
  };

  /** The claim is gone (fenced) or about to run out unrenewed: write nothing more, and stop the loop. */
  const loseClaim = (held: Held, why: "fenced" | "not-renewed") => {
    if (held.fence.lost || killed) return;
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

  const renew = async (held: Held) => {
    if (held.renewing || held.fence.lost || held.ending || killed) return;
    held.renewing = true;
    const sentAt = Date.now();
    try {
      const renewed = await store.renew(held.claim, { leaseMs });
      if (held.fence.lost || killed) return;
      held.claim = renewed;
      armDeadline(held, sentAt + leaseMs - stopMarginMs);
    } catch (error) {
      if (isFenced(error)) loseClaim(held, "fenced");
      // Any other failure (a busy store) is tried at the next renew; the deadline stops the loop if none lands.
      else emit({ type: "error", runId: held.claim.runId, step: "renew", message: message(error) });
    } finally {
      held.renewing = false;
    }
  };
  const renewTimer = setInterval(() => {
    for (const held of runs.values()) void renew(held);
  }, renewEveryMs);

  /** Hands the run's new command rows to its loop: stop as stop(), the other kinds as command(); refusals are taken. */
  const deliver = async (held: Held) => {
    if (held.delivering || held.stopping || held.ending || held.fence.lost || killed) return;
    held.delivering = true;
    try {
      const rows = await store.commands(held.claim.runId, held.cursor);
      for (const row of rows) {
        if (held.stopping || held.ending || held.fence.lost || killed) break;
        held.cursor = Math.max(held.cursor, row.id);
        if (row.takenAt !== null) continue;
        if (row.kind === "stop") {
          stopLoop(held, { kind: "command", commandId: row.id });
          break;
        }
        const outcome = COMMAND_KINDS.has(row.kind) ? await held.loop.command(row) : { refused: `no command is of kind ${JSON.stringify(row.kind)}` };
        if ("refused" in outcome) {
          await store.take(held.claim, row.id, "refused", outcome.refused);
          emit({ type: "refused", runId: held.claim.runId, commandId: row.id, reason: outcome.refused });
        }
      }
    } catch (error) {
      if (isFenced(error)) loseClaim(held, "fenced");
      else emit({ type: "error", runId: held.claim.runId, step: "commands", message: message(error) });
    } finally {
      held.delivering = false;
    }
  };
  const deliverAll = () => {
    if (closed || killed) return;
    for (const held of runs.values()) void deliver(held);
    commandTimer = setTimeout(deliverAll, commandPollMs);
  };

  /** After start() settles: a final run's leftover rows refused, then one flush, then the release. A lost claim writes
   *  nothing; a killed runner does nothing. */
  const finish = async (held: Held, end: LoopEnd, threw: boolean) => {
    held.ending = true;
    clearTimeout(held.deadline);
    const { claim } = held;
    try {
      if (killed || held.fence.lost) return;
      if (threw && end.state === "failed") await store.runs.update(claim, { state: "failed", summary: end.error.message });
      if (end.state === "ended" || end.state === "stopped" || end.state === "failed") {
        const reason = endedReason(end.state);
        for (const row of await store.commands(claim.runId, 0)) {
          if (row.takenAt !== null) continue;
          await store.take(claim, row.id, "refused", reason);
          emit({ type: "refused", runId: claim.runId, commandId: row.id, reason });
        }
      }
      await store.flush();
      await store.release(claim, end.state === "parked" && end.wakeAt !== undefined ? { wakeAt: end.wakeAt } : undefined);
      emit({ type: "released", runId: claim.runId, epoch: claim.epoch, end: end.state });
    } catch (error) {
      emit({ type: "error", runId: claim.runId, step: isFenced(error) ? "release (fenced)" : "release", message: message(error) });
    } finally {
      runs.delete(claim.runId);
    }
  };

  const hold = (claim: Claim, sentAt: number) => {
    const fence = { lost: false };
    const abort = new AbortController();
    const loop = createLoop({
      journal: (forClaim) => fenced(store.journal(forClaim), fence, forClaim.runId),
      flush: () => store.flush(),
      signal: abort.signal,
    });
    const held: Held = { claim, loop, fence, abort, cursor: 0, stopping: false, ending: false, renewing: false, delivering: false };
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
      const free = loops - runs.size;
      if (free <= 0) return;
      for (const runId of await store.runs.claimable({ limit: free })) {
        if (closed || killed || runs.size >= loops) break;
        if (runs.has(runId)) continue;
        const sentAt = Date.now();
        let claim: Claim | null;
        try {
          claim = await store.claim(runId, name, { leaseMs });
        } catch (error) {
          emit({ type: "error", runId, step: "claim", message: message(error) });
          continue;
        }
        if (!claim || closed || killed) continue;
        try {
          hold(claim, sentAt);
        } catch (error) {
          // The loop could not be made: the run fails here, so it is not claimed again and again.
          emit({ type: "error", runId, step: "create loop", message: message(error) });
          await store.runs.update(claim, { state: "failed", summary: message(error) }).catch(() => {});
          await store.flush().catch(() => {});
          await store.release(claim).catch(() => {});
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
