// Every `node --test` command CI runs gives each test a deadline and exits once its tests are done, so a test that never settles
// fails with its name instead of holding the job until GitHub cancels it with nothing named (two verify jobs, 2026-10-12), and a
// test file that leaves a timer or a socket open cannot keep the run waiting either.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const DEADLINE = ['--test-timeout=240000', '--test-force-exit'];
const pkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

test('every test command CI runs carries a per-test deadline and force-exit', () => {
  const commands = [];
  for (const name of ['test:release', 'test:examples']) commands.push([`package.json ${name}`, pkg(ROOT).scripts[name]]);
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const script = pkg(join(ROOT, 'packages', dir)).scripts?.test;
    if (!script) continue;
    // a package with its own runner (pi-browser's run-tests.mjs) passes the flags where it spawns node --test
    const runner = /^node (scripts\/[\w-]+\.mjs)/.exec(script);
    commands.push([`packages/${dir} test`, runner ? readFileSync(join(ROOT, 'packages', dir, runner[1]), 'utf8') : script]);
  }
  for (const [where, command] of commands) {
    for (const flag of DEADLINE) assert.ok(command.includes(flag), `${where} lacks ${flag}: ${command.slice(0, 120)}`);
  }
});

test('with those flags a test that never settles fails by name, as a timeout', () => {
  // with a timer running, as in a hung test: on Node 22 a pending promise with nothing else alive is failed when the loop
  // empties, so only a test that also holds a handle can hang there (on Node 24 the bare promise hangs too)
  const never = "import { it } from 'node:test';\nit('a promise that never settles', () => new Promise(() => { setInterval(() => {}, 1000); }));\n";
  const run = inScratch('never.test.mjs', never, ['--test-timeout=1000', '--test-force-exit']);
  assert.equal(run.error, undefined, 'the run ended by itself');
  assert.notEqual(run.status, 0);
  // named: by the test (Node 24), or by its file, which on Node 22 is itself a test the deadline bounds and times out first
  assert.match(run.stdout, /a promise that never settles|never\.test\.mjs/);
  assert.match(run.stdout, /test timed out after 1000ms/);
});

test('with those flags a file that leaves a timer open passes and ends; without force-exit it is still running 5 s later', () => {
  const leak = "import { it } from 'node:test';\nit('passes but leaves a timer', () => { setInterval(() => {}, 1000); });\n";
  const run = inScratch('leak.test.mjs', leak, ['--test-timeout=1000', '--test-force-exit']);
  assert.equal(run.error, undefined, 'the run ended by itself');
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /passes but leaves a timer/);
  const held = inScratch('leak.test.mjs', leak, [], 5_000);
  assert.equal(held.error?.code, 'ETIMEDOUT', 'without --test-force-exit the open timer keeps the run going');
});

/** `node --test FLAGS FILE` on one file written to a scratch directory: a fresh runner, not a child of this one
 * (NODE_TEST_CONTEXT would make it report to us and exit 0). */
function inScratch(name, source, flags, timeout = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), 'deadlines-'));
  try {
    writeFileSync(join(dir, name), source);
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    return spawnSync(process.execPath, ['--test', ...flags, name], { cwd: dir, encoding: 'utf8', timeout, killSignal: 'SIGKILL', env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
