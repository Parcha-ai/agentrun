import assert from "node:assert/strict";
import { test } from "node:test";
import { ARC, bandOf, lessonFor } from "../page/lessons.ts";

test("a checkpoint's lesson follows the distance its own file reports, not the clock", () => {
  assert.equal(bandOf(0), "fall");
  assert.equal(bandOf(ARC.shuffleFrom - 0.01), "fall");
  assert.equal(bandOf(ARC.shuffleFrom), "shuffle");
  assert.equal(bandOf(ARC.walkFrom - 0.01), "shuffle");
  assert.equal(bandOf(ARC.walkFrom), "walk");
  assert.equal(bandOf(4.2), "walk");
});

test("a file that reports no usable distance teaches no lesson", () => {
  for (const d of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.equal(bandOf(d), null, String(d));
  assert.equal(lessonFor(null, false), null);
});

test("the arc reads: don't fall, shuffle, first steps, then walking has its own caption", () => {
  assert.equal(lessonFor("fall", false), "Lesson 1: don't fall over.");
  assert.equal(lessonFor("shuffle", false), "Lesson 2: shuffling forward.");
  assert.equal(lessonFor("walk", true), "First steps.");
  assert.equal(lessonFor("walk", false), null);
});

test("D2's measured checkpoints on the take body land in the lessons the lead's arc names", () => {
  const measured: [number, number][] = [[1, 0.03], [2, 0.05], [3, 0.12], [4, 0.15], [5, 0.19], [6, 3.1], [7, 4.0], [8, 4.4], [9, 4.7], [10, 4.9]];
  const bands = measured.map(([, d]) => bandOf(d));
  assert.deepEqual(bands, ["fall", "fall", "shuffle", "shuffle", "shuffle", "walk", "walk", "walk", "walk", "walk"]);
  let first = true;
  const said = bands.map((b) => {
    const line = lessonFor(b, b === "walk" && first);
    if (b === "walk") first = false;
    return line;
  });
  assert.deepEqual(said, ["Lesson 1: don't fall over.", "Lesson 1: don't fall over.", "Lesson 2: shuffling forward.", "Lesson 2: shuffling forward.", "Lesson 2: shuffling forward.", "First steps.", null, null, null, null]);
});
