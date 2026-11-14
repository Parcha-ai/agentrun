// A person's hold on a run's desktop or phone (serve/src/workspace/computer-hold.ts): agent, pending (the take waits out
// the agent's call in flight) and person; a take ends given, answered, idle, away or released, each said once; while the
// person has it, the run's computer calls park, and at the hand-back a look runs on the screen as the
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

/** A computer's one port that records each op, and the run's exec beside it. */
function ports() {
  const calls = [];
  return {
    calls,
    hands: {
      maxExecS: 600,
      exec: async () => (calls.push("exec"), { exitCode: 0, signal: null, timedOut: false }),
      computer: { groups: ["ui", "screen", "input.pointer", "apps", "exec", "files"], call: async (op, args) => (calls.push(op), { value: { op, args }, text: op, images: [] }) },
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
  const hands = heldHands({ computer: { groups: ["ui"], call: async (op) => (calls.push(op), op === "observe" ? await inShot : undefined, { value: null, text: op, images: [] }) } }, hold);
  const first = hands.computer.call("observe", {});
  await settled(Promise.resolve());
  assert.equal(hold.take(), true);
  assert.equal(hold.state(), "pending", "the take waits out the call in flight");
  const parked = hands.computer.call("act", { steps: [{ press: "@e1" }] });
  assert.equal(await settled(parked), false, "a new agent call is parked while the take is pending");
  finish();
  await first;
  assert.equal(hold.state(), "person", "the call ended: the person drives");
  hold.give();
  await assert.rejects(parked, (error) => error.kind === TAKEN_OVER, "the parked act is not done");
  assert.deepEqual(calls, ["observe"]);
});

test("while held, a look (observe, a screenshot, the app list) waits and then runs, and an act (act, raw input, opening an app) waits and then is not done, in words; with nobody holding, both run", async () => {
  const { calls, hands: own } = ports();
  const hold = computerHold();
  const hands = heldHands(own, hold);
  await hands.computer.call("act", { steps: [{ press: "@e1" }] });
  assert.deepEqual(calls, ["act"], "nobody holds it: the act runs");
  hold.take();
  const looks = ["observe", "screenshot", "apps.list"].map((op) => hands.computer.call(op, {}));
  const acts = ["act", "input.act", "apps.open"].map((op) => hands.computer.call(op, {}));
  for (const call of [...looks, ...acts]) assert.equal(await settled(call), false, "every look and act waits while the person holds it");
  assert.deepEqual(calls, ["act"], "none reached the computer");
  hold.give();
  assert.deepEqual((await Promise.all(looks)).map((answer) => answer.text), ["observe", "screenshot", "apps.list"], "the looks run after the hand-back");
  const refused = await Promise.allSettled(acts);
  assert.deepEqual(refused.map((one) => [one.status, one.reason?.kind, one.reason?.message]), [
    ["rejected", TAKEN_OVER, personHadWords("act")], ["rejected", TAKEN_OVER, personHadWords("input")], ["rejected", TAKEN_OVER, personHadWords("app opening")],
  ]);
  assert.match(personHadWords("act"), /observe again before you act/);
  assert.deepEqual(calls, ["act", "observe", "screenshot", "apps.list"], "the acts were never sent");
  assert.equal((await hands.exec("true", { timeoutS: 1 })).exitCode, 0, "exec passes through, held or not");
});

test("the shell's and the files' ops through the computer are not the person's: they pass through while held", async () => {
  const { calls, hands: own } = ports();
  const hold = computerHold();
  const hands = heldHands(own, hold);
  hold.take();
  for (const op of ["shell.run", "files.read", "files.write", "files.list", "files.stat"]) assert.equal((await hands.computer.call(op, {})).text, op);
  assert.deepEqual(calls, ["shell.run", "files.read", "files.write", "files.list", "files.stat"]);
  assert.deepEqual(hands.computer.groups, own.computer.groups, "the port keeps its groups");
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
