// P1 (review-F): a workflow's deadline_s / poll.deadline_s / poll.interval_s / retry.backoff_s carry
// no ceiling, so a delay derived from them can pass Node's 2^31-1 ms (~24.86 day) timer limit, where
// setTimeout clamps to ~1 ms and fires at once. setLongTimeout re-arms in <= 2^31-1 ms slices. These
// prove the mechanism at the reviewer's clock: 3,000,000 s (past the limit, chains) and 2,000,000 s
// (the control, one slice) each wait the full time, never ~1 ms.
//
// The interpreter's two timer sites both route through setLongTimeout: sleep() (retry.backoff_s and
// poll.interval_s) and the call-node deadline timer (deadline_s). The end-to-end deadline case is in
// long-timer-runner.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setLongTimeout, MAX_TIMER_DELAY_MS as MAX } from "../dist/long-timer.js";

const PAST_LIMIT_MS = 3_000_000 * 1000; // 3e6 s > 2^31-1 ms (chains)
const CONTROL_MS = 2_000_000 * 1000;    // 2e6 s < 2^31-1 ms (one slice, control)

// Advance the fake clock from 0 to `ms`, stopping at every slice boundary (k × MAX from the start),
// since node's mock tick drops a re-arm scheduled in the middle of one tick. Reads the flag at 2 ms
// (where an overflowed timer would already have fired), one ms before the deadline, and at it.
function drive(t, ms, read) {
  let now = 0;
  const to = (target) => { while (now < target) { const next = Math.min(target, (Math.floor(now / MAX) + 1) * MAX); t.mock.timers.tick(next - now); now = next; } };
  to(2); const early = read();
  to(ms - 1); const before = read();
  to(ms); return { early, before, after: read() };
}

for (const [label, ms] of [["3,000,000 s (past the limit)", PAST_LIMIT_MS], ["2,000,000 s (control)", CONTROL_MS]]) {
  test(`setLongTimeout: ${label} does not fire at ~1 ms and fires exactly on time`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fired = 0;
    setLongTimeout(() => { fired += 1; }, ms);
    const { early, before, after } = drive(t, ms, () => fired);
    assert.equal(early, 0, "does not fire at ~1 ms");
    assert.equal(before, 0, "does not fire one tick early");
    assert.equal(after, 1, "fires exactly on time");
  });
}

test("setLongTimeout: clear() cancels a past-limit delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const timer = setLongTimeout(() => { fired += 1; }, PAST_LIMIT_MS);
  t.mock.timers.tick(MAX);
  timer.clear();
  t.mock.timers.tick(PAST_LIMIT_MS);
  assert.equal(fired, 0);
});
