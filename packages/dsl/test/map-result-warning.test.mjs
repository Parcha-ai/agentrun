// The validator's advice on a map whose items return their whole state: a warning, never a refusal.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorContract, validateWorkflow } from '@parcha/agentrun-dsl';

const SCHEMAS = {
  Input: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
  Out: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
};
const doc = (map) => ({
  v: 2, name: 'warned', schemas: SCHEMAS, input: { schemaId: 'Input' }, output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [map, { node: 'code', label: 'count', code: 's => ({ result: { count: s.found.length } })' }] },
});
const body = { node: 'chain', steps: [{ node: 'code', label: 'score', code: 's => ({ score: s.item_index })' }] };
const WARNING = 'map "each": each item\'s result is its whole state, including items; set resultPath (or an as in the body) for a large map';

test('a map with no resultPath whose body writes no as is valid, with a warning that names its list', () => {
  assert.deepEqual(validateWorkflow(doc({ node: 'map', label: 'each', itemsPath: 'items', as: 'found', body })), { ok: true, warnings: [WARNING] });
});

test('a map with a resultPath, or a body that writes an as, gets no warning', () => {
  assert.deepEqual(validateWorkflow(doc({ node: 'map', label: 'each', itemsPath: 'items', as: 'found', resultPath: 'score', body })), { ok: true });
  const scored = { node: 'code', label: 'score', code: 's => ({ score: s.item_index })', as: 'score' };
  assert.deepEqual(validateWorkflow(doc({ node: 'map', label: 'each', itemsPath: 'items', as: 'found', body: scored })), { ok: true });
});

test('a map nested in a map item is warned about too, and a refused document still gets its warnings', () => {
  const inner = { node: 'map', label: 'inner', itemsPath: 'item.parts', as: 'parts', body };
  const outer = { node: 'map', label: 'each', itemsPath: 'items', as: 'found', body: { node: 'chain', steps: [inner] } };
  assert.deepEqual(validateWorkflow(doc(outer)).warnings, [WARNING, 'map "inner": each item\'s result is its whole state, including item.parts; set resultPath (or an as in the body) for a large map']);
  const refused = validateWorkflow(doc({ node: 'map', label: 'each', itemsPath: 'items', as: 'found' }));
  assert.equal(refused.ok, false);
});

test('the author skill says it in one line', () => {
  assert.match(authorContract(), /each item's result is its whole state, the mapped list included: set `resultPath` \(or an `as` in the body\) for a large map; the validator warns\./);
});
