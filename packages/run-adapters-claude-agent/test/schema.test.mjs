// A host tool's input schema reaches the Claude Agent model through zod (the process layer's bridge), so a tool may use
// exactly what the bridge carries: anything else is refused when the session opens, naming the tool and where, never
// dropped. What is carried round-trips: the zod the bridge builds accepts an input that fits the schema and rejects one
// missing a required field. A schema's hash (for parity tables) is of its canonical JSON.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { canonicalJson, schemaHash } from '@parcha/agentrun-adapters';
import { zodFromJsonSchema } from '@parcha/agentrun-adapters/process';
import { claudeAgentAdapter, toolSchemaProblems } from '@parcha/agentrun-claude-agent';
import { fakeSdk } from '@parcha/agentrun-claude-agent/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';

/** Everything the bridge carries, in one schema, with an input that fits it. */
const CARRIED = {
  type: 'object',
  title: 'Search',
  description: 'Search the web.',
  properties: {
    query: { type: 'string', description: 'What to look for.', minLength: 1, maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    score: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.25 },
    code: { type: 'string', pattern: '^[A-Z]{2}$' },
    email: { type: 'string', format: 'email' },
    page: { type: 'string', format: 'uri' },
    at: { type: 'string', format: 'date-time' },
    depth: { enum: ['quick', 'deep'] },
    kind: { const: 'web' },
    since: { type: ['string', 'null'] },
    region: { type: 'string', nullable: true },
    sites: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
    filter: { anyOf: [{ type: 'string' }, { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'], additionalProperties: false }] },
    extra: { type: 'object', additionalProperties: { type: 'number' } },
    anything: {},
  },
  required: ['query', 'depth'],
  additionalProperties: false,
};
const FITS = { query: 'acme', limit: 5, score: 0.5, code: 'US', email: 'a@b.example', page: 'https://b.example/x', at: '2026-10-28T06:00:00Z', depth: 'deep', kind: 'web', since: null, region: null, sites: ['a.example'], filter: { domain: 'b.example' }, extra: { x: 1 }, anything: [1, 'two'] };

test('a schema of what the bridge carries passes, and round-trips: an input that fits is accepted, one missing a required field is not', () => {
  assert.deepEqual(toolSchemaProblems(CARRIED), []);
  const zod = zodFromJsonSchema(CARRIED, z);
  assert.equal(zod.safeParse(FITS).success, true, JSON.stringify(zod.safeParse(FITS).error?.issues));
  for (const field of CARRIED.required) {
    const { [field]: _, ...missing } = FITS;
    assert.equal(zod.safeParse(missing).success, false, `without ${field}`);
  }
  assert.equal(zod.safeParse({ ...FITS, stray: 1 }).success, false, 'additionalProperties: false holds');
  // Each carried keyword holds: an input that breaks it is rejected, and the schema the model is shown still says it.
  for (const [field, bad] of [['query', ''], ['limit', 51], ['score', 0], ['score', 0.3], ['code', 'usa'], ['email', 'not-an-email'], ['page', 'not a url'], ['at', 'yesterday'], ['sites', []], ['sites', ['a', 'b', 'c', 'd']]]) {
    assert.equal(zod.safeParse({ ...FITS, [field]: bad }).success, false, `${field}: ${JSON.stringify(bad)}`);
  }
  const shown = JSON.stringify(z.toJSONSchema(zod));
  for (const kept of ['"minLength":1', '"maximum":50', '"exclusiveMinimum":0', '"multipleOf":0.25', '"pattern":"^[A-Z]{2}$"', '"format":"email"', '"format":"uri"', '"format":"date-time"', '"minItems":1', '"maxItems":3']) assert.ok(shown.includes(kept), `the model is shown ${kept}: ${shown.slice(0, 300)}`);
});

test('what the bridge would drop is refused, each by name and place', () => {
  const at = (prop) => ({ type: 'object', properties: { p: prop } });
  for (const [prop, said] of [
    [{ type: 'string', format: 'hostname' }, /#\/properties\/p: the format "hostname" is not carried/],
    [{ format: 'email' }, /the keyword "format" is not carried to the model on this type/],
    [{ type: 'number', minLength: 1 }, /the keyword "minLength" is not carried to the model on this type/],
    [{ type: 'string', minimum: 0 }, /the keyword "minimum" is not carried to the model on this type/],
    [{ type: ['string', 'null'], pattern: '(' }, /"pattern" is not a regular expression/],
    [{ type: 'number', exclusiveMinimum: true }, /"exclusiveMinimum" must be a number/],
    [{ type: 'array', items: { type: 'string' }, uniqueItems: true }, /the keyword "uniqueItems"/],
    [{ $ref: '#/definitions/x' }, /the keyword "\$ref"/],
    [{ allOf: [{ type: 'string' }] }, /the keyword "allOf"/],
    [{ oneOf: [{ type: 'string' }, { type: 'number' }] }, /the keyword "oneOf"/],
    [{ type: 'string', default: 'x' }, /the keyword "default"/],
    [{ anyOf: [{ type: 'string' }] }, /"anyOf" needs at least two schemas/],
    [{ type: ['string', 'number'] }, /more than one non-null type/],
    [{ type: 'array', items: [{ type: 'string' }] }, /"items" as a list/],
    [{ enum: [{ a: 1 }] }, /"enum" must list strings/],
    [{ const: { a: 1 } }, /"const" must be/],
    [{ type: 'objekt' }, /unknown type/],
    [{ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, /"required" names "b"/],
    [{ type: 'object', patternProperties: { '^x': { type: 'string' } } }, /the keyword "patternProperties"/],
  ]) {
    const problems = toolSchemaProblems(at(prop));
    assert.ok(problems.some((p) => said.test(p)), `${JSON.stringify(prop)}: ${JSON.stringify(problems)}`);
  }
  assert.match(toolSchemaProblems({ type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { u: { type: 'string', format: 'hostname' } } } } } }).join(), /#\/properties\/list\/items\/properties\/u: the format "hostname"/, 'nested, with its path');
});

test("a session whose tool's schema uses what the bridge cannot carry is refused when it opens, naming the tool and where", async () => {
  const adapter = claudeAgentAdapter({ model: 'm', provider: { origin: 'https://x.invalid', credential: () => 'k' }, sdk: fakeSdk(), standIn: { command: process.execPath }, sessionsDir: '/nonexistent' });
  const fetchTool = { name: 'fetch_url', description: 'Fetch.', inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'hostname' } }, required: ['url'] }, replay: 'safe', call: async () => ({ text: '' }) };
  const spec = { key: 'step:s', label: 's', system: [], tools: [fetchTool], context: 'fresh' };
  assert.deepEqual(adapter.check(spec), ['the tool fetch_url\'s input schema: #/properties/url: the format "hostname" is not carried to the model']);
  await assert.rejects(adapter.open(spec, { signal: new AbortController().signal, onEvent: () => {} }), /the tool fetch_url's input schema: #\/properties\/url: the format "hostname"/);
  assert.deepEqual(adapter.check({ ...spec, tools: [{ ...fetchTool, inputSchema: CARRIED }] }), [], 'a carried schema passes');
});

test("a schema's hash is of its canonical JSON: the same for any key order, different for a different schema", () => {
  const a = { type: 'object', properties: { b: { type: 'string' }, a: { type: 'integer' } }, required: ['b'] };
  const b = { required: ['b'], properties: { a: { type: 'integer' }, b: { type: 'string' } }, type: 'object' };
  assert.equal(canonicalJson(a), '{"properties":{"a":{"type":"integer"},"b":{"type":"string"}},"required":["b"],"type":"object"}');
  assert.equal(schemaHash(a), schemaHash(b));
  // The sha256 of that canonical text, worked out apart from this code (printf '%s' <text> | sha256sum).
  assert.equal(schemaHash(a), '71edce2786d0a9256975ee01a45e5ad084c7d9e3e9b2d119193a2ad236878a3f');
  assert.notEqual(schemaHash(a), schemaHash({ ...a, required: ['a'] }));
  assert.notEqual(schemaHash({ enum: ['x', 'y'] }), schemaHash({ enum: ['y', 'x'] }), 'arrays keep their order');
});
