import assert from "node:assert/strict";
import { test } from "node:test";
import { SerialReader } from "../episode2/reader.ts";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

test("a read that lands after the take started over is dropped, and the next read is applied", async () => {
  let generation = 1;
  const applied: string[] = [];
  const first = deferred<string | undefined>();
  const reads = [first.promise, Promise.resolve<string | undefined>("new take")];
  const r = new SerialReader(() => reads.shift()!, () => generation, (t) => applied.push(t));
  const pending = r.tick();
  generation = 2; // the take started over while the read was on its way
  first.resolve("old take's progress");
  await pending;
  assert.deepEqual(applied, [], "the old take's progress is not applied to the new one");
  await r.tick();
  assert.deepEqual(applied, ["new take"]);
});

test("reads do not overlap: a tick while one is in flight starts nothing, so an older read can never land after a newer one", async () => {
  let started = 0;
  const first = deferred<string | undefined>();
  const applied: string[] = [];
  const r = new SerialReader(() => (++started === 1 ? first.promise : Promise.resolve("later")), () => 1, (t) => applied.push(t));
  const a = r.tick();
  await r.tick();
  await r.tick();
  assert.equal(started, 1);
  first.resolve("earlier");
  await a;
  await r.tick();
  assert.deepEqual(applied, ["earlier", "later"], "in the order they were asked");
});

test("a read with nothing (not written yet, or failed) applies nothing and frees the reader", async () => {
  const applied: string[] = [];
  let n = 0;
  const r = new SerialReader(async () => {
    if (++n === 1) return undefined;
    if (n === 2) throw new Error("network");
    return "ok";
  }, () => 1, (t) => applied.push(t));
  await r.tick();
  await r.tick();
  await r.tick();
  assert.deepEqual(applied, ["ok"]);
});
