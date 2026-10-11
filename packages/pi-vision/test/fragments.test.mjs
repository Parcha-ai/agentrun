// Fragments: the citation forms a receipt and an answer use, built and read back. What this module writes it reads;
// what it would never write (an unknown key, page 0, a window that ends before it starts, a region off the page,
// pixels instead of percent) reads as nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { citation, formatFragment, parseCitation, parseFragment } from "@parcha/pi-vision";

test("pages, windows and regions are written in the forms hosts resolve", () => {
  assert.equal(citation("filing.pdf", { page: { from: 3, to: 3 } }), "filing.pdf#page=3");
  assert.equal(citation("filing.pdf", { page: { from: 1, to: 37 } }), "filing.pdf#page=1-37");
  assert.equal(citation("call.mp4", { t: { from: 60, to: 90 } }), "call.mp4#t=60,90");
  assert.equal(citation("call.mp4", { t: { from: 62.5 } }), "call.mp4#t=62.5");
  assert.equal(citation("photo.jpg", { xywh: { x: 10, y: 20, w: 30, h: 40 } }), "photo.jpg#xywh=percent:10,20,30,40");
  assert.equal(formatFragment({ xywh: { x: 0, y: 50, w: 50, h: 50 }, t: { from: 5, to: 6 }, page: { from: 2, to: 2 } }), "page=2&t=5,6&xywh=percent:0,50,50,50", "dimensions in a fixed order");
});

test("what is written reads back as the same fragment", () => {
  const cases = [
    { page: { from: 1, to: 1 } }, { page: { from: 7, to: 200 } }, { t: { from: 0 } }, { t: { from: 0.25, to: 1799.5 } },
    { xywh: { x: 0, y: 0, w: 100, h: 100 } }, { xywh: { x: 12.5, y: 0.125, w: 50, h: 33.333 } },
    { page: { from: 4, to: 4 }, xywh: { x: 50, y: 50, w: 50, h: 50 } }, { t: { from: 30, to: 31 }, xywh: { x: 1, y: 2, w: 3, h: 4 } },
  ];
  for (const fragment of cases) {
    assert.deepEqual(parseFragment(formatFragment(fragment)), fragment, formatFragment(fragment));
    assert.deepEqual(parseFragment(`#${formatFragment(fragment)}`), fragment);
    assert.deepEqual(parseCitation(citation("a/b.pdf", fragment)), { path: "a/b.pdf", fragment });
  }
});

test("Media Fragments' temporal spellings read as windows", () => {
  assert.deepEqual(parseFragment("t=npt:10,20"), { t: { from: 10, to: 20 } });
  assert.deepEqual(parseFragment("t=,20"), { t: { from: 0, to: 20 } });
  assert.deepEqual(parseFragment("t=10"), { t: { from: 10 } });
});

test("anything this module would not write reads as nothing", () => {
  for (const text of ["", "#", "page=0", "page=3-2", "page=1.5", "page=a", "page=", "page", "t=", "t=,", "t=10,", "t=20,10", "t=10,10", "t=-1", "t=00:01:00",
    "xywh=10,20,30,40", "xywh=pixel:10,20,30,40", "xywh=percent:10,20,30", "xywh=percent:60,0,50,10", "xywh=percent:0,0,0,10", "xywh=percent:0,0,10,101",
    "page=1&page=2", "zoom=200", "page=1&zoom=200", "page=1&"]) {
    assert.equal(parseFragment(text), null, JSON.stringify(text));
  }
  for (const bad of [{}, { page: { from: 0, to: 1 } }, { page: { from: 2, to: 1 } }, { t: { from: 5, to: 5 } }, { t: { from: Number.NaN } }, { xywh: { x: 90, y: 0, w: 20, h: 10 } }]) {
    assert.throws(() => formatFragment(bad), RangeError, JSON.stringify(bad));
  }
});

test("a citation splits at the last # that starts a fragment, so a # in a file name stays in the path", () => {
  assert.deepEqual(parseCitation("notes#2.pdf#page=4"), { path: "notes#2.pdf", fragment: { page: { from: 4, to: 4 } } });
  assert.deepEqual(parseCitation("a#page=2.pdf"), { path: "a#page=2.pdf", fragment: null });
  assert.deepEqual(parseCitation("input_files/report.pdf"), { path: "input_files/report.pdf", fragment: null });
  assert.deepEqual(parseCitation("#page=2"), { path: "#page=2", fragment: null }, "a fragment with no path is not a citation");
});

test("seconds and percent are written to the thousandth, and what that cannot keep is refused, so a written citation always reads back", () => {
  assert.equal(formatFragment({ t: { from: 1.23456, to: 2 } }), "t=1.235,2");
  assert.deepEqual(parseFragment(formatFragment({ t: { from: 1.23456, to: 2 } })), { t: { from: 1.235, to: 2 } });
  for (const lost of [{ t: { from: 1, to: 1.0001 } }, { xywh: { x: 0, y: 0, w: 0.0004, h: 10 } }, { xywh: { x: 99.9996, y: 0, w: 0.0004, h: 1 } }]) {
    assert.throws(() => formatFragment(lost), RangeError, JSON.stringify(lost));
  }
  // Any fragment that formats reads back as its rounded self.
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const r3 = (v) => Number(v.toFixed(3));
  for (let i = 0; i < 2000; i++) {
    const from = next() * 100, w = next() * 0.01 * (i % 3 ? 1000 : 1), x = next() * 100;
    const fragment = { t: { from, to: from + next() * 0.002 }, xywh: { x, y: next() * 50, w, h: next() * 50 } };
    let text;
    try { text = formatFragment(fragment); } catch (error) { assert.ok(error instanceof RangeError); continue; }
    assert.deepEqual(parseFragment(text), { t: { from: r3(fragment.t.from), to: r3(fragment.t.to) }, xywh: { x: r3(x), y: r3(fragment.xywh.y), w: r3(w), h: r3(fragment.xywh.h) } }, text);
  }
});
