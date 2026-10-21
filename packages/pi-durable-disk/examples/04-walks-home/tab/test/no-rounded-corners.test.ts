// Invariant: no rounded corner on any surface of the creature page, which is filmed; only a true circle, such as a status dot.
// The page's sheet is read as text, so a corner added later fails here before it is filmed. A drawn circle (a foot, a handle on the sketch) is a shape, not a corner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

test("the creature page has no rounded corner: every border-radius is 0, or a true circle (50%)", () => {
  const bad: string[] = [];
  read("index.html").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/border-radius\s*:\s*([^;}"]+)/g)) {
      const v = m[1]!.trim();
      if (!/^(0|0px|50%)(\s*!important)?$/.test(v)) bad.push(`index.html:${i + 1}: border-radius: ${v}`);
    }
  });
  assert.deepEqual(bad, []);
});

test("the sketch draws its torso with square corners (no roundRect)", () => {
  assert.doesNotMatch(read("src/sketch.ts"), /roundRect\(/);
});
