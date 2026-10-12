// The crash sweep over the reference child on the file store: every crossing of admit, dispatch, settle and commit is
// cut, and the run resumes without dispatching an effect twice.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { COUNT_TOKEN_HEADER, countingServer, crashSweep } from '@parcha/agentrun-dsl/recovery/testing';

const child = fileURLToPath(new URL('./fixtures/crash-child.mjs', import.meta.url));
const COMPLETE = { status: 'complete', output: { ok: true } };
const UNKNOWN = { status: 'stopped', code: 'FROZEN_EFFECT_UNKNOWN' };
const outcomeOf = (run) => run.rows.find((row) => row.outcome)?.outcome;

// What a cut leaves: nothing durable before an admission or after a commit, so the run goes on; an effect admitted and
// never completed is unknown, and the run stops on it rather than dispatch it again.
const expectation = (found) => {
  const wanted = found.point === 'dispatch' || found.point === 'settle' ? UNKNOWN : COMPLETE;
  return JSON.stringify(outcomeOf(found.resumed)) === JSON.stringify(wanted) ? [] : [`the resume ended ${JSON.stringify(outcomeOf(found.resumed))}, not ${JSON.stringify(wanted)}`];
};

for (const machines of [1, 2]) {
  test(`the sweep cuts every crossing and no effect is dispatched twice, on ${machines} machine${machines === 2 ? 's' : ''}`, async () => {
    const result = await crashSweep({ child, machines, expect: expectation });
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.crossings, { admit: 2, dispatch: 2, settle: 2, commit: 3 });
    assert.equal(result.cases.length, 9);
    assert.deepEqual(outcomeOf(result.census), COMPLETE);
  });
}

test('a host that dispatches without consulting the journal is caught', async () => {
  const result = await crashSweep({ child, env: { PLANT: 'bypass-journal' }, expect: expectation });
  assert.ok(result.violations.some((reason) => /was dispatched 2 times/.test(reason)), result.violations.join('\n'));
});

test('the counting server counts only the requests that carry its token', async () => {
  const server = await countingServer();
  try {
    await fetch(`${server.url}/effect/stray`, { method: 'POST' });
    await fetch(`${server.url}/`);
    await fetch(`${server.url}/effect/mine`, { method: 'POST', headers: { [COUNT_TOKEN_HEADER]: server.token } });
    assert.deepEqual(server.counts, { '/effect/mine': 1 });
  } finally { await server.close(); }
});

const stub = fileURLToPath(new URL('./fixtures/crash-stub-child.mjs', import.meta.url));

test('a later open that prints the outcome and then fails is a violation', async () => {
  const result = await crashSweep({ child: stub, env: { STUB: 'fail-late' } });
  assert.ok(result.violations.some((reason) => /a later open after admit-1 did not end its run: exit 3/.test(reason)), result.violations.join('\n'));
  assert.deepEqual((await crashSweep({ child: stub })).violations, []);
});

test('a child that never ends is killed at the deadline and reported, and the sweep goes on', async () => {
  const result = await crashSweep({ child: stub, env: { STUB: 'hang' }, timeoutMs: 1500 });
  assert.ok(result.violations.some((reason) => /the resume after admit-1 was still running after 1500 ms and was killed/.test(reason)), result.violations.join('\n'));
  assert.equal(result.cases.length, 1);
});

test('a sweep that cannot make its directory rejects and leaves no server listening', async () => {
  const before = process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
  await assert.rejects(crashSweep({ child: stub, directory: '/nonexistent-crash-sweep-parent/x' }), /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length <= before, 'the failed sweep left its counting server listening');
});
