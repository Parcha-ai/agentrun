import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow } from '../dist/index.js';

const code = () => ({ node: 'code', label: 'result', code: 's => ({ result: {} })' });
const workflow = root => ({ v: 2, name: 'guard', schemas: { Result: { type: 'object' } }, output: { schemaId: 'Result', path: 'result' }, root });
const call = () => ({ node: 'call', label: 'lookup', via: 'tool', tool: 'lookup', out: 'Result', as: 'result', deadline_s: 1 });

test('malformed discriminators and nested containers fail before any adapter dispatch', async () => {
  const cases = [
    [workflow({ node: { toString: null } }), 'root.node'],
    [workflow({ ...call(), deadline_s: { toString: null }, poll: { until: { predicate: 'empty', path: 'status' }, interval_s: 1, deadline_s: 2 } }), 'root.deadline_s'],
    [workflow({ ...call(), poll: { until: { predicate: { toString: null } }, interval_s: 1, deadline_s: 2 } }), 'root.poll.until.predicate'],
    [workflow({ node: 'escalate', label: 'stop', when: { predicate: { toString: null } } }), 'root.when.predicate'],
    [workflow({ node: 'chain', steps: [null] }), 'root.steps[0]'],
    [workflow({ node: 'map', body: { node: 'chain', steps: 'wrong' } }), 'root.body.steps'],
    [workflow({ node: 'route', branches: { bad: null } }), 'root.branches.bad'],
    [workflow({ node: 'workflow', workflow: { ...workflow(code()), schemas: null } }), 'root.workflow.schemas'],
    [workflow({ ...call(), retry: { attempts: 2, on: [{ toString: null }] } }), 'root.retry.on[0]'],
  ];
  for (const [candidate, field] of cases) {
    const result = validateWorkflow(candidate, { inputKeys: [] });
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some(error => error.includes(field)), JSON.stringify(result));
    let dispatches = 0;
    await assert.rejects(runWorkflow(candidate, {}, {
      runNode: async () => { dispatches++; return {}; },
      runEffect: async () => { dispatches++; return {}; },
      runJudge: async () => { dispatches++; return { answers: {} }; },
    }), { name: 'WorkflowInvalidError' });
    assert.equal(dispatches, 0, field);
  }
});

test('traversal guard retains numeric semantic diagnostics and leaves caller input unchanged', () => {
  for (const deadline_s of [undefined, NaN, Infinity, -1, 'soon']) {
    const candidate = workflow({ ...call(), poll: { until: { predicate: 'empty', path: 'status' }, interval_s: 1, deadline_s } });
    const before = structuredClone(candidate);
    const result = validateWorkflow(candidate);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /poll.deadline_s must be at least deadline_s and at most 7200/);
    assert.deepEqual(candidate, before);
  }
  const result = validateWorkflow(workflow({ ...call(), poll: 'soon' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /poll must be an object/);
});

test('unknown kinds and absent fields retain semantic diagnostics', () => {
  assert.match(validateWorkflow(workflow({ node: 'unrecognized' })).errors.join('\n'), /unknown node kind "unrecognized"/);
  assert.match(validateWorkflow(workflow({ node: 'chain' })).errors.join('\n'), /chain needs steps/);
  assert.match(validateWorkflow(workflow({ node: 'loop', label: 'repeat', body: code(), maxIters: 1 })).errors.join('\n'), /until: unknown predicate/);
});
