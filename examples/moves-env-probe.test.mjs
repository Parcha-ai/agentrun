// The environment probe (moves/env-probe.ts), offline: a scanner that finds a secret's value in any environment or command line its own user can read, by hash, without holding the value.
// The cases that matter: a process that started with a key and only deleted it from process.env is FOUND (red), and one handed the key on a file descriptor is NOT (green).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { judge, parseReport, scannerArgv, scannerCommand, specOf } from './moves/env-probe.ts';

const made = () => `sk-test-${randomBytes(24).toString('hex')}`;
const children = new Set();
after(() => { for (const child of children) child.kill('SIGKILL'); });

/** A fake instance: a Node process that is ready when it has printed `ready`, and stays until its stdin closes. */
function instance({ env = {}, argv = [], code, fd3 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, '--', ...argv], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'inherit', ...(fd3 === undefined ? [] : ['pipe'])] });
    children.add(child);
    child.on('error', reject);
    child.stdout.once('data', () => resolve(child));
    if (fd3 !== undefined) child.stdio[3].end(fd3);
  });
}
const stop = (child) => { child.stdin.end(); children.delete(child); };

/** The scanner, run as this test's own user; `only` narrows it to some processes, because this machine holds other people's environments (that is a finding, on a real box, and noise here). */
function scan(secrets, options = {}) {
  const argv = scannerArgv(specOf(secrets, options.only));
  const run = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH, ...(options.env ?? {}) }, maxBuffer: 16 << 20 });
  assert.equal(run.status, 0, run.stderr);
  return parseReport(run.stdout);
}

const KEEPS_AND_DELETES = `const v = process.env.HELD; delete process.env.HELD; globalThis.keep = v; console.log('ready'); process.stdin.resume();`;
const READS_FD = `const fs = require('node:fs'); globalThis.keep = fs.readFileSync(3, 'utf8'); console.log('ready'); process.stdin.resume();`;
const IDLE = `console.log('ready'); process.stdin.resume();`;

test('the spec carries a hash and a length for each value and never the value, and neither does the scanner\'s command', () => {
  const secret = { name: 'ANTHROPIC_API_KEY', value: made() };
  const spec = specOf([secret]);
  assert.equal(spec.values[0].length, secret.value.length);
  assert.ok(!JSON.stringify(spec).includes(secret.value));
  assert.ok(!scannerArgv(spec).join('\n').includes(secret.value));
  assert.ok(!scannerCommand(spec).includes(secret.value));
  assert.throws(() => specOf([{ name: 'X', value: 'short' }]), /too short/);
});

test('RED: a process that started with the key in its environment and only deleted it from process.env is found', async () => {
  const secret = { name: 'ANTHROPIC_API_KEY', value: made() };
  const child = await instance({ env: { HELD: secret.value }, code: KEEPS_AND_DELETES });
  try {
    const report = scan([secret]);
    assert.ok(report.counts.ANTHROPIC_API_KEY.procEnviron >= 1, JSON.stringify(report.counts));
    const verdict = judge(report);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => /ANTHROPIC_API_KEY is in procEnviron/.test(p)), verdict.problems.join(' | '));
    assert.ok(verdict.problems.every((p) => !p.includes(secret.value)), 'the verdict never prints the value');
  } finally { stop(child); }
});

test('GREEN: a process handed the key on a file descriptor, with a clean environment, is not found', async () => {
  const secret = { name: 'ANTHROPIC_API_KEY', value: made() };
  const child = await instance({ code: READS_FD, fd3: secret.value });
  try {
    const report = scan([secret], { only: [child.pid] });
    assert.deepEqual(report.counts.ANTHROPIC_API_KEY, { ownEnv: 0, procEnviron: 0, procCmdline: 0 });
    const verdict = judge(report);
    assert.deepEqual(verdict, { ok: true, problems: [] });
    assert.equal(report.procsReadable, 1, 'it read the instance, so a zero is a finding and not an empty scan');
  } finally { stop(child); }
});

test('RED: a key given as an argument is found in the command line, and a key inside a longer string is found too', async () => {
  const flag = { name: 'ANTHROPIC_API_KEY', value: made() };
  const prefixed = { name: 'MODAL_TOKEN_SECRET', value: made() };
  const child = await instance({ argv: [`--key=${flag.value}`], env: { WRAPPED: `pre-${prefixed.value}-post` }, code: IDLE });
  try {
    const report = scan([flag, prefixed]);
    assert.ok(report.counts.ANTHROPIC_API_KEY.procCmdline >= 1, JSON.stringify(report.counts));
    assert.ok(report.counts.MODAL_TOKEN_SECRET.procEnviron >= 1, JSON.stringify(report.counts));
    assert.equal(judge(report).ok, false);
  } finally { stop(child); }
});

test('RED: the scanner finds the value in its own environment', () => {
  const secret = { name: 'MODAL_TOKEN_ID', value: made() };
  const report = scan([secret], { env: { SOMETHING: secret.value } });
  assert.ok(report.counts.MODAL_TOKEN_ID.ownEnv >= 1, JSON.stringify(report.counts));
  assert.equal(judge(report).ok, false);
});

test('RED: a forbidden or key-like NAME in a readable environment fails the probe even when the value is not one it holds', async () => {
  const secret = { name: 'ANTHROPIC_API_KEY', value: made() };
  const child = await instance({ env: { ANTHROPIC_API_KEY: 'not-the-held-value', MY_SERVICE_TOKEN_X: 'x', FINE_NAME: 'y' }, code: IDLE });
  try {
    const report = scan([secret], { only: [child.pid] });
    assert.ok(report.forbiddenNames.includes('ANTHROPIC_API_KEY'));
    assert.ok(report.secretishNames.includes('MY_SERVICE_TOKEN_X'));
    assert.ok(!report.secretishNames.includes('FINE_NAME'));
    assert.deepEqual(report.secretishNames, ['ANTHROPIC_API_KEY', 'MY_SERVICE_TOKEN_X']);
    const verdict = judge(report);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((p) => /key-like names: MY_SERVICE_TOKEN_X/.test(p)), verdict.problems.join(' | '));
  } finally { stop(child); }
});

test('a scan that read nothing is not a pass', () => {
  assert.equal(judge({ uid: 1, procsReadable: 0, procsUnreadable: 40, forbiddenNames: [], secretishNames: [], counts: {} }).ok, false);
});

test('the scanner command is one shell command that runs and reports, so a runner that takes a string can use it', () => {
  const secret = { name: 'ANTHROPIC_API_KEY', value: made() };
  const run = spawnSync('/bin/sh', ['-c', scannerCommand(specOf([secret]))], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(judge(parseReport(run.stdout)).problems.filter((p) => p.includes('is in')), []);
});

test('an unnarrowed scan reads every process of the user and says how many it could not read (other users\' processes)', () => {
  const report = scan([{ name: 'ANTHROPIC_API_KEY', value: made() }]);
  assert.ok(report.procsReadable >= 1);
  assert.ok(report.procsUnreadable > 0, 'pid 1 and the other users\' processes are not readable here');
});
