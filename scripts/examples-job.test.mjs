// CI's examples job runs every example suite, each with npm test's per-test deadline and force-exit: a suite added under
// packages/pi-durable-disk/examples without a step here fails this check, as does a step that drops either flag.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const EXAMPLES = 'packages/pi-durable-disk/examples';
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const job = ci.slice(ci.indexOf('\n  examples:'));
// each step: its working directory and its command (the job's steps are `- name:` blocks at six spaces)
const steps = job.split('\n      - ').slice(1).map((block) => ({
  dir: /\n {8}working-directory: (\S+)/.exec(block)?.[1],
  run: /\n {8}run: (.+)/.exec(block)?.[1],
}));

/** Every directory under the examples with a package.json whose `test` script runs test files: a suite. */
function suites(dir = join(ROOT, EXAMPLES)) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const at = join(dir, entry.name);
    const pkg = join(at, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).scripts?.test) found.push(relative(ROOT, at));
    found.push(...suites(at));
  }
  return found;
}

test('the examples job has a step for every example suite', () => {
  assert.ok(job.length > 20, 'ci.yml has an examples job');
  const ran = new Set(steps.map((s) => s.dir).filter(Boolean));
  const all = suites();
  assert.ok(all.includes(`${EXAMPLES}/03-tab-to-cloud`) && all.includes(`${EXAMPLES}/04-walks-home/show`), all.join(', '));
  for (const suite of all) assert.ok(ran.has(suite), `${suite} has tests and no step in the examples job`);
});

test('every suite step installs its own suite, then runs it with the per-test deadline and force-exit', () => {
  const runs = steps.filter((s) => s.dir?.startsWith(EXAMPLES) && s.run && !/^npm ci [^&]*$/.test(s.run));
  assert.ok(runs.length >= 9, `${runs.length} suite steps`);
  for (const { dir, run } of runs) {
    // a step is its suite's installs and build, then one test command: a failed install fails that suite's step alone
    const parts = run.split(' && ');
    const command = parts.pop();
    for (const part of parts) assert.match(part, /^npm (ci|install|run build)\b/, `${dir}: only installs and the build come before the tests: ${run}`);
    if (command === 'node scripts/run-tests.mjs') {
      // the show's own runner: node:test's run() carries the same two
      const runner = readFileSync(join(ROOT, dir, 'scripts', 'run-tests.mjs'), 'utf8');
      assert.match(runner, /run\(\{[^}]*timeout: 240_000[^}]*forceExit: true[^}]*\}\)/, `${dir}'s runner passes the deadline to run()`);
      continue;
    }
    assert.ok(command.startsWith('node --test ') && command.includes('--test-timeout=240000') && command.includes('--test-force-exit'), `${dir}: ${command}`);
  }
});
