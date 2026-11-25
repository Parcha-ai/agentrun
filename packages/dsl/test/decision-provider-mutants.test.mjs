// The DecisionProvider conformance suite catches a provider that breaks a rule: each mutant fails the tests that state the
// rule it breaks, and the provider that breaks none passes them all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './decision-provider-mutants.mjs';

const runner = fileURLToPath(new URL('./decision-provider-mutants.mjs', import.meta.url));
/** The suite's 18 tests once for each mutant, every mutant in one process, its titles under the mutant's name. */
let ran;
function suiteRun() {
  if (ran) return ran;
  const env = { ...process.env, DECISION_MUTANT: Object.keys(MUTANTS).join(',') };
  delete env.NODE_TEST_CONTEXT;
  ran = spawnSync(process.execPath, ['--test', '--test-reporter=tap', runner], { env, encoding: 'utf8' });
  return ran;
}
/** The titles of the suite's tests that failed on a mutant. */
function failures(mutant) {
  const run = suiteRun();
  const prefix = `${mutant}: `;
  const results = [...run.stdout.matchAll(/^(not )?ok \d+ - (.+)$/gm)].filter(([, , title]) => title.startsWith(prefix));
  assert.equal(results.length, 18, `${mutant}: the whole suite ran\n${run.stdout.slice(-2000)}`);
  return results.filter(([, not]) => not).map(([, , title]) => title.slice(prefix.length));
}

const EXPECTED = {
  none: [],
  'extra-answers': [/^an answer to a question not asked, or none for one asked, is invalid_response/],
  'unknown-cost-as-zero': [/^a cost it does not know is null, never 0/],
  'untyped-errors': [/^401 and 403 are auth errors/, /^422 is invalid_request/, /^429 is rate_limited/, /^a 5xx is outcome_unknown/, /^a provider that cannot replay never retries/],
  'malformed-as-http': [/^a malformed body is invalid_response/],
  'ignores-abort': [/^an abort stops a request in flight as aborted/],
  'ignores-deadline': [/^a request in flight past its deadline is outcome_unknown/],
  'leaks-key': [/^no key appears in a result or an error/],
  'sends-over-capacity': [/^a request beyond its declared capabilities is refused before anything is sent/],
  'refusal-as-false': [/^a refusal comes back as a refusal/],
  'evidence-as-text': [/^evidence is a list of sources/],
  'request-id-number': [/^evidence is a list of sources, and the request id a string or null/],
  'needs-a-value': [/^needs names environment variables, never their values/],
  'retries-after-send': [/^a provider that cannot replay never retries a failure after the request was sent/],
  'declares-box': [/^it declares only what the seam can send/],
  'ignores-models': [/^a request beyond its declared capabilities is refused before anything is sent/],
  'declares-pdf-input': [/^it declares only what the seam can send/],
};

test('every mutant has an expectation, and the provider that keeps every rule passes the suite', () => {
  assert.deepEqual(Object.keys(MUTANTS).sort(), Object.keys(EXPECTED).sort());
  assert.deepEqual(failures('none'), []);
  const run = suiteRun();
  assert.match(run.stdout, new RegExp(`^# tests ${18 * Object.keys(MUTANTS).length}$`, 'm'), 'every mutant\'s suite ran');
  assert.equal(run.status === 0, !/^not ok /m.test(run.stdout), `exit ${run.status}: a failed test, and only one, fails the run`);
});

for (const [mutant, expected] of Object.entries(EXPECTED).filter(([name]) => name !== 'none')) {
  test(`the suite catches ${mutant}`, () => {
    const failed = failures(mutant);
    for (const title of expected) assert.ok(failed.some((t) => title.test(t)), `${mutant}: expected a failure matching ${title}, got ${JSON.stringify(failed)}`);
    assert.equal(failed.length, expected.length, `${mutant}: only the tests its rule names fail, got ${JSON.stringify(failed)}`);
  });
}
