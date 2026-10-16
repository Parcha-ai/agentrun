// The validator sweep's collector runs the dsl, pi and examples suites with `node --test`; its concurrency is the caller's to set.
// The collector runs here for real with `execFileSync` replaced by a spy, so what is asserted is the command line the suites would get.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const collect = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec/lean/sweep/collect.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'sweep-collect-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const spy = join(scratch, 'spy.mjs');
writeFileSync(spy, [
  "import { appendFileSync } from 'node:fs';",
  "import { createRequire, syncBuiltinESMExports } from 'node:module';",
  "const childProcess = createRequire(import.meta.url)('node:child_process');",
  "childProcess.execFileSync = (command, args) => { appendFileSync(process.env.SPY_LOG, `${JSON.stringify(args)}\\n`); return Buffer.alloc(0); };",
  'syncBuiltinESMExports();',
].join('\n'));

let runs = 0;
/** The argument lists the collector gave `node` for the dsl, pi and examples suites, and its own exit status and stderr. */
function suites(args, env = {}) {
  const log = join(scratch, `calls-${runs += 1}.log`);
  writeFileSync(log, '');
  const done = spawnSync(process.execPath, ['--import', spy, collect, ...args], {
    encoding: 'utf8', env: { ...process.env, TEST_CONCURRENCY: '', ...env, SPY_LOG: log },
  });
  return { ...done, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}
const out = () => join(scratch, 'corpus.json');
const flags = (call) => call.filter((arg) => arg.startsWith('--') && arg !== '--test');

test('with neither a flag nor TEST_CONCURRENCY the suites run as before, at node\'s default', () => {
  const { calls } = suites([out()]);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(flags(call), []);
});

test('--test-concurrency reaches the command line of every suite, as a value or joined with =', () => {
  for (const args of [['--test-concurrency', '3', out()], [out(), '--test-concurrency=3']]) {
    const { calls } = suites(args);
    assert.equal(calls.length, 3, args.join(' '));
    for (const call of calls) assert.deepEqual(flags(call), ['--test-concurrency=3'], args.join(' '));
  }
});

test('TEST_CONCURRENCY sets it when no flag does, and the flag wins over it', () => {
  const envCalls = suites([out()], { TEST_CONCURRENCY: '5' }).calls;
  assert.equal(envCalls.length, 3);
  for (const call of envCalls) assert.deepEqual(flags(call), ['--test-concurrency=5']);
  const flagCalls = suites(['--test-concurrency=2', out()], { TEST_CONCURRENCY: '5' }).calls;
  assert.equal(flagCalls.length, 3);
  for (const call of flagCalls) assert.deepEqual(flags(call), ['--test-concurrency=2']);
});

test('a concurrency that is not a positive whole number stops the collector before it runs a suite', () => {
  for (const [args, env] of [[['--test-concurrency', '0'], {}], [['--test-concurrency=many'], {}], [['--test-concurrency'], {}], [[], { TEST_CONCURRENCY: '-1' }]]) {
    const { status, stderr, calls } = suites([...args, out()], env);
    assert.equal(status, 2, args.join(' '));
    assert.match(stderr, /test concurrency must be a positive whole number/);
    assert.deepEqual(calls, []);
  }
});
