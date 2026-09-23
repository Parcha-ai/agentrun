import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '@parcha/agentrun-dsl';
import {
  createSupportTriageWorkflow, supportTriageWorkflow, supportTriageInputs,
  supportTriageFailureFixture, supportTriageTools, scriptedSupportTriageDeps,
} from '../dist/triage-demo.js';

// Fictional fixed expectations: this suite tests execution, never model accuracy.
function observed(options) {
  const scripted = scriptedSupportTriageDeps(options);
  const calls = [];
  const events = [];
  const deps = { onEvent: event => events.push(event) };
  for (const name of ['runEffect', 'runJudge', 'runNode']) {
    deps[name] = async args => { calls.push({ name, args }); return scripted[name](args); };
  }
  return { calls, events, deps };
}

test('billing uses local evidence and a typed route, without an agent or account action', async () => {
  const { calls, events, deps } = observed();
  const result = await runWorkflow(supportTriageWorkflow, supportTriageInputs.billing, deps);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output, {
    draftOnly: true, ticketId: 'fictional-billing', queue: 'billing', evidenceIds: ['ledger-1'],
    summary: 'Review the supplied billing records; no refund or other account action has been taken.',
  });
  assert.deepEqual(calls.map(c => c.name), ['runEffect', 'runJudge', 'runEffect']);
  const judge = calls[1].args;
  assert.deepEqual(judge.state, supportTriageInputs.billing);
  assert.equal(judge.questions.branch.type, 'choice');
  assert.deepEqual(Object.keys(judge.questions.branch.criteria), ['billing', 'technical', 'unresolved']);
  assert.match(judge.questions.branch.criteria.billing, /does not prove a refund is due/);
  assert.match(judge.questions.branch.criteria.technical, /not an invented root cause/);
  assert.match(judge.questions.branch.criteria.unresolved, /insufficient or conflicting evidence/);
  const route = events.find(e => e.type === 'route.chosen');
  assert.deepEqual(route.detail.value, { branch: 'billing', taken: 'billing', unsure: false });
  assert.equal(route.detail.sidecar.confidence.branch, 0.95);
  assert.equal(route.detail.model, 'scripted-fictional-not-jev');
});

test('technical uses one evidence-only agent and preserves a draft, not a verified diagnosis', async () => {
  const { calls, deps } = observed();
  const result = await runWorkflow(supportTriageWorkflow, supportTriageInputs.technical, deps);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output, {
    draftOnly: true, ticketId: 'fictional-technical', queue: 'technical', evidenceIds: ['log-1'],
    summary: 'The supplied log records export error E42 after date-range selection. Root cause and a verified fix remain unknown.',
  });
  assert.deepEqual(calls.map(c => c.name), ['runEffect', 'runJudge', 'runNode', 'runEffect']);
  assert.deepEqual(calls[2].args.tools, []);
  assert.deepEqual(JSON.parse(calls[2].args.user), supportTriageInputs.technical);
});

test('ambiguous input ends unresolved, with neither a handoff nor an agent', async () => {
  const { calls, deps } = observed();
  const result = await runWorkflow(supportTriageWorkflow, supportTriageInputs.ambiguous, deps);
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalation.kind, 'human-review');
  assert.equal(result.escalation.stage, 'triage');
  assert.equal(result.state.result, undefined);
  assert.deepEqual(calls.map(c => c.name), ['runEffect', 'runJudge']);
});

test('explicit no-match remains unresolved even when the model is confident', async () => {
  const { calls, deps } = observed();
  deps.runJudge = async () => ({ answers: { branch: { type: 'choice', choice: 'unresolved', probabilities: { billing: 0, technical: 0, unresolved: 1 }, confidence: 1 } } });
  const result = await runWorkflow(supportTriageWorkflow, supportTriageInputs.ambiguous, deps);
  assert.equal(result.status, 'escalated');
  assert.equal(result.state.routing.unsure, false);
  assert.equal(result.state.routing.taken, 'unresolved');
  assert.equal(calls.filter(c => c.name === 'runEffect').length, 1);
});

test('a tool failure rejects; it is not converted into evidence, an answer, or a retry', async () => {
  const { calls, deps } = observed(supportTriageFailureFixture.options);
  await assert.rejects(runWorkflow(supportTriageWorkflow, supportTriageFailureFixture.input, deps), /local evidence lookup unavailable/);
  assert.deepEqual(calls.map(c => c.name), ['runEffect']);
});

test('a policy revision changes the route for identical evidence and scripted judgments', async () => {
  const original = structuredClone(supportTriageWorkflow);
  const strict = createSupportTriageWorkflow({ minimumConfidence: 0.95 });
  const baseline = await runWorkflow(supportTriageWorkflow, supportTriageInputs.technical, scriptedSupportTriageDeps());
  const revised = await runWorkflow(strict, supportTriageInputs.technical, scriptedSupportTriageDeps());
  assert.equal(baseline.status, 'complete');
  assert.equal(revised.status, 'escalated');
  assert.deepEqual(revised.state.routing, { branch: 'technical', taken: 'unresolved', unsure: true });
  assert.deepEqual(baseline.state['routing$answers'], revised.state['routing$answers']);
  assert.deepEqual(supportTriageWorkflow, original);
  assert.throws(() => createSupportTriageWorkflow({ minimumConfidence: NaN }), /between 0 and 1/);
});

test('exact local lookup excludes unrelated records and copies evidence', async () => {
  const [lookup, handoff] = supportTriageTools();
  const args = {
    ticketId: 'ticket-a', evidence: [
      { id: 'a', ticketId: 'ticket-a', text: 'Supplied evidence.' },
      { id: 'b', ticketId: 'ticket-b', text: 'Other fictional ticket.' },
    ],
  };
  const found = await lookup.execute('test', args);
  assert.deepEqual(found.details, { evidence: [{ id: 'a', ticketId: 'ticket-a', text: 'Supplied evidence.' }] });
  found.details.evidence[0].text = 'changed copy';
  assert.equal(args.evidence[0].text, 'Supplied evidence.');
  await assert.rejects(handoff.execute('test', { ...args, queue: 'billing', summary: 'Draft' }), /Invalid fictional handoff/);
  await assert.rejects(lookup.execute('test', { ...args, evidence: [args.evidence[0], args.evidence[0]] }), /must be unique/);
});

test('cancelled local tools do no work; scripted deps reject unsupported fixtures', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Stopped by user'));
  await assert.rejects(supportTriageTools()[0].execute('test', {}, controller.signal), /Stopped by user/);
  const input = { ticket: { id: 'not-a-fixture', text: 'A new ticket' }, evidence: [] };
  await assert.rejects(runWorkflow(supportTriageWorkflow, input, scriptedSupportTriageDeps()), /No scripted response/);
});
