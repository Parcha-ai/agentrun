// verify-eve-package.mjs runs each consumer step through runStep. A check that fails once with no visible cause is a
// flake, so a step must settle deterministically: a timed-out step's whole process group is gone before the step
// rejects (the consumer directory's cleanup never races a live child), and a failure shows both stdout and stderr.
// Each case drives a tiny `sh` command with a short timeout: no npm, no network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runStep } from './verify-eve-package.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

/** A scratch directory, and the pid a command writes to `pidfile` (or `grandchild`) there; the test kills each pid left. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-eve-step-'));
  const pidOf = (file = 'pidfile') => Number(readFileSync(join(dir, file), 'utf8').trim());
  t.after(() => {
    for (const file of ['pidfile', 'grandchild']) {
      try { const pid = pidOf(file); if (pid > 0) process.kill(pid, 'SIGKILL'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, pidOf };
}

/** Run a step and record, in the same tick it settles, whether the pid in `pidfile` is still alive. */
const settle = (pidOf, promise) => promise.then(
  stdout => ({ stdout, alive: alive(pidOf()) }),
  error => ({ error, alive: alive(pidOf()) }),
);

test('a step that outlives its timeout: its grandchild is killed before the step rejects, and the error says it timed out', async (t) => {
  const { dir, pidOf } = scratch(t);
  // The grandchild leaves the step's pipes, as eve's build workers do, so only a group kill reaches it.
  const step = runStep('sh', ['-c', 'sleep 37 >/dev/null 2>&1 & echo $! > pidfile; echo started; exec sleep 37'],
    { cwd: dir, env: process.env, timeout: 300, grace: 200 });
  const { error, alive: grandchild } = await settle(pidOf, step);
  assert.equal(grandchild, false, 'the grandchild is gone when the step settles');
  assert.ok(error, 'the step rejects');
  assert.match(error.message, /timed out after \d+ ms \(limit 300 ms\)/);
  assert.match(error.message, /--- stdout \(last 5000 chars\) ---\nstarted\n/);
});

test('a step that fails: the error holds its stdout and its stderr, each labelled, and the exit code', async (t) => {
  const { dir } = scratch(t);
  const step = runStep('sh', ['-c', 'echo $$ > pidfile; echo out-text-from-step; echo err-text-from-step >&2; exit 1'],
    { cwd: dir, env: process.env, timeout: 10_000, grace: 200 });
  const error = await step.then(() => null, error => error);
  assert.ok(error, 'the step rejects');
  assert.ok(error.message.includes('out-text-from-step'), `stdout in the error: ${error.message}`);
  assert.ok(error.message.includes('err-text-from-step'), `stderr in the error: ${error.message}`);
  assert.match(error.message, /--- stdout \(last 5000 chars\) ---\nout-text-from-step\n/);
  assert.match(error.message, /--- stderr \(last 5000 chars\) ---\nerr-text-from-step\n/);
  assert.match(error.message, /exit code 1/);
  assert.doesNotMatch(error.message, /timed out/);
});

test('a step that exits 0: it resolves with its stdout and leaves no process behind', async (t) => {
  const { dir, pidOf } = scratch(t);
  const step = runStep('sh', ['-c', 'echo $$ > pidfile; echo ok-text-from-step'],
    { cwd: dir, env: process.env, timeout: 10_000, grace: 200 });
  const { stdout, error, alive: left } = await settle(pidOf, step);
  assert.equal(error, undefined, String(error?.message));
  assert.equal(stdout, 'ok-text-from-step\n');
  assert.equal(left, false);
});

test('a step that exits 0 with a background child still running: the child is killed before the step resolves', async (t) => {
  const { dir, pidOf } = scratch(t);
  const step = runStep('sh', ['-c', 'sleep 37 >/dev/null 2>&1 & echo $! > pidfile; echo ok-text-from-step'],
    { cwd: dir, env: process.env, timeout: 10_000, grace: 200 });
  const { stdout, error, alive: left } = await settle(pidOf, step);
  assert.equal(left, false, 'the background child is gone when the step settles');
  assert.equal(error, undefined, String(error?.message));
  assert.equal(stdout, 'ok-text-from-step\n');
});

test('a step that exits 0 while its background child holds its pipes: it resolves at once, not at its timeout', async (t) => {
  const { dir, pidOf } = scratch(t);
  // No redirection: the background child inherits stdout and stderr, so the pipes stay open after the step exits.
  const started = Date.now();
  const step = runStep('sh', ['-c', 'sleep 37 & echo $! > pidfile; echo ok-text-from-step'],
    { cwd: dir, env: process.env, timeout: 4_000, grace: 200 });
  const { stdout, error, alive: left } = await settle(pidOf, step);
  assert.equal(error, undefined, String(error?.message));
  assert.equal(stdout, 'ok-text-from-step\n');
  assert.equal(left, false, 'the background child is gone when the step settles');
  assert.ok(Date.now() - started < 2_000, `settled in ${Date.now() - started} ms, well before the 4000 ms limit`);
});

test('a step that exits 0 just before its limit: waiting for its leftover child does not count as a timeout', async (t) => {
  const { dir, pidOf } = scratch(t);
  // The step exits after ~50 ms; its child ignores SIGTERM (inherited across exec) and lives ~400 ms more, so the
  // cleanup after exit runs past the 200 ms limit, inside the 600 ms grace.
  const step = runStep('sh', ['-c', '(trap "" TERM; exec sleep 0.4) >/dev/null 2>&1 & echo $! > pidfile; sleep 0.05; echo ok-text-from-step'],
    { cwd: dir, env: process.env, timeout: 200, grace: 600 });
  const { stdout, error, alive: left } = await settle(pidOf, step);
  assert.equal(error, undefined, String(error?.message));
  assert.equal(stdout, 'ok-text-from-step\n');
  assert.equal(left, false, 'the child is gone when the step settles');
});

test('a step that floods its output and ignores SIGTERM: what it keeps stays within the cap', async (t) => {
  const { dir } = scratch(t);
  // It ignores SIGTERM, so it keeps writing through the grace until SIGKILL.
  const flood = 'trap "" TERM; echo $$ > pidfile; while :; do printf "%01000d\\n" 0; done';
  const step = runStep('sh', ['-c', flood], { cwd: dir, env: process.env, timeout: 10_000, maxBuffer: 1024, grace: 500 });
  const error = await step.then(() => null, error => error);
  assert.ok(error, 'the step rejects');
  const said = /stdout over 1024 bytes \(written (\d+), kept the last (\d+)\)/.exec(error.message);
  assert.ok(said, `the error says how much was written and kept: ${error.message.slice(0, 400)}`);
  const [written, kept] = [Number(said[1]), Number(said[2])];
  assert.ok(written > 4 * 1024, `it kept writing through the grace (${written} bytes)`);
  assert.ok(kept <= 1024, `kept ${kept} bytes, no more than the 1024-byte cap`);
});

test('a SIGINT to the process running a step stops the step and its grandchild, the caller\'s cleanup still runs, and it exits 130', async (t) => {
  const { dir, pidOf } = scratch(t);
  // A caller as verify-packages is: a step in a try, a cleanup in its finally, the exit code from the error's signal.
  const script = `import { writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { runStep } from ${JSON.stringify(new URL('./verify-eve-package.mjs', import.meta.url).href)};
try {
  await runStep('sh', ['-c', 'sleep 37 >/dev/null 2>&1 & echo $! > grandchild; echo $$ > pidfile; exec sleep 37'], { cwd: process.cwd(), env: process.env, timeout: 60_000, grace: 200 });
} catch (error) {
  process.exitCode = 128 + constants.signals[error.signal];
} finally {
  writeFileSync('cleaned', '');
}`;
  const caller = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  caller.stdout.on('data', chunk => { output += chunk; }); caller.stderr.on('data', chunk => { output += chunk; });
  const exited = once(caller, 'exit');
  for (const end = Date.now() + 30_000; !(existsSync(join(dir, 'pidfile')) && pidOf() > 0);) {
    assert.ok(Date.now() < end, `the step started within 30 s: ${output}`);
    await sleep(25);
  }
  caller.kill('SIGINT');
  const [code, signal] = await exited;
  assert.equal(alive(pidOf()), false, `the step's process is gone once the caller has exited (caller: code ${code}, signal ${signal})`);
  assert.equal(alive(pidOf('grandchild')), false, 'the step\'s grandchild, which left its pipes, is gone too');
  assert.ok(existsSync(join(dir, 'cleaned')), 'the caller\'s finally ran');
  assert.equal(code, 130, `the caller exits 128 + SIGINT: ${output}`);
});
