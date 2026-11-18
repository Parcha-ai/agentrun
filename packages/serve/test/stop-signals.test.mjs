// The server's stop policy on SIGINT and SIGTERM (stop-signals.ts), on a fake clock and timer: one stop per press, a
// later signal stops at once, and a stop past its deadline stops at once. Each exits once, and its line says the cut
// runs resume on the next start. cli-stop.test.mjs walks the first two through the real CLI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEADLINE_MARGIN_MS, REPEAT_MS, stopOnce, stopOnSignals } from "../dist/stop-signals.js";

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

test("a stop asked earlier (a signal during the start, handed over once the start is done) keeps its own time: a second signal a window after it stops at once", async () => {
  const h = harness();
  h.at(5_000);
  h.stop(3_000);
  assert.equal(h.closes(), 1);
  h.at(5_100);
  h.stop();
  assert.deepEqual(h.codes, [130], "a window past the first signal, though not past the hand-over");
  assert.match(h.said[0], /^stopping now; runs resume on the next start/);
});

test("a command's stop: the first signal says its line and aborts, a repeat within the window is that same stop, a later one exits 130, and nothing listens once unhooked", () => {
  let clock = 0;
  const said = [];
  const codes = [];
  const stop = stopOnce(() => said.push("stopping"), { now: () => clock, exit: (code) => codes.push(code) });
  assert.equal(process.emit("SIGINT"), false, "nothing listens before the hook");
  stop.hook();
  assert.equal(process.emit("SIGINT"), true);
  assert.equal(stop.signal.aborted, true);
  clock = REPEAT_MS;
  process.emit("SIGTERM");
  assert.deepEqual([said, codes], [["stopping"], []], "the launcher's copy of the first signal is not a second stop");
  clock = REPEAT_MS + 1;
  process.emit("SIGINT");
  assert.deepEqual([said, codes], [["stopping"], [130]]);
  stop.unhook();
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], [0, 0]);
});
