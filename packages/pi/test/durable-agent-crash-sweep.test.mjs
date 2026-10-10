// The crash sweep over a run with an effect and an agent step on a pi-durable Harness over SQLite: every crossing of
// admit, dispatch, settle, commit, session, request and submit is cut, the run resumes, and the effect is dispatched
// once. The step's model request may be asked again, as a request is; the effect never is.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { crashSweep } from '@parcha/agentrun-dsl/recovery/testing';

const child = fileURLToPath(new URL('./fixtures/crash-agent-child.mjs', import.meta.url));
const COMPLETE = { status: 'complete', output: { ok: true } };
const UNKNOWN = { status: 'stopped', code: 'FROZEN_EFFECT_UNKNOWN' };
const outcomeOf = (run) => run.rows.find((row) => row.outcome)?.outcome;

// An effect admitted and never completed is unknown and stops the run. Every other cut leaves a run that goes on.
const expectation = (found) => {
  const wanted = found.point === 'dispatch' || found.point === 'settle' ? UNKNOWN : COMPLETE;
  return JSON.stringify(outcomeOf(found.resumed)) === JSON.stringify(wanted) ? [] : [`the resume ended ${JSON.stringify(outcomeOf(found.resumed))}, not ${JSON.stringify(wanted)}`];
};

for (const machines of [1, 2]) {
  test(`the sweep cuts every crossing of an agent step and no effect is dispatched twice, on ${machines} machine${machines === 2 ? 's' : ''}`, async () => {
    const result = await crashSweep({ child, machines, expect: expectation });
    assert.deepEqual(result.violations, []);
    for (const point of ['admit', 'dispatch', 'settle', 'commit', 'session', 'request', 'submit']) assert.ok(result.crossings[point] >= 1, `${point} was crossed`);
    assert.deepEqual(outcomeOf(result.census), COMPLETE);
  });
}
