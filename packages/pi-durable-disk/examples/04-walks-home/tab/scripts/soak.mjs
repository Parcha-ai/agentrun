// A soak of the page for the live-demo shoot: the creature walks for SOAK_MIN minutes (30) while a random kick (60 to 400 N, random
// direction) lands every 20 to 40 s. Records falls, getups, recoveries, NaN, unexpected clock resets and the JS heap (after a forced
// GC) every minute; prints a summary and exits 1 on a NaN, an unexpected reset, or heap growth beyond the stated noise.
//   CDP_PORT=9333 THROTTLE=4 SOAK_MIN=30 POLICY=<policy.json> OUT=<dir> [LITE=1] node scripts/soak.mjs
// With no POLICY it runs the dummy trot (which cannot get up: the script resets it when it is down for 15 simulated seconds).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openApp, sleep } from './_cdp.mjs';

const minutes = Number(process.env.SOAK_MIN ?? 30);
const throttle = Number(process.env.THROTTLE ?? 4);
const out = process.env.OUT ?? '.';
mkdirSync(out, { recursive: true });
const log = `${out}/soak-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const seed = Number(process.env.SEED ?? Date.now() % 100000);
let rng = seed; const rand = () => { rng = (rng * 1664525 + 1013904223) % 4294967296; return rng / 4294967296; };

const app = await openApp({ throttle, width: Number(process.env.W ?? 700), height: Number(process.env.H ?? 500), query: process.env.LITE ? '?lite=1' : '' });
const { ev } = app;
if (process.env.POLICY) {
  const r = await ev(`__walks.loadPolicyText(${JSON.stringify(readFileSync(process.env.POLICY, 'utf8'))}, 'policy.json').then(() => 'loaded', (e) => 'refused: ' + e.message)`);
  if (r !== 'loaded') throw new Error(`policy ${r}`);
  await ev('__walks.resetSim()');
}
const snap = async () => JSON.parse(await ev('JSON.stringify({ ...__walks.stats(), simTime: __walks.app.sim.time, mode: __walks.app.sim.mode, up: __walks.app.sim.uprightness() })'));
const note = (o) => appendFileSync(log, JSON.stringify(o) + '\n');

const start = Date.now(), end = start + minutes * 60000;
const first = await snap();
const heap0 = await app.heapMB();
note({ event: 'start', seed, throttle, minutes, policy: process.env.POLICY ? 'file' : 'dummy trot', heap_mb: heap0 });

const samples = []; // per-minute: { min, heap_mb, fps, steps_per_s, rtf }
const kicks = [];
let last = first, lastT = Date.now(), nextKick = start + 20000 + rand() * 20000, nextSample = start + 60000, scriptResets = 0, downSince = null;

while (Date.now() < end) {
  await sleep(500);
  const now = Date.now();
  const s = await snap();
  // a creature that stays down without a getup network (or one that never rose) is reset, as an operator would
  if (s.up < 0.3) { downSince ??= s.simTime; if (s.simTime - downSince > 15) { await ev('__walks.resetSim()'); scriptResets++; downSince = null; note({ event: 'script-reset', at_s: (now - start) / 1000 }); } } else downSince = null;
  if (now >= nextKick) {
    const force = 60 + rand() * 340, angle = rand() * 2 * Math.PI;
    const before = await snap();
    await ev(`__walks.kickWorld(${Math.cos(angle)}, ${Math.sin(angle)}, ${force})`);
    kicks.push({ at_s: +((now - start) / 1000).toFixed(1), force_n: Math.round(force), angle_deg: Math.round((angle * 180) / Math.PI), up_before: +before.up.toFixed(2), falls_before: before.falls, getups_before: before.getups });
    note({ event: 'kick', ...kicks.at(-1) });
    nextKick = now + 20000 + rand() * 20000;
  }
  if (now >= nextSample) {
    const dt = (now - lastT) / 1000;
    const row = { min: Math.round((now - start) / 60000), heap_mb: await app.heapMB(), fps: +((s.frames - last.frames) / dt).toFixed(1), steps_per_s: +((s.steps - last.steps) / dt).toFixed(1), rtf: +((s.simTime - last.simTime) / dt).toFixed(3), falls: s.falls, getups: s.getups, recoveries: s.recoveries, nan: s.nan, unexpected_resets: s.resetsSeen };
    samples.push(row); note({ event: 'sample', ...row });
    last = s; lastT = now; nextSample += 60000;
  }
}
const final = await snap();
const heap1 = await app.heapMB();
await app.close();

// heap trend: least-squares slope over the per-minute samples
const xs = samples.map((r) => r.min), ys = samples.map((r) => r.heap_mb);
const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
const slope = n > 1 ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0) : 0; // MB per minute
const noiseMB = Math.max(2, 0.1 * heap0); // "noise": the larger of 2 MB and 10% of the starting heap
const summary = {
  minutes, throttle, seed, policy: process.env.POLICY ? 'file' : 'dummy trot',
  kicks: kicks.length, kick_force_n: kicks.length ? [Math.min(...kicks.map((k) => k.force_n)), Math.max(...kicks.map((k) => k.force_n))] : null,
  falls: final.falls - first.falls, getups: final.getups - first.getups, recoveries: final.recoveries - first.recoveries, script_resets: scriptResets,
  nan: final.nan - first.nan, unexpected_clock_resets: final.resetsSeen - first.resetsSeen,
  heap_mb: { start: heap0, end: heap1, min: Math.min(...ys, heap0), max: Math.max(...ys, heap1), slope_mb_per_min: +slope.toFixed(4), growth_over_run_mb: +(heap1 - heap0).toFixed(2), noise_allowance_mb: noiseMB },
  fps: { min: Math.min(...samples.map((r) => r.fps)), median: [...samples.map((r) => r.fps)].sort((a, b) => a - b)[Math.floor(n / 2)] },
  realtime_factor_min: Math.min(...samples.map((r) => r.rtf)),
};
summary.verdict = { nan: summary.nan === 0, no_unexpected_resets: summary.unexpected_clock_resets === 0, heap_within_noise: heap1 - heap0 <= noiseMB && slope * minutes <= noiseMB };
note({ event: 'summary', ...summary });
writeFileSync(`${out}/soak-summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(Object.values(summary.verdict).every(Boolean) ? 0 : 1);
