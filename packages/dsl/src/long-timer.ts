// Node's timers accept a delay of at most 2^31-1 ms (~24.8 days); a larger delay silently overflows
// to a near-immediate fire with a TimeoutOverflowWarning. A workflow's deadline_s, poll.deadline_s,
// poll.interval_s and retry.backoff_s carry no upper ceiling, so a delay derived from them can exceed
// that. `setLongTimeout` re-arms in <= MAX_TIMER_DELAY_MS chunks, so the callback fires at the
// intended time however far out it is, and returns a handle that clears whichever chunk is pending.

export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export type LongTimer = { clear(): void };

/** Schedule `fn` after `ms`, re-arming in <= MAX_TIMER_DELAY_MS chunks so a delay past Node's timer
 *  limit still fires on time instead of overflowing. `clear()` cancels the pending chunk. */
export function setLongTimeout(fn: () => void, ms: number): LongTimer {
  let remaining = Number.isFinite(ms) ? Math.max(0, ms) : MAX_TIMER_DELAY_MS;
  let handle: ReturnType<typeof setTimeout>;
  const tick = (): void => {
    if (remaining <= MAX_TIMER_DELAY_MS) { handle = setTimeout(fn, remaining); return; }
    remaining -= MAX_TIMER_DELAY_MS;
    handle = setTimeout(tick, MAX_TIMER_DELAY_MS);
  };
  tick();
  return { clear() { clearTimeout(handle); } };
}
