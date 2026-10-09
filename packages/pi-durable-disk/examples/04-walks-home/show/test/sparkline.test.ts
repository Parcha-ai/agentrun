import assert from "node:assert/strict";
import { test } from "node:test";
import { sparklineSvg } from "../page/sparkline.ts";

const D2 = [0.03, 0.06, 0.12, 0.17, 0.42, 3.59, 4.49, 4.76, 4.75, 4.74].map((metres, i) => ({ n: i + 1, metres }));
const coords = (svg: string) => (/points="([^"]+)"/.exec(svg)?.[1] ?? "").split(" ").filter(Boolean).map((p) => p.split(",").map(Number) as [number, number]);

test("before any version there is nothing to draw", () => {
  assert.equal(sparklineSvg([]), "");
});

test("each version is a point, left to right in the order they arrived, higher for a longer walk in the same 10 s", () => {
  const svg = sparklineSvg(D2);
  const pts = coords(svg);
  assert.equal(pts.length, 10);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i]![0] > pts[i - 1]![0], "x increases");
  assert.ok(pts[0]![1] > pts[5]![1], "the first version (0.03 m) sits below the sixth (3.59 m)");
  const top = Math.min(...pts.map((p) => p[1]));
  assert.equal(pts[7]![1], top, "the best version is the highest point");
  assert.ok(pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
});

test("the latest version is marked and labelled with its own number and distance", () => {
  const svg = sparklineSvg(D2.slice(0, 6));
  assert.match(svg, /class="last"/);
  assert.match(svg, />v6 3\.6 m</);
  assert.equal((svg.match(/<circle/g) ?? []).length, 6);
});

test("one version, or versions that all walked nothing, still draw without a broken number", () => {
  const one = sparklineSvg([{ n: 1, metres: 0.03 }]);
  assert.equal((one.match(/<circle/g) ?? []).length, 1);
  assert.doesNotMatch(one, /NaN|Infinity/);
  const flat = sparklineSvg([{ n: 1, metres: 0 }, { n: 2, metres: 0 }]);
  assert.doesNotMatch(flat, /NaN|Infinity/);
  assert.ok(coords(flat).every(([, y]) => Number.isFinite(y)));
});

test("it says what it shows, for a reader that cannot see it", () => {
  assert.match(sparklineSvg(D2), /role="img" aria-label="Metres walked in 10 s, by version"/);
});

import { chartPoints } from "../page/sparkline.ts";

test("the chart takes the versions the feed knows and the ones the tab reported, one point per version, the tab's word winning", () => {
  assert.deepEqual(chartPoints([{ n: 1, metres: 0.03 }, { n: 2, metres: 0.06 }], []), [{ n: 1, metres: 0.03 }, { n: 2, metres: 0.06 }]);
  assert.deepEqual(chartPoints([], [{ n: 2, metres: 0.07 }, { n: 1, metres: 0.04 }]), [{ n: 1, metres: 0.04 }, { n: 2, metres: 0.07 }], "in version order");
  assert.deepEqual(chartPoints([{ n: 1, metres: 0.03 }, { n: 2, metres: 0.06 }], [{ n: 2, metres: 0.07 }]), [{ n: 1, metres: 0.03 }, { n: 2, metres: 0.07 }]);
  assert.deepEqual(chartPoints([], []), []);
});
