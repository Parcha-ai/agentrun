// A planned handoff in the reference entry: the spec's list and its refusals, the flags (one at a time), a place that cannot report the run's status, and the one-week mapping of a released process's outcome.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffsOf } from '../packages/harness/dist/demo-spec.js';
import { releasedOutcome } from '../packages/harness/dist/handoff.js';
import { run } from './reference-demo-helpers.mjs';

const one = { point: 'effect.kept charge', n: 5, why: 'the fifth charge is kept' };

test('handoffsOf: a point, a reason, n and where; nothing else; effect.kept points only; a spec may hold kills at the same crossing', () => {
  assert.deepEqual(handoffsOf({ name: 'x', handoffs: [one] }), [one]);
  assert.deepEqual(handoffsOf({ name: 'x' }), []);
  // The entry runs one list: a spec with a kill and a handoff at one crossing is valid as written.
  assert.deepEqual(handoffsOf({ name: 'x', kills: [{ point: 'effect.kept charge', n: 5, why: 'k' }], handoffs: [one] }), [one]);
  assert.throws(() => handoffsOf({ name: 'x', handoffs: [{ ...one, kind: 'box' }] }), /a handoff has no kind/);
  assert.throws(() => handoffsOf({ name: 'x', handoffs: [{ ...one, hold: 2 }] }), /a handoff has no hold/);
  assert.throws(() => handoffsOf({ name: 'x', handoffs: [{ point: 'event workflow.node.start', why: 'w' }] }), /a handoff point starts with effect.kept /);
  assert.throws(() => handoffsOf({ name: 'x', handoffs: [{ point: 'effect.kept charge' }] }), /names a point and says why/);
  assert.throws(() => handoffsOf({ name: 'x', handoffs: [{ ...one, n: 0 }] }), /n is a positive integer/);
  assert.throws(() => handoffsOf({ name: 'x', handoffs: [{ ...one, where: {} }] }), /where is an object/);
});

test('releasedOutcome: only a failed outcome of a process that exited 0 after a landed handoff, with the run left sleeping or paused', () => {
  const failed = { status: 'failed', generation: 1 };
  assert.deepEqual(releasedOutcome(failed, 0, 'sleeping', true), { status: 'released', generation: 1 });
  assert.deepEqual(releasedOutcome(failed, 0, 'paused', true), { status: 'released', generation: 1 });
  assert.equal(releasedOutcome(failed, 0, 'sleeping', false), failed, 'no handoff landed');
  assert.equal(releasedOutcome(failed, 0, 'running', true), failed, 'the run was not left sealed');
  assert.equal(releasedOutcome(failed, 0, undefined, true), failed, 'the last run.json is unknown');
  assert.equal(releasedOutcome(failed, 1, 'sleeping', true), failed, 'the process did not exit 0');
  const complete = { status: 'complete', generation: 2 };
  assert.equal(releasedOutcome(complete, 0, 'sleeping', true), complete, 'a delivered run is never relabeled');
  assert.equal(releasedOutcome(undefined, 0, 'sleeping', true), undefined);
});

test('--kill and --handoff are different runs: both together are refused before anything starts', async (t) => {
  await assert.rejects(run(t, { kills: [{ point: 'effect.kept charge', why: 'k' }], handoffs: [one] }, ['--kill', '--handoff']), /--kill and --handoff are different runs/);
});

test('--handoff on a place that cannot report the run\'s status is refused at load, never reported as unlanded afterwards', async (t) => {
  await assert.rejects(run(t, { handoffs: [one] }, ['--handoff']), /cannot report the run's status/);
});
