import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow } from '../packages/dsl/dist/index.js';
import { workflow } from './support-answer.mjs';
import { scenarios, createScriptedAdapters } from './support-answer-fixtures.mjs';

for (const name of Object.keys(scenarios)) {
  test(`${name}: the actual DSL calls only the required adapters, in order`, async () => {
    const fixture = scenarios[name];
    const { deps, calls, events } = createScriptedAdapters(name);
    assert.deepEqual(validateWorkflow(workflow, { input: fixture.input }), { ok: true });
    const result = await runWorkflow(workflow, fixture.input, deps);
    const investigated = name === 'payment' || name === 'unresolved';
    assert.deepEqual(calls.map(call => call.kind), investigated
      ? ['tool', 'judge', 'agent', 'judge'] : ['tool', 'judge']);
    assert.equal(events.filter(event => event.type === 'judge.answered').length, investigated ? 2 : 1);
    assert.equal(events.filter(event => event.type === 'effect.attempt').length, 1);
    assert.equal(result.status, name === 'unresolved' ? 'escalated' : 'complete');
    if (result.status === 'complete') assert.deepEqual(result.output, fixture.investigated ?? fixture.found);
    else {
      assert.equal(result.escalation.kind, 'support_review');
      assert.equal(result.output, undefined);
      assert.equal(result.state.needsReview, true);
    }
    if (investigated) {
      assert.deepEqual(calls.at(-1).input.answer, fixture.investigated, 'Jev rechecks the actual agent submission.');
      assert.equal(calls.filter(call => call.kind === 'agent').length, 1);
    }
  });
}

test('a low-confidence yes does not bypass investigation', async () => {
  const { deps, calls } = createScriptedAdapters('payment', { initial: ['yes', 0.6] });
  const result = await runWorkflow(workflow, scenarios.payment.input, deps);
  assert.equal(result.status, 'complete');
  assert.deepEqual(calls.map(call => call.kind), ['tool', 'judge', 'agent', 'judge']);
});

for (const recheck of [['yes', 0.79], ['no', 0.99], ['uncertain', 0.99]]) {
  test(`recheck ${recheck.join('/')}: escalate after one agent attempt`, async () => {
    const { deps, calls } = createScriptedAdapters('payment', { recheck });
    const result = await runWorkflow(workflow, scenarios.payment.input, deps);
    assert.equal(result.status, 'escalated');
    assert.equal(result.output, undefined);
    assert.equal(calls.filter(call => call.kind === 'agent').length, 1);
    assert.equal(calls.filter(call => call.kind === 'judge').length, 2);
  });
}

test('the confidence threshold includes 0.8', async () => {
  const { deps, calls } = createScriptedAdapters('password', { initial: ['yes', 0.8] });
  assert.equal((await runWorkflow(workflow, scenarios.password.input, deps)).status, 'complete');
  assert.equal(calls.filter(call => call.kind === 'agent').length, 0);
});

test('an invalid agent submission is rejected before recheck or returning an answer', async () => {
  const { deps, calls } = createScriptedAdapters('payment', { agentOutput: { text: 'A claim with no sources.' } });
  await assert.rejects(runWorkflow(workflow, scenarios.payment.input, deps), /submission does not satisfy schema "Answer"/);
  assert.deepEqual(calls.map(call => call.kind), ['tool', 'judge', 'agent']);
});

test('the scripted adapters fail for an unknown request instead of faking general reasoning', async () => {
  const { deps, calls } = createScriptedAdapters('password');
  await assert.rejects(runWorkflow(workflow, { request: 'A different request.' }, deps));
  assert.equal(calls.length, 0);
});

for (const found of [
  { text: '', sources: [] },
  { text: '   ', sources: ['help:empty'] },
  { text: 'An answer with no supporting source.', sources: [] },
]) {
  test(`incomplete lookup ${JSON.stringify(found)} requires one investigation even after a confident yes`, async () => {
    const { deps, calls } = createScriptedAdapters('payment', { found, initial: ['yes', 0.99] });
    const result = await runWorkflow(workflow, scenarios.payment.input, deps);
    assert.equal(result.status, 'complete');
    assert.deepEqual(calls.map(call => call.kind), ['tool', 'judge', 'agent', 'judge']);
    assert.deepEqual(calls.find(call => call.kind === 'agent').input.existingAnswer, found);
    assert.deepEqual(result.output, scenarios.payment.investigated);
    assert.deepEqual(calls.at(-1).input.answer, result.output);
  });
}

test('empty lookup that remains unresolved escalates without returning an answer', async () => {
  const { deps, calls } = createScriptedAdapters('unresolved', { found: { text: '', sources: [] } });
  const result = await runWorkflow(workflow, scenarios.unresolved.input, deps);
  assert.equal(result.status, 'escalated');
  assert.equal(result.output, undefined);
  assert.equal(result.escalation.kind, 'support_review');
  assert.deepEqual(calls.map(call => call.kind), ['tool', 'judge', 'agent', 'judge']);
});
