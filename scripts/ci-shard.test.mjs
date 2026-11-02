// ci-shard's time limits, on a made-up repository: a test that never settles fails by its --test-timeout, named, and a suite
// that never exits is killed at the shard's limit with everything it started, the shard failing with a line that names it.
// A script of a shape ci-shard does not know fails the shard before anything runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-shard.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'ci-shard-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };

// A repository ci-shard can read: the workspaces its shards name, each with a test that passes, and one more, stall, whose
// test runs packages/stall/test/*.test.mjs (or `stallScript`). The rest shard runs stall's test, then test:release, which passes.
const repo = (name, files, stallScript = "node --test 'test/*.test.mjs'") => {
  const root = join(scratch, name);
  write(join(root, 'package.json'), { name, private: true, workspaces: ['packages/*'], scripts: { 'test:examples': 'node --test examples/*.test.mjs', 'test:release': "node --test 'release/*.test.mjs'", 'test:viewer': 'node -e 0' } });
  write(join(root, 'release/ok.test.mjs'), "import test from 'node:test'; test('passes', () => {});");
  for (const workspace of ['pi-transport', 'pi-browser', 'pi-durable-disk', 'pi-durable-agent', 'agentrun-serve', 'agentrun-dsl', 'agentrun-jev', 'agentrun-pi']) {
    write(join(root, 'packages', workspace, 'package.json'), { name: `@parcha/${workspace}`, scripts: { test: 'node -e 0' } });
  }
  write(join(root, 'packages/stall/package.json'), { name: 'stall', scripts: { test: stallScript } });
  for (const [path, text] of Object.entries(files)) write(join(root, 'packages/stall', path), text);
  return root;
};

// The shard's run, in a process group of its own: what a shard with no limit leaves running is ended with it.
const shard = async (t, root, name, env) => {
  // A run of its own, not one nested in this file's (node --test skips a run it finds inside another).
  const { NODE_TEST_CONTEXT: _nested, ...outer } = process.env;
  const started = Date.now();
  const run = spawn(process.execPath, [script, name], { cwd: root, env: { ...outer, npm_config_update_notifier: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  t.after(() => { try { process.kill(-run.pid, 'SIGKILL'); } catch { /* gone */ } });
  let output = '';
  run.stdout.on('data', (chunk) => { output += chunk; });
  run.stderr.on('data', (chunk) => { output += chunk; });
  let timer;
  const status = await Promise.race([new Promise((resolve) => run.on('close', resolve)), new Promise((resolve) => { timer = setTimeout(resolve, 60_000, 'still running'); })]);
  clearTimeout(timer);
  return { status, output, seconds: (Date.now() - started) / 1000 };
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
  const { status, output, seconds } = await shard(t, root, 'rest', { CI_SHARD_TEST_TIMEOUT_MS: '1000', CI_SHARD_TIMEOUT_MS: '30000' });
  assert.equal(status, 1, output);
  assert.match(output, /test timed out after 1000ms/, output);
  // Node 24 applies --test-timeout to each test; Node 22 to each test file, so there the file is the name the log gives.
  assert.match(output, major >= 24 ? /✖ a test that never settles/ : /not ok \d+ - test\/hang\.test\.mjs/, output);
  assert.match(output, /^failed: npm exec -w stall -c "node --test --test-timeout=1000 'test\/\*\.test\.mjs'"$/m, output);
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
  const { status, output, seconds } = await shard(t, root, 'rest', { CI_SHARD_TEST_TIMEOUT_MS: '60000', CI_SHARD_TIMEOUT_MS: '10000', CI_SHARD_TEST_PID_FILE: pidFile });
  assert.equal(status, 1, output);
  assert.match(output, /^::error::ci-shard: npm exec -w stall -c "node --test --test-timeout=60000 'test\/\*\.test\.mjs'" ran [\d.]+ min and was killed at the shard's 0\.2-minute limit$/m, output);
  assert.match(output, /^::error::ci-shard: npm exec -c "node --test --test-timeout=60000 'release\/\*\.test\.mjs'" was not run: the shard's 0\.2-minute limit had passed$/m, output);
  assert.match(output, /^failed: npm exec -w stall -c "node --test --test-timeout=60000 'test\/\*\.test\.mjs'", npm exec -c "node --test --test-timeout=60000 'release\/\*\.test\.mjs'"$/m, output);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `the test file's process ${pid} was killed with the suite`);
  assert.ok(seconds < 30, `${seconds} s`);
});

test('a script of a shape ci-shard does not know fails the shard, naming it, before anything runs; every script on main is one it knows', async (t) => {
  const root = repo('unknown', { 'test/ok.test.mjs': "import test from 'node:test'; test('passes', () => {});" }, "node --test 'test/*.test.mjs' && echo done");
  const { status, output } = await shard(t, root, 'rest', {});
  assert.notEqual(status, 0, output);
  assert.match(output, /stall's test script, "node --test 'test\/\*\.test\.mjs' && echo done", is neither `node --test \[--test-concurrency=<n>\] <files>`/, output);
  assert.doesNotMatch(output, /::group::/, 'nothing ran');
  // This repository's own scripts, every shard: each either gets --test-timeout or is one ci-shard runs as it is.
  const listed = await shard(t, dirname(dirname(script)), '--list', { CI_SHARD_TEST_TIMEOUT_MS: '600000' });
  assert.equal(listed.status, 0, listed.output);
  assert.match(listed.output, /npm exec -w @parcha\/agentrun-serve -c "node --test --test-timeout=600000 [^"]*"/, listed.output);
  assert.match(listed.output, /npm run test -w @parcha\/pi-durable-disk/, listed.output);
});
