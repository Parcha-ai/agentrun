// A demo test file whose tests all pass but which leaves a child, a server or a held pipe open fails by name within seconds, and its process exits: it never holds
// node --test's report of every later file until the job's limit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reap } from './reference-demo-helpers.mjs';

test('a file that leaves a child, a server and a pipe held by a child\'s child open fails naming each, and its process exits in seconds', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-left-open-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const grandchild = join(tmp, 'grandchild.pid');
  const planted = join(tmp, 'planted.test.mjs');
  writeFileSync(planted, `
    import { spawn } from 'node:child_process';
    import { createServer } from 'node:net';
    import { test } from 'node:test';
    import ${JSON.stringify(new URL('./reference-demo-helpers.mjs', import.meta.url).href)};
    test('passes, and leaves three things open', async () => {
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', 'still-running'], { stdio: ['ignore', 'pipe', 'pipe'] });
      createServer().listen(0, '127.0.0.1');
      const parent = spawn(process.execPath, ['-e', 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true }); require("node:fs").writeFileSync(process.argv[1], String(c.pid)); c.unref();', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((resolve) => parent.on('exit', resolve));
    });
  `);
  const started = Date.now();
  // A run of its own, not one nested in this file's (node --test skips a run it finds inside another).
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const run = spawn(process.execPath, ['--test', '--test-reporter=tap', planted], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  run.stdout.on('data', (chunk) => { out += chunk; });
  run.stderr.on('data', (chunk) => { out += chunk; });
  const pids = [];
  // Its own process group: a run that hung (no guard) is ended with everything it started.
  t.after(async () => { try { process.kill(-run.pid, 'SIGKILL'); } catch { /* gone */ } await reap(pids); });
  let timer;
  const code = await Promise.race([new Promise((resolve) => run.on('close', resolve)), new Promise((resolve) => { timer = setTimeout(() => resolve('still running'), 60_000); })]);
  clearTimeout(timer);
  try { pids.push(Number(readFileSync(grandchild, 'utf8'))); } catch { /* never started */ }
  assert.equal(code, 1, `the planted file's run ended failed, not hung: ${out.slice(-2000)}`);
  assert.ok(Date.now() - started < 60_000);
  assert.match(out, /ok 1 - passes, and leaves three things open/, 'its test passed');
  assert.match(out, /left open after the file's last test, now closed: /);
  assert.match(out, /child \d+ \(-e setTimeout\(\(\) => \{\}, 600000\) still-running\)/, 'the child, by pid and argv');
  assert.match(out, /server \{"address":"127\.0\.0\.1"/, 'the server, by address');
  assert.match(out, /a pipe still held open/, 'the pipe a child\'s child kept');
});
