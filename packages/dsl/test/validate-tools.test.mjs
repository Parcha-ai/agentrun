import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow } from '../dist/index.js';

// validateWorkflow's opt-in `tools`: the host's tool names. Given, a node that names a tool outside them is refused at
// validation; absent, validation is what it was.

const schemas = { In: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, Out: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } };
const doc = (root) => ({ v: 2, name: 'tools-fixture', schemas, input: { schemaId: 'In' }, output: { schemaId: 'Out' }, root });
const model = (node, tools) => ({ node, label: node, instructions: 'Answer the question.', out: 'Out', as: node, tools });

/** One workflow per node kind that names tools, the tool named `search`, and the pointer of the node that names it. */
const KINDS = {
  agent: [doc(model('agent', ['search'])), '/root'],
  decide: [doc(model('decide', ['search'])), '/root'],
  extract: [doc(model('extract', ['search'])), '/root'],
  report: [doc({ node: 'chain', steps: [model('agent', []), { node: 'report', label: 'report', instructions: 'Write it up.', tools: ['search'] }] }), '/root/steps/1'],
  artifact: [doc({ node: 'chain', steps: [model('agent', []), { node: 'artifact', label: 'brief', type: 'markdown', instructions: 'Write the brief.', tools: ['search'] }] }), '/root/steps/1'],
  'call via tool': [doc({ node: 'call', label: 'look', via: 'tool', tool: 'search', args: { q: '{q}' }, out: 'Out', as: 'look', deadline_s: 5 }), '/root'],
  'child workflow': [doc({ node: 'workflow', label: 'inner', workflow: { v: 2, name: 'inner', schemas, input: { schemaId: 'In' }, output: { schemaId: 'Out' }, root: model('agent', ['search']) }, input: { q: '{q}' }, out: 'Out', as: 'inner' }), '/root/workflow/root'],
};

test('absent, the option changes nothing: workflows that name tools validate as they did', () => {
  for (const [kind, [workflow]] of Object.entries(KINDS)) {
    for (const executeCode of [undefined, false]) {
      const today = validateWorkflow(workflow, executeCode === undefined ? undefined : { executeCode });
      assert.deepEqual(today, { ok: true }, kind);
      assert.deepEqual(validateWorkflow(workflow, { ...(executeCode === undefined ? {} : { executeCode }), tools: undefined }), today, kind);
    }
  }
});

test('given, a tool outside the list is an error naming the node\'s path and the tool, for every kind that names tools', () => {
  for (const [kind, [workflow, pointer]] of Object.entries(KINDS)) {
    const result = validateWorkflow(workflow, { tools: ['fetch_page'] });
    assert.equal(result.ok, false, kind);
    assert.equal(result.issues.length, 1, `${kind}: ${result.errors.join('; ')}`);
    assert.equal(result.issues[0].code, 'NODE_FIELD_INVALID', kind);
    assert.equal(result.issues[0].path, pointer, kind);
    assert.match(result.issues[0].message, /tool "search" is not one of the host's tools/, kind);
    assert.equal(result.errors[0], result.issues[0].message);
  }
});

test('given, every tool in the list passes', () => {
  for (const [kind, [workflow]] of Object.entries(KINDS)) assert.deepEqual(validateWorkflow(workflow, { tools: ['fetch_page', 'search'] }), { ok: true }, kind);
});

test('given an empty list, a workflow that names no tool passes and one that names a tool does not', () => {
  assert.deepEqual(validateWorkflow(doc(model('agent', [])), { tools: [] }), { ok: true });
  assert.deepEqual(validateWorkflow(doc(model('agent', undefined)), { tools: [] }), { ok: true });
  assert.equal(validateWorkflow(KINDS.agent[0], { tools: [] }).ok, false);
});

test('given, each unlisted tool of a node is its own error', () => {
  const result = validateWorkflow(doc(model('agent', ['search', 'fetch_page', 'exec_command'])), { tools: ['fetch_page'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => [issue.path, issue.message.match(/tool "([^"]+)"/)[1]]), [['/root', 'search'], ['/root', 'exec_command']]);
});

test('given, a call node via shell or executor names no tool and is not affected', () => {
  const shell = doc({ node: 'call', label: 'run', via: 'shell', command: 'echo hi', out: 'Out', as: 'run', deadline_s: 5 });
  assert.deepEqual(validateWorkflow(shell, { tools: [] }), validateWorkflow(shell));
});
