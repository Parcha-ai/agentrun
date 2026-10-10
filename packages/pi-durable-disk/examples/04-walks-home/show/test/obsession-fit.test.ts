import assert from "node:assert/strict";
import { test } from "node:test";
import { DESIGN_HEIGHT, DESIGN_WIDTH, MIN_ZOOM, stageZoom } from "../obsession/fit.ts";

// Live mode runs in the viewer's own browser. The stage is laid out for 1600x900 (the recording's size) and, in a smaller window, scaled down as a whole so the same layout fits:
// the big moment is the tallest thing on it, and it clipped under the caption strip at 1440x900 and 1280x800.
test("the recording's 1600x900 is exactly as designed: no zoom at all", () => {
  assert.equal(stageZoom(1600, 900), 1);
  assert.deepEqual([DESIGN_WIDTH, DESIGN_HEIGHT], [1600, 900]);
});

test("a bigger window is never zoomed up: the layout is the one that was designed", () => {
  for (const [w, h] of [[1920, 1080], [2560, 1440], [1600, 1200], [3000, 900]]) assert.equal(stageZoom(w, h), 1, `${w}x${h}`);
});

test("a smaller window scales the whole stage by the tighter of its two ratios, so the designed layout still fits", () => {
  assert.equal(stageZoom(1280, 800), 0.8);
  assert.equal(stageZoom(1440, 900), 0.9);
  assert.equal(stageZoom(1512, 982), 0.945);
  assert.equal(stageZoom(1024, 768), 0.64);
  assert.equal(stageZoom(1920, 700), 0.778, "short and wide: the height is the tighter ratio");
  for (const [w, h] of [[1280, 800], [1440, 900], [1512, 982], [1024, 768]]) {
    const z = stageZoom(w, h);
    assert.ok(w / z >= DESIGN_WIDTH - 1 && h / z >= DESIGN_HEIGHT - 1, `${w}x${h}: the layout viewport (${Math.round(w / z)}x${Math.round(h / z)}) is at least the designed one`);
  }
});

test("a tiny or nonsense window is clamped or left alone, never zero or NaN", () => {
  assert.equal(stageZoom(300, 200), MIN_ZOOM);
  for (const bad of [0, -5, NaN, Infinity]) assert.equal(stageZoom(bad, 900), 1, `width ${bad}`);
});
