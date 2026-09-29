// An `agent` node's `budget_usd` and `context`: the validator admits them on `agent` only, refuses a value
// outside their range with the node's path and label, and the interpreter hands both to the host's
// `runNode` as `budgetUsd` and `context`. The host decides what they mean (its pot, its transcript).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow, validateWorkflow, AGENT_CONTEXTS, NODE_FIELDS } from '../dist/index.js';

const Out = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
const flow = (node) => ({ v: 2, name: 'agent-fields', schemas: { Out }, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [{ node: 'agent', label: 'task', instructions: 'Answer.', out: 'Out', as: 'final', ...node }] } });

test('the vocabulary names both fields on agent only', () => {
  assert.deepEqual([...AGENT_CONTEXTS], ['fresh', 'fork']);
  assert.ok(NODE_FIELDS.agent.includes('budget_usd') && NODE_FIELDS.agent.includes('context'));
  for (const kind of ['decide', 'extract', 'report']) assert.ok(!NODE_FIELDS[kind].includes('budget_usd') && !NODE_FIELDS[kind].includes('context'), kind);
});

test('the validator admits a positive budget_usd and a listed context, and refuses anything else with the node path', () => {
  assert.equal(validateWorkflow(flow({ budget_usd: 0.25, context: 'fork' })).ok, true);
  assert.equal(validateWorkflow(flow({ context: 'fresh' })).ok, true);
  const refusals = [
    [{ budget_usd: 0 }, /\(task\): budget_usd must be a number of dollars greater than 0/],
    [{ budget_usd: -1 }, /budget_usd must be a number of dollars greater than 0/],
    [{ budget_usd: '1' }, /budget_usd must be a number of dollars greater than 0/],
    [{ budget_usd: Infinity }, /budget_usd must be a number of dollars greater than 0/],
    [{ context: 'shared' }, /\(task\): context must be fresh\|fork/],
  ];
  for (const [fields, message] of refusals) {
    const result = validateWorkflow(flow(fields));
    assert.equal(result.ok, false, JSON.stringify(fields));
    assert.match(result.errors.join('\n'), message, JSON.stringify(fields));
  }
  const onDecide = validateWorkflow({ ...flow({}), root: { node: 'chain', steps: [{ node: 'decide', label: 'd', instructions: 'x', out: 'Out', as: 'final', budget_usd: 1 }] } });
  assert.equal(onDecide.ok, false, 'a decide node has no budget_usd');
});

test('the interpreter hands both to the host, and omits them when the node declares neither', async () => {
  const seen = [];
  const runNode = async (params) => { seen.push({ budgetUsd: params.budgetUsd, context: params.context, has: ['budgetUsd', 'context'].filter((k) => k in params) }); return { answer: 'ok' }; };
  assert.equal((await runWorkflow(flow({ budget_usd: 0.5, context: 'fork' }), { question: 'q' }, { runNode })).status, 'complete');
  assert.equal((await runWorkflow(flow({}), { question: 'q' }, { runNode })).status, 'complete');
  assert.deepEqual(seen[0], { budgetUsd: 0.5, context: 'fork', has: ['budgetUsd', 'context'] });
  assert.deepEqual(seen[1], { budgetUsd: undefined, context: undefined, has: [] });
});
