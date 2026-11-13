// A person's hold on a run's desktop or phone (serve/src/workspace/computer-hold.ts): agent, pending (the take waits out
// the agent's call in flight) and person; a take ends given, answered, idle, away or released, each said once; while the
// person has it, the run's screen, input and phone calls park, and at the hand-back a look runs on the screen as the
// person left it and an act is not done, the model told the person had it. The agent's ask is one at a time, clamped to
// its longest wait, and ends done, cancelled or expired. Driven by events and a fake clock: nothing here sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASK_WAITING, computerHold, HOLD_ASK_MAX_MS, HOLD_IDLE_MS, heldHands, personHadWords, TAKEN_OVER } from "../dist/workspace/computer-hold.js";

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
      phone: { shot: record("phone.shot", { png: new Uint8Array([2]), width: 1, height: 1 }), tree: record("phone.tree", { nodes: [], total: 0, truncated: false }), tap: record("phone.tap"), swipe: record("phone.swipe"), type: record("phone.type"), key: record("phone.key"), apps: { list: record("phone.apps.list", ["mail"]), open: record("phone.apps.open") } },
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

/** The hold's state changes, as [state, ended?]. */
const statesOf = (events) => events.filter((event) => event.type === "state").map((event) => (event.ended ? [event.state, event.ended] : [event.state]));

test("a take is taken once and ends given, idle (no input for its bound), away or released, each said once with its take's name", () => {
  const time = fakeTime();
  const hold = computerHold({ timers: time.timers, now: time.now });
  const events = [];
  hold.on((event) => events.push(event));
  assert.equal(hold.state(), "agent");
  assert.equal(hold.take({ by: 7 }), true);
  assert.equal(hold.current(), "c7", "a row's take is named by the row");
  assert.equal(hold.take(), false, "taking a held computer changes nothing");
  assert.equal(hold.state(), "person", "no agent call in flight: the person drives at once");
  assert.equal(hold.give("given", { by: 8 }), true);
  assert.equal(hold.give(), false, "nothing held, nothing given");

  hold.take();
  time.advance(HOLD_IDLE_MS - 1);
  hold.touched();
  time.advance(HOLD_IDLE_MS - 1);
  assert.equal(hold.state(), "person", "input from the person starts the idle bound again");
  time.advance(1);
  assert.equal(hold.state(), "agent", "no input for the idle bound: back to the agent");

  hold.take();
  hold.away();
  hold.take();
  hold.close();
  assert.equal(hold.take(), false, "a closed hold takes nothing");
  assert.deepEqual(statesOf(events), [["person"], ["agent", "given"], ["person"], ["agent", "idle"], ["person"], ["agent", "away"], ["person"], ["agent", "released"]]);
  assert.deepEqual(events.slice(0, 2).map((event) => [event.take, event.by]), [["c7", 7], ["c7", 8]], "the rows that took it and gave it back");
  assert.equal(HOLD_IDLE_MS, 15 * 60_000);
});

test("a take while the agent's call is in flight is pending until that call ends, and new agent calls park meanwhile", async () => {
  const hold = computerHold();
  let finish;
  const inShot = new Promise((resolve) => (finish = resolve));
  const calls = [];
  const hands = heldHands({ screen: { shot: async () => (calls.push("shot"), await inShot, { png: 1 }) }, input: { actions: async () => void calls.push("actions") } }, hold);
  const first = hands.screen.shot();
  await settled(Promise.resolve());
  assert.equal(hold.take(), true);
  assert.equal(hold.state(), "pending", "the take waits out the call in flight");
  const parked = hands.input.actions([{ type: "click" }]);
  assert.equal(await settled(parked), false, "a new agent call is parked while the take is pending");
  finish();
  await first;
  assert.equal(hold.state(), "person", "the call ended: the person drives");
  hold.give();
  await assert.rejects(parked, (error) => error.code === TAKEN_OVER, "the parked act is not done");
  assert.deepEqual(calls, ["shot"]);
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

test("a phone's looks (its screen, its structure, its apps) wait and run; its acts (tap, swipe, typing, a key, opening an app) wait and are not done", async () => {
  const { calls, phone } = ports();
  const hold = computerHold();
  const hands = heldHands(phone, hold);
  hold.take();
  const parked = [hands.phone.shot(), hands.phone.tree(), hands.phone.apps.list(), hands.phone.tap({ x: 1, y: 2 }), hands.phone.swipe({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 1 }), hands.phone.type("x"), hands.phone.key("back"), hands.phone.apps.open("mail")];
  for (const call of parked) assert.equal(await settled(call), false);
  hold.give();
  const answers = await Promise.allSettled(parked);
  assert.deepEqual(answers.slice(0, 3).map((a) => a.status), ["fulfilled", "fulfilled", "fulfilled"]);
  assert.deepEqual(answers.slice(3).map((a) => [a.status, a.reason?.code, a.reason?.message]), [
    ["rejected", TAKEN_OVER, personHadWords("phone", "tap")], ["rejected", TAKEN_OVER, personHadWords("phone", "swipe")],
    ["rejected", TAKEN_OVER, personHadWords("phone", "typing")], ["rejected", TAKEN_OVER, personHadWords("phone", "key press")],
    ["rejected", TAKEN_OVER, personHadWords("phone", "app opening")],
  ]);
  assert.deepEqual(calls.map(([name]) => name), ["phone.shot", "phone.tree", "phone.apps.list"], "only the looks reached the phone");
});

test("a phone that offers neither its tree nor its keys (an iPhone) keeps neither through the hold", () => {
  const { phone } = ports();
  const { tree, key, ...bare } = phone.phone;
  const hands = heldHands({ ...phone, phone: bare }, computerHold());
  assert.equal(hands.phone.tree, undefined);
  assert.equal(hands.phone.key, undefined);
});

test("the agent's ask: one at a time, clamped to its longest wait, answered by the person, or expired; a hand-back while the person holds the computer answers it done, and the take ends answered", async () => {
  const time = fakeTime();
  const hold = computerHold({ timers: time.timers, now: time.now });
  const events = [];
  hold.on((event) => events.push(event));
  const hands = heldHands({}, hold);
  const asking = hands.handoff.ask({ instruction: "Sign in", completion_condition: "the inbox shows", expires_at: new Date(time.now() + 10 * HOLD_ASK_MAX_MS).toISOString() });
  const ask = hold.asked();
  assert.equal(ask.expires_at, new Date(time.now() + HOLD_ASK_MAX_MS).toISOString(), "clamped to the longest wait");
  await assert.rejects(hands.handoff.ask({ instruction: "again", completion_condition: "x" }), new RegExp(ASK_WAITING));
  assert.equal(hold.answer("not-it", "done"), false);
  assert.equal(hold.answer(ask.id, "cancelled", { by: 3 }), true);
  assert.deepEqual(await asking, { outcome: "cancelled" });
  assert.equal(hold.answer(ask.id, "done"), false, "answered once");

  const lapsing = hold.ask({ instruction: "Pay", completion_condition: "paid" });
  time.advance(HOLD_ASK_MAX_MS);
  assert.deepEqual(await lapsing, { outcome: "expired" });

  const taking = hold.ask({ instruction: "Type the code", completion_condition: "signed in" });
  hold.take();
  hold.give();
  assert.deepEqual(await taking, { outcome: "done" }, "the hand-back answered it");
  assert.deepEqual(events.filter((event) => event.type !== "asked").map((event) => (event.type === "answered" ? ["answered", event.outcome] : [event.state, event.ended])), [
    ["answered", "cancelled"], ["answered", "expired"], ["person", undefined], ["agent", "answered"], ["answered", "done"],
  ]);
});

test("an ask stops at its signal's abort, and at the hold's close; a parked call stops at its signal's abort", async () => {
  const hold = computerHold();
  const controller = new AbortController();
  const asking = hold.ask({ instruction: "x", completion_condition: "y" }, controller.signal);
  controller.abort(new Error("the run stopped"));
  await assert.rejects(asking, /the run stopped/);
  assert.equal(hold.asked(), undefined, "the ask is closed");
  hold.take();
  const parked = new AbortController();
  const waiting = hold.enter(parked.signal);
  parked.abort(new Error("the call was cut"));
  await assert.rejects(waiting, /the call was cut/);
  const left = hold.ask({ instruction: "x", completion_condition: "y" });
  hold.close();
  await assert.rejects(left, /let go before the person answered/);
  assert.equal(hold.state(), "agent", "closed: the take ended released");
});

test("once the run is ending (finish), nothing new is taken, and a take in force goes on until it ends (#2134)", () => {
  const time = fakeTime();
  const hold = computerHold({ timers: time.timers, now: time.now });
  assert.equal(hold.take(), true);
  hold.finish();
  assert.equal(hold.finishing(), true);
  assert.equal(hold.state(), "person", "the take in force is not ended by the run's end");
  assert.equal(hold.give(), true, "it is handed back as before");
  assert.equal(hold.take(), false, "a take after the hand-back is refused: the release would cut it");
  assert.equal(hold.state(), "agent");
  assert.equal(computerHold().finishing(), false, "a hold is not ending until finish");
});
