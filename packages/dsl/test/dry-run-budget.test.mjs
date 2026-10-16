// A dry run is bounded. Synthetic answers that never end a loop stop at a step budget, a signal stops it, and it yields
// to the event loop as it goes, so a host takes a stop meanwhile. Each of these ends not run, never passed or failed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dryRunWorkflow } from '../dist/index.js';

const Done = { type: 'object', additionalProperties: false, required: ['done'], properties: { done: { type: 'boolean' } } };
/** A loop its synthetic answers never end: the agent says done: false every time, up to 200,000 times. */
const endless = (body = { node: 'agent', label: 'check', instructions: 'Check whether it is done.', out: 'Done', as: 'check' }) => ({
  v: 2, name: 'endless', schemas: { Done }, output: { schemaId: 'Done', path: 'check' },
  root: { node: 'loop', label: 'until-done', maxIters: 200_000, until: { predicate: 'field_true', path: 'check.done' }, body },
});
const notRun = (result, pattern) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.skipped?.some((reason) => pattern.test(reason)), JSON.stringify(result.skipped));
  if ('status' in result) assert.equal(result.status, 'not_run');
};

test('a loop its synthetic answers never end stops at the step budget, not run', async () => {
  notRun(await dryRunWorkflow(endless(), { maxSteps: 50 }), /stopped after 50 synthetic steps/);
});

test('without a budget given, the dry run stops at 10,000 synthetic steps', async () => {
  notRun(await dryRunWorkflow(endless()), /stopped after 10000 synthetic steps/);
});

test('a code node the host runs counts as a step', async () => {
  let ran = 0;
  const runCode = async () => { ran += 1; return { check: { done: false } }; };
  notRun(await dryRunWorkflow(endless({ node: 'code', label: 'tick', code: 's => ({ check: { done: false } })' }), { maxSteps: 30, runCode }), /stopped after 30 synthetic steps/);
  assert.equal(ran, 30);
});

test('a dry run yields as it goes, so a stop given meanwhile ends it, not run', async () => {
  const controller = new AbortController();
  let ticked = false;
  setTimeout(() => { ticked = true; controller.abort(); }, 0);
  const result = await dryRunWorkflow(endless(), { signal: controller.signal, maxSteps: 1_000_000 });
  assert.equal(ticked, true, 'a timer ran during the dry run');
  notRun(result, /was stopped before it finished/);
});

test('a signal already stopped runs nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  let ran = 0;
  notRun(await dryRunWorkflow(endless({ node: 'code', label: 'tick', code: 's => ({ check: { done: false } })' }), { signal: controller.signal, runCode: async () => { ran += 1; return {}; } }), /was stopped before it finished/);
  assert.equal(ran, 0);
});
