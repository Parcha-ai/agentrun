// supervision and places: the place seam, the kills a place can and cannot make, the signals, the budget stop and the operator's kill.
// One of the files the reference entry's demo tests are split into (each under about two minutes serial on CI); the shared helpers are in reference-demo-helpers.mjs.
// The reference entry as a demo's platform (item A of the entry brief): the spec's kills list through the supervisor (a named crossing, a storm, a box kind),
// --input, --max-usd, the browser choice, and the box the job's tools run in. The demo here is the reference job itself, started through demo-fixture.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { effectiveBoxes } from '../packages/harness/dist/demo-spec.js';
import { BOX_CROSSINGS, localPlace, capJudge, chooseBrowser, crossings, demo, tapBox, JEV_CAPS, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from '@parcha/agentrun-harness';
import { ORIGINAL, FIXTURE, BASELINE, run, composeHost, destroyBoxes, meterKnown, RUN_LABEL, localBoxes, ctx, finish, lines, planFor, recordingPlace, specWith, reap, SITES, signInHome, filesIn, killSpec, boxed } from './reference-demo-helpers.mjs';

test('the place seam: the supervisor starts, kills and recovers through the place, writes the kill line BEFORE the place kills, and passes the token the place mints for each attempt on stdin', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'process' }, { point: 'judge.asked verdict', why: 'box', kind: 'box' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const calls = [];
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: recordingPlace(calls, recording, { token: true }) });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(calls.map((call) => [call.call, call.kind ?? call.gen]), [['start', 1], ['kill', 'process'], ['recover', 'process'], ['kill', 'box'], ['recover', 'box'], ['release', undefined]].map(([call, x]) => (call === 'start' ? [call, 1] : call === 'recover' ? [call, x === 'process' ? 'process' : 'box'] : [call, x])).map((row) => row), 'start, then kill and recover for each kill, then release');
  const kills = calls.filter((call) => call.call === 'kill');
  assert.ok(kills.every((call) => call.killLines >= 1), 'the kill line was on the recording when the place was asked to kill');
  assert.deepEqual(kills.map((call) => call.killLines), [1, 2], 'one more kill line before each kill');
  const starts = calls.filter((call) => call.call === 'start' || call.call === 'recover');
  assert.deepEqual(starts.map((call) => call.stdin), ['mount-token-1', 'mount-token-2', 'mount-token-3'], 'the place mints each attempt\'s token and the supervisor passes it on stdin as it is');
  assert.ok(!calls.some((call) => call.secretInEnv), 'the token is never in the environment');
  assert.deepEqual(validateRecording(recording), []);
  assert.deepEqual(readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'kill').map((line) => line.data.kind), ['process', 'box']);
  // The supervisor read nothing under the run's directory: the result blob is the record the last runner reported, and the store's hash came from its report too.
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.equal(JSON.parse(readFileSync(join(recording, 'blobs', `${manifest.result.blob}.json`), 'utf8')).record.company, 'Acme Ltd');
  assert.match(manifest.source.store_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(manifest.source.store_sha256, '0'.repeat(64));
  const localOnly = localPlace({ self: FIXTURE, paths: { id: 'r', root: '/x', work: '/x/work', store: '/x/store' } });
  assert.equal(localOnly.token, undefined, 'the local place mints no token');
});
test('a place that cannot lose its machine refuses a box kill, and says which place', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'box', kind: 'box' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const calls = [];
  await assert.rejects(() => demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'recording')], place: recordingPlace(calls, join(tmp, 'recording'), { kills: ['process'] }) }), /the fake place cannot lose its box/);
  assert.deepEqual(calls.map((call) => call.call), ['release'], 'refused before anything started or was killed: the run was not stopped first, and no box loss was recorded');
});
test('a place that can only lose its box is not refused for a run with no kill planned: the refusal is for a kill it cannot make', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference' });
  const calls = [];
  const result = await demo({ ...options, argv: ['--json', '--record', join(tmp, 'recording')], place: recordingPlace(calls, join(tmp, 'recording'), { kills: ['box'] }) });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
});
test('a kill the place cannot make is recorded as a host line with its code and ends the attempt cleanly: no unhandled rejection, no further attempt', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'the place will fail to kill' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const calls = [];
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: recordingPlace(calls, recording, { killThrows: true }) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(unhandled, [], 'nothing was left unhandled');
  assert.deepEqual(result.failedKills, [{ gen: 1, code: 'KILL_FAILED' }]);
  assert.equal(result.processes.length, 1, 'the run did not go on after a kill the place could not make');
  assert.equal(calls.filter((call) => call.call === 'recover').length, 0);
  const lines = readEvents(recording).filter((line) => line.source === 'host');
  const failed = lines.find((line) => line.kind === 'kill.failed');
  assert.deepEqual([failed.data.gen, failed.data.code], [1, 'KILL_FAILED']);
  assert.ok(lines.findIndex((line) => line.kind === 'kill') < lines.findIndex((line) => line.kind === 'kill.failed'), 'the kill line first, then the failure');
});
test('a place that rejects a kill without stopping the process does not hang the supervisor: it records the failure and ends, whether the kill was planned or the budget\'s', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', expectedCost: 0.05, kills: [{ point: 'judge.asked verdict', why: 'the place will fail to kill' }] });
  const pids = [];
  // The kill rejects and the process is left running: its exit never comes (the child parks for a minute at the crossing).
  const place = ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, start: async (order) => { const runner = await inner.start(order); pids.push(runner.pid); return { ...runner, exited: new Promise(() => {}) }; }, kill: async () => { throw Object.assign(new Error('the provider refused'), { code: 'KILL_REFUSED' }); } };
  };
  try {
  const started = Date.now();
  const planned = await demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'planned')], place });
  assert.ok(Date.now() - started < 30_000, 'it did not wait for the exit of a process that was never stopped');
  assert.deepEqual(planned.failedKills, [{ gen: 1, code: 'KILL_REFUSED' }]);
  assert.equal(planned.processes.length, 1);
  // The budget's stop fails the same way.
  process.env.DEMO_JUDGE_COST = '0.3'; process.env.DEMO_LINGER_MS = '20000';
  const budget = await demo({ ...options, argv: ['--json', '--record', join(tmp, 'budget')], place });
  assert.deepEqual(budget.failedKills, [{ gen: 1, code: 'KILL_REFUSED' }]);
  } finally { await reap(pids); }
});
test('the budget\'s stop is awaited: the place has finished killing (its provider cleanup too) before the supervisor finishes the attempt and releases the place', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', expectedCost: 0.05 });
  process.env.DEMO_JUDGE_COST = '0.3'; process.env.DEMO_LINGER_MS = '20000';
  const order = [];
  const place = ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, kill: async (runner, kind) => { await inner.kill(runner, kind); await new Promise((resolve) => setTimeout(resolve, 500)); order.push('kill done'); }, release: async () => { order.push('release'); } };
  };
  const result = await demo({ ...options, argv: ['--json', '--record', join(tmp, 'recording')], place });
  assert.equal(result.overBudget, true);
  assert.deepEqual(order, ['kill done', 'release'], 'the kill, with its slow cleanup, ended before the place was released');
});
test('a place that cannot be made, or released, leaves nothing open: the scratch is removed and the error is the one the place raised', { timeout: 120_000 }, async (t) => {
  const { options } = await specWith(t, { name: 'reference' });
  let scratch;
  await assert.rejects(() => demo({ ...options, argv: ['--json'], place: async ({ paths }) => { scratch = paths.root; throw new Error('the provider is down'); } }), /the provider is down/);
  assert.equal(existsSync(scratch), false, 'a place that failed to be made left no scratch behind');
  let root;
  await assert.rejects(() => demo({ ...options, argv: ['--json'], place: ({ paths, self, destroyBoxes, requestFile }) => { root = paths.root; return { ...localPlace({ self, paths, destroyBoxes, requestFile }), release: async () => { throw new Error('release failed'); } }; } }), /release failed/);
  assert.equal(existsSync(root), false, 'a place that failed to release still had its scratch removed');
});
test('a box kill is carried out once: the recovery that follows does not stop the old runner (nor ask the providers to destroy its boxes) again', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'the machine is lost', kind: 'box' }] });
  let destroyed = 0;
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'recording')], place: ({ paths, self, requestFile }) => localPlace({ self, paths, requestFile, destroyBoxes: () => { destroyed += 1; } }) });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.equal(destroyed, 1, 'the boxes were destroyed once for one box kill');
});
test('the place\'s signals carry the kill request: a place with its own signals() is the one the supervisor reads, not the files', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const asked = [];
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, signals: (attempt) => ({ [Symbol.asyncIterator]() { const it = inner.signals(attempt)[Symbol.asyncIterator](); return { async next() { const next = await it.next(); if (!next.done) asked.push([attempt, next.value.kind, next.value.crossing.point]); return next; }, return: () => it.return() }; } }) };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(asked, [[1, 'kill-request', 'judge.asked verdict']]);
});
// ---- the place answers where the kill request is, and the supervisor honors it only with the attempt's nonce ---------------------------------------

test('askToBeKilled writes the request durably (whole, with the attempt\'s nonce), and the request written at requestFile(gen) is the one signals(gen) yields, for localPlace and a place with its own requestFile and signals', { timeout: 120_000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { localPlace } = await import('@parcha/agentrun-harness');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-request-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const asks = (file, nonce) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', 'import("./packages/harness/dist/crossings.js").then((m) => m.askToBeKilled(process.argv[1], process.argv[2])({ point: "vision.filing", n: 2, pid: process.pid }))', file, nonce], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
    const wait = setInterval(() => { if (existsSync(file)) { clearInterval(wait); resolve(child); } }, 20);
  });
  const first = async (iterable) => { const iterator = iterable[Symbol.asyncIterator](); const next = await iterator.next(); await iterator.return?.(); return next.value; };
  const local = localPlace({ self: FIXTURE, paths: { id: 'r', root: tmp, work: join(tmp, 'work'), store: join(tmp, 'store') }, requestFile: (attempt) => join(tmp, `kill-${attempt}.json`) });
  assert.equal(local.requestFile(3), join(tmp, 'kill-3.json'));
  const a = await asks(local.requestFile(1), 'nonce-for-attempt-1');
  t.after(() => a.kill('SIGKILL'));
  assert.deepEqual(readdirSync(tmp).filter((name) => name.includes('kill-1')), ['kill-1.json'], 'written whole: no temporary file is left beside it');
  assert.deepEqual(await first(local.signals(1)), { kind: 'kill-request', crossing: { point: 'vision.filing', n: 2, pid: a.pid }, nonce: 'nonce-for-attempt-1' });
  // A place of its own: a requestFile outside the run\'s work/ (the disk place\'s <root>/signals/kill-<gen>.json) and a signals that reads that same file.
  mkdirSync(join(tmp, 'signals'));
  const own = (attempt) => join(tmp, 'signals', `kill-${attempt}.json`);
  const other = { ...local, requestFile: own, signals: (attempt) => localPlace({ self: FIXTURE, paths: local.paths, requestFile: own }).signals(attempt) };
  const b = await asks(other.requestFile(2), 'nonce-for-attempt-2');
  t.after(() => b.kill('SIGKILL'));
  assert.deepEqual(await first(other.signals(2)), { kind: 'kill-request', crossing: { point: 'vision.filing', n: 2, pid: b.pid }, nonce: 'nonce-for-attempt-2' });
});
test('every order\'s KILL_REQUEST is the place\'s requestFile(gen); a request with the attempt\'s nonce kills, and a missing or wrong one is ignored with a host line', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await killSpec(t);
  mkdirSync(join(tmp, 'signals'));
  const orders = [];
  const own = (attempt) => join(tmp, 'signals', `kill-${attempt}.json`);
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile: own });
    return {
      ...inner,
      start: (order) => { orders.push(order.env); return inner.start(order); },
      recover: (last, kind, order) => { orders.push(order.env); return inner.recover(last, kind, order); },
      // Before the child\'s own request, forged ones: no nonce, and another nonce. A custom iterator, not a generator: the supervisor\'s return() must end a pending next().
      signals: (attempt) => ({ [Symbol.asyncIterator]() {
        const forged = attempt === 1 ? [{ kind: 'kill-request', crossing: { point: 'forged.no-nonce', n: 1 } }, { kind: 'kill-request', crossing: { point: 'forged.wrong-nonce', n: 1 }, nonce: 'not-this-attempts-nonce' }] : [];
        const real = inner.signals(attempt)[Symbol.asyncIterator]();
        return { next: async () => (forged.length ? { done: false, value: forged.shift() } : real.next()), return: () => real.return() };
      } }),
    };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(orders.map((env) => env.KILL_REQUEST), [own(1), own(2)], 'the order\'s KILL_REQUEST is the place\'s requestFile(gen), on start and recover alike');
  assert.ok(orders.every((env) => /^[0-9a-f]{32}$/.test(env.KILL_NONCE)) && orders[0].KILL_NONCE !== orders[1].KILL_NONCE, 'a fresh 16-byte nonce for each attempt');
  assert.ok(existsSync(own(1)) && JSON.parse(readFileSync(own(1), 'utf8')).nonce === orders[0].KILL_NONCE, 'the child wrote its request there, with its attempt\'s nonce');
  const lines = readEvents(recording).filter((line) => line.source === 'host');
  assert.deepEqual(lines.filter((line) => line.kind === 'kill').map((line) => line.data.crossing?.point), ['judge.asked verdict'], 'one kill line, at the real crossing: a forged request never makes one');
  assert.deepEqual(lines.filter((line) => line.kind === 'kill.request.ignored').map((line) => [line.data.point, line.data.reason]), [['forged.no-nonce', 'no nonce'], ['forged.wrong-nonce', 'wrong nonce']]);
  assert.ok(!JSON.stringify(lines).includes(orders[0].KILL_NONCE), 'the nonce is on no line');
});
test('the child reads KILL_NONCE once and removes it before anything starts: a command the child starts does not see it', { timeout: 300_000 }, async (t) => {
  const { options } = await killSpec(t, { kills: [] });
  process.env.DEMO_LEAK_STEPS = 'envProbe';
  let nonce;
  const { localPlace } = await import('@parcha/agentrun-harness');
  const result = await demo({ ...options, argv: ['--json', '--record', join(await mkdtemp(join(tmpdir(), 'reference-probe-')), 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, start: (order) => { nonce = order.env.KILL_NONCE; return inner.start(order); } };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.match(nonce, /^[0-9a-f]{32}$/, 'the order had one');
  assert.deepEqual(JSON.parse(readFileSync(join(result.dir, 'nonce-seen.json'), 'utf8')), { inProcess: false, inCommand: false });
});
// ---- the operator's kill ------------------------------------------------------------------------------------------------------------------------

test('an operator kill (a control file the supervisor watches, never the child\'s request file) kills through the place, writes a kill line with crossing null and label operator, and the run resumes with repeated 0', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-operator-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  Object.assign(process.env, { DEMO_SPEC: file, DEMO_OPERATOR_HOLD: join(tmp, 'control', 'kill-now') });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const control = join(tmp, 'control', 'kill-now');
  mkdirSync(join(tmp, 'control'));
  const recording = join(tmp, 'recording');
  // The operator\'s page, here a test: once the first process has asked its first model request (where the fixture holds it until the control file is consumed, so the run cannot finish first), it makes the control file.
  const killed = [];
  const placeOn = (trigger) => ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, start: async (order) => {
      const runner = await inner.start(order);
      const waiting = setInterval(() => { try { if (readFileSync(order.env.CROSS_LOG, 'utf8').includes(trigger) && !killed.length) { killed.push(order.gen); writeFileSync(control, ''); clearInterval(waiting); } } catch { /* not yet */ } }, 5);
      runner.exited.then(() => clearInterval(waiting));
      return runner;
    } };
  };
  const place = placeOn('model.request turn 0');
  const result = await demo({ ...options, argv: ['--json', '--record', recording, '--operator-kill', control], place });
  assert.deepEqual(result.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']], JSON.stringify(result.processes));
  assert.equal(result.record.company, 'Acme Ltd');
  assert.ok(!existsSync(control), 'the supervisor consumed the control file');
  const lines = readEvents(recording);
  const kills = lines.filter((line) => line.source === 'host' && line.kind === 'kill');
  assert.deepEqual(kills.map((line) => [line.data.gen, line.data.label, line.data.crossing, line.data.kind]), [[1, 'operator', null, 'process']]);
  assert.deepEqual(result.kills.map((kill) => [kill.gen, kill.point, kill.why]), [[1, null, 'the operator asked']]);
  const counted = fold(lines);
  assert.deepEqual([counted.processes, counted.kills, counted.repeated, counted.unknown], [2, 1, 0, 0]);
  assert.deepEqual(validateRecording(recording), []);
  // The plan\'s own kill is not lost: an operator kill that ends an attempt first leaves its planned kill for the next one.
  killed.length = 0;
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'planned' }] }));
  rmSync(join(tmp, 'control', 'kill-now.held'), { force: true });
  const { options: planned } = await import(`${FIXTURE}?options=${Date.now()}`);
  const both = await demo({ ...planned, argv: ['--kill', '--json', '--operator-kill', control], place: placeOn('model.request turn 0') });
  assert.deepEqual(both.kills.map((kill) => [kill.gen, kill.point ?? 'operator']), [[1, 'operator'], [2, 'judge.asked verdict']]);
  assert.deepEqual(both.unlanded, []);
  assert.equal(both.processes.at(-1).outcome.status, 'complete');
  // A stale control file would kill the first process at once: it is refused.
  writeFileSync(control, '');
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--operator-kill', control] }), /already exists/);
});
test('a kill request written in short pieces is whole when it is renamed into place: the supervisor reads the complete request', { timeout: 60_000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-request-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'kill-1.json');
  const crossings_ = new URL('../packages/harness/dist/crossings.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const writeSync = fs.writeSync;
    fs.writeSync = (fd, data, offset = 0) => writeSync(fd, data, offset, Math.min(5, data.length - offset));
    syncBuiltinESMExports();
    const { askToBeKilled } = await import(${JSON.stringify(crossings_)});
    askToBeKilled(process.argv[1], 'a-nonce')({ point: 'judge.asked verdict', n: 1, pid: process.pid });`;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script, file], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  for (let waited = 0; !existsSync(file) && waited < 20_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { point: 'judge.asked verdict', n: 1, pid: child.pid, nonce: 'a-nonce' }, 'the whole request, though each write took 5 bytes');
});
test('the slow status tick does not queue a read behind one still running: a place whose reads take seconds is read a bounded number of times', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-slow-status-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  Object.assign(process.env, { DEMO_SPEC: file, DEMO_LINGER_MS: '7000' });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  let reads = 0;
  const started = Date.now();
  await demo({ ...options, argv: ['--json', '--record', join(tmp, 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => ({
    ...localPlace({ self, paths, destroyBoxes, requestFile }),
    status: async () => { reads += 1; await new Promise((resolve) => setTimeout(resolve, 2500)); return { record: null }; },
  }) });
  // Boundary reads (start, exit, result) plus the ticks that found no read running; a tick queued behind every slow read would make six or more.
  assert.ok(reads <= 5, `the status was read ${reads} times in ${Date.now() - started} ms`);
});
test('an operator kill carries to the next attempt only the tool kills that did not land, and a control that cannot be removed is a failed kill, not a crash', { timeout: 300_000 }, async (t) => {
  const { notLanded } = await import('../packages/harness/dist/demo.js');
  const dir = await mkdtemp(join(tmpdir(), 'reference-landed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'crossings.jsonl');
  const row = (extra) => `${JSON.stringify({ point: 'transport.box.exec', n: 0, pid: 1, ...extra })}\n`;
  writeFileSync(log, row({}) + row({ landed: true, tool: 0 }) + row({ point: 'transport.tool.started' }));
  const tools = [{ point: 'transport.box.exec', n: 1 }, { point: 'transport.box.exec', n: 2 }, { point: 'transport.tool.started', n: 1 }];
  assert.deepEqual(notLanded(tools, log), [tools[1], tools[2]], 'the entry the log says fired (index 0) is spent; the one at the same point that has not fired, and other points, are carried');
  assert.deepEqual(notLanded(tools, join(dir, 'no-log')), tools, 'nothing landed when the child wrote no log');
  // A control that cannot be removed (a directory made by mistake): a failed kill on the normal path, and the supervisor does not crash.
  const { tmp, options } = await specWith(t, { name: 'reference' });
  const control = join(tmp, 'control');
  let asked = false;
  const place = ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, start: async (order) => { const runner = await inner.start(order); if (!asked) { asked = true; setTimeout(() => mkdirSync(control), 50); } return runner; } };
  };
  const bad = await demo({ ...options, argv: ['--json', '--operator-kill', control], place });
  assert.equal(bad.failedKills.length, 1, 'the control that could not be removed is a failed kill');
  assert.equal(bad.kills.length, 0, 'and no kill happened');

});
test('a slow status read does not hold up supervision: the spend cap stops a running child while the place is still answering the first read', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', expectedCost: 0.05 });
  process.env.DEMO_JUDGE_COST = '0.3'; process.env.DEMO_LINGER_MS = '20000';
  const recording = join(tmp, 'recording');
  await demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => ({
    ...localPlace({ self, paths, destroyBoxes, requestFile }),
    status: async () => { await new Promise((resolve) => setTimeout(resolve, 6000)); return { record: null }; },
  }) });
  const host = readEvents(recording).filter((line) => line.source === 'host');
  const started = host.find((line) => line.kind === 'process.started').t;
  const stopped = host.find((line) => line.kind === 'kill').t;
  assert.ok(stopped - started < 4500, `the cap stopped the child ${stopped - started} ms after it started, not after the 6 s read`);
});
test('--operator-kill is refused by a place that cannot make a process kill, before anything starts', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference' });
  const calls = [];
  await assert.rejects(() => demo({ ...options, argv: ['--json', '--operator-kill', join(tmp, 'control')], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, name: 'box-only', kills: ['box'], start: async (order) => { calls.push('start'); return inner.start(order); }, release: async () => { calls.push('release'); } };
  } }), /box-only place cannot lose its process: --operator-kill/);
  assert.deepEqual(calls, ['release'], 'nothing was started');
});
