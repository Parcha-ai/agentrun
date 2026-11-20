// web_save's download slots (web-save.ts saveSlots) across a runner's runs. Each run runs in a process of its own
// (run-child-host.ts), so a gate in that process would be one per run. The bound is per runner, the process that holds
// the claims: its one gate (web-save.ts SERVER_SLOTS) is exposed on each run's channel, and a run's web_save takes its
// slots there. The run's process is untrusted: a release frees only its own take's slot, once, and every slot a run
// holds or waits for is let go when its channel ends (its process crashed, was killed, or its run ended).
import { ClaimRefused } from "./loop-contract.js";
import { type Channel, ChannelClosed } from "./run-channel.js";
import { SAVE_CONCURRENCY, type SaveSlots } from "../web-save.js";

const TARGET = "saves";
/** The most takes one run may have held or waiting at once: a run's waiters live in the runner, so a run may not queue
 *  without bound. */
export const SAVE_SLOTS_PER_RUN = 16;

/** Exposes `gate` on the runner's side of a run's `channel`. Answers what the runner calls when that channel ends. */
export function exposeSaveSlots(channel: Pick<Channel, "expose">, gate: SaveSlots): () => void {
  const held = new Set<() => void>();
  const waits = new Set<AbortController>();
  let closed = false;
  channel.expose(TARGET, async (method, args) => {
    if (method !== "take") throw new ClaimRefused(`the runner has no ${method} for a run's download slots`);
    const [signal] = args;
    if (!(signal instanceof AbortSignal)) throw new TypeError("a download slot is taken under the call's signal");
    if (closed) throw new ChannelClosed("the run's channel ended");
    if (held.size + waits.size >= SAVE_SLOTS_PER_RUN) throw new ClaimRefused(`this run already has ${SAVE_SLOTS_PER_RUN} web_save downloads held or waiting`);
    const left = new AbortController();
    waits.add(left);
    let release: () => void;
    try {
      release = await gate.take(AbortSignal.any([signal, left.signal]));
    } finally {
      waits.delete(left);
    }
    // Granted as the channel ended: no answer reaches the run, so the slot goes back now.
    if (closed) {
      release();
      throw new ChannelClosed("the run's channel ended");
    }
    held.add(release);
    // The gate's release is once only: a second call frees nothing.
    return () => {
      held.delete(release);
      release();
    };
  });
  return () => {
    if (closed) return;
    closed = true;
    for (const wait of waits) wait.abort(new ChannelClosed("the run's channel ended"));
    for (const release of held) release();
    held.clear();
  };
}

/** A run process's web_save slots: its runner's gate, taken over `channel`. */
export function remoteSaveSlots(channel: Pick<Channel, "call">): SaveSlots {
  let busy = 0;
  let waiting = 0;
  return {
    size: SAVE_CONCURRENCY,
    get busy() { return busy; },
    get waiting() { return waiting; },
    async take(signal) {
      waiting++;
      let release: unknown;
      try {
        release = await channel.call(TARGET, "take", [signal]);
      } finally {
        waiting--;
      }
      if (typeof release !== "function") throw new TypeError("the runner answered no release for a download slot");
      busy++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        busy--;
        // A release that cannot cross (the channel ended) is no loss: the runner frees the slot when the channel ends.
        Promise.resolve((release as () => unknown)()).catch(() => {});
      };
    },
  };
}
