// The per-browser mutex between a person driving the live view and the model's browser calls (src/core/driving.ts), in the shape live-view/protocol.ts
// asks of it (`DrivingGates`): the two never interleave, in either direction, and a viewer's input is discarded while the agent acts, never queued.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFailureError } from "../dist/index.js";
import { PERSON_DRIVING, createDrivingGates, drivingGates, personDrivingFailure, withModelCall } from "../dist/core/driving.js";

/** Timers the test turns by hand. */
function clock() {
  let now = 0, next = 1;
  const pending = new Map();
  return {
    timers: { set: (run, ms) => { const id = next++; pending.set(id, { at: now + ms, run }); return id; }, clear: (id) => { pending.delete(id); } },
    advance(ms) { now += ms; for (const [id, t] of [...pending]) if (t.at <= now) { pending.delete(id); t.run(); } },
    pending: () => pending.size,
  };
}
const rig = (idleMs = 3000) => { const c = clock(); return { c, gates: createDrivingGates({ idleMs, timers: c.timers }) }; };
const watch = (gate) => { const seen = []; const stop = gate.onChange((s) => seen.push(s)); return { seen, stop }; };

test("a model call is refused while a person is driving", () => {
  const { gates } = rig();
  const g = gates("tag-a");
  assert.equal(g.input(), "driving");
  assert.equal(g.model(), "person_driving");
  assert.equal(g.state(), "person", "the refused call changed nothing");
});

test("a model call in flight makes the viewer's input discarded, not queued: it never turns into the person driving later", () => {
  const { gates } = rig();
  const g = gates("tag-a");
  const call = g.model();
  assert.equal(typeof call, "object");
  assert.equal(g.state(), "agent");
  assert.equal(g.input(), "agent_acting");
  assert.equal(g.input(), "agent_acting");
  call.release();
  assert.equal(g.state(), "idle", "the discarded input did not start a turn for the person");
  const again = g.model();
  assert.equal(typeof again, "object", "so the model may act again at once");
  again.release();
});

test("the mutex holds both ways in one sequence, and each change is announced once", () => {
  const { gates, c } = rig(3000);
  const g = gates("t");
  const { seen } = watch(g);
  const call = g.model();
  assert.equal(g.input(), "agent_acting");
  call.release();
  assert.equal(g.input(), "driving");
  assert.equal(g.input(), "driving");
  assert.equal(g.model(), "person_driving");
  c.advance(2999);
  assert.equal(g.model(), "person_driving", "still driving 1 ms before the idle limit");
  c.advance(1);
  assert.equal(g.state(), "idle");
  const again = g.model();
  assert.equal(typeof again, "object");
  again.release();
  assert.deepEqual(seen, ["agent", "idle", "person", "idle", "agent", "idle"], "agent, idle, person, idle, agent, idle: transitions only");
});

test("each input of the person extends their turn, with one timer, never a pile", () => {
  const { gates, c } = rig(1000);
  const g = gates("t");
  g.input();
  c.advance(900);
  g.input();
  c.advance(900);
  assert.equal(g.state(), "person", "the second input moved the limit");
  assert.equal(c.pending(), 1);
  c.advance(100);
  assert.equal(g.state(), "idle");
  assert.equal(c.pending(), 0);
});

test("two model calls in flight keep the state 'agent' until both are released, and releasing one twice counts once", () => {
  const { gates } = rig();
  const g = gates("t");
  const { seen } = watch(g);
  const a = g.model(), b = g.model();
  a.release(); a.release();
  assert.equal(g.state(), "agent", "b still runs");
  b.release();
  assert.equal(g.state(), "idle");
  assert.deepEqual(seen, ["agent", "idle"]);
});

test("a gate is the tag's: the same tag gives the same gate, other tags are independent", () => {
  const { gates } = rig();
  assert.equal(gates("a"), gates("a"));
  assert.notEqual(gates("a"), gates("b"));
  gates("a").input();
  const other = gates("b").model();
  assert.equal(typeof other, "object", "a person driving 'a' does not stop the model on 'b'");
  assert.equal(gates("a").model(), "person_driving");
  other.release();
});

test("end forgets the gate: listeners dropped, the timer cleared, and the tag starts over", () => {
  const { gates, c } = rig();
  const g = gates("t");
  const { seen } = watch(g);
  g.input();
  g.end();
  assert.equal(c.pending(), 0, "the idle timer went with it");
  assert.equal(g.state(), "idle");
  const fresh = gates("t");
  assert.notEqual(fresh, g, "the tag's next gate is a new one");
  const call = fresh.model();
  assert.equal(typeof call, "object");
  call.release();
  g.input();
  assert.deepEqual(seen, ["person"], "the ended gate's listener heard nothing after end, even from a stale reference");
  g.end();
});

test("the process's default registry is one registry: the model side and the live view get the same gate for a tag", () => {
  const tag = `default-registry-${process.pid}`;
  try {
    assert.equal(drivingGates(tag), drivingGates(tag));
    drivingGates(tag).input();
    assert.equal(drivingGates(tag).model(), "person_driving", "a person driving through one caller stops the model through another");
    assert.notEqual(drivingGates(tag), createDrivingGates()(tag), "a test's own registry is isolated from it");
  } finally { drivingGates(tag).end(); }
});

test("viewing is a viewer being connected, not driving: it survives the idle window, and end() clears it from the gate and from the tag's next gate", () => {
  const { gates, c } = rig(1000);
  const g = gates("t");
  assert.equal(g.viewing(), false);
  g.setViewing(true);
  g.input();
  c.advance(1000);
  assert.equal(g.state(), "idle");
  assert.equal(g.viewing(), true, "idle is not away");
  g.end();
  assert.equal(g.viewing(), false, "the ended gate no longer says a viewer is connected");
  assert.equal(gates("t").viewing(), false, "and the tag's next gate starts without one");
});

test("unsubscribing stops the notices, and a listener that throws cannot stop the model or another listener", () => {
  const { gates } = rig();
  const g = gates("t");
  const { seen, stop } = watch(g);
  g.onChange(() => { throw new Error("viewer bug"); });
  const heard = [];
  g.onChange((s) => heard.push(s));
  const call = g.model();
  call.release();
  assert.deepEqual(heard, ["agent", "idle"], "the listener after the throwing one still heard both");
  stop();
  g.model().release();
  assert.deepEqual(seen, ["agent", "idle"], "nothing after unsubscribing");
});

test("withModelCall refuses with a typed, retryable failure while a person drives, and releases when the work throws", async () => {
  const { gates } = rig();
  const g = gates("t");
  g.input();
  await assert.rejects(withModelCall(g, async () => 1), (error) => {
    assert.ok(error instanceof BrowserFailureError);
    assert.equal(error.failure.code, "refused");
    assert.equal(error.failure.retryable, true);
    assert.equal(error.failure.effect, "none");
    assert.ok(error.failure.message.startsWith(`${PERSON_DRIVING}: `), error.failure.message);
    assert.deepEqual(error.failure, personDrivingFailure());
    return true;
  });
  g.end();
  const h = gates("t");
  await assert.rejects(withModelCall(h, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(h.state(), "idle", "the call was released");
  assert.equal(await withModelCall(h, async () => 7), 7);
});
