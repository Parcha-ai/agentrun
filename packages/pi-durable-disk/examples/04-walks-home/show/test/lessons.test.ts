import assert from "node:assert/strict";
import { test } from "node:test";
import { ARC, bandOf, lessonName, versionLine } from "../page/lessons.ts";

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

test("a file that reports no usable distance has no band", () => {
  for (const d of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.equal(bandOf(d), null, String(d));
});

test("every version gets a caption in the same fixed window: its number, the lesson, and how far it walked in 10 s", () => {
  assert.equal(versionLine(1, "fall", 0.03), "Version 1: don't fall over - 0.03 m in 10 s");
  assert.equal(versionLine(4, "shuffle", 0.17), "Version 4: shuffling forward - 0.17 m in 10 s");
  assert.equal(versionLine(6, "steps", 3.59), "Version 6: first steps - 3.6 m in 10 s");
  assert.equal(versionLine(8, "walk", 4.76), "Version 8: walking - 4.8 m in 10 s");
  assert.equal(versionLine(undefined, "walk", 4), "A new version: walking - 4.0 m in 10 s", "no number reported: no number invented");
  for (const band of ["fall", "shuffle", "steps", "walk"] as const) assert.match(versionLine(2, band, 1), / in 10 s$/, "always the same window");
});

test("D2's measured checkpoints on the take body (cc8b0f6b, one H100, 20 runs of 10 s each) land in the lessons the arc names", () => {
  const metres = [0.03, 0.06, 0.12, 0.17, 0.42, 3.59, 4.49, 4.76, 4.75, 4.74];
  assert.deepEqual(metres.map(bandOf), ["fall", "fall", "shuffle", "shuffle", "shuffle", "steps", "walk", "walk", "walk", "walk"]);
  assert.deepEqual(metres.map((d) => lessonName(bandOf(d)!)), ["don't fall over", "don't fall over", "shuffling forward", "shuffling forward", "shuffling forward", "first steps", "walking", "walking", "walking", "walking"]);
});

test("a run that reaches first steps at a different checkpoint says the same thing: the band decides, not the number", () => {
  assert.equal(lessonName(bandOf(3.6)!), "first steps", "whether it is checkpoint 5 or 7");
  assert.equal(lessonName(bandOf(2.2)!), "first steps");
});

test("no lesson quotes a fall rate or any number but the lesson's own and the distance: a rate measured on a different random brain is never put over the tab's untrained creature", () => {
  for (const band of ["fall", "shuffle", "steps", "walk"] as const) assert.doesNotMatch(lessonName(band), /\d|%/, band); // no lesson numbers either: "Version 5 / Lesson 2" confused a viewer
});
