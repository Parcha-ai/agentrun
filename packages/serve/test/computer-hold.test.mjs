// A person's hold on a run's desktop or phone (serve/src/workspace/computer-hold.ts): while the owner holds it, the
// run's screen, input and phone calls park; at the hand-back a look runs on the screen as the person left it, and an act
// is not done, the model told the person had it. A hold ends at the hand-back, after its longest time, or at the run's
// end. Driven by events and a fake clock: nothing here sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerHold, HOLD_MAX_MS, heldHands, personHadWords, TAKEN_OVER } from "../dist/workspace/computer-hold.js";

/** A fake clock: timers run when the test moves time on. */
function fakeTime(start = 1_000_000) {
  let now = start;
  const pending = new Set();
  return {
    now: () => now,
    timers: { set: (run, ms) => { const timer = { at: now + ms, run }; pending.add(timer); return timer; }, clear: (timer) => pending.delete(timer) },
    advance(ms) {
      now += ms;
      for (const timer of [...pending].sort((a, b) => a.at - b.at)) if (timer.at <= now) { pending.delete(timer); timer.run(); }
    },
  };
}

/** A desktop's and a phone's ports that record each call. */
function ports() {
  const calls = [];
  const record = (name, answer) => async (...args) => (calls.push([name, ...args]), answer);
  return {
    calls,
    desktop: {
      maxExecS: 600, exec: record("exec", { exitCode: 0, signal: null, timedOut: false }),
      screen: { shot: record("screen.shot", { png: new Uint8Array([1]), width: 1, height: 1 }) },
      input: { actions: record("input.actions") },
    },
    phone: {
      maxExecS: 600,
      phone: { shot: record("phone.shot", { png: new Uint8Array([2]), width: 1, height: 1 }), tap: record("phone.tap"), swipe: record("phone.swipe"), type: record("phone.type"), apps: { list: record("phone.apps.list", ["mail"]), open: record("phone.apps.open") } },
    },
  };
}

/** Whether `promise` has settled yet: it is given every queued turn first. */
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  return done;
}

test("a hold is taken once, ends at the hand-back, after its longest time, or at the run's end, each said once", () => {
  const time = fakeTime();
  const hold = computerHold({ timers: time.timers, now: time.now });
  const ends = [];
  hold.onEnd((why) => ends.push(why));
  assert.deepEqual(hold.state(), { held: false });
  assert.equal(hold.take(), true);
  assert.equal(hold.take(), false, "taking a held computer changes nothing");
  assert.deepEqual(hold.state(), { held: true, since: 1_000_000, until: 1_000_000 + HOLD_MAX_MS });
  assert.equal(hold.give(), true);
  assert.equal(hold.give(), false, "nothing held, nothing given");
  assert.equal(hold.take(), true);
  time.advance(HOLD_MAX_MS - 1);
  assert.equal(hold.state().held, true);
  time.advance(1);
  assert.equal(hold.state().held, false, "at its longest time it goes back to the agent");
  hold.take();
  hold.give("ended");
  assert.deepEqual(ends, ["given", "expired", "ended"]);
  assert.equal(HOLD_MAX_MS, 15 * 60_000);
});

test("while held, a desktop's look waits and then runs, and its act waits and then is not done, in words; with nobody holding, both run", async () => {
  const { calls, desktop } = ports();
  const hold = computerHold();
  const hands = heldHands(desktop, hold);
  await hands.input.actions([{ type: "click" }]);
  assert.deepEqual(calls.map(([name]) => name), ["input.actions"], "nobody holds it: the act runs");
  hold.take();
  const look = hands.screen.shot();
  const doing = hands.input.actions([{ type: "type", text: "hi" }]);
  assert.equal(await settled(look), false, "the look waits while the person holds it");
  assert.equal(await settled(doing), false, "so does the act");
  assert.deepEqual(calls.map(([name]) => name), ["input.actions"], "neither reached the computer");
  hold.give();
  assert.deepEqual(await look, { png: new Uint8Array([1]), width: 1, height: 1 }, "the look runs after the hand-back");
  await assert.rejects(doing, (error) => error.code === TAKEN_OVER && error.message === personHadWords("desktop", "input"));
  assert.deepEqual(calls.map(([name]) => name), ["input.actions", "screen.shot"], "the act was never sent");
  assert.equal((await hands.exec("true", { timeoutS: 1 })).exitCode, 0, "exec passes through, held or not");
});

test("a phone's looks (its screen, its apps) wait and run; its acts (tap, swipe, typing, opening an app) wait and are not done", async () => {
  const { calls, phone } = ports();
  const hold = computerHold();
  const hands = heldHands(phone, hold);
  hold.take();
  const parked = [hands.phone.shot(), hands.phone.apps.list(), hands.phone.tap({ x: 1, y: 2 }), hands.phone.swipe({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 1 }), hands.phone.type("x"), hands.phone.apps.open("mail")];
  for (const call of parked) assert.equal(await settled(call), false);
  hold.give();
  const answers = await Promise.allSettled(parked);
  assert.deepEqual(answers.slice(0, 2).map((a) => a.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(answers.slice(2).map((a) => [a.status, a.reason?.code, a.reason?.message]), [
    ["rejected", TAKEN_OVER, personHadWords("phone", "tap")], ["rejected", TAKEN_OVER, personHadWords("phone", "swipe")],
    ["rejected", TAKEN_OVER, personHadWords("phone", "typing")], ["rejected", TAKEN_OVER, personHadWords("phone", "app opening")],
  ]);
  assert.deepEqual(calls.map(([name]) => name), ["phone.shot", "phone.apps.list"], "only the looks reached the phone");
});

test("a wait for the hand-back stops at its signal's abort", async () => {
  const hold = computerHold();
  hold.take();
  const controller = new AbortController();
  const waiting = hold.untilFree(controller.signal);
  controller.abort(new Error("the run stopped"));
  await assert.rejects(waiting, /the run stopped/);
  hold.give();
  await hold.untilFree();
});
