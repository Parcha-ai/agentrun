// The conformance suite catches a store that breaks a rule: each mutant store fails the tests that state the rule it
// breaks, and the store that breaks none passes them all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './recovery-conformance-mutants.mjs';

const runner = fileURLToPath(new URL('./recovery-conformance-mutants.mjs', import.meta.url));
/** The titles of the suite's tests that failed on a mutant. */
function failures(mutant) {
  const env = { ...process.env, RECOVERY_MUTANT: mutant };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', runner], { env, encoding: 'utf8' });
  const failed = [...run.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(([, title]) => title.replace(`${mutant}: `, ''));
  assert.equal(run.status === 0, failed.length === 0, `${mutant}: exit ${run.status}\n${run.stdout.slice(-2000)}`);
  assert.match(run.stdout, /^# tests 12$/m, `${mutant}: the whole suite ran`);
  return failed;
}

const EXPECTED = {
  none: [],
  'admit-without-its-state': [/^admit commits the effect with the state that admits it/],
  'two-owners': [/^a journal has one owner/],
  'binding-unchecked': [/^a binding that differs is refused/],
  'effects-forgotten': [/^admit commits the effect/, /^an effect admitted and never completed is unknown/, /^complete stores the result/, /^an effect completed with no state/],
  'half-an-admission': [/^values are stored as plain JSON, and a write that cannot be stored writes nothing at all/],
  'commits-after-close': [/^a closed journal commits nothing/],
};

test('every mutant has an expectation, and the store that keeps every rule passes the suite', () => {
  assert.deepEqual(Object.keys(MUTANTS).sort(), Object.keys(EXPECTED).sort());
  assert.deepEqual(failures('none'), []);
});

for (const [mutant, expected] of Object.entries(EXPECTED).filter(([name]) => name !== 'none')) {
  test(`the suite catches a store with ${mutant}`, () => {
    const failed = failures(mutant);
    for (const title of expected) assert.ok(failed.some((name) => title.test(name)), `${mutant} should fail ${title}; failed: ${JSON.stringify(failed)}`);
  });
}
