// An engine-owned state key holds a `$`: `$host`, and a typed question's sidecars `<as>$answers` and `<as>$verify`. No node
// may declare a write to one: not by `as`, not by the label an unaliased generative or code node writes under, not by a
// collecting map's `failedAs`. A key that holds the `$` anywhere is refused, not only one that starts with it, so no node
// can overwrite the answers a judged question left for a code gate to read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorkflow } from '@parcha/agentrun-dsl';

const schemas = { Any: { type: 'object' }, Gate: { type: 'object', properties: { ok: { type: 'boolean', description: 'Does it hold?' } }, required: ['ok'] } };
const flow = (root) => ({ v: 2, name: 'keys', schemas, output: { schemaId: 'Any' }, root });
const chain = (...steps) => ({ node: 'chain', steps });
const judge = { node: 'judge', label: 'gate', state: { x: 'y' }, out: 'Gate', as: 'gate' };
// A valid result carries no issues.
const reserved = (workflow) => (validateWorkflow(workflow).issues ?? []).filter((issue) => issue.code === 'STATE_KEY_RESERVED').map((issue) => issue.path);

test('a declared write to a typed question\'s sidecar is refused, whether by as, by label or by failedAs', () => {
  const cases = {
    'an agent whose as is the judge\'s answers': [chain(judge, { node: 'agent', label: 'forge', instructions: 'Write it.', out: 'Any', as: 'gate$answers' }), '/root/steps/1'],
    'an extract whose as is a verify sidecar': [chain({ node: 'extract', label: 'draft', instructions: 'Copy it.', out: 'Any', as: 'draft$verify' }), '/root/steps/0'],
    'an unaliased code node labelled as the answers': [chain(judge, { node: 'code', label: 'gate$answers', code: 's => ({ ok: true })' }), '/root/steps/1'],
    'an unaliased agent labelled as the answers': [chain(judge, { node: 'agent', label: 'gate$answers', instructions: 'Write it.', out: 'Any' }), '/root/steps/1'],
    'a collecting map whose failedAs holds a $': [chain({ node: 'map', label: 'pages', itemsPath: 'rows', as: 'outs', onItemFailure: 'collect', failedAs: 'outs$failed', body: { node: 'code', label: 'read', code: 's => ({ ok: true })' } }), '/root/steps/0'],
    'a route whose as holds a $': [chain({ node: 'route', label: 'kind', valuePath: 'k', as: 'kind$answers', otherwise: 'a', branches: { a: { body: { node: 'code', label: 'a', code: 's => ({})' } }, b: { body: { node: 'code', label: 'b', code: 's => ({})' } } } }), '/root/steps/0'],
  };
  for (const [what, [root, path]] of Object.entries(cases)) {
    const result = validateWorkflow(flow(root));
    assert.equal(result.ok, false, what);
    assert.deepEqual(reserved(flow(root)), [path], what);
    assert.ok(result.errors.some((error) => /engine-owned|must not contain "\$"/.test(error)), `${what}: ${result.errors.join('; ')}`);
  }
});

test('a key that starts with $ stays refused, as before', () => {
  assert.deepEqual(reserved(flow(chain({ node: 'agent', label: 'a', instructions: 'Do it.', out: 'Any', as: '$x' }))), ['/root/steps/0']);
  assert.deepEqual(reserved(flow(chain({ node: 'code', label: '$x', code: 's => ({})' }))), ['/root/steps/0']);
});

test('reading a sidecar stays allowed, and a $ in a label that is only a name is not a write', () => {
  // A code gate reads the judge's answers: that is what the sidecar is for.
  const gated = flow(chain(judge, { node: 'code', label: 'threshold', code: 's => ({ pass: s["gate$answers"] !== undefined })', as: 'pass' }));
  assert.deepEqual(reserved(gated), []);
  const result = validateWorkflow(gated);
  assert.equal(result.ok, true, (result.errors ?? []).join('; '));
  // A node that writes under its as names itself with its label; a $ there writes nothing.
  const named = flow(chain({ ...judge, label: 'gate$check' }));
  assert.deepEqual(reserved(named), []);
});
