import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowObservation, workflowView, progressLines, formatWorkflowView, readable } from '../dist/workflow-view.js';
import { runWorkflow, inspectWorkflow } from '@parcha/agentrun-dsl';
import { restoreWorkflowSession } from '../dist/workflow-session.js';
import { demoWorkflow, demoInput, scriptedDemoDeps } from '../dist/demo.js';
import { supportTriageWorkflow, supportTriageInputs, scriptedSupportTriageDeps } from '../dist/triage-demo.js';

test('observation distinguishes repeated paths, failure and escalation instead of finished count', () => {
  const observed = new WorkflowObservation();
  for (const [index, status] of ['ok', 'failed', 'escalated'].entries()) {
    observed.record({ type: 'node.start', label: 'same', executionPath: `/root/items/${index}/body`, detail: { kind: 'agent' } });
    observed.record({ type: 'node.end', label: 'same', executionPath: `/root/items/${index}/body`, detail: { kind: 'agent', status } });
  }
  assert.match(progressLines(observed.data)[0], /1 succeeded · 0 active · 1 failed · 1 need attention/);
});

test('restored unfinished runs and mixed repeated instances never become succeeded', () => {
  const workflow = { v: 2, name: 'Fictional interrupted map', schemas: { Result: { type: 'object' } }, output: { schemaId: 'Result' },
    root: { node: 'map', label: 'items', itemsPath: 'items', as: 'results', body: { node: 'agent', label: 'item', instructions: 'Use the fictional item.', out: 'Result' } } };
  const observation = { steps: {
    '/root/items/0/body': { label: 'item', kind: 'agent', status: 'succeeded' },
    '/root/items/1/body': { label: 'item', kind: 'agent', status: 'running' },
  }, notes: {}, decisions: [], omitted: 0 };
  const restored = restoreWorkflowSession([{ type: 'custom', customType: 'agentrun:snapshot', data: {
    version: 1, workflow, input: { items: [{}, {}] }, running: true, runId: 'crash-witness',
    createdAt: '2026-09-23T00:00:00.000Z', observation,
  } }]);
  assert.equal(restored.report.status, 'interrupted');
  const view = workflowView(restored.workflow, restored);
  assert.equal(view.nodes.find(node => node.path === '/root/body').status, 'interrupted');
  assert.equal(view.nodes[0].status, 'interrupted');
  assert.equal(inspectWorkflow(workflow).sha256, view.digest);
  observation.steps['/root/items/1/body'].status = 'unrecognized';
  const unknown = workflowView(workflow, { observation, report: restored.report });
  assert.equal(unknown.nodes.find(node => node.path === '/root/body').status, 'completion not observed');
});

test('actual decision context stays separate from interpreter acceptance', async () => {
  const observed = new WorkflowObservation();
  const deps = observed.observe({ runJudge: async () => ({ answers: { relevant: { type: 'noul', noul: .7 } } }) });
  const request = { label: 'gate', executionPath: '/root', kind: 'judge', state: { source: 'Fictional evidence' }, questions: { relevant: { type: 'noul', instructions: 'Does this support the claim?' } } };
  await deps.runJudge(request);
  assert.equal(observed.data.decisions[0].accepted, undefined);
  observed.record({ type: 'judge.answered', executionPath: '/root', label: 'gate' });
  assert.equal(observed.data.decisions[0].accepted, true);
  assert.match(observed.data.decisions[0].evidence, /Fictional evidence/);
  assert.match(observed.data.decisions[0].questions, /support the claim/);
});

test('observation limits are disclosure, never execution limits', async () => {
  const observed = new WorkflowObservation();
  let calls = 0;
  const deps = observed.observe({ runJudge: async () => { calls++; return { answers: {} }; } });
  for (let i = 0; i < 40; i++) await deps.runJudge({ label: 'gate', kind: 'judge', state: 'fictional', questions: {} });
  assert.equal(calls, 40);
  assert.equal(observed.data.decisions.length, 32);
  assert.equal(observed.data.omitted, 8);
});

test('view keeps revision identity and exposes bounds, required inputs and capabilities', () => {
  const view = workflowView(demoWorkflow, { availableTools: [], limits: { deadlineMs: null }, input: {} });
  assert.equal(view.status, 'draft');
  assert.equal(view.digest.length, 64);
  const text = formatWorkflowView(view);
  assert.match(text, /deadlineMs=disabled/);
  assert.match(text, /Unavailable.*search/);
  assert.match(text, /not resume/);
  assert(view.nodes.every(node => node.status === 'planned'));
});

test('loop bound is not presented as successful evidence completion', () => {
  const observed = new WorkflowObservation();
  observed.record({ type: 'loop.exited', label: 'research', executionPath: '/root', detail: { reason: 'bound_reached', iterations: 3 } });
  assert.match(observed.data.notes['/root'], /not proof of success/);
});

test('real scripted route maps execution paths and marks only genuinely unselected branches skipped', async () => {
  const observed = new WorkflowObservation();
  const report = await runWorkflow(supportTriageWorkflow, supportTriageInputs.billing,
    observed.observe({ ...scriptedSupportTriageDeps(), onEvent: event => observed.record(event) }));
  const view = workflowView(supportTriageWorkflow, { observation: observed.data, report, mode: 'scripted', model: 'unknown/unknown' });
  assert.equal(report.status, 'complete');
  assert.equal(view.nodes.find(node => node.label === 'draft-billing-handoff').status, 'succeeded');
  assert.equal(view.nodes.find(node => node.label === 'summarize-technical-evidence').status, 'skipped (branch not selected)');
  assert.equal(view.nodes.find(node => node.label === 'request-human-review').status, 'skipped (branch not selected)');
  assert.equal(observed.data.decisions[0].accepted, true);
  assert.match(view.nodes.find(node => node.kind === 'route').details.join('\n'), /does not prove a refund is due/);
  assert.equal(view.nodes.find(node => node.path === '/root').status, 'observed work succeeded');
  assert.doesNotMatch(view.summary.join('\n'), /Agent model/);
});

test('a fired escalation is visible as the selected stage, with its original event intact', async () => {
  const observed = new WorkflowObservation();
  const events = [];
  const report = await runWorkflow(supportTriageWorkflow, supportTriageInputs.ambiguous,
    observed.observe({ ...scriptedSupportTriageDeps(), onEvent: event => { events.push(event); observed.record(event); } }));
  const view = workflowView(supportTriageWorkflow, { observation: observed.data, report });
  assert.equal(report.status, 'escalated');
  assert.equal(view.nodes.find(node => node.label === 'request-human-review').status, 'needs attention');
  assert.equal(view.nodes.find(node => node.label === 'draft-billing-handoff').status, 'skipped (branch not selected)');
  assert.equal(events.find(event => event.type === 'escalate.evaluated').detail.fired, true);
  assert.match(view.summary.join('\n'), /1 need attention/);

  const notFired = new WorkflowObservation();
  notFired.record({ type: 'escalate.evaluated', label: 'request-human-review',
    executionPath: '/root/steps/1/branches/unresolved/body', detail: { fired: false } });
  const falseView = workflowView(supportTriageWorkflow, { observation: notFired.data, report: { status: 'complete' } });
  assert.equal(falseView.nodes.find(node => node.label === 'request-human-review').status, 'condition not met');
});

test('real nested research map attributes repeated executions and child schema rubrics', async () => {
  const observed = new WorkflowObservation();
  const report = await runWorkflow(demoWorkflow, demoInput,
    observed.observe({ ...scriptedDemoDeps(), onEvent: event => observed.record(event) }));
  assert.equal(report.status, 'complete');
  const view = workflowView(demoWorkflow, { observation: observed.data, report });
  const repeated = view.nodes.find(node => node.label === 'write-finding');
  assert.equal(repeated.status, 'succeeded');
  assert.match(repeated.summary, /observed executions succeeded/);
  assert.equal(view.nodes.find(node => node.kind === 'map').status, 'observed work succeeded');
  assert.ok(view.nodes.some(node => node.path.includes('/workflow/root')));
  for (const node of view.nodes.filter(node => node.path.includes('/workflow/root') && node.details.some(line => line.startsWith('Output schema:')))) {
    const index = node.details.findIndex(line => line.startsWith('Output schema:'));
    assert.match(node.details[index + 1], /"type"/);
  }
});

test('partial observation cannot imply a structural stage succeeded', async () => {
  const observed = new WorkflowObservation();
  const report = await runWorkflow(demoWorkflow, demoInput,
    observed.observe({ ...scriptedDemoDeps(), onEvent: event => observed.record(event) }));
  const partial = { ...observed.data, omitted: 1 };
  const view = workflowView(demoWorkflow, { observation: partial, report });
  assert.equal(view.nodes.find(node => node.path === '/root').status, 'completion not observed');
  assert.equal(view.nodes.find(node => node.kind === 'map').status, 'completion not observed');
  assert.equal(view.nodes.find(node => node.label === 'write-finding').status, 'succeeded');
  assert.match(view.summary.join('\n'), /Observation is partial/);

  const failed = structuredClone(partial);
  const path = Object.keys(failed.steps).find(path => path.includes('/body/'));
  assert.ok(path);
  failed.steps[path].status = 'failed';
  assert.equal(workflowView(demoWorkflow, { observation: failed, report }).nodes[0].status, 'failed');
});

test('ask answers require interpreter acceptance, not just a transport response', async () => {
  const observed = new WorkflowObservation();
  await observed.observe({ runJudge: async () => ({ answers: { enough: { type: 'noul', noul: .8 } } }) })
    .runJudge({ label: 'enough', executionPath: '/root/iterations/0', kind: 'ask', state: {}, questions: {} });
  assert.equal(observed.data.decisions[0].accepted, undefined);
  observed.record({ type: 'ask.evaluated', label: 'enough', executionPath: '/root/iterations/0', detail: { holds: true } });
  assert.equal(observed.data.decisions[0].accepted, true);
});

test('terminal cancellation projects stale running steps without rewriting raw evidence', () => {
  const observed = new WorkflowObservation();
  observed.record({ type: 'node.start', label: 'read-supplied-evidence', executionPath: '/root/steps/0', detail: { kind: 'call' } });
  const view = workflowView(supportTriageWorkflow, { observation: observed.data, report: { status: 'interrupted' } });
  assert.equal(view.nodes.find(node => node.path === '/root/steps/0').status, 'interrupted');
  assert.equal(observed.data.steps['/root/steps/0'].status, 'running');
  assert.match(view.summary.join('\n'), /0 active/);
  assert.match(view.summary.join('\n'), /1 interrupted/);
});

test('bounded observation never invokes getters, proxy traps or expands sparse giant arrays', async () => {
  let touched = 0;
  const value = { evidence: 'x'.repeat(100_000), get malicious() { touched++; throw new Error('not display data'); } };
  assert.match(readable(value, 100), /Display excerpt/);
  assert.match(readable({ get malicious() { touched++; throw new Error('no'); } }), /Accessor not read/);
  assert.match(readable(new Proxy({}, { ownKeys() { touched++; throw new Error('no'); } })), /Non-JSON/);
  assert.match(readable(new Array(2 ** 32 - 1), 100), /Display excerpt/);
  const observed = new WorkflowObservation(); let called = false;
  await observed.observe({ runJudge: async () => { called = true; return { answers: {} }; } })
    .runJudge({ label: 'fictional', state: value, questions: {}, kind: 'judge' });
  assert.equal(called, true); assert.equal(touched, 0);
  assert.equal(readable({ full: 'x'.repeat(30_000) }, Number.MAX_SAFE_INTEGER), JSON.stringify({ full: 'x'.repeat(30_000) }, null, 2));
});
