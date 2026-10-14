// The install call's door: the box's id is kept before the door waits, a process that resumes reattaches to the box a killed one left
// (never starting a second while the first is alive), a lost box is started again in a fresh one, and with no Docker the step is skipped
// and says so. The boxes here are scripted; pt-daytona's Docker ones answer the same two calls.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installThroughBox } from './dependency-audit/install-door.ts';
import { makeTools } from './dependency-audit/tools.ts';

const RESULT = { exitCode: 0, scriptLog: 'postinstall: downloading chromium', outbound: [{ host: 'registry.npmjs.org', ip: '104.16.0.1', port: 443, at: 1 }, { host: 'storage.googleapis.com', ip: '142.250.0.1', port: 443, at: 2 }], durationMs: 5000, seen: 'connections seen by strace' };

/** Boxes that answer from a script, with every call they were given. */
function boxes(answers) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async startInstall(name, version) { calls.push(['start', name, version]); n += 1; return { boxId: `box-${n}` }; },
    async attachInstall(boxId) { calls.push(['attach', boxId]); const next = answers.shift(); return typeof next === 'function' ? next(boxId) : next; },
  };
}

async function root(t) {
  const dir = await mkdtemp(join(tmpdir(), 'audit-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the box id is kept before the door waits, and a result completes the call', async (t) => {
  const dir = await root(t);
  const fake = boxes([{ running: true }, RESULT]);
  const out = await installThroughBox(dir, fake, 'puppeteer', '18.2.1');
  assert.equal(out.how, 'started');
  assert.deepEqual(out.result, RESULT);
  assert.deepEqual(fake.calls.map((call) => call[0]), ['start', 'attach', 'attach']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'boxes', 'puppeteer@18.2.1', 'box.json'), 'utf8')).boxId, 'box-1');
});

test('a process that resumes reattaches to the box a killed one left, and starts no second box', async (t) => {
  const dir = await root(t);
  const killed = boxes([() => { throw new Error('the process died while it waited'); }]);
  await assert.rejects(installThroughBox(dir, killed, 'puppeteer', '18.2.1'), /died while it waited/);
  assert.deepEqual(killed.calls.map((call) => call[0]), ['start', 'attach']);
  const resumed = boxes([RESULT]);
  const out = await installThroughBox(dir, resumed, 'puppeteer', '18.2.1');
  assert.equal(out.how, 'reattached');
  assert.deepEqual(resumed.calls, [['attach', 'box-1']], 'the resumed process asked the same box and started none');
});

test('a box that is gone is started again in a fresh one, and the new id is the one kept', async (t) => {
  const dir = await root(t);
  const fake = boxes([{ gone: true }, RESULT]);
  const out = await installThroughBox(dir, fake, 'puppeteer', '18.2.1');
  assert.equal(out.how, 'restarted');
  assert.deepEqual(fake.calls.map((call) => call[0]), ['start', 'attach', 'start', 'attach']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'boxes', 'puppeteer@18.2.1', 'box.json'), 'utf8')).boxId, 'box-2');
  assert.deepEqual(out.lost, ['box-1']);
  // The process that waits on the fresh box dies; the next one reattaches, and the lost box is still on the call's record.
  const dir2 = await root(t);
  await assert.rejects(installThroughBox(dir2, boxes([{ gone: true }, () => { throw new Error('died'); }]), 'x', '1.0.0'), /died/);
  const resumed = boxes([RESULT]);
  const again = await installThroughBox(dir2, resumed, 'x', '1.0.0');
  assert.equal(again.how, 'restarted');
  assert.deepEqual(again.lost, ['box-1']);
});

test('a box that never ends fails the call at its deadline instead of waiting for ever', async (t) => {
  const dir = await root(t);
  const fake = { async startInstall() { return { boxId: 'box-1' }; }, async attachInstall() { await new Promise((resolve) => setTimeout(resolve, 5)); return { running: true }; } };
  await assert.rejects(installThroughBox(dir, fake, 'slow', '1.0.0', { deadlineMs: 20, waitMs: 1 }), /did not end in time/);
});

test('the install tool names the hosts outside the registry from the box, and says where they were seen', async (t) => {
  const dir = await root(t);
  const tools = makeTools({ root: dir, source: { live: true }, boxes: boxes([RESULT]) });
  const out = await tools.install({ name: 'puppeteer', version: '18.2.1', scripts: { postinstall: 'node install.js' } });
  assert.equal(out.ran, true);
  assert.deepEqual(out.hosts, ['registry.npmjs.org', 'storage.googleapis.com']);
  assert.deepEqual(out.outside, ['storage.googleapis.com']);
  const receipt = JSON.parse(readFileSync(join(dir, out.receipt), 'utf8'));
  assert.equal(receipt.label, 'connections seen by strace');
  assert.deepEqual(receipt.box, { id: 'box-1', how: 'started' });
});

test('with no Docker the install is skipped and the receipt says so; a replay\'s box is not a fact about the package', async (t) => {
  const dir = await root(t);
  const noDocker = { async startInstall() { throw Object.assign(new Error('no docker'), { code: 'DOCKER_UNAVAILABLE' }); }, async attachInstall() { throw new Error('unreachable'); } };
  const skipped = await makeTools({ root: dir, source: { live: true }, boxes: noDocker }).install({ name: 'x', version: '1.0.0', scripts: {} });
  assert.equal(skipped.ran, false);
  assert.match(JSON.parse(readFileSync(join(dir, skipped.receipt), 'utf8')).note, /Docker is not available/);
  const replay = await makeTools({ root: dir, source: { live: true }, boxes: boxes([{ ...RESULT, outbound: [], standIn: true }]) }).install({ name: 'y', version: '1.0.0', scripts: {} });
  assert.equal(replay.ran, false);
  assert.deepEqual(replay.outside, []);
  assert.ok(existsSync(join(dir, replay.receipt)));
});

test('a package the box cannot install does not stop the audit: the receipt says why it was not installed', async (t) => {
  const dir = await root(t);
  const refusing = { async startInstall(name) { throw new Error(`"${name}" is not an npm package name`); }, async attachInstall() { throw new Error('unreachable'); } };
  const out = await makeTools({ root: dir, source: { live: true }, boxes: refusing }).install({ name: 'execSync', version: '1.0.2', scripts: {} });
  assert.equal(out.ran, false);
  assert.match(JSON.parse(readFileSync(join(dir, out.receipt), 'utf8')).note, /could not be run: "execSync" is not an npm package name/);
  const slow = { async startInstall() { return { boxId: 'b' }; }, async attachInstall() { await new Promise((resolve) => setTimeout(resolve, 5)); return { running: true }; } };
  // A deadline is still the call's failure, not a skip.
  await assert.rejects(installThroughBox(dir, slow, 'slow', '1.0.0', { deadlineMs: 20, waitMs: 1 }), /did not end in time/);
});

test('a result read from the box is kept before it is returned: a process that dies after reading it starts no second install', async (t) => {
  const dir = await root(t);
  const first = boxes([RESULT]);
  assert.equal((await installThroughBox(dir, first, 'puppeteer', '18.2.1')).how, 'started');
  // The box is gone now (it is removed when its result is read). A resumed process takes the kept result and asks no box.
  const resumed = boxes([{ gone: true }]);
  const again = await installThroughBox(dir, resumed, 'puppeteer', '18.2.1');
  assert.deepEqual(again.result, RESULT);
  assert.deepEqual(resumed.calls, [], 'no box was asked and none was started');
});
