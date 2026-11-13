// The runner's live ticker (batched per RUNNER): each loop reports a reader of its run's held state (a running tool, a
// partial answer) through LoopDeps.live as it changes; once per tick the ticker reads and writes every run's changed state
// in ONE store transaction (store.live.put), so a runner's held-state writes stay at about one per tick whatever its loop
// count, never fighting the journal for SQLite's one writer. Never in the journal: run_live is outside it. A run's row
// goes when its loop ends (store.live.drop), right after its end commit.
import type { Claim, HeldState, Loop, LoopFactory } from "./loop-contract.js";
import type { Live } from "../store/store.js";
import { redactedAnswer, redactedLive, redactedOutput } from "../key-refusal.js";

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

/** A run's held state as the live view keeps it, under `values`, every secret value the run's one redactor holds. A
 *  running tool's id and name are cut whole (redactedAnswer). Its args by a workflow output's rule (redactedOutput): every
 *  string, property names included; a number whose digits hold a held value or that equals one, withheld; an object two of
 *  whose names come out the same once cut, withheld whole, never one value dropped over the other. What is still
 *  streaming (the tool's output, the partial answer) by redactedLive: a tail as long as a held value's widest form is held
 *  back, so a secret half streamed at a tick shows none of itself; the settled record replaces it whole once it ends. */
function cutHeld(state: HeldState, values: readonly string[]): HeldState {
  if (values.length === 0) return state;
  const tools = state.tools.map((tool) => ({
    callId: redactedAnswer(tool.callId, values),
    name: redactedAnswer(tool.name, values),
    ...(tool.args !== undefined ? { args: redactedOutput(tool.args, values) } : {}),
    ...(tool.output !== undefined ? { output: redactedLive(tool.output, values) } : {}),
  }));
  return { tools, ...(state.partial ? { partial: { text: redactedLive(state.partial.text, values) } } : {}) };
}

/** Wraps `createLoop` so its loops' held states reach run_live, batched per tick, cut by each loop's redactor. */
export function withLiveTicker(store: { readonly live: Live }, createLoop: LoopFactory, options: LiveTickerOptions = {}): LiveTicker {
  const tickMs = options.tickMs ?? 250;
  /** The newest held-state reader of each run since the last tick, with the claim it was reported under. */
  // Each with its loop's redactor's values (LoopDeps.redact, the runner's one), read at each tick: a claim can hold more.
  const changed = new Map<string, { claim: Claim; read: () => HeldState | undefined; values: () => readonly string[] }>();
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
      const rows = [...changed.values()].map(({ claim, read, values }) => ({ claim, state: cutHeld(stateOf(read), values()) }));
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
      // makes) has no live view: its held state is never written uncut. Nor has a loop whose redactor does not know its
      // values (a bare function): a value still streaming, a number or an object's names cannot be cut by text alone.
      const values = deps.redact?.heldValues;
      const loop: Loop = createLoop({
        ...deps,
        live: (read) => {
          if (!claim || closed || deps.signal.aborted || values === undefined) return;
          changed.set(claim.runId, { claim, read, values });
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
