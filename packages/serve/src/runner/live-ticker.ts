// The runner's live ticker (batched per RUNNER): each loop reports a reader of its run's held state (a running tool, a
// partial answer) through LoopDeps.live as it changes; once per tick the ticker reads and writes every run's changed state
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
  /** Stops ticking at once and writes nothing more, what is pending included: a runner killed (a crash) lets nothing go. */
  stop(): void;
}

/** `value` with every string in it, keys included, cut by `cut`, its shape kept. */
function cutAll(value: unknown, cut: (text: string) => string): unknown {
  if (typeof value === "string") return cut(value);
  if (Array.isArray(value)) return value.map((item) => cutAll(item, cut));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [cut(key), cutAll(item, cut)]));
  return value;
}
/** A run's held state as the live view keeps it: every value (a running tool's name, its args, its streamed output, the
 *  partial answer) cut by the run's one redactor. */
const cutHeld = (state: HeldState, cut: (text: string) => string): HeldState => cutAll(state, cut) as HeldState;

/** Wraps `createLoop` so its loops' held states reach run_live, batched per tick, cut by each loop's redactor. */
export function withLiveTicker(store: { readonly live: Live }, createLoop: LoopFactory, options: LiveTickerOptions = {}): LiveTicker {
  const tickMs = options.tickMs ?? 250;
  /** The newest held-state reader of each run since the last tick, with the claim it was reported under. */
  // Each with its loop's redactor (LoopDeps.redact, the runner's one): every value is cut by it before it is written.
  const changed = new Map<string, { claim: Claim; read: () => HeldState | undefined; cut: (text: string) => string }>();
  /** The ticker's writes, one after another: a run's drop never lands before a put already on its way. */
  let writing: Promise<unknown> = Promise.resolve();
  let closed = false;
  /** Stopped (a runner killed): nothing more is written, neither a tick queued behind a write already on its way nor a
   *  loop's drop at its end. Only a write already on its way at the stop lands, under the store's fence. */
  let stopped = false;
  /** A reader's held state, read once here at the tick; nothing held (an empty row) when there is none or it can't be read. */
  const stateOf = (read: () => HeldState | undefined): HeldState => {
    try {
      return read() ?? { tools: [] };
    } catch {
      return { tools: [] };
    }
  };

  const tick = (): Promise<unknown> => {
    writing = writing.then(async () => {
      if (stopped) return;
      const rows = [...changed.values()].map(({ claim, read, cut }) => ({ claim, state: cutHeld(stateOf(read), cut) }));
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
      // The claim's signal aborts when its claim is lost (or the runner shuts down past its drain): from then the loop's
      // held state is neither taken nor written, though the loop still reports while it stops. The store fences a write
      // by its run's epoch and live lease, but a claim lost for its renews is lost before its lease runs out.
      // Removed when the loop ends (its start settles), so a runner that holds many loops over its life gains none.
      const onAbort = () => {
        if (claim && changed.get(claim.runId)?.claim === claim) changed.delete(claim.runId);
      };
      deps.signal.addEventListener("abort", onAbort, { once: true });
      // The run's one redactor: a running tool's args and output and a partial answer can quote a secret the runner holds
      // (a key its claim opened), and the live view is read by people and consoles. A loop given none (never one the runner
      // makes) has no live view: its held state is never written uncut.
      const cut = deps.redact;
      const loop: Loop = createLoop({
        ...deps,
        live: (read) => {
          if (!claim || closed || deps.signal.aborted || cut === undefined) return;
          changed.set(claim.runId, { claim, read, cut });
        },
      });
      return {
        start: async (given) => {
          claim = given;
          try {
            return await loop.start(given);
          } finally {
            deps.signal.removeEventListener("abort", onAbort);
            // The run's row goes once its loop ends, before start() resolves (so before the runner releases the run):
            // after any put already on its way, and a state reported before the end is not written after it.
            changed.delete(given.runId);
            // Under its claim: a loop that ended after its claim was lost drops nothing of a later claim's row. A runner
            // killed (stopped) writes nothing more, its drop included.
            if (!stopped) writing = writing.then(() => (stopped ? undefined : store.live.drop(given).catch(() => undefined)));
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
    stop: () => {
      closed = true;
      stopped = true;
      clearInterval(timer);
      changed.clear();
    },
  };
}
