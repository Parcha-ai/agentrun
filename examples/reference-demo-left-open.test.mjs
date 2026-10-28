// A demo test file whose tests all pass but which leaves a child, a server or a held pipe open fails by name within seconds, and its process exits: it never holds
// node --test's report of every later file until the job's limit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reap } from './reference-demo-helpers.mjs';

test('a file that leaves a child (with one of its own), a server and a pipe held by a child\'s child open fails naming each, and its process exits in seconds; what its own after() closes is not named', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-left-open-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sub = join(tmp, 'sub.pid');
  const held = join(tmp, 'held.pid');
  const planted = join(tmp, 'planted.test.mjs');
  // Where the planted processes write their children's pids, by environment.
  const write = (name) => `require("node:fs").writeFileSync(process.env.${name}, String(c.pid))`;
  writeFileSync(planted, `
    import { spawn } from 'node:child_process';
    import { createServer } from 'node:net';
    import { after, test } from 'node:test';
    import ${JSON.stringify(new URL('./reference-demo-helpers.mjs', import.meta.url).href)};
    const tidy = createServer().listen(0, '127.0.0.1');
    after(() => new Promise((resolve) => tidy.close(resolve)));
    test('passes, and leaves three things open', async () => {
      spawn(process.execPath, ['-e', ${JSON.stringify(`const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" }); ${write('LEFT_OPEN_SUB')}; setTimeout(() => {}, 600000);`)}, 'still-running'], { stdio: ['ignore', 'pipe', 'pipe'] });
      createServer().listen(0, '127.0.0.1');
      const parent = spawn(process.execPath, ['-e', ${JSON.stringify(`const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true }); ${write('LEFT_OPEN_HELD')}; c.unref();`)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((resolve) => parent.on('exit', resolve));
      while (!existsSync(process.env.LEFT_OPEN_SUB)) await new Promise((resolve) => setTimeout(resolve, 20));
    });
  `);
  const started = Date.now();
  // A run of its own, not one nested in this file's (node --test skips a run it finds inside another).
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const run = spawn(process.execPath, ['--test', '--test-reporter=tap', planted], { env: { ...env, LEFT_OPEN_SUB: sub, LEFT_OPEN_HELD: held }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  run.stdout.on('data', (chunk) => { out += chunk; });
  run.stderr.on('data', (chunk) => { out += chunk; });
  const pids = [];
  // Its own process group: a run that hung (no guard) is ended with everything it started.
  t.after(async () => { try { process.kill(-run.pid, 'SIGKILL'); } catch { /* gone */ } await reap(pids); });
  let timer;
  const code = await Promise.race([new Promise((resolve) => run.on('close', resolve)), new Promise((resolve) => { timer = setTimeout(() => resolve('still running'), 60_000); })]);
  clearTimeout(timer);
  const pidIn = (file) => { try { return Number(readFileSync(file, 'utf8')); } catch { return undefined; } };
  const [subPid, heldPid] = [pidIn(sub), pidIn(held)];
  pids.push(...[subPid, heldPid].filter(Boolean));
  assert.equal(code, 1, `the planted file's run ended failed, not hung: ${out.slice(-2000)}`);
  assert.ok(Date.now() - started < 60_000);
  assert.match(out, /ok 1 - passes, and leaves three things open/, 'its test passed');
  const named = out.match(/left open after the file's last test, now closed: (.*)/)?.[1] ?? '';
  assert.match(named, new RegExp(`child \\d+ \\(-e .* still-running\\) and 1 it started \\(${subPid}\\)`), `the child, by pid and argv, and the one it started: ${named}`);
  assert.equal(named.match(/server \{"address":"127\.0\.0\.1"/g)?.length, 1, `the server left open, and not the one the file's own after() closed: ${named}`);
  assert.match(named, /a pipe still held open/, 'the pipe a child\'s child kept');
  assert.throws(() => process.kill(subPid, 0), { code: 'ESRCH' }, 'the child\'s own child was killed with it');
});
