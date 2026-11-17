import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciVerdict, readCiVerdict, requiredChecks } from './release-ci-gate.mjs';

const sha = 'a'.repeat(40);
const required = ['verify', 'lean'];
const job = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
const run = (change = {}) => ({ id: 7, head_sha: sha, event: 'push', head_branch: 'main', status: 'completed', jobs: [job('verify'), job('lean'), job('real-chrome', 'failure'), job('phoned', 'failure')], ...change });
// The answer of GET /repos/{repo}/rules/branches/main, as the repository's ruleset gives it.
const rules = (contexts = required) => [
  { type: 'deletion', parameters: null },
  { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
  { type: 'required_status_checks', parameters: { required_status_checks: contexts.map(context => ({ context, integration_id: 15368 })), strict_required_status_checks_policy: false } },
  { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } },
];

test('a push run on main of this exact commit whose every required check passed lets the release go, though jobs that are not required failed', () => {
  assert.deepEqual(ciVerdict(sha, [run()], required), { pass: true, run: 7, checks: ['verify', 'lean'] });
});

test('every check the main ruleset requires is one, lean as well as verify', () => {
  assert.deepEqual(requiredChecks(rules()), ['verify', 'lean']);
  assert.deepEqual(requiredChecks([...rules(['verify']), ...rules(['lean', 'verify'])]), ['verify', 'lean'], 'two rulesets: the union');
  assert.throws(() => requiredChecks(rules([])), /requires no status check/, 'a ruleset that requires nothing is nothing to trust');
  assert.throws(() => requiredChecks([]), /requires no status check/);
  assert.throws(() => requiredChecks({ message: 'Not Found' }), /could not be read/);
});

test('anything that is not a pass of every required check on this commit, pushed to main, stops the release', () => {
  const stops = (runs, reason, at = sha, checks = required) => { const verdict = ciVerdict(at, runs, checks); assert.equal(verdict.pass, false); assert.match(verdict.reason, reason); };
  stops([], /no push run on main/);
  stops([run({ head_sha: 'b'.repeat(40) })], /no push run on main/, sha, required);
  // A merge-queue run carries the queue's own commit; even one at this commit is not the push run on main.
  stops([run({ event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-1-' + 'c'.repeat(40) })], /no push run on main/);
  stops([run({ event: 'pull_request' })], /no push run on main/);
  stops([run({ head_branch: 'v0.1.0-beta.30' })], /no push run on main/);
  stops([run({ status: 'in_progress', jobs: undefined })], /is in_progress; wait/);
  stops([run({ jobs: undefined })], /could not be read/);
  stops([run({ jobs: 'not a list' })], /could not be read/);
  stops([run({ jobs: [job('lean')] })], /no verify job/);
  stops([run({ jobs: [job('verify')] })], /no lean job/, sha, required);
  stops([run({ jobs: [job('verify', 'failure'), job('lean')] })], /verify is failure/);
  stops([run({ jobs: [job('verify'), job('lean', 'failure')] })], /lean is failure/, sha, required);
  stops([run({ jobs: [job('verify', null), job('lean')] })], /verify is completed/);
  stops([run({ jobs: [job('verify', 'skipped'), job('lean')] })], /verify is skipped/);
  stops([run({ jobs: [job('verify'), job('lean', 'cancelled')] })], /lean is cancelled/);
  // A matrix job named after a required check is not that check.
  stops([run({ jobs: [job('verify (24)'), job('lean')] })], /no verify job/);
  stops([run()], /no required check/, sha, []);
  stops([run()], /no required check/, sha, null);
  stops(undefined, /could not be read/);
  stops({ total_count: '1' }, /could not be read/);
  stops([run()], /not a commit sha/, '');
  stops([run()], /not a commit sha/, 'main');
  stops([run()], /not a commit sha/, 'a'.repeat(10));
  // The newest run is the verdict: an older green run of the same commit does not outvote a red re-run.
  stops([run({ id: 9, jobs: [job('verify', 'failure'), job('lean')] }), run()], /run 9/);
  // An older run of another commit listed first never stands in for this commit's run.
  stops([run({ id: 3, head_sha: 'd'.repeat(40) }), run({ id: 8, status: 'queued', jobs: undefined })], /run 8 on a{40} is queued/);
});

test('the reader reads main\'s required checks, the push runs of the exact sha and the newest run\'s latest jobs, retries, and gives up closed after three', async () => {
  const calls = [];
  const answers = (sequence) => async (url) => { calls.push(url); const next = sequence.shift(); return typeof next === 'number' ? { ok: false, status: next } : { ok: true, json: async () => next }; };
  const listed = { workflow_runs: [run({ jobs: undefined })] };
  const verdict = await readCiVerdict({ repository: 'o/r', sha, token: 't', fetchImpl: answers([rules(), listed, { jobs: run().jobs }]), wait: async () => {} });
  assert.deepEqual(verdict, { pass: true, run: 7, checks: ['verify', 'lean'] });
  assert.match(calls[0], /repos\/o\/r\/rules\/branches\/main$/);
  assert.match(calls[1], /actions\/workflows\/ci\.yml\/runs\?head_sha=a{40}&event=push&branch=main/);
  assert.match(calls[2], /actions\/runs\/7\/jobs\?filter=latest/);
  calls.length = 0;
  const red = await readCiVerdict({ repository: 'o/r', sha, token: 't', fetchImpl: answers([rules(), listed, { jobs: [job('verify'), job('lean', 'failure')] }]), wait: async () => {} });
  assert.deepEqual(red, { pass: false, reason: 'ci.yml run 7: lean is failure' });
  calls.length = 0;
  await assert.rejects(readCiVerdict({ repository: 'o/r', sha, token: 't', fetchImpl: answers([502, 502, 502]), wait: async () => {} }), /GitHub answered 502/);
  assert.equal(calls.length, 3);
});
