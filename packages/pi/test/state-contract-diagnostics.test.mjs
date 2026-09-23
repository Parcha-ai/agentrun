import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowStateError, runWorkflow } from '@parcha/agentrun-dsl';
import { WorkflowExtensionService } from '../dist/extension-service.js';
import { formatRunReport } from '../dist/presentation.js';

// Fictional local fixtures only. No inference, source corpus, or external effects.
const secret = 'PRIVATE_STATE_VALUE_SENTINEL';
const base = root => ({ v: 2, name: 'fictional-state-contract', schemas: { Result: { type: 'object' } },
  output: { schemaId: 'Result' }, root });
const agent = { node: 'agent', label: 'consume', instructions: 'Fictional fixture.', tools: [], out: 'Result', as: 'result' };
async function run(root, input, deps = {}) {
  const service = new WorkflowExtensionService();
  try {
    service.preflight(base(root), input);
    service.prepare(base(root), { allowExecutableCandidates: true });
    return await service.run(input, { deps });
  } finally { await service.dispose(); }
}
const check = (report, reason, stage, path) => {
  assert.equal(report.status, 'failed');
  assert.equal(report.error.code, 'state_invalid');
  assert.equal(report.error.reason, reason);
  assert.equal(report.error.stage, stage);
  assert.equal(report.error.path, path);
  assert(formatRunReport(report).includes(`Step: ${stage}`));
  if (path !== undefined) assert(formatRunReport(report).includes(`State path: ${path}`));
  assert.doesNotMatch(JSON.stringify(report.error), new RegExp(secret));
};

test('missing and empty required evidence expose the exact authored path before agent construction', async () => {
  for (const payload of [{ present: secret }, { missing: [] }, { missing: '' }, { missing: null }]) {
    const report = await run({ ...agent, requires: ['payload.missing'] }, { payload }, {
      runNode: async () => { throw new Error('Must not dispatch'); },
    });
    check(report, 'required_nonempty', 'consume', 'payload.missing');
    assert.deepEqual(report.calls, { agent: 0, judge: 0, tool: 0 });
  }
});

test('required false and zero remain concrete evidence; diagnostic repair does not weaken or tighten requires', async () => {
  for (const value of [false, 0]) {
    const report = await run({ ...agent, requires: ['payload.value'] }, { payload: { value } }, { runNode: async () => ({ value }) });
    assert.equal(report.status, 'complete'); assert.equal(report.calls.agent, 1);
  }
});

test('nested whole-value and string interpolation failures preserve consuming stage without values', async () => {
  for (const value of ['{payload.missing}', 'prefix {payload.missing}', { nested: ['{payload.missing}'] }]) {
    const report = await run({ ...agent, state: { value } }, { payload: { present: secret } }, {
      runNode: async () => { throw new Error('Must not dispatch'); },
    });
    check(report, 'missing_interpolation', 'consume', 'payload.missing');
    assert.equal(report.calls.agent, 0);
  }
});

test('map requires a list and identifies a missing body resultPath without inferring content', async () => {
  const map = { node: 'map', label: 'records', itemsPath: 'items', as: 'rows', body: agent };
  check(await run(map, { items: secret }, { runNode: async () => ({}) }), 'expected_list', 'records', 'items');
  const missing = await run({ ...map, resultPath: 'result.missing' }, { items: [1] }, { runNode: async () => ({ present: secret }) });
  check(missing, 'missing_map_result', 'records', 'result.missing');
  assert.equal(missing.calls.agent, 1);
  const empty = await run(map, { items: [] }, { runNode: async () => ({}) });
  assert.equal(empty.status, 'complete'); assert.deepEqual(empty.output.rows, []);
});

test('parallel conflicting keys are diagnosed, while distinct keys retain ordinary merge semantics', async () => {
  const branch = (label, as, value) => ({ node: 'code', label, as, code: `() => (${value})` });
  const conflicting = { node: 'parallel', label: 'split', branches: [
    { node: 'code', label: 'left', code: '(s) => ({[s.key]:1})' },
    { node: 'code', label: 'right', code: '(s) => ({[s.key]:2})' },
  ] };
  const collision = await run(conflicting, { key: secret });
  check(collision, 'parallel_write_conflict', 'split', undefined);
  assert.doesNotMatch(formatRunReport(collision), new RegExp(secret));
  const fixed = { ...conflicting, branches: [branch('left', 'left', 1), branch('right', 'right', 2)] };
  const report = await run(fixed, {});
  assert.equal(report.status, 'complete'); assert.deepEqual(report.output, { left: 1, right: 2 });
});

test('SDK preserves typed state errors; arbitrary and duck-typed adapter exceptions stay opaque', async () => {
  await assert.rejects(runWorkflow(base({ ...agent, requires: ['payload.missing'] }), { payload: {} }, { runNode: async () => ({}) }), error => {
    assert(error instanceof WorkflowStateError); assert.equal(error.reason, 'required_nonempty'); return true;
  });
  for (const error of [new Error(secret), { name: 'WorkflowStateError', code: 'state_invalid', reason: 'missing_interpolation', message: secret }]) {
    const report = await run(agent, {}, { runNode: async () => { throw error; } });
    assert.equal(report.error.code, 'execution_failed'); assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  }
});

test('cancellation wins over a late state diagnostic and preserves the retained report', async () => {
  const service = new WorkflowExtensionService(); service.prepare(base(agent));
  let entered, reject;
  const ready = new Promise(resolve => { entered = resolve; });
  const running = service.run({}, { deps: { runNode: () => { entered(); return new Promise((_resolve, fail) => { reject = fail; }); } } });
  await ready; service.stop();
  const report = await running; const retained = service.inspect().lastReport;
  reject(new WorkflowStateError(secret, 'consume', 'payload.missing', 'missing_interpolation'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(report.status, 'interrupted'); assert.equal(report.error.code, 'cancelled');
  assert.deepEqual(service.inspect().lastReport, retained); await service.dispose();
});
