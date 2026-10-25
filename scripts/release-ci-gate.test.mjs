import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciVerdict, readCiVerdict, REQUIRED_GATES } from './release-ci-gate.mjs';

const sha = 'a'.repeat(40);
const job = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
const gates = ['verify (22.19.0)', 'verify (22.23.2)', 'verify (24.21.0)'];
const run = (change = {}) => ({ id: 7, head_sha: sha, event: 'push', head_branch: 'main', status: 'completed', jobs: [...gates.map(name => job(name)), job('lean', 'failure'), job('real-chrome', 'failure')], ...change });

test('a push run on main whose verify gates all passed lets the release go, though jobs that are not gates failed', () => {
  assert.deepEqual(ciVerdict(sha, [run()]), { pass: true, run: 7 });
  assert.deepEqual(REQUIRED_GATES, ['verify (22.19.0)', 'verify (22.23.2)']);
});

test('anything that is not a pass of every verify gate on this commit, pushed to main, stops the release', () => {
  const stops = (runs, reason, at = sha) => { const verdict = ciVerdict(at, runs); assert.equal(verdict.pass, false); assert.match(verdict.reason, reason); };
  stops([], /no push run on main/);
  stops([run({ head_sha: 'b'.repeat(40) })], /no push run on main/);
  stops([run({ event: 'pull_request' })], /no push run on main/);
  stops([run({ head_branch: 'v0.1.0-beta.30' })], /no push run on main/);
  stops([run({ status: 'in_progress', jobs: undefined })], /is in_progress; wait/);
  stops([run({ jobs: undefined })], /could not be read/);
  stops([run({ jobs: 'not a list' })], /could not be read/);
  stops([run({ jobs: [job('verify (22.23.2)')] })], /no verify \(22\.19\.0\) job/);
  stops([run({ jobs: gates.map(name => job(name, name.includes('24.21') ? 'failure' : 'success')) })], /verify \(24\.21\.0\) is failure/);
  stops([run({ jobs: gates.map(name => job(name, name.includes('22.19') ? null : 'success')) })], /verify \(22\.19\.0\) is completed/);
  stops([run({ jobs: gates.map(name => job(name, name.includes('22.23') ? 'skipped' : 'success')) })], /verify \(22\.23\.2\) is skipped/);
  stops(undefined, /could not be read/);
  stops({ total_count: '1' }, /could not be read/);
  stops([run()], /not a commit sha/, '');
  stops([run()], /not a commit sha/, 'main');
  // The newest run is the verdict: an older green run of the same commit does not outvote a red re-run.
  stops([run({ id: 9, jobs: gates.map(name => job(name, 'failure')) }), run()], /run 9/);
});

test('the reader reads the newest run\'s latest jobs, retries a failed answer, and gives up closed after three', async () => {
  const calls = [];
  const answers = (sequence) => async (url) => { calls.push(url); const next = sequence.shift(); return typeof next === 'number' ? { ok: false, status: next } : { ok: true, json: async () => next }; };
  const listed = { workflow_runs: [run({ jobs: undefined })] };
  const verdict = await readCiVerdict({ repository: 'o/r', sha, token: 't', fetchImpl: answers([listed, { jobs: run().jobs }]), wait: async () => {} });
  assert.deepEqual(verdict, { pass: true, run: 7 });
  assert.match(calls[0], /actions\/workflows\/ci\.yml\/runs\?head_sha=a{40}&event=push&branch=main/);
  assert.match(calls[1], /actions\/runs\/7\/jobs\?filter=latest/);
  calls.length = 0;
  await assert.rejects(readCiVerdict({ repository: 'o/r', sha, token: 't', fetchImpl: answers([502, 502, 502]), wait: async () => {} }), /GitHub answered 502/);
  assert.equal(calls.length, 3);
});
