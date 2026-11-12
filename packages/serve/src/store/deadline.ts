// A store transaction's deadline counted from its begin, the one rule both connections keep (sqlite/connection.ts,
// postgres/connection.ts): only the time this process could run counts. One counted from its call (a lease's renew, a
// fromCall transaction) stays each connection's wall-clock timer.

/** How often an open transaction's deadline looks at the process's event loop, and how far past its look a look may
 *  come before the gap counts as the process held up (runnableDeadline). */
export const TICK_MS = 50;
export const STALL_MS = 50;

/** A running deadline: `clear()` stops it; `held()` is the time it gave back so far, the process held up, so a bound
 *  reckoned from the deadline's due time (a Postgres commit's) moves with it. A hold that ended since the last look is
 *  counted as `held()` reads it, never left for a look that would come after the bound was reckoned. */
export type RunnableDeadline = { clear(): void; held(): number };

/** Calls `expire` once `ms` of the time this process could run have passed, counted from now on the monotonic clock
 *  (performance.now: the host's clock set forward or back is never counted). A look every TICK_MS measures the event
 *  loop: a gap more than STALL_MS past its look was the process held up by other work (a harness binary hashed, a
 *  command run synchronously, the machine holding the process), wherever in the transaction it fell, before its
 *  deadline or across it, and is not counted. A wait of the transaction's own (a call awaited inside it) leaves the
 *  loop free, so it counts in full and is refused on time. */
export function runnableDeadline(ms: number, expire: () => void): RunnableDeadline {
  // Cleared with the functions they were set with: a caller that swaps the global timers while a transaction is open
  // (node:test's mocked timers, enabled mid-run) would otherwise clear nothing, and the look's interval would hold the
  // process open for good.
  const [after, every, cancel, stop] = [setTimeout, setInterval, clearTimeout, clearInterval];
  const start = performance.now();
  let last = start;
  let held = 0;
  const look = () => {
    const now = performance.now();
    const gap = now - last - TICK_MS;
    if (gap > STALL_MS) held += gap;
    last = now;
    return now;
  };
  const ticks = every(look, TICK_MS);
  let timer: NodeJS.Timeout | undefined;
  const check = () => {
    const left = ms - (look() - start - held);
    if (left <= 0) return expire();
    timer = after(check, Math.ceil(left));
  };
  timer = after(check, ms);
  return {
    clear: () => {
      stop(ticks);
      cancel(timer);
    },
    held: () => {
      look();
      return held;
    },
  };
}
