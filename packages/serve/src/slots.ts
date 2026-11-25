// A gate of n slots, handed out first come first served: web_save's downloads (web-save.ts), Mode 2's pieced writes
// (runner/big-writes.ts) and a run's subagents (runner/subagent.ts). A leaf module: it imports nothing.

/** Slots handed out first come first served. `take` answers the slot's release (once), or rejects with the signal's
 *  reason if it aborts first, leaving the queue; with no signal it waits until a slot is free. */
export type Slots = { readonly size: number; readonly busy: number; readonly waiting: number; take(signal?: AbortSignal): Promise<() => void> };

export function slots(size: number): Slots {
  let busy = 0;
  const queue: Array<() => void> = [];
  const releaser = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      // The slot goes straight to the next waiter, so busy only drops when no one waits.
      const next = queue.shift();
      if (next) next();
      else busy--;
    };
  };
  return {
    size,
    get busy() { return busy; },
    get waiting() { return queue.length; },
    take(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (busy < size) {
        busy++;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve, reject) => {
        const leave = () => {
          queue.splice(queue.indexOf(grant), 1);
          reject(signal!.reason);
        };
        const grant = () => {
          signal?.removeEventListener("abort", leave);
          resolve(releaser());
        };
        queue.push(grant);
        signal?.addEventListener("abort", leave, { once: true });
      });
    },
  };
}
