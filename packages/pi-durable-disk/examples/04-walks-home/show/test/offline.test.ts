import assert from "node:assert/strict";
import { test } from "node:test";
import { bannerState, proofLine, walkedOver10, type Attempt } from "../page/offline.ts";

const failed = (ms: number): Attempt => ({ ok: false, ms });
const answered = (ms: number): Attempt => ({ ok: true, ms });

test("the proof says what the page's own attempt to reach the cloud disk really did, and how long it took", () => {
  assert.equal(proofLine([]), "");
  assert.equal(proofLine([failed(41)]), "Cloud disk: no answer (failed in 41 ms)");
  assert.equal(proofLine([failed(41), failed(38), failed(40)]), "Cloud disk: no answer (tried 3 times, last failed in 40 ms)");
  assert.equal(proofLine([failed(41), answered(12)]), "Cloud disk: answered in 12 ms", "a success is shown as one, never as a failure");
});

test("the banner says Wi-Fi is off only when the browser is offline AND the page's own attempt to reach the cloud failed", () => {
  assert.deepEqual(bannerState({ offline: false, clickedAt: null, now: 1000, attempts: [] }), { mode: "on", label: "Wi-Fi: on" });
  assert.deepEqual(bannerState({ offline: false, clickedAt: 900, now: 1000, attempts: [] }), { mode: "clicked", label: "Wi-Fi: off" }, "a click is the user's act, shown small");
  assert.equal(bannerState({ offline: false, clickedAt: 900, now: 1000 + 6000, attempts: [] }).mode, "on", "a click that never became real goes back");
  assert.deepEqual(bannerState({ offline: true, clickedAt: 900, now: 1000, attempts: [] }), { mode: "clicked", label: "Wi-Fi: off" }, "offline but nothing tried yet: no banner");
  assert.deepEqual(bannerState({ offline: true, clickedAt: null, now: 1000, attempts: [failed(41)] }), { mode: "banner", label: "Wi-Fi off - running entirely in your browser" });
  assert.deepEqual(bannerState({ offline: true, clickedAt: null, now: 1000, attempts: [failed(41), answered(9)] }), { mode: "contradiction", label: "Wi-Fi: on" }, "the browser says offline but the cloud answered: no banner");
  assert.equal(bannerState({ offline: false, clickedAt: null, now: 1000, attempts: [failed(41)] }).mode, "on", "back online: the old failures do not keep the banner up");
});

// walk-meter: D3's tab reports, about once per simulated second, the straight-line ground distance from where the current version started.
const meter = (from: number, to: number, version = 3, step = 0.5) => Array.from({ length: to - from + 1 }, (_, i) => ({ t: from + i, metres: (from + i) * step, version }));

test("how far it walked in 10 seconds is the change in its distance over the last 10 simulated seconds of one version", () => {
  assert.equal(walkedOver10(meter(0, 12)), 5);
  assert.equal(walkedOver10(meter(0, 10)), 5, "exactly 10 s");
  assert.equal(walkedOver10(meter(0, 9)), null, "9 s is not 10 s: no claim");
  assert.equal(walkedOver10([]), null);
});

test("a new version starts the distance over, so a window never spans two", () => {
  const mixed = [...meter(0, 6, 3), ...meter(7, 12, 4).map((m) => ({ ...m, metres: m.metres - 3 }))];
  assert.equal(walkedOver10(mixed), null, "only 5 s of version 4");
  assert.equal(walkedOver10([...meter(0, 12, 3), ...meter(13, 25, 4)]), 5, "13..25 is 12 s of version 4: the last 10 s of it, 12.5 - 7.5");
});

test("a creature that went back toward where it started makes no claim, and a result is rounded to a tenth", () => {
  assert.equal(walkedOver10([{ t: 0, metres: 5, version: 1 }, { t: 10, metres: 3, version: 1 }]), null);
  assert.equal(walkedOver10([{ t: 0, metres: 0, version: 1 }, { t: 10, metres: 4.76, version: 1 }]), 4.8);
});
