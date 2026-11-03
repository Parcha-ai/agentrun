// npm-ci-retry.mjs against a fake npm on PATH: one more `npm ci` after a network error, none after any other failure.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./npm-ci-retry.mjs', import.meta.url));

/** The error lines npm 11 prints for each failure (`npm error code <code>` first), and its exit code. */
const FAILURES = {
  ECONNRESET: 'npm error code ECONNRESET\nnpm error network aborted\nnpm error network This is a problem related to network connectivity.\n',
  EAI_FAIL: 'npm error code EAI_FAIL\nnpm error network request to https://registry.npmjs.org/x failed, reason: getaddrinfo EAI_FAIL registry.npmjs.org\n',
  EUSAGE: 'npm error code EUSAGE\nnpm error\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.\n',
  EBADENGINE: 'npm error code EBADENGINE\nnpm error engine Unsupported engine\nnpm error engine Not compatible with your version of node/npm: x@1.0.0\n',
};

/** A directory holding an `npm` that logs each call's arguments and answers each `npm ci` with the next of `plan`
 *  (`ok`, or a FAILURES key with an optional `:<exit code>`, 1 if not given). */
function fakeNpm(t, plan) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-ci-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'npm'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const n = readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter(Boolean).length;
const [step, code] = (${JSON.stringify(plan)}[n - 1] ?? 'ok').split(':');
if (step === 'ok') { console.log('added 1 package in 1s'); process.exit(0); }
process.stderr.write(${JSON.stringify(FAILURES)}[step]);
process.exit(Number(code ?? 1));
`);
  chmodSync(join(dir, 'npm'), 0o755);
  const run = (args, env = {}) => {
    const done = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`, NPM_CI_RETRY_WAIT_MS: '0', ...env } });
    return { ...done, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  };
  return run;
}

test('a network error is retried once, after a warning naming its code, and the retry decides the exit', (t) => {
  const done = fakeNpm(t, ['ECONNRESET', 'ok'])(['--ignore-scripts']);
  assert.equal(done.status, 0);
  assert.deepEqual(done.calls, ['ci --ignore-scripts', 'ci --ignore-scripts'], 'the same flags both times');
  assert.match(done.stdout, /^::warning::npm ci failed on a network error \(ECONNRESET\), retrying once$/m);
  assert.match(done.stderr, /npm error network aborted/, "npm's own output is passed through");
});

test('a code outside the list that npm reports as a network error is retried too, and named', (t) => {
  const done = fakeNpm(t, ['EAI_FAIL', 'ok'])(['--ignore-scripts']);
  assert.equal(done.status, 0);
  assert.equal(done.calls.length, 2);
  assert.match(done.stdout, /::warning::npm ci failed on a network error \(EAI_FAIL\), retrying once/);
});

test('a second network error fails with npm\'s code, with no third try', (t) => {
  const done = fakeNpm(t, ['ECONNRESET', 'ECONNRESET:7'])(['--ignore-scripts']);
  assert.equal(done.status, 7);
  assert.equal(done.calls.length, 2);
});

test('a lockfile out of step and an engine npm refuses are not retried and keep npm\'s exit code', (t) => {
  for (const [plan, status] of [[['EUSAGE'], 1], [['EBADENGINE:3'], 3]]) {
    const done = fakeNpm(t, [...plan, 'ok'])(['--ignore-scripts']);
    assert.equal(done.status, status, plan[0]);
    assert.equal(done.calls.length, 1, `${plan[0]}: npm ci ran once`);
    assert.doesNotMatch(done.stdout, /::warning::/, plan[0]);
  }
});

test('success runs npm once; the wait before a retry is NPM_CI_RETRY_WAIT_MS, a whole number', (t) => {
  assert.deepEqual(fakeNpm(t, ['ok'])(['--ignore-scripts', '--no-audit']).calls, ['ci --ignore-scripts --no-audit']);
  const started = Date.now();
  assert.equal(fakeNpm(t, ['ECONNRESET', 'ok'])([], { NPM_CI_RETRY_WAIT_MS: '400' }).status, 0);
  assert.ok(Date.now() - started >= 400, 'waited before the retry');
  const bad = fakeNpm(t, ['ok'])([], { NPM_CI_RETRY_WAIT_MS: '15s' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /NPM_CI_RETRY_WAIT_MS is a whole number of milliseconds, not "15s"/);
  assert.deepEqual(bad.calls, [], 'npm not run');
});
