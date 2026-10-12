import assert from "node:assert/strict";
import { test } from "node:test";
import { WriteGate } from "../tab/write-gate.ts";

const tick = () => new Promise<void>((r) => setImmediate(r));

test("a write waits while the gate is closed and runs when it opens", async () => {
  let closed = true;
  const gate = new WriteGate(() => closed, async () => { await tick(); });
  const ran: string[] = [];
  const held = gate.run(async () => { ran.push("a"); });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(ran, [], "nothing is written while closed");
  closed = false;
  await held;
  assert.deepEqual(ran, ["a"]);
});

test("drain waits for a write that started before the gate closed, and a write after the close is not part of it", async () => {
  let closed = false;
  const gate = new WriteGate(() => closed, async () => { await tick(); });
  let release!: () => void;
  const order: string[] = [];
  const inFlight = gate.run(() => new Promise<void>((r) => { release = () => { order.push("landed"); r(); }; }));
  closed = true; // the checkout starts
  const late = gate.run(async () => { order.push("late"); });
  const drained = gate.drain().then(() => order.push("drained"));
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(order, [], "the drain is waiting for the write in flight");
  release();
  await drained;
  await inFlight;
  assert.deepEqual(order, ["landed", "drained"], "the in-flight write landed before the drain finished; the late one is still held");
  closed = false;
  await late;
  assert.deepEqual(order, ["landed", "drained", "late"]);
});

test("a failed write does not keep the drain waiting; a gate closed past the limit refuses as not-holder", async () => {
  let closed = false;
  let t = 0;
  const gate = new WriteGate(() => closed, async () => { t += 100; }, 1_000, () => t);
  const failed = gate.run(async () => { throw new Error("disk"); });
  await assert.rejects(failed, /disk/);
  await gate.drain();
  closed = true;
  await assert.rejects(gate.run(async () => {}), /not-holder/);
});
