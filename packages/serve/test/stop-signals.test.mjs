// The server's stop policy on SIGINT and SIGTERM (stop-signals.ts), on a fake clock and timer: one stop per press, a
// later signal stops at once, and a stop past its deadline stops at once. Each exits once, and its line says the cut
// runs resume on the next start. cli-stop.test.mjs walks the first two through the real CLI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEADLINE_MARGIN_MS, REPEAT_MS, stopOnSignals } from "../dist/stop-signals.js";

function harness({ runs = 1, boundMs = 4_000 } = {}) {
  let clock = 0;
  const timers = [];
  const said = [];
  const codes = [];
  let closes = 0;
  let finish;
  const closed = new Promise((resolve) => (finish = resolve));
  const stop = stopOnSignals({
    close: () => (closes++, closed),
    stopping: () => ({ runs, boundMs }),
    done: (code) => codes.push(code),
    say: (line) => said.push(line),
    now: () => clock,
    setTimer: (run, ms) => timers.push({ run, at: clock + ms }),
  });
  return { stop, said, codes, timers, closes: () => closes, finish, at: (ms) => (clock = ms) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a repeat within the window is the same stop: one close, and it exits 0 when the close ends", async () => {
  const h = harness();
  h.stop();
  h.at(REPEAT_MS - 1);
  h.stop();
  assert.equal(h.closes(), 1);
  assert.deepEqual(h.said, []);
  h.finish();
  await settle();
  assert.deepEqual(h.codes, [0]);
});

test("a signal after the window stops at once with 130, saying the runs resume; the close ending later changes nothing", async () => {
  const h = harness({ runs: 2 });
  h.stop();
  h.at(REPEAT_MS);
  h.stop();
  assert.deepEqual(h.said, ["stopping now; runs resume on the next start (2 were running)"]);
  assert.deepEqual(h.codes, [130]);
  h.finish();
  await settle();
  assert.deepEqual(h.codes, [130], "it exits once");
});

test("a stop past its runs' drain bound and the margin stops at once: the deadline is set when the stop begins", async () => {
  const h = harness({ runs: 1, boundMs: 4_000 });
  h.stop();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].at, 4_000 + DEADLINE_MARGIN_MS, "its runs' drain bound plus the margin");
  h.at(h.timers[0].at);
  h.timers[0].run();
  assert.deepEqual(h.said, ["the stop passed its deadline, stopping now; runs resume on the next start (1 was running)"]);
  assert.deepEqual(h.codes, [130]);
  h.finish();
  await settle();
  assert.deepEqual(h.codes, [130], "a close that ends after the deadline doesn't exit again");
});

test("a stop with no runs left says no count, and a deadline after a clean end does nothing", async () => {
  const h = harness({ runs: 0, boundMs: 0 });
  h.stop();
  h.finish();
  await settle();
  assert.deepEqual(h.codes, [0]);
  h.timers[0].run();
  assert.deepEqual(h.codes, [0]);
  assert.deepEqual(h.said, []);
  const quiet = harness({ runs: 0 });
  quiet.stop();
  quiet.at(REPEAT_MS);
  quiet.stop();
  assert.deepEqual(quiet.said, ["stopping now; runs resume on the next start"]);
});
