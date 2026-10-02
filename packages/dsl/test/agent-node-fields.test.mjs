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

test('the shipped schema bounds budget_usd as the validator does, above 0', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(await readFile(new URL('../schema/workflow.schema.json', import.meta.url), 'utf8'));
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.properties?.budget_usd) found.push(value.properties.budget_usd);
    Object.values(value).forEach(walk);
  };
  walk(schema);
  assert.ok(found.length > 0, 'the agent node schema names budget_usd');
  for (const property of found) assert.equal(property.exclusiveMinimum, 0);
});

test('an older document with budget still loads, and an author writing budget is told budget_usd', async () => {
  const { candidatePolicyErrors } = await import('../dist/index.js');
  const older = flow({ budget: 3 });
  assert.equal(validateWorkflow(older).ok, true, 'budget on an agent is accepted and ignored, as before');
  const errors = candidatePolicyErrors(older, {});
  assert.ok(errors.some((e) => /task: budget is not read; declare budget_usd/.test(e)), errors.join('\n'));
  assert.deepEqual(candidatePolicyErrors(flow({ budget_usd: 3 }), {}).filter((e) => /budget/.test(e)), []);
});
