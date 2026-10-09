import assert from "node:assert/strict";
import { test } from "node:test";
import { bannerState, diskAnswered, DiskProbe, proofLine, trimMeter, walkedOver10, type Attempt } from "../page/offline.ts";

const failed = (ms: number): Attempt => ({ ok: false, ms });
const answered = (ms: number): Attempt => ({ ok: true, ms });

test("the proof says what the page's own attempt to reach the cloud disk really did, and how long it took", () => {
  assert.equal(proofLine([]), "");
  assert.equal(proofLine([failed(41)]), "Cloud: unreachable (tried once)");
  assert.equal(proofLine([failed(41), failed(38), failed(40)]), "Cloud: unreachable (tried 3 times)");
  assert.equal(proofLine([failed(41), answered(12)]), "Cloud: answered in 12 ms", "a success is shown as one, never as a failure");
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

// Greptile on #116, round two: the screen must never overstate.
test("a reading gap never stretches the window: 12 s of movement is not reported as 10 s", () => {
  assert.equal(walkedOver10([{ t: 0, metres: 0, version: 1 }, { t: 12, metres: 6, version: 1 }]), null, "nothing was measured at the 10 s boundary, and 12 s apart is too far to interpolate");
  assert.equal(walkedOver10([{ t: 0, metres: 0, version: 1 }, { t: 3, metres: 1.5, version: 1 }, { t: 6, metres: 3, version: 1 }, { t: 9, metres: 4.5, version: 1 }, { t: 12, metres: 6, version: 1 }]), null, "3 s apart: too far to interpolate");
});

test("a boundary that falls between two close readings is interpolated, so the number is for exactly 10 s", () => {
  const every2 = [0, 2, 4, 6, 8, 10, 12, 14].map((t) => ({ t, metres: t * 0.5, version: 1 }));
  assert.equal(walkedOver10(every2), 5, "readings 2 s apart still bracket the boundary at t=4 (exactly)");
  const odd = [0.5, 2.5, 4.5, 6.5, 8.5, 10.5, 12.5].map((t) => ({ t, metres: t * 0.5, version: 1 }));
  assert.equal(walkedOver10(odd), 5, "boundary at 2.5 is a reading; 1 Hz-ish readings give exactly 10 s of movement");
  const between = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11.5].map((t) => ({ t, metres: t * 2, version: 1 }));
  assert.equal(walkedOver10(between), 20, "end 11.5, boundary 1.5 lies between readings at 1 and 2: 23 - 3 = 20 over exactly 10 s");
});

test("only a real disk reply counts as the cloud answering: an error from the stage or from the network is a failed attempt", () => {
  for (const status of [200, 204, 304, 404]) assert.equal(diskAnswered(status), true, String(status));
  for (const status of [500, 502, 503, 504]) assert.equal(diskAnswered(status), false, `${status}: the stage could not reach the run's server`);
});

const deferred = () => {
  let resolve!: (v: { status: number }) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<{ status: number }>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

test("the probe records what each attempt really did: an answer, a 502, a network error", async () => {
  let n = 0;
  const probe = new DiskProbe(async () => {
    n++;
    if (n === 1) return { status: 204 };
    if (n === 2) return { status: 502 };
    throw new TypeError("Failed to fetch");
  });
  await probe.probe();
  await probe.probe();
  await probe.probe();
  assert.deepEqual(probe.attempts.map((a) => a.ok), [true, false, false]);
  assert.equal(proofLine(probe.attempts.slice(1)), "Cloud: unreachable (tried 2 times)");
});

test("an attempt still in flight when probing stops is cancelled, and its late result never fills the next period's proof", async () => {
  const late = deferred();
  const signals: AbortSignal[] = [];
  const probe = new DiskProbe((signal) => (signals.push(signal), late.promise));
  const inFlight = probe.probe();
  probe.stop();
  assert.equal(signals[0]!.aborted, true, "the pending request is aborted");
  late.resolve({ status: 200 });
  await inFlight;
  assert.deepEqual(probe.attempts, [], "a result from the earlier period is dropped");
  const next = new DiskProbe(async () => ({ status: 200 }));
  await next.probe();
  assert.equal(next.attempts.length, 1);
});

test("at most five attempts are kept", async () => {
  const probe = new DiskProbe(async () => ({ status: 204 }));
  for (let i = 0; i < 9; i++) await probe.probe();
  assert.equal(probe.attempts.length, 5);
});

test("the offline history is bounded to what the 10 s window needs, and it gives the same answer", () => {
  const long = Array.from({ length: 2000 }, (_, i) => ({ t: i, metres: i * 0.5, version: 3 }));
  const kept = trimMeter(long);
  assert.ok(kept.length <= 16, `kept ${kept.length}`);
  assert.equal(walkedOver10(kept), walkedOver10(long));
  const twoVersions = [...Array.from({ length: 50 }, (_, i) => ({ t: i, metres: i, version: 3 })), ...Array.from({ length: 5 }, (_, i) => ({ t: 50 + i, metres: i, version: 4 }))];
  assert.ok(trimMeter(twoVersions).every((m) => m.version === 4), "earlier versions are discarded");
  assert.deepEqual(trimMeter([]), []);
});

// Cold view 6: "last failed in 1 ms" read like a blocked call, i.e. debug output. The unreachable line carries a count, never a time.
test("the unreachable line is plain: a count of tries, no milliseconds", () => {
  for (const ms of [0, 1, 41, 3000]) assert.doesNotMatch(proofLine([failed(ms), failed(ms)]), /\d+ ms/);
});
