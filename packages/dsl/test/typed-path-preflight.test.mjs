import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflow, runWorkflow, inspectWorkflow, formatWorkflowTree } from '../dist/index.js';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
const number = { type: 'number' };
const graph = () => ({ v: 2, name: 'Fictional typed edges', schemas: {
  Tool: object({ content: { type: 'array', items: object({ text: { type: 'string' } }) }, details: object({ value: number }) }),
  Answer: object({ value: number }),
}, output: { schemaId: 'Answer', path: 'answer' }, root: { node: 'chain', steps: [
  { node: 'call', label: 'read-number', via: 'tool', tool: 'read_number', args: {}, out: 'Tool', as: 'read', deadline_s: 5 },
  { node: 'extract', label: 'answer', instructions: 'Return the supplied fictional value.', out: 'Answer', state: { value: '{read.details.value}' } },
] } });
const check = workflow => validateWorkflow(workflow, { executeCode: false, input: {} });

test('known closed tool envelope path fails inspection before any source or model work', async () => {
  const workflow = graph(); workflow.root.steps[1].state.value = '{read.value}';
  const checked = check(workflow);
  assert.equal(checked.ok, false); assert.match(checked.errors.join(' '), /read.value.*excluded by the upstream schema/);
  let called = 0;
  await assert.rejects(runWorkflow(workflow, {}, { runEffect: async () => { called++; }, runNode: async () => { called++; } }), /read.value/);
  assert.equal(called, 0);
});

test('correct envelope and implicit label binding execute unchanged', async () => {
  const workflow = graph(); assert.deepEqual(check(workflow), { ok: true });
  const result = await runWorkflow(workflow, {}, { runEffect: async () => ({ content: [], details: { value: 7 } }),
    runNode: async request => JSON.parse(request.user) });
  assert.deepEqual(result.output, { value: 7 });
});

test('closed nested requires, itemsPath and final output mistakes fail preflight', () => {
  for (const field of ['requires', 'itemsPath', 'output']) {
    const workflow = graph();
    if (field === 'requires') workflow.root.steps[1].requires = ['read.value'];
    if (field === 'itemsPath') workflow.root.steps[1] = { node: 'map', label: 'map', as: 'answer', itemsPath: 'read.rows', body: workflow.root.steps[1] };
    if (field === 'output') workflow.output.path = 'answer.answer';
    const result = check(workflow); assert.equal(result.ok, false, field); assert.match(result.errors.join(' '), /excluded by the upstream schema/);
  }
});

test('optional properties are not treated as impossible, and array element paths retain their shape', () => {
  const workflow = graph(); workflow.root.steps[1].state = { text: '{read.content.0.text}' };
  assert.deepEqual(check(workflow), { ok: true });
  workflow.root.steps[1].state.text = '{read.content.0.missing}';
  assert.equal(check(workflow).ok, false);
});

test('open, union and reference schemas stand down instead of inventing certainty', () => {
  for (const schema of [{ type: 'object' }, { anyOf: [object({ value: number }), object({ other: number })] },
    { $ref: '#/definitions/Answer' }, { type: 'object', additionalProperties: false, patternProperties: { '^val': number } }]) {
    const workflow = graph(); workflow.schemas.Tool = schema; workflow.root.steps[1].state.value = '{read.value}';
    assert.deepEqual(check(workflow), { ok: true });
  }
});

test('dynamic code stands down without executing factories; later typed overwrite replaces earlier shape', () => {
  const workflow = graph(); workflow.root.steps.splice(1, 0, { node: 'code', label: 'dynamic', code: '(() => { throw new Error("DO_NOT_RUN"); })()' });
  workflow.root.steps[2].state.value = '{read.value}'; assert.deepEqual(check(workflow), { ok: true });
  const overwritten = graph(); overwritten.root.steps.splice(1, 0, { node: 'extract', label: 'overwrite', out: 'Answer', as: 'read', instructions: 'Fictional.' });
  overwritten.root.steps[2].state.value = '{read.value}'; assert.deepEqual(check(overwritten), { ok: true });
});

test('inspection shows actual implicit binding and final selection, without changing its source hash', () => {
  const workflow = graph(), before = JSON.stringify(workflow), view = inspectWorkflow(workflow);
  assert.equal(view.nodes[2].writes, 'answer'); assert.equal(view.nodes[2].outputSchema, 'Answer');
  assert.equal(view.outputPath, 'answer');
  assert.match(formatWorkflowTree(view), /answer \[extract\] → answer \(Answer\)/);
  assert.match(formatWorkflowTree(view), /Final output: answer \(Answer\)/);
  assert.equal(JSON.stringify(workflow), before);
});
