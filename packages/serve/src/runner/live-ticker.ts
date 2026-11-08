// The runner's live ticker (the lead's ruling (c), batched per RUNNER): each loop reports its run's held state (a running
// tool, a partial answer) through LoopDeps.live as it changes; once per tick the ticker writes every run's changed state
// in ONE store transaction (store.live.put), so a runner's held-state writes stay at about one per tick whatever its loop
// count, never fighting the journal for SQLite's one writer. Never in the journal: run_live is outside it. A run's row
// goes when its loop ends (store.live.drop), right after its end commit.
import type { Claim, HeldState, Loop, LoopFactory } from "./loop-contract.js";
import type { Live } from "../store/store.js";

export interface LiveTickerOptions {
  /** How often the changed held states are written. Default 250 ms. */
  readonly tickMs?: number;
}

export interface LiveTicker {
  /** The loops of `createLoop`, each reporting its held state to this ticker. */
  readonly createLoop: LoopFactory;
  /** Writes what is pending and stops ticking. */
  close(): Promise<void>;
}

/** Wraps `createLoop` so its loops' held states reach run_live, batched per tick. */
export function withLiveTicker(store: { readonly live: Live }, createLoop: LoopFactory, options: LiveTickerOptions = {}): LiveTicker {
  const tickMs = options.tickMs ?? 250;
  /** The newest held state of each run since the last tick, with the claim it was reported under. */
  const changed = new Map<string, { claim: Claim; state: HeldState }>();
  /** The ticker's writes, one after another: a run's drop never lands before a put already on its way. */
  let writing: Promise<unknown> = Promise.resolve();
  let closed = false;

  const tick = (): Promise<unknown> => {
    writing = writing.then(async () => {
      const rows = [...changed.values()];
      changed.clear();
      if (rows.length > 0) await store.live.put(rows).catch(() => undefined);
    });
    return writing;
  };
  const timer = setInterval(() => void tick(), tickMs);
  timer.unref?.();

  return {
    createLoop: (deps) => {
      let claim: Claim | undefined;
      const loop: Loop = createLoop({
        ...deps,
        live: (state) => {
          if (!claim || closed) return;
          if (state === undefined) changed.set(claim.runId, { claim, state: { tools: [] } });
          else changed.set(claim.runId, { claim, state });
        },
      });
      return {
        start: async (given) => {
          claim = given;
          try {
            return await loop.start(given);
          } finally {
            // The run's row goes once its loop ends, before start() resolves (so before the runner releases the run):
            // after any put already on its way, and a state reported before the end is not written after it.
            changed.delete(given.runId);
            writing = writing.then(() => store.live.drop(given.runId).catch(() => undefined));
            await writing;
          }
        },
        command: (command) => loop.command(command),
        stop: (reason) => loop.stop(reason),
      };
    },
    close: async () => {
      closed = true;
      clearInterval(timer);
      await tick();
    },
  };
}
