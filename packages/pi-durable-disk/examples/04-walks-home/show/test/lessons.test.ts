import assert from "node:assert/strict";
import { test } from "node:test";
import { ARC, bandOf, lessonFor } from "../page/lessons.ts";

test("a checkpoint's lesson follows the distance its own file reports, not the clock or its number", () => {
  assert.equal(bandOf(0), "fall");
  assert.equal(bandOf(ARC.shuffleFrom - 0.01), "fall");
  assert.equal(bandOf(ARC.shuffleFrom), "shuffle");
  assert.equal(bandOf(ARC.stepsFrom - 0.01), "shuffle");
  assert.equal(bandOf(ARC.stepsFrom), "steps");
  assert.equal(bandOf(ARC.walkFrom - 0.01), "steps");
  assert.equal(bandOf(ARC.walkFrom), "walk");
  assert.equal(bandOf(9), "walk");
});

test("a file that reports no usable distance teaches no lesson", () => {
  for (const d of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.equal(bandOf(d), null, String(d));
  assert.equal(lessonFor(null), null);
});

test("the arc reads: don't fall, shuffle, first steps, then walking has its own caption", () => {
  assert.equal(lessonFor("fall"), "Lesson 1: don't fall over.");
  assert.equal(lessonFor("shuffle"), "Lesson 2: shuffling forward.");
  assert.equal(lessonFor("steps"), "First steps.");
  assert.equal(lessonFor("walk"), null);
});

test("D2's measured checkpoints on the take body (cc8b0f6b, one H100, 20 runs of 10 s each) land in the lessons the arc names", () => {
  const metres = [0.03, 0.06, 0.12, 0.17, 0.42, 3.59, 4.49, 4.76, 4.75, 4.74];
  assert.deepEqual(metres.map(bandOf), ["fall", "fall", "shuffle", "shuffle", "shuffle", "steps", "walk", "walk", "walk", "walk"]);
  assert.deepEqual(metres.map((d) => lessonFor(bandOf(d))), ["Lesson 1: don't fall over.", "Lesson 1: don't fall over.", "Lesson 2: shuffling forward.", "Lesson 2: shuffling forward.", "Lesson 2: shuffling forward.", "First steps.", null, null, null, null]);
});

test("a run that reaches first steps at a different checkpoint says the same thing: the band decides, not the number", () => {
  assert.equal(lessonFor(bandOf(3.6)), "First steps.", "whether it is checkpoint 5 or 7");
  assert.equal(lessonFor(bandOf(2.2)), "First steps.");
});

test("no lesson line quotes a number: a fall rate measured on a different random brain is never put over the tab's untrained creature", () => {
  for (const band of ["fall", "shuffle", "steps", "walk"] as const) assert.doesNotMatch((lessonFor(band) ?? "").replace(/^Lesson \d: /, ""), /\d|%/, band); // "Lesson 1" is a name, not a measurement
});
