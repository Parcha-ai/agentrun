// Parallel branches must write disjoint state keys, and an unaliased agent, decide or extract node writes under its label.
// Validation reads the keys a branch writes from `declaredWrites`, which counted `as` but not that label, so two branches
// writing the same label passed validation and then failed every run at the merge. Each refused case below is one the
// interpreter refuses at run time. A code node's patch keys are still unknown before it runs (Lean finding F2): the run
// is where that collision is caught.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaredWrites, runWorkflow, validateWorkflow } from '@parcha/agentrun-dsl';

const schemas = { Any: { type: 'object' } };
const flow = (root) => ({ v: 2, name: 'parallel-writes', schemas, output: { schemaId: 'Any' }, root });
const gen = (node, label, extra = {}) => ({ node, label, instructions: 'Do it.', out: 'Any', ...extra });
const code = (label, body) => ({ node: 'code', label, code: `s => (${body})` });
const parallel = (...branches) => ({ node: 'parallel', label: 'p', branches });
const conflicts = (workflow) => (validateWorkflow(workflow).issues ?? []).filter((issue) => issue.code === 'PARALLEL_WRITE_CONFLICT').map((issue) => issue.path);
const run = (workflow) => runWorkflow(workflow, {}, { runNode: async () => ({ ok: true }) }).then((result) => result.status, (error) => `${error.code}: ${error.reason ?? error.message}`);
// The run refuses such a collision either at the merge (before validation saw the label) or, once validation sees it, at
// the run's own validation before any branch runs.
const runRefuses = /^(state_invalid: parallel_write_conflict|workflow_invalid: .*both write state\.)/;

test('two branches that write the same label are refused at validation, as the run refuses them at the merge', async () => {
  const cases = {
    'two unaliased agents with one label': parallel(gen('agent', 'look'), gen('agent', 'look')),
    'an unaliased decide and an unaliased extract with one label': parallel(gen('decide', 'page'), gen('extract', 'page')),
    'an unaliased agent and an extract whose as is that label': parallel(gen('agent', 'page'), gen('extract', 'read', { as: 'page' })),
  };
  for (const [what, root] of Object.entries(cases)) {
    assert.match(await run(flow(root)), runRefuses, `${what}: the run refuses it`);
    assert.deepEqual(conflicts(flow(root)), ['/root'], `${what}: validation refuses it`);
  }
});

test('an unaliased agent, decide or extract declares its label as a write; an aliased one its as; an unaliased code node neither', () => {
  assert.deepEqual([...declaredWrites(gen('agent', 'look'))], ['look']);
  assert.deepEqual([...declaredWrites(gen('decide', 'pick'))], ['pick']);
  assert.deepEqual([...declaredWrites(gen('extract', 'take', { as: 'found' }))], ['found']);
  assert.deepEqual([...declaredWrites(code('patch', '{ k: 1 }'))], [], 'a code node\'s patch keys are known only once it runs');
});

test('branches that write different keys stay valid and run; code patches stay a run-time check, as finding F2 documents', async () => {
  const disjoint = flow(parallel(gen('agent', 'left'), gen('agent', 'right')));
  assert.deepEqual(conflicts(disjoint), []);
  assert.equal(await run(disjoint), 'complete');
  // F2: two unaliased code patches, and an unaliased agent beside a code patch, still validate; the merge refuses them.
  for (const root of [parallel(code('c1', '{ k: 1 }'), code('c2', '{ k: 2 }')), parallel(gen('agent', 'x'), code('c', '{ x: 1 }'))]) {
    assert.equal(validateWorkflow(flow(root)).ok, true);
    assert.equal(await run(flow(root)), 'state_invalid: parallel_write_conflict');
  }
});

test('a blank or whitespace-only write key is refused, and declaredWrites keys the way the interpreter writes (as || label)', () => {
  // The interpreter writes under `as || label` (mergeStageDelta), where `as` wins when it is any non-empty string,
  // whitespace included. declaredWrites must read the same key, and the validator must reject a blank one, or a
  // whitespace `as` (key " ") would hide a disjointness collision: it declared its label while it executed under " ".
  const blankAs = gen('agent', 'look', { as: ' ' });
  const blankAsEmpty = gen('agent', 'look', { as: '' });
  const blankLabel = gen('agent', ' ');
  for (const [what, node] of [['whitespace as', blankAs], ['empty as', blankAsEmpty], ['whitespace label (no as)', blankLabel]]) {
    const issues = (validateWorkflow(flow(node)).issues ?? []).map((i) => i.code);
    assert.ok(issues.includes('NODE_FIELD_INVALID'), `${what}: refused with NODE_FIELD_INVALID (got ${issues.join(',')})`);
  }
  // declaredWrites keys by `as || label`: a whitespace `as` is the key the interpreter uses, not the label.
  assert.deepEqual([...declaredWrites(gen('agent', 'look', { as: ' ' }))], [' '], 'the whitespace `as` is the key, as the interpreter writes it');
  assert.deepEqual([...declaredWrites(gen('agent', 'look'))], ['look'], 'no as: the label is the key');
  assert.deepEqual([...declaredWrites(gen('agent', 'look', { as: 'kept' }))], ['kept'], 'a real as is the key');
});
