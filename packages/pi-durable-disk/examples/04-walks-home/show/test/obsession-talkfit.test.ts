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

// Greptile on #177: the chosen scale is reported to three decimals, and rounding to the NEAREST can round a fitting scale UP past the room (measure 800 * s, room 499.9: the search ends at
// 0.62487, which rounds to 0.625 and measures 500). The text then wraps one line more than it was measured to, and the cut mark is skipped. The reported scale always fits.
test("the scale that is reported always fits: it is never rounded up past the room", () => {
  const m = (s: number) => 800 * s;
  const r = chooseScale(m, 499.9);
  assert.equal(r.fits, true);
  assert.ok(m(r.scale) <= 499.9, `0.625 would measure 500; got ${r.scale} measuring ${m(r.scale)}`);
  // Every fractional room across the range, for several content sizes.
  for (const per of [650, 800, 1234.5, 3000]) {
    for (let room = 300; room < per; room += 7.37) {
      const out = chooseScale((s) => per * s, room);
      if (out.fits) assert.ok(per * out.scale <= room, `per ${per}, room ${room}: scale ${out.scale} measures ${per * out.scale}`);
    }
  }
  assert.ok(chooseScale(m, 499.9).scale > 0.62, "and it is still the largest that fits, to three decimals: not shrunk more than needed");
});
