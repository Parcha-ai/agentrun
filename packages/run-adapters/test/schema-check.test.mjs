// toolSchemaProblems: what every harness adapter refuses in a tool's input schema before a session starts, by tool
// name and JSON pointer. The cases are SCHEMA_CHECK_CASES, which each adapter's own check() test runs too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolSchemaProblems } from '@parcha/agentrun-kernel';
import { SCHEMA_CHECK_CASES } from '@parcha/agentrun-kernel/testing';

/** The JSON pointers a problem list names (`<tool>: <pointer>: <why>`). */
const pointers = (tool, problems) => problems.map((p) => {
  assert.ok(p.startsWith(`${tool}: `), `the problem names the tool: ${p}`);
  return p.slice(tool.length + 2).split(': ')[0];
});

for (const c of SCHEMA_CHECK_CASES) {
  test(`${c.name}: ${c.refusedAt.length ? `refused at ${c.refusedAt.join(', ')}` : 'used as given'}`, () => {
    assert.deepEqual(pointers('lookup', toolSchemaProblems('lookup', c.schema)), c.refusedAt);
  });
}

test('a remote $ref says which ref it was, and a refused root says what it found', () => {
  assert.match(toolSchemaProblems('t', { type: 'object', properties: { r: { $ref: 'other.json#/x' } } })[0], /other\.json#\/x/);
  assert.match(toolSchemaProblems('t', { type: 'array' })[0], /"array"/);
});

test('every place a schema is invalid is named, once each', () => {
  const problems = toolSchemaProblems('t', { type: 'object', properties: { a: { type: 'strng' }, n: { type: 'number', minimum: 'x' } }, required: 'a' });
  assert.deepEqual(pointers('t', problems).sort(), ['/properties/a/type', '/properties/n/minimum', '/required']);
});

test('a schema that is not JSON (a cycle in its objects, a BigInt) is refused at once, and the check returns', () => {
  const cyclic = { type: 'object', properties: {} };
  cyclic.properties.child = cyclic;
  const [problem, ...rest] = toolSchemaProblems('loop', cyclic);
  assert.match(problem, /^loop: \/: the schema is not JSON \(.*circular/i);
  assert.deepEqual(rest, []);
  assert.match(toolSchemaProblems('big', { type: 'object', properties: { n: { type: 'integer', maximum: 10n } } })[0], /^big: \/: the schema is not JSON/);
});
