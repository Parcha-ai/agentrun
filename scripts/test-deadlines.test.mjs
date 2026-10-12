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

test('with those flags a test that never settles fails by name, and a file that leaves a timer open still ends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deadlines-'));
  try {
    writeFileSync(join(dir, 'never.test.mjs'), "import { it } from 'node:test';\nit('a promise that never settles', () => new Promise(() => {}));\n");
    writeFileSync(join(dir, 'leak.test.mjs'), "import { it } from 'node:test';\nit('passes but leaves a timer', () => { setInterval(() => {}, 1000); });\n");
    // the same flags, with a short deadline so this check is quick
    // a fresh runner, not a child of this one (NODE_TEST_CONTEXT would make it report to us and exit 0)
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, ['--test', '--test-timeout=1000', '--test-force-exit', 'never.test.mjs', 'leak.test.mjs'],
      { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
    assert.equal(run.error, undefined, 'the run ended by itself');
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /a promise that never settles/);
    assert.match(run.stdout, /passes but leaves a timer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
