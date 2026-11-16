// A wake for command rows and new runs: a hint to read now, not a source of truth. An in-process bus keyed by a store's
// `where` (two handles on the same data share one), so a write through one handle wakes the readers of the others without
// waiting for their poll. It reaches handles in this process only: a row another process writes wakes nothing here, and
// the reader's poll finds it.

/** What woke a listener: a command row was written for the run, or one was taken, refused or answered; or the run was
 *  queued (a new run a runner may claim now). */
export interface CommandWake {
  readonly runId: string;
  readonly what: "written" | "answered" | "queued";
}

type Listener = (event: CommandWake) => void;

const listeners = new Map<string, Set<Listener>>();

/** Subscribes `listener` to the commands of the data at `where`; answers the unsubscribe. */
export function watchCommandsAt(where: string, listener: Listener): () => void {
  let set = listeners.get(where);
  if (set === undefined) listeners.set(where, (set = new Set()));
  const mine = set;
  mine.add(listener);
  return () => {
    mine.delete(listener);
    if (mine.size === 0 && listeners.get(where) === mine) listeners.delete(where);
  };
}

/** Tells the listeners of `where` about `events`, after the write committed: asynchronously, each listener's throw
 *  swallowed, so a write never waits on or fails with a listener. */
export function wakeCommands(where: string, ...events: readonly CommandWake[]): void {
  const set = listeners.get(where);
  if (set === undefined || events.length === 0) return;
  queueMicrotask(() => {
    for (const listener of [...set]) {
      for (const event of events) {
        try {
          listener(event);
        } catch {
          // A listener's failure is its own.
        }
      }
    }
  });
}
