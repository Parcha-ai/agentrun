// A create that is slow to place is reported and kept, never cancelled: it joins when it places, and is given up only when the pool closes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitPlacement } from "../placement-wait.ts";

const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

test("a create that places after the slow threshold is reported once and then joins: the same request is waited for, not terminated", async () => {
  const slow: number[] = [];
  const outcome = await awaitPlacement(later(120, "box"), { slowAfterMs: 30, signal: new AbortController().signal, onSlow: (ms) => void slow.push(ms) });
  assert.ok("placed" in outcome && outcome.value === "box", "the late box is the result, not a timeout");
  assert.equal(slow.length, 1, "reported once");
  assert.ok(slow[0]! >= 25, "after about the threshold");
  assert.ok("placed" in outcome && outcome.waitedMs >= 110);
});

test("a create that places before the threshold is not reported", async () => {
  const slow: number[] = [];
  const outcome = await awaitPlacement(later(5, "box"), { slowAfterMs: 200, signal: new AbortController().signal, onSlow: (ms) => void slow.push(ms) });
  assert.ok("placed" in outcome);
  assert.equal(slow.length, 0);
});

test("a create that fails with an error rejects (the pool's retry is for that), and a slow one is not turned into an error", async () => {
  await assert.rejects(awaitPlacement(Promise.reject(new Error("no such image")), { slowAfterMs: 50, signal: new AbortController().signal, onSlow: () => undefined }), /no such image/);
});

test("the pool closing while a box is still placing abandons the wait, so the caller can terminate the box if it ever lands", async () => {
  const closing = new AbortController();
  const waiting = awaitPlacement(later(500, "box"), { slowAfterMs: 10, signal: closing.signal, onSlow: () => undefined });
  setTimeout(() => closing.abort(), 40);
  assert.deepEqual(await waiting, { abandoned: true });
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await awaitPlacement(later(500, "box"), { slowAfterMs: 10, signal: already.signal, onSlow: () => undefined }), { abandoned: true });
});
