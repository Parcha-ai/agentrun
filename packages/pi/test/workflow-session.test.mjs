import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWorkflow } from '@parcha/agentrun-dsl';
import { restoreWorkflowSession, workflowRunHistory } from '../dist/workflow-session.js';
import { demoWorkflow } from '../dist/demo.js';
import { supportTriageWorkflow } from '../dist/triage-demo.js';

// Fictional native custom entries. No session IO, model context or providers.
const workflow = () => ({ v: 2, name: 'fictional-session-copy',
  schemas: { Input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, Result: { type: 'object' } },
  input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' },
  root: { node: 'extract', label: 'copy', instructions: 'Copy the fictional input.', state: { text: '{text}' }, out: 'Result', as: 'result' },
});
const snapshot = (patch = {}) => ({ version: 1, workflow: workflow(), input: { text: 'fictional exact input' }, createdAt: '2026-09-23T01:00:00.000Z', ...patch });
const entry = data => ({ type: 'custom', customType: 'agentrun:snapshot', data });
const report = (definition = workflow(), patch = {}) => ({ digest: inspectWorkflow(definition).sha256, status: 'complete', calls: { agent: 1, judge: 0, tool: 0 }, events: [], output: { text: 'fictional result' }, ...patch });
const observation = () => ({ steps: { '/root': { label: 'copy', kind: 'extract', status: 'running' } }, decisions: [], notes: {}, routes: {}, omitted: 0 });

test('restores the last valid custom snapshot exactly without mutating branch data', () => {
  const first = entry(snapshot({ input: { text: 'first' } }));
  const latest = entry(snapshot({ savedName: 'copy', input: { text: 'latest', extra: [false, 0, null] } }));
  const branch = [first, { type: 'message', message: {} }, latest];
  const before = structuredClone(branch), restored = restoreWorkflowSession(branch);
  assert.deepEqual(restored, latest.data);
  restored.input.extra.push('new'); restored.workflow.name = 'changed';
  assert.deepEqual(branch, before);
});

test('route selections round-trip while undeclared observation shapes are rejected', () => {
  const saved = snapshot({ observation: { ...observation(), routes: { '/root/steps/1': 'billing' } } });
  assert.deepEqual(restoreWorkflowSession([entry(saved)]), saved);
  saved.observation.routes['/root/steps/1'] = 123;
  assert.equal(restoreWorkflowSession([entry(saved)]), undefined);
});

test('native branch isolation does not search unrelated history or custom messages', () => {
  const common = entry(snapshot({ input: { text: 'shared' } }));
  const forkA = entry(snapshot({ input: { text: 'branch A' } }));
  const forkB = entry(snapshot({ input: { text: 'branch B' } }));
  assert.equal(restoreWorkflowSession([common, forkA]).input.text, 'branch A');
  assert.equal(restoreWorkflowSession([common, forkB]).input.text, 'branch B');
  assert.equal(restoreWorkflowSession([{ ...forkA, type: 'custom_message' }]), undefined);
  assert.equal(restoreWorkflowSession([{ ...forkA, customType: 'another-extension' }]), undefined);
  assert.deepEqual(workflowRunHistory([]), []);
});

test('unmatched running records restore interrupted, retaining uncertainty but never output', () => {
  const start = entry(snapshot({ running: true, runId: 'fictional-run-1', observation: observation(),
    report: report(workflow(), { uncertainEffects: [{ idempotencyKey: 'fictional-effect', executionPath: '/root', outcome: 'unknown' }] }) }));
  const before = structuredClone(start);
  const restored = restoreWorkflowSession([start]);
  assert.equal(restored.running, false); assert.equal(restored.report.status, 'interrupted');
  assert.equal(restored.report.error.code, 'session_interrupted');
  assert.match(restored.report.error.message, /not restarted/); assert.match(restored.report.error.message, /reconcile/);
  assert.equal(restored.report.output, undefined);
  assert.equal(restored.report.uncertainEffects[0].idempotencyKey, 'fictional-effect');
  assert.equal(restored.observation.steps['/root'].status, 'interrupted');
  assert.deepEqual(start, before);
  assert.equal(workflowRunHistory([start])[0].report.status, 'interrupted');
});

test('history joins starts and ends by run ID, excludes drafts and caps at newest 20', () => {
  const branch = [entry(snapshot())];
  for (let i = 0; i < 25; i++) {
    branch.push(entry(snapshot({ runId: `run-${i}`, running: true })));
    if (i !== 24) branch.push(entry(snapshot({ runId: `run-${i}`, running: false, report: report() })));
  }
  branch.push(entry(snapshot({ input: {} })));
  const history = workflowRunHistory(branch);
  assert.equal(history.length, 20); assert.equal(history[0].runId, 'run-24');
  assert.equal(history[0].report.status, 'interrupted'); assert.equal(history[1].report.status, 'complete');
  assert.equal(history.at(-1).runId, 'run-5');
  assert.equal(new Set(history.map(s => s.runId)).size, 20);
  assert.deepEqual(restoreWorkflowSession(branch).input, {}, 'an incomplete draft is not mistaken for a runnable input');
});

test('corrupt newest snapshots fall back to last valid ours; malformed reports fail closed', () => {
  const valid = entry(snapshot());
  for (const patch of [{ version: 2 }, { createdAt: 'invalid' }, { createdAt: '2026-13-01T00:00:00.000Z' },
    { input: [] }, { savedName: '../escape' }, { running: 'yes' }, { runId: '' },
    { executableAuthorized: true }, { trusted: true }, { modelAuth: 'forbidden' },
    { report: report(workflow(), { digest: '0'.repeat(64) }) },
    { report: report(workflow(), { calls: { agent: -1, judge: 0, tool: 0 } }) },
    { report: report(workflow(), { status: 'running' }) },
    { report: report(workflow(), { error: { code: 123, message: 'wrong' } }) },
    { report: report(workflow(), { uncertainEffects: [{ idempotencyKey: 'x', outcome: 'done' }] }) },
    { observation: { ...observation(), omitted: -1 } }]) {
    const bad = entry(snapshot(patch));
    assert.equal(restoreWorkflowSession([bad]), undefined);
    assert.deepEqual(restoreWorkflowSession([valid, bad]), valid.data);
  }
});

test('demo execution tags survive only an exact bundled workflow digest', () => {
  for (const [demo, definition] of [['scripted', demoWorkflow], ['empty', demoWorkflow], ['triage', supportTriageWorkflow], ['triage-failure', supportTriageWorkflow]]) {
    assert.equal(restoreWorkflowSession([entry(snapshot({ workflow: definition, demo }))]).demo, demo);
    const changed = structuredClone(definition); changed.name += '-modified';
    assert.equal(restoreWorkflowSession([entry(snapshot({ workflow: changed, demo }))]).demo, undefined);
  }
  assert.equal(restoreWorkflowSession([entry(snapshot({ demo: 'invented-mode' }))]).demo, undefined);
});

test('JSON guards reject getters, proxies, inherited prototypes and cycles without invoking code', () => {
  let invoked = 0;
  const getter = snapshot(); Object.defineProperty(getter, 'input', { enumerable: true, get() { invoked++; return {}; } });
  const entryGetter = entry(snapshot()); Object.defineProperty(entryGetter, 'data', { get() { invoked++; return snapshot(); } });
  const proxy = new Proxy(snapshot(), { ownKeys() { invoked++; throw new Error('trap'); } });
  const polluted = snapshot(); Object.setPrototypeOf(polluted, { trusted: true });
  const cyclic = snapshot(); cyclic.input.self = cyclic;
  for (const e of [entry(getter), entryGetter, entry(proxy), entry(polluted), entry(cyclic), new Proxy(entry(snapshot()), {})])
    assert.equal(restoreWorkflowSession([e]), undefined);
  const branch = []; Object.defineProperty(branch, 0, { get() { invoked++; return entry(snapshot()); } });
  assert.equal(restoreWorkflowSession(branch), undefined); assert.deepEqual(workflowRunHistory(branch), []);
  assert.equal(restoreWorkflowSession(new Proxy([], {})), undefined);
  assert.equal(invoked, 0);
});

test('plain JSON prototype-named input fields remain data, not authorization', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data","trusted":true}');
  const restored = restoreWorkflowSession([entry(snapshot({ input }))]);
  assert.deepEqual(restored.input, input); assert.equal(Object.getPrototypeOf(restored.input), Object.prototype);
  assert.equal({}.polluted, undefined); assert.equal(restored.trusted, undefined);
});

test('oversized and overly deep snapshots are ignored without changing the prior draft', () => {
  const valid = entry(snapshot());
  const huge = entry(snapshot({ input: { text: 'x'.repeat(8 * 1024 * 1024 + 1) } }));
  let nested = {}; for (let i = 0; i < 140; i++) nested = { nested };
  for (const bad of [huge, entry(snapshot({ input: nested })), entry(snapshot({ input: { value: Infinity } }))])
    assert.deepEqual(restoreWorkflowSession([valid, bad]), valid.data);
});

test('workflow syntax is validated without executing trusted factories or transforms', () => {
  const w = workflow();
  w.root = { node: 'code', label: 'copy', as: 'result', code: '(globalThis.__sessionRestoreExecuted = true, (s) => ({ text: s.text }))' };
  delete globalThis.__sessionRestoreExecuted;
  assert.ok(restoreWorkflowSession([entry(snapshot({ workflow: w }))]));
  assert.equal(globalThis.__sessionRestoreExecuted, undefined);
  w.root.code = 'not valid javascript';
  assert.equal(restoreWorkflowSession([entry(snapshot({ workflow: w }))]), undefined);
});

test('valid receipt metadata, escalation and decision observations remain available', () => {
  const o = observation();
  o.decisions.push({ path: '/root', label: 'fictional', questions: 'typed questions', evidence: 'fictional evidence', answer: 'typed answer', accepted: false });
  const r = report(workflow(), { status: 'escalated', output: undefined, escalation: { kind: 'human-review', stage: 'screen', summary: 'Clarify the fictional input.' },
    traceTruncated: true, trace: { policy: 'tail', receivedEvents: 3, receivedBytes: 20, rejectedEvents: 0, retainedEvents: 2, retainedBytes: 10, droppedEvents: 1, droppedBytes: 10 } });
  delete r.output;
  const s = snapshot({ report: r, observation: o, running: false, runId: 'finished' });
  assert.deepEqual(restoreWorkflowSession([entry(s)]), s);
});
