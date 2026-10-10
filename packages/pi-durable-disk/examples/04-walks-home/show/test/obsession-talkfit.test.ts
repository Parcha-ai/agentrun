import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_TALK_SCALE, chooseScale } from "../obsession/talkfit.ts";

// The big centre view shows the small model's answer large. Take 7 cut the joke's punchline off at the bottom (a fixed line clamp and a box that overflowed) while the side chat showed it
// all. The type shrinks to fit the box, never below a readable size; an answer too long even then is cut with a visible mark, and what is shown is its END.
const content = (perUnit: number, fixed = 0) => (scale: number) => fixed + perUnit * scale; // a box whose content height grows linearly with the type size

test("an answer that fits at full size is left at full size", () => {
  assert.deepEqual(chooseScale(content(300), 400), { scale: 1, fits: true });
  assert.deepEqual(chooseScale(content(400), 400), { scale: 1, fits: true }, "exactly the room");
});

test("a longer answer gets the largest type that fits the box", () => {
  const r = chooseScale(content(800), 500);
  assert.equal(r.fits, true);
  assert.ok(r.scale < 1 && r.scale >= MIN_TALK_SCALE);
  assert.ok(content(800)(r.scale) <= 500, "what is chosen fits");
  assert.ok(content(800)(r.scale + 0.01) > 500 - 0.5 || r.scale + 0.01 >= 1, "and it is nearly the largest that does: not shrunk more than needed");
  // Fixed parts (the question, the thinking) take room too.
  const r2 = chooseScale(content(600, 200), 500);
  assert.ok(content(600, 200)(r2.scale) <= 500 && r2.fits);
});

test("an answer too long for the smallest readable type does not fit: the minimum, flagged, so the page cuts it with a visible mark", () => {
  const r = chooseScale(content(5000), 500);
  assert.deepEqual(r, { scale: MIN_TALK_SCALE, fits: false });
  assert.ok(MIN_TALK_SCALE >= 0.4 && MIN_TALK_SCALE < 1, "small but readable: 42 px type at this scale is still about 17 px");
});

test("nonsense measures and rooms never give a scale outside the range", () => {
  for (const [m, avail] of [[() => NaN, 500], [() => Infinity, 500], [() => 100, NaN], [() => 100, -5], [() => 100, 0]] as [(s: number) => number, number][]) {
    const r = chooseScale(m, avail);
    assert.ok(r.scale >= MIN_TALK_SCALE && r.scale <= 1 && Number.isFinite(r.scale), JSON.stringify(r));
  }
  assert.equal(chooseScale(() => 100, NaN).fits, false, "no room to speak of: not claimed to fit");
});
