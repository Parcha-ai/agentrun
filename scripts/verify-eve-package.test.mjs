// runStep, driven by tiny `sh` commands: no npm, no network.
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

/** A node process in `dir` that runs `body` with runStep imported, as verify-packages runs a step; `closed` settles with
 *  its exit code and signal, `output` is what it wrote. */
function caller(dir, body) {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { runStep } from ${JSON.stringify(new URL('./verify-eve-package.mjs', import.meta.url).href)};\n${body}`],
  { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, output: '', closed: once(child, 'close') };
  child.stdout.on('data', chunk => { run.output += chunk; }); child.stderr.on('data', chunk => { run.output += chunk; });
  return run;
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
    { cwd: dir, env: process.env, timeout: 1_000, grace: 200 });
  const { error, alive: grandchild } = await settle(pidOf, step);
  assert.equal(grandchild, false, 'the grandchild is gone when the step settles');
  assert.ok(error, 'the step rejects');
  assert.match(error.message, /timed out after \d+ ms \(limit 1000 ms\)/);
  assert.match(error.message, /--- stdout \(last 5000 chars\) ---\nstarted\n/);
});

test('a step that fails: the error holds its stdout and its stderr, each labelled, and the exit code', async (t) => {
  const { dir } = scratch(t);
  const step = runStep('sh', ['-c', 'echo $$ > pidfile; echo out-text-from-step; echo err-text-from-step >&2; exit 1'],
    { cwd: dir, env: process.env, timeout: 10_000, grace: 200 });
  const error = await step.then(() => null, error => error);
  assert.ok(error, 'the step rejects');
  assert.match(error.message, /--- stdout \(last 5000 chars\) ---\nout-text-from-step\n/);
  assert.match(error.message, /--- stderr \(last 5000 chars\) ---\nerr-text-from-step\n/);
  assert.match(error.message, /exit code 1/);
  assert.doesNotMatch(error.message, /timed out/);
});

test('a step killed by a signal of its own: it rejects naming the signal, and was not stopped by this process', async (t) => {
  const { dir } = scratch(t);
  const step = runStep('sh', ['-c', 'echo $$ > pidfile; kill -TERM $$'], { cwd: dir, env: process.env, timeout: 10_000, grace: 200 });
  const error = await step.then(() => null, error => error);
  assert.ok(error, 'the step rejects');
  assert.match(error.message, /signal SIGTERM/);
  assert.doesNotMatch(error.message, /stopped by/);
  assert.equal(error.stoppedBy, undefined, 'only a signal to this process sets stoppedBy');
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

test('a step that exits 0 while its background child holds its pipes: it resolves at once, not at its timeout', async (t) => {
  const { dir, pidOf } = scratch(t);
  // No redirection: the background child inherits stdout and stderr, so the pipes stay open after the step exits.
  const step = runStep('sh', ['-c', 'sleep 37 & echo $! > pidfile; echo ok-text-from-step'],
    { cwd: dir, env: process.env, timeout: 4_000, grace: 200 });
  const { stdout, error, alive: left } = await settle(pidOf, step);
  assert.equal(error, undefined, String(error?.message));
  assert.equal(stdout, 'ok-text-from-step\n');
  assert.equal(left, false, 'the background child is gone when the step settles');
});

test('a step that exits 0 while a process outside its group holds its pipes: it resolves with its stdout and lets go of them', { timeout: 20_000 }, async (t) => {
  const { dir, pidOf } = scratch(t);
  // setsid gives the background sleep a session of its own, out of reach of the group kill, and it inherits the pipes. The
  // step exits once the pid is written from inside the new session, and says ok only if setsid didn't fork ($!). Its
  // caller exits only if runStep stops waiting on the pipes and lets go of them; else it lives as long as the sleep, past
  // this test's 20 s limit.
  const outside = `setsid sh -c 'echo $$ > pidfile; exec sleep 37' & until [ -s pidfile ]; do sleep 0.01; done; [ "$(cat pidfile)" = "$!" ] && echo ok-text-from-step`;
  const run = caller(dir, `process.stdout.write(await runStep('sh', ['-c', ${JSON.stringify(outside)}], { cwd: process.cwd(), env: process.env, timeout: 10_000, grace: 200 }));`);
  const [code] = await run.closed;
  assert.equal(code, 0, run.output);
  assert.equal(run.output, 'ok-text-from-step\n');
  assert.equal(alive(pidOf()), true, 'the sleep outside the group was running all along: the test kills it');
  assert.match(readFileSync(`/proc/${pidOf()}/cmdline`, 'utf8'), /^sleep\x0037\x00$/, 'the pid is the sleep itself');
});

test('a step that exits 0 just before its limit: waiting for its leftover child does not count as a timeout', async (t) => {
  const { dir, pidOf } = scratch(t);
  // The step exits at once; its child ignores SIGTERM (inherited across exec) and lives 1.5 s more, so the cleanup
  // after exit runs past the 1000 ms limit, inside the 3000 ms grace.
  const step = runStep('sh', ['-c', '(trap "" TERM; exec sleep 1.5) >/dev/null 2>&1 & echo $! > pidfile; echo ok-text-from-step'],
    { cwd: dir, env: process.env, timeout: 1_000, grace: 3_000 });
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
  const kept = Number(said[2]);
  assert.ok(kept <= 1024, `kept ${kept} bytes, no more than the 1024-byte cap`);
});

test('a SIGINT to the process running a step stops the step and its grandchild, the caller\'s cleanup still runs, and it exits 130', async (t) => {
  const { dir, pidOf } = scratch(t);
  // A caller as verify-packages is: a step in a try, a cleanup in its finally, the exit code from the error's signal.
  const run = caller(dir, `import { writeFileSync } from 'node:fs';
import { constants } from 'node:os';
try {
  await runStep('sh', ['-c', 'sleep 37 >/dev/null 2>&1 & echo $! > grandchild; echo $$ > pidfile; exec sleep 37'], { cwd: process.cwd(), env: process.env, timeout: 60_000, grace: 200 });
} catch (error) {
  process.exitCode = 128 + constants.signals[error.stoppedBy];
} finally {
  writeFileSync('cleaned', '');
}`);
  for (const end = Date.now() + 30_000; !(existsSync(join(dir, 'pidfile')) && pidOf() > 0);) {
    assert.ok(Date.now() < end, `the step started within 30 s: ${run.output}`);
    await sleep(25);
  }
  run.child.kill('SIGINT');
  const [code, signal] = await run.closed;
  assert.equal(alive(pidOf()), false, `the step's process is gone once the caller has exited (caller: code ${code}, signal ${signal})`);
  assert.equal(alive(pidOf('grandchild')), false, 'the step\'s grandchild, which left its pipes, is gone too');
  assert.ok(existsSync(join(dir, 'cleaned')), 'the caller\'s finally ran');
  assert.equal(code, 130, `the caller exits 128 + SIGINT: ${run.output}`);
});
