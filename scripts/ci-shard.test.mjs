// ci-shard's time limits, on a made-up repository: a test that never settles fails by its --test-timeout, named, and a suite
// that never exits is killed at the shard's limit with everything it started, the shard failing with a line that names it.
// A script of a shape ci-shard does not know fails the shard before anything runs. A cancel that reaches ci-shard stops its
// suite the same way the limit does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-shard.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'ci-shard-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
// Unref'd: a wait that loses a race does not hold this file's process.
const sleep = (ms, value) => new Promise((resolve) => { setTimeout(resolve, ms, value).unref(); });
// Linux's state letter for `pid` from /proc (Z: exited, not yet reaped); undefined where there is no entry to read (no /proc,
// or the process was reaped meanwhile).
const state = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)[0]; } catch { return undefined; } };
// The pid `file` holds once it holds a whole one, else null: a file read while it is being written can be empty.
const pidIn = (file) => {
  try { const text = readFileSync(file, 'utf8'); return /^\d+$/.test(text) ? Number(text) : null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
// `pid`, once it is sure to name one other process: 0 or a negative pid signals a whole process group (this file's runner's
// among them), 1 is init. Anything else fails the test and is never signalled.
const killable = (pid) => {
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid, `refusing to signal pid ${pid}: it does not name one other process`);
  return pid;
};
// Whether `pid` has ended within 5 s, asked every 50 ms. A killed process whose parent died first is reparented and can still
// answer kill(pid, 0) for a moment, while it exits or as a zombie until it is reaped.
const ended = async (pid) => {
  for (const until = Date.now() + 5_000; ; await delay(50)) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    if (state(pid) === 'Z') return true;
    if (Date.now() >= until) return false;
  }
};

// A repository ci-shard can read: one workspace, stall, whose test runs packages/stall/test/*.test.mjs (or `stallScript`),
// and the root's test:release, which passes, in one pool of one shard. Shard any-1 runs stall's test, then test:release.
const repo = (name, files, stallScript = "node --test 'test/*.test.mjs'") => {
  const root = join(scratch, name);
  write(join(root, 'package.json'), { name, private: true, workspaces: ['packages/*'], scripts: { 'test:release': "node --test 'release/*.test.mjs'" } });
  write(join(root, 'scripts/ci-shards.json'), { rootSuites: ['test:release'], pools: { any: { shards: 1 } } });
  write(join(root, 'release/ok.test.mjs'), "import test from 'node:test'; test('passes', () => {});");
  write(join(root, 'packages/stall/package.json'), { name: 'stall', scripts: { test: stallScript } });
  for (const [path, text] of Object.entries(files)) write(join(root, 'packages/stall', path), text);
  return root;
};

// ci-shard started in a process group of its own. `closed` settles with its exit status once it and every process holding its
// output have ended. At the test's end a run still going gets SIGTERM, which ci-shard passes on to its suite's own group
// (SIGKILL to what is left after its grace); then SIGKILL to ci-shard's group, and this file lets go of the pipes, so a suite
// that outlived all that cannot hold this file's process.
const start = (t, root, name, env) => {
  // A run of its own, not one nested in this file's (node --test skips a run it finds inside another).
  const { NODE_TEST_CONTEXT: _nested, ...outer } = process.env;
  const run = spawn(process.execPath, [script, name], { cwd: root, env: { ...outer, npm_config_update_notifier: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  run.stdout.on('data', (chunk) => { output += chunk; });
  run.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => run.on('close', resolve));
  t.after(async () => {
    try { process.kill(run.pid, 'SIGTERM'); } catch { /* gone */ }
    await Promise.race([closed, sleep(20_000)]);
    try { process.kill(-run.pid, 'SIGKILL'); } catch { /* gone */ }
    run.stdout.destroy();
    run.stderr.destroy();
  });
  return { pid: run.pid, closed, output: () => output };
};

// The shard's run to its end, or to 60 s.
const shard = async (t, root, name, env) => {
  const started = Date.now();
  const run = start(t, root, name, env);
  const status = await Promise.race([run.closed, sleep(60_000, 'still running')]);
  return { status, output: run.output(), seconds: (Date.now() - started) / 1000 };
};

const major = Number(process.versions.node.split('.')[0]);

test('a test that never settles fails by --test-timeout, named in the shard\'s log, before the shard\'s limit', { timeout: 90_000 }, async (t) => {
  const root = repo('hang', {
    'test/hang.test.mjs': `
      import test from 'node:test';
      test('a test that never settles', (t) => new Promise(() => {
        const timer = setInterval(() => {}, 1000);
        t.signal.addEventListener('abort', () => clearInterval(timer));
      }));
    `,
  });
  const { status, output, seconds } = await shard(t, root, 'any-1', { CI_SHARD_TEST_TIMEOUT_MS: '1000', CI_SHARD_TIMEOUT_MS: '30000' });
  assert.equal(status, 1, output);
  assert.match(output, /test timed out after 1000ms/, output);
  // Node 24 applies --test-timeout to each test; Node 22 to each test file, so there the file is the name the log gives.
  assert.match(output, major >= 24 ? /✖ a test that never settles/ : /not ok \d+ - test\/hang\.test\.mjs/, output);
  assert.match(output, /^failed: npm exec -w stall -c "node --test --test-timeout=1000 test\/hang\.test\.mjs"$/m, output);
  assert.doesNotMatch(output, /::error::ci-shard/, 'the shard\'s limit did not fire');
  assert.ok(seconds < 25, `${seconds} s`);
});

test('a suite whose tests pass but whose process never exits is killed at the shard\'s limit, with what it started; the commands after it are not run, and each is named', { timeout: 90_000 }, async (t) => {
  const pidFile = join(scratch, 'open.pid');
  const root = repo('open', {
    'test/open.test.mjs': `
      import { writeFileSync } from 'node:fs';
      import test from 'node:test';
      writeFileSync(process.env.CI_SHARD_TEST_PID_FILE, String(process.pid));
      setInterval(() => {}, 1000);
      test('passes, and leaves an interval running', () => {});
    `,
  });
  // The test timeout is long, so on Node 22 (where it bounds the file) the shard's limit is what ends the file.
  const { status, output, seconds } = await shard(t, root, 'any-1', { CI_SHARD_TEST_TIMEOUT_MS: '60000', CI_SHARD_TIMEOUT_MS: '10000', CI_SHARD_TEST_PID_FILE: pidFile });
  assert.equal(status, 1, output);
  assert.match(output, /^::error::ci-shard: npm exec -w stall -c "node --test --test-timeout=60000 test\/open\.test\.mjs" ran [\d.]+ min and was killed at the shard's 0\.2-minute limit$/m, output);
  assert.match(output, /^::error::ci-shard: npm exec -c "node --test --test-timeout=60000 release\/ok\.test\.mjs" was not run: the shard's 0\.2-minute limit had passed$/m, output);
  assert.match(output, /^failed: npm exec -w stall -c "node --test --test-timeout=60000 test\/open\.test\.mjs", npm exec -c "node --test --test-timeout=60000 release\/ok\.test\.mjs"$/m, output);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(await ended(pid), `the test file's process ${pid} is still running 5 s after its suite was killed`);
  assert.ok(seconds < 30, `${seconds} s`);
});

test('a script of a shape ci-shard does not know fails the shard, naming it, before anything runs; every script on main is one it knows', async (t) => {
  const root = repo('unknown', { 'test/ok.test.mjs': "import test from 'node:test'; test('passes', () => {});" }, "node --test 'test/*.test.mjs' && echo done");
  const { status, output } = await shard(t, root, 'any-1', {});
  assert.notEqual(status, 0, output);
  assert.match(output, /stall's test script, "node --test 'test\/\*\.test\.mjs' && echo done", is neither `node --test \[--test-concurrency=<n>\] \[--test-timeout=<ms>\] <files>`/, output);
  assert.doesNotMatch(output, /::group::/, 'nothing ran');
  // This repository's own scripts, every shard: each either gets --test-timeout or is one ci-shard runs as it is.
  const listed = await shard(t, dirname(dirname(script)), '--list', { CI_SHARD_TEST_TIMEOUT_MS: '600000' });
  assert.equal(listed.status, 0, listed.output);
  assert.match(listed.output, /npm exec -w @parcha\/agentrun-serve -c "node --test --test-timeout=600000 --test-concurrency=8 test\/[^"]*"/, listed.output);
  assert.match(listed.output, /npm exec -w @parcha\/pi-durable-disk -c "node --test --test-timeout=240000 test\/[^"]*"/, listed.output, "pi-durable-disk keeps its own limit");
  assert.match(listed.output, /npm exec -w @parcha\/pi-transport -c "vitest --run test\/[^"]*"/, listed.output);
  assert.match(listed.output, /npm run test -w @parcha\/pi-browser/, listed.output, 'a whole suite runs as its script is');
});

test('a cancel that reaches ci-shard stops its suite as the limit does: SIGTERM to its group, SIGKILL 10 s on to what ignores it, and ci-shard exits with the signal\'s status', { timeout: 90_000 }, async (t) => {
  const pidFile = join(scratch, 'stubborn.pid');
  // The suite's test starts a process that ignores SIGTERM, in the suite's group, and never settles. That process writes its pid
  // once its handler is in place.
  const root = repo('stubborn', {
    'test/stubborn.test.mjs': `
      import { spawn } from 'node:child_process';
      import test from 'node:test';
      test('starts a process that ignores SIGTERM, and waits', () => new Promise(() => {
        spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); const fs = require('node:fs'); const file = process.env.CI_SHARD_TEST_PID_FILE; fs.writeFileSync(file + '.tmp', String(process.pid)); fs.renameSync(file + '.tmp', file); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      }));
    `,
  });
  const run = start(t, root, 'any-1', { CI_SHARD_TEST_PID_FILE: pidFile });
  let pid = null;
  while ((pid = pidIn(pidFile)) === null) await sleep(50);
  killable(pid);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const sent = Date.now();
  process.kill(run.pid, 'SIGTERM');
  const status = await Promise.race([run.closed, sleep(30_000, 'still running')]);
  const seconds = (Date.now() - sent) / 1000;
  assert.equal(status, 143, run.output());
  assert.ok(await ended(pid), `the suite's process ${pid}, which ignores SIGTERM, is still running 5 s after ci-shard exited`);
  assert.ok(seconds >= 9 && seconds < 25, `${seconds} s: SIGTERM, the 10 s grace, then SIGKILL`);
  assert.doesNotMatch(run.output(), /::group::npm exec -c/, 'the suites after it were not started');
});
