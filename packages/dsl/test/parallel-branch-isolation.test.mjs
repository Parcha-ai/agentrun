import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow } from '../dist/index.js';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const workflow = reversed => {
  const branches = [
    { node: 'extract', label: 'replace', instructions: 'Return the replacement.', out: 'Replacement', as: 'shared' },
    { node: 'extract', label: 'read-original', instructions: 'Return the original.', state: { value: '{shared.original}' }, out: 'Result', as: 'result' },
  ];
  return {
    v: 2, name: 'parallel-input-isolation',
    schemas: { Input: object({ shared: object({ original: { type: 'string' } }) }), Replacement: object({ replacement: { type: 'string' } }), Result: { type: 'string' } },
    input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' },
    root: { node: 'parallel', label: 'parallel', branches: reversed ? branches.reverse() : branches },
  };
};
const input = { shared: { original: 'hello' } };

test('a parallel branch reads the pre-branch state whatever order its siblings are written in', async () => {
  const finals = [];
  for (const reversed of [false, true]) {
    for (const executeCode of [false, true]) assert.deepEqual(validateWorkflow(workflow(reversed), { input, executeCode }), { ok: true }, `reversed=${reversed} executeCode=${executeCode}`);
    const seen = [];
    const result = await runWorkflow(workflow(reversed), input, { runNode: async request => {
      if (request.label === 'replace') return { replacement: 'bye' };
      seen.push(JSON.parse(request.user));
      return JSON.parse(request.user).value;
    } });
    assert.equal(result.status, 'complete');
    assert.deepEqual(seen, [{ value: 'hello' }], 'the reading branch saw the input value, not its sibling\'s write');
    finals.push(result.state);
  }
  assert.deepEqual(finals[0], finals[1], 'both orders reach the same final state');
  assert.deepEqual(finals[0], { shared: { replacement: 'bye' }, result: 'hello' });
});

test('a parallel branch still cannot read a key only its sibling writes, in either order', () => {
  for (const reversed of [false, true]) {
    const wf = workflow(reversed);
    for (const branch of wf.root.branches) if (branch.label === 'read-original') branch.state = { value: '{fresh}' };
    for (const branch of wf.root.branches) if (branch.label === 'replace') branch.as = 'fresh';
    const verdict = validateWorkflow(wf, { input });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some(error => /interpolates \{fresh\}/.test(error)), verdict.errors.join(' | '));
  }
});

test('knowledge from before a parallel node survives it, and shell files produced in a branch reach the terminal', () => {
  const wf = {
    v: 2, name: 'parallel-files', schemas: { R: { type: 'object' } }, output: { schemaId: 'R' },
    root: { node: 'chain', steps: [
      { node: 'parallel', label: 'p', branches: [
        { node: 'call', label: 'a', via: 'shell', command: 'true', as: 'a', deadline_s: 5, produces: ['a.txt'] },
        { node: 'call', label: 'b', via: 'shell', command: 'true', as: 'b', deadline_s: 5, produces: ['b.txt'] },
      ] },
      { node: 'artifact', label: 'deliver', type: 'text', path: 'a.txt' },
    ] },
  };
  assert.deepEqual(validateWorkflow(wf, { inputKeys: [] }), { ok: true });
  wf.root.steps[0].branches.reverse();
  assert.deepEqual(validateWorkflow(wf, { inputKeys: [] }), { ok: true });
});
