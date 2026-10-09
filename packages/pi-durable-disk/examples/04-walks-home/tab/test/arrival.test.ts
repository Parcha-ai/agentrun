import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArrivalTracker, arrivalMeta, describeArrival, PolicyWatcher, planArrival, type PolicySource } from '../src/arrival.ts';
import { presetForSha } from '../src/bodies.ts';
import { sha256Hex } from '../src/policy.ts';
import { defaultDesign } from '../src/design.ts';
import { buildMjcf } from '../src/mjcf.ts';

const SHA_3DOF = await sha256Hex(buildMjcf(defaultDesign(3)).xml);
const SHA_2DOF = await sha256Hex(buildMjcf(defaultDesign(2)).xml);
const policyText = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'mlp-v1', spec_version: 1, mjcf_sha256: SHA_3DOF, provenance: { host: 'modal', wall_s: 229.2 }, ...over });

// ---- planArrival: one test per branch ----------------------------------------------------------------------

test('a policy for the body on screen is loaded, with its metadata', async () => {
  const p = await planArrival(policyText(), SHA_3DOF, presetForSha);
  assert.equal(p.action, 'load');
  if (p.action === 'load') assert.deepEqual(p.meta, { host: 'modal', trainingSeconds: 229.2 });
});

test('a policy for another preset body switches to that preset', async () => {
  const p = await planArrival(policyText({ mjcf_sha256: SHA_2DOF }), SHA_3DOF, presetForSha);
  assert.equal(p.action, 'switch-body');
  if (p.action === 'switch-body') assert.equal(p.preset.name, 'quadruped 2-DOF');
});

test('a policy for a body that is no preset is refused, and says why', async () => {
  const p = await planArrival(policyText({ mjcf_sha256: 'a'.repeat(64) }), SHA_3DOF, presetForSha);
  assert.equal(p.action, 'refuse');
  if (p.action === 'refuse') assert.match(p.reason, /neither the one on screen nor a preset/);
});

test('refusals: not JSON, not an object, wrong format, unknown or missing spec_version, malformed sha', async () => {
  const cases: [string, RegExp][] = [
    ['{"format": "mlp-v1", "spec', /not valid JSON/],
    ['', /not valid JSON/],
    ['[]', /not a policy object/],
    ['null', /not a policy object/],
    [policyText({ format: 'onnx' }), /unknown format "onnx"/],
    [policyText({ format: undefined }), /unknown format undefined/],
    [policyText({ spec_version: 2 }), /unknown spec_version 2/],
    [policyText({ spec_version: undefined }), /unknown spec_version undefined/],
    [policyText({ spec_version: '1' }), /unknown spec_version "1"/],
    [policyText({ mjcf_sha256: 'abc' }), /missing or malformed/],
    [policyText({ mjcf_sha256: undefined }), /missing or malformed/],
    [policyText({ mjcf_sha256: SHA_3DOF.toUpperCase() }), /missing or malformed/],
  ];
  for (const [text, why] of cases) {
    const p = await planArrival(text, SHA_3DOF, presetForSha);
    assert.equal(p.action, 'refuse', text.slice(0, 40));
    if (p.action === 'refuse') assert.match(p.reason, why, text.slice(0, 40));
  }
});

// ---- the metadata is never invented -------------------------------------------------------------------------

test('arrivalMeta reads host and wall_s from provenance and nothing else', () => {
  assert.deepEqual(arrivalMeta({ provenance: { host: 'modal', wall_s: 229.2, universe: 'u0' } }), { host: 'modal', trainingSeconds: 229.2 });
  assert.deepEqual(arrivalMeta({ provenance: { host: '  daytona-gpu  ', wall_s: 0 } }), { host: 'daytona-gpu', trainingSeconds: 0 });
  for (const bad of [{}, { provenance: null }, { provenance: [] }, null, undefined, 'x']) {
    assert.deepEqual(arrivalMeta(bad), { host: null, trainingSeconds: null }, JSON.stringify(bad));
  }
  assert.deepEqual(arrivalMeta({ provenance: { host: '', wall_s: -3 } }), { host: null, trainingSeconds: null });
  assert.deepEqual(arrivalMeta({ provenance: { host: 7, wall_s: '229' } }), { host: null, trainingSeconds: null });
  assert.deepEqual(arrivalMeta({ provenance: { wall_s: NaN } }), { host: null, trainingSeconds: null });
  assert.deepEqual(arrivalMeta({ provenance: { universe: 'u0', device: 'cuda:0' } }), { host: null, trainingSeconds: null }, 'device is not a host');
});

test('the toast names the machine and the time when the file has both, and says what is missing otherwise', () => {
  assert.equal(describeArrival({ host: 'modal', trainingSeconds: 229.2 }), 'policy arrived from modal after 229 s of training');
  assert.equal(describeArrival({ host: 'modal', trainingSeconds: 8.46 }), 'policy arrived from modal after 8.5 s of training');
  const hostOnly = describeArrival({ host: 'modal', trainingSeconds: null });
  assert.match(hostOnly, /from modal/);
  assert.match(hostOnly, /does not say how long/);
  assert.doesNotMatch(hostOnly, /\d+ s of training/);
  const secsOnly = describeArrival({ host: null, trainingSeconds: 120 });
  assert.match(secsOnly, /after 120 s of training/);
  assert.match(secsOnly, /does not say which machine/);
  assert.doesNotMatch(secsOnly, /from /);
  const neither = describeArrival({ host: null, trainingSeconds: null });
  assert.match(neither, /neither the machine nor the training time/);
  assert.doesNotMatch(neither, /\d/);
});

// ---- the watcher ----------------------------------------------------------------------------------------------

function fakeSource(script: (Parameters<PolicySource['read']>[0] extends infer E ? () => { text: string; etag?: string } | 'unchanged' | null | Error : never)[]) {
  const calls: (string | undefined)[] = [];
  let i = 0;
  const source: PolicySource = {
    async read(etag) {
      calls.push(etag);
      const r = script[Math.min(i++, script.length - 1)]();
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { source, calls };
}

test('the watcher hands over each distinct content once, however many polls see it', async () => {
  const seen: string[] = [];
  const { source } = fakeSource([() => null, () => ({ text: 'A' }), () => ({ text: 'A' }), () => ({ text: 'B' }), () => ({ text: 'B' }), () => ({ text: 'A' })]);
  const w = new PolicyWatcher(source, { sha256: sha256Hex, onFile: (t) => { seen.push(t); } });
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await w.tick());
  assert.deepEqual(seen, ['A', 'B', 'A'], 'A, then B, then A again is a new arrival: the file changed back');
  assert.deepEqual(results, [false, true, false, true, false, true]);
});

test('"unchanged" and a missing file are not arrivals, and the last etag is sent back to the source', async () => {
  const seen: string[] = [];
  const { source, calls } = fakeSource([() => ({ text: 'A', etag: 'e1' }), () => 'unchanged', () => null, () => ({ text: 'B', etag: 'e2' })]);
  const w = new PolicyWatcher(source, { sha256: sha256Hex, onFile: (t) => { seen.push(t); } });
  for (let i = 0; i < 4; i++) await w.tick();
  assert.deepEqual(seen, ['A', 'B']);
  assert.deepEqual(calls, [undefined, 'e1', 'e1', 'e1']);
});

test('content already present when the watcher is primed is not an arrival; a change after it is', async () => {
  const seen: string[] = [];
  const { source } = fakeSource([() => ({ text: 'OLD' }), () => ({ text: 'OLD' }), () => ({ text: 'NEW' })]);
  const w = new PolicyWatcher(source, { sha256: sha256Hex, onFile: (t) => { seen.push(t); } });
  await w.prime();
  assert.equal(await w.tick(), false);
  assert.equal(await w.tick(), true);
  assert.deepEqual(seen, ['NEW']);
});

test('a failing source or handler is reported and does not stop later arrivals', async () => {
  const errors: string[] = [];
  const seen: string[] = [];
  const { source } = fakeSource([() => new Error('network down'), () => ({ text: 'BAD' }), () => ({ text: 'GOOD' })]);
  const w = new PolicyWatcher(source, {
    sha256: sha256Hex,
    onFile: (t) => { seen.push(t); if (t === 'BAD') throw new Error('handler refused'); },
    onError: (e) => errors.push((e as Error).message),
  });
  assert.equal(await w.tick(), false);
  assert.equal(await w.tick(), false, 'a handler that throws is not a delivered arrival');
  assert.equal(await w.tick(), true);
  assert.deepEqual(errors, ['network down', 'handler refused']);
  assert.deepEqual(seen, ['BAD', 'GOOD']);
});

test('an invalid file is reported once, not on every poll', async () => {
  const seen: string[] = [];
  const { source } = fakeSource([() => ({ text: '{not json' })]);
  const w = new PolicyWatcher(source, { sha256: sha256Hex, onFile: (t) => { seen.push(t); } });
  for (let i = 0; i < 5; i++) await w.tick();
  assert.equal(seen.length, 1);
});

test('start polls on the timer and stop ends it', async () => {
  const timers: (() => void)[] = [];
  let reads = 0;
  const source: PolicySource = { async read() { reads++; return null; } };
  const w = new PolicyWatcher(source, { sha256: sha256Hex, onFile: () => {}, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  w.start();
  w.start(); // idempotent
  assert.equal(timers.length, 1);
  timers.shift()!();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1);
  assert.equal(timers.length, 1, 'the next poll is scheduled after the first finished');
  w.stop();
  timers.shift()!();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1, 'stopped: no more reads');
});

// ---- the timing ---------------------------------------------------------------------------------------------------

test('arrival to walking and the 10 s mean speed, on the page clock', () => {
  // arrived at page ms 1000, installed at 1400; the creature walks at 0.5 m/s from the first step; 50 Hz control steps; one sim second = 700 page ms
  const tr = new ArrivalTracker({ arrivedAtMs: 1000, installedAtMs: 1400, command: 0.5 });
  for (let i = 0; i <= 500; i++) {
    const t = i * 0.02;
    tr.sample(t, 0.5 * t, 0, 1, 1400 + t * 700);
  }
  const r = tr.result();
  assert.equal(r.done, true);
  assert.equal(r.arrivalToInstalledMs, 400);
  assert.equal(r.simSecondsToWalking, 1, 'the first moment a full second has been walked');
  assert.equal(r.arrivalToWalkingMs, 1400 + 1 * 700 - 1000);
  assert.ok(Math.abs(r.meanSpeed! - 0.5) < 1e-9);
  assert.equal(r.fell, false);
});

test('it never walks: no walking time, a near-zero mean speed, and not a fall', () => {
  const tr = new ArrivalTracker({ arrivedAtMs: 0, installedAtMs: 10, command: 0.5 });
  for (let i = 0; i <= 500; i++) tr.sample(i * 0.02, 0.001, 0, 1, 10 + i * 20);
  const r = tr.result();
  assert.equal(r.arrivalToWalkingMs, null);
  assert.equal(r.simSecondsToWalking, null);
  assert.ok(r.meanSpeed! < 0.01);
  assert.equal(r.fell, false);
});

test('a creature that falls is never counted as walking, even if it moved', () => {
  const tr = new ArrivalTracker({ arrivedAtMs: 0, installedAtMs: 0, command: 0.5 });
  tr.sample(0, 0, 0, 1, 0);
  tr.sample(0.5, 0.5, 0, 0.1, 500); // knocked over while moving fast
  for (let i = 51; i <= 500; i++) tr.sample(i * 0.02, 0.5 + 0.5 * (i * 0.02 - 0.5), 0, 0.1, i * 20);
  const r = tr.result();
  assert.equal(r.fell, true);
  assert.equal(r.arrivalToWalkingMs, null);
});

test('a command of 0 has no walking moment, and samples after the window are ignored', () => {
  const tr = new ArrivalTracker({ arrivedAtMs: 0, installedAtMs: 0, command: 0 });
  for (let i = 0; i <= 500; i++) tr.sample(i * 0.02, i * 0.02 * 0.4, 0, 1, i * 20);
  const done = tr.result();
  assert.equal(done.arrivalToWalkingMs, null);
  assert.ok(Math.abs(done.meanSpeed! - 0.4) < 1e-9);
  tr.sample(20, 1000, 0, 1, 99999); // after done: ignored
  assert.deepEqual(tr.result(), done);
});

test('the mean speed is not reported before the window has run', () => {
  const tr = new ArrivalTracker({ arrivedAtMs: 0, installedAtMs: 0, command: 0.5 });
  for (let i = 0; i <= 200; i++) tr.sample(i * 0.02, i * 0.01, 0, 1, i * 20);
  const r = tr.result();
  assert.equal(r.done, false);
  assert.equal(r.meanSpeed, null);
});
