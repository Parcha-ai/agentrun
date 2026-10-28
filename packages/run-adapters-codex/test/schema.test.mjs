// What Codex 0.164.0 does to a tool's schema (measured on the pinned binary, in test/fixtures/schema-column.json): it
// drops the keywords the adapter DESCRIBES in the tool's description, and drops or retypes the shapes the adapter REFUSES
// when the session is checked. Nothing else changes, so there is no silent difference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { codexAdapter } from '@parcha/agentrun-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';
import { codexSchemaProblems, describeDropped, describedDescription, DESCRIBED_HEADING, stripDescribed } from '../dist/schema.js';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const P = (inner) => ({ type: 'object', properties: { p: inner } });

test('each structural shape Codex drops or retypes is refused, by tool, JSON pointer and keyword', () => {
  const refused = {
    'tuple items': [P({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] }), '/properties/p/items', 'items (an array)'],
    prefixItems: [P({ type: 'array', prefixItems: [{ type: 'string' }] }), '/properties/p/prefixItems', 'prefixItems'],
    patternProperties: [P({ type: 'object', patternProperties: { '^a': { type: 'string' } } }), '/properties/p/patternProperties', 'patternProperties'],
    if: [P({ type: 'object', if: { properties: { a: { type: 'string' } } }, then: { required: ['b'] } }), '/properties/p/if', 'if/then/else'],
    then: [P({ type: 'object', then: { required: ['b'] } }), '/properties/p/then', 'if/then/else'],
    else: [P({ type: 'object', else: { required: ['b'] } }), '/properties/p/else', 'if/then/else'],
    not: [P({ not: { type: 'string' } }), '/properties/p/not', 'not'],
    'an object in enum': [P({ enum: ['a', { b: 1 }] }), '/properties/p/enum', 'enum with a non-scalar value'],
    'an array in enum': [P({ enum: [[1]] }), '/properties/p/enum', 'enum with a non-scalar value'],
    'an object const': [P({ const: { a: 1 } }), '/properties/p/const', 'enum with a non-scalar value'],
    'an enum of integers with no type': [P({ enum: [1, 2, 3] }), '/properties/p/enum', 'enum with non-string values and no type (Codex types it string)'],
    'a numeric const with no type': [P({ const: 5 }), '/properties/p/const', 'enum with non-string values and no type (Codex types it string)'],
    contains: [P({ type: 'array', items: { type: 'string' }, contains: { const: 'a' } }), '/properties/p/contains', 'contains'],
    dependentRequired: [{ type: 'object', properties: { a: { type: 'string' } }, dependentRequired: { a: ['b'] } }, '/dependentRequired', 'dependentRequired'],
    propertyNames: [P({ type: 'object', propertyNames: { pattern: '^a' } }), '/properties/p/propertyNames', 'propertyNames'],
    'items true': [P({ type: 'array', items: true }), '/properties/p/items', 'items (a boolean)'],
    'allOf with constraints in a member': [P({ allOf: [{ type: 'string' }, { minLength: 2 }] }), '/properties/p/allOf', 'allOf with constraints in its members'],
  };
  for (const [name, [schema, pointer, keyword]] of Object.entries(refused)) {
    assert.deepEqual(codexSchemaProblems('lookup', schema), [`lookup: ${pointer}: ${keyword} is not supported by Codex 0.164.0 (it drops or retypes it)`], name);
  }
});

test('every schema position is walked: $defs, union branches, items, additionalProperties, and the submit tool', () => {
  const where = {
    '$defs': { type: 'object', properties: { a: { $ref: '#/$defs/X' } }, $defs: { X: { not: {} } } },
    definitions: { definitions: { X: { if: {} } } },
    'an anyOf branch': P({ anyOf: [{ type: 'null' }, { not: {} }] }),
    'a oneOf branch': P({ oneOf: [{ type: 'string' }, { type: 'array', prefixItems: [] }] }),
    'an items schema': P({ type: 'array', items: { type: 'object', patternProperties: {} } }),
    additionalProperties: P({ type: 'object', additionalProperties: { not: {} } }),
    'a nested property': { type: 'object', properties: { a: { type: 'object', properties: { b: { enum: [{}] } } } } },
  };
  for (const [name, schema] of Object.entries(where)) assert.equal(codexSchemaProblems('t', schema).length, 1, name);
  // The submit tool's schema is a tool's like any other: a DSL output schema arrives through it.
  const envelope = { type: 'object', properties: { value: { type: 'object', properties: { x: { not: {} } } } }, required: ['value'] };
  assert.match(codexSchemaProblems('submit', envelope)[0], /^submit: \/properties\/value\/properties\/x\/not: not is not supported by Codex 0\.164\.0/);
});

test('shapes Codex carries are accepted, and a property NAMED like a keyword is not one', () => {
  const accepted = [
    P({ anyOf: [{ type: 'string' }, { type: 'null' }] }),
    P({ oneOf: [{ type: 'string' }, { type: 'number' }] }),
    P({ enum: ['a', 'b'] }),
    P({ type: 'integer', enum: [1, 2] }),
    P({ const: 'web' }),
    P({ type: ['string', 'null'] }),
    P({ type: 'array', items: { type: 'string' }, minItems: 1 }),
    P({ type: 'array', items: { type: 'string' } }),
    { type: 'object', properties: { not: { type: 'string' }, if: { type: 'string' }, items: { type: 'string' }, patternProperties: { type: 'string' }, prefixItems: { type: 'string' }, enum: { type: 'string' }, allOf: { type: 'string' } } },
    { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } } } },
    P({ allOf: [{ $ref: '#/$defs/A' }, { type: 'object' }] }),
    { type: 'object', additionalProperties: true },
  ];
  for (const schema of accepted) assert.deepEqual(codexSchemaProblems('t', schema), [], JSON.stringify(schema).slice(0, 80));
});

test("a stripped keyword is described in the tool's description, one line per pointer, sorted, under one fixed heading", () => {
  const schema = {
    type: 'object', title: 'Score card',
    properties: {
      value: { type: 'object', properties: { score: { type: 'integer', minimum: 0, maximum: 4 }, id: { type: 'string', pattern: '^[a-z]+$', minLength: 1, maxLength: 12 } } },
      tags: { type: 'array', items: { type: 'string', format: 'uri' }, minItems: 1, maxItems: 5, uniqueItems: true },
      ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.5, default: 0.5 },
      note: { type: 'string', nullable: true, deprecated: true },
      bag: { type: 'object', minProperties: 1, maxProperties: 2, properties: {} },
    },
  };
  assert.deepEqual(describeDropped(schema), [
    '(the whole value): object, titled "Score card"',
    'bag: object, at least 1 properties, at most 2 properties',
    'note: string, may be null, deprecated',
    'ratio: number, greater than 0, less than 1, a multiple of 0.5, default 0.5',
    'tags: array, at most 5 items, items are unique',
    'tags[]: string, format uri',
    'value.id: string, matches ^[a-z]+$, at least 1 characters, at most 12 characters',
    'value.score: integer, at least 0, at most 4',
  ]);
  const text = describedDescription('Look a thing up.', schema);
  assert.ok(text.startsWith(`Look a thing up.\n\n${DESCRIBED_HEADING}\n`), text);
  assert.ok(text.includes('\n- value.score: integer, at least 0, at most 4'));
  assert.equal(describedDescription('Plain.', P({ type: 'string' })), 'Plain.', 'nothing to describe: the description is the tool\'s own');
  assert.deepEqual(describedDescription('x', schema), describedDescription('x', JSON.parse(JSON.stringify(schema))), 'deterministic');
});

test('the adapter refuses a session whose tool Codex would mangle, before anything is paid, and still runs one it carries', async () => {
  const codex = codexAdapter({ model: 'luna-test', provider: { origin: 'https://provider.invalid', credential: () => 'k' }, sessionsDir: '/nonexistent', standIn: { command: process.execPath, args: ['-e', ''] } });
  const tool = (name, inputSchema) => ({ name, description: 'd', inputSchema, replay: 'safe', call: async () => ({ text: 'ok' }) });
  const spec = (tools) => ({ key: 'step:schema', label: 'x', system: [], tools, context: 'fresh' });
  assert.deepEqual(codex.check(spec([tool('good', P({ anyOf: [{ type: 'string' }, { type: 'null' }], minLength: 2 }))])), []);
  const problems = codex.check(spec([tool('bad', P({ not: {} })), tool('worse', P({ enum: [{}] }))]));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^bad: \/properties\/p\/not: not is not supported by Codex 0\.164\.0/);
  assert.match(problems[1], /^worse: \/properties\/p\/enum: enum with a non-scalar value/);
});

test('the recorded column: a schema the adapter does not refuse comes out of Codex as the original less exactly the described keywords', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/schema-column.json', import.meta.url), 'utf8')).rows;
  assert.ok(rows.length >= 29);
  const outcomes = { forwarded: 0, described: 0, refused: 0 };
  for (const row of rows) {
    const problems = codexSchemaProblems('probe', row.schema);
    if (problems.length) {
      outcomes.refused += 1;
      assert.ok(row.forwarded === null || JSON.stringify(row.forwarded) !== JSON.stringify(stripDescribed(row.schema)), `${row.hash}: refused, yet Codex carried it`);
      continue;
    }
    assert.notEqual(row.forwarded, null, `${row.hash}: Codex dropped a tool the adapter does not refuse`);
    assert.deepEqual(row.forwarded, stripDescribed(row.schema), `${row.hash} (${row.source}): Codex changed something the adapter neither refuses nor describes`);
    outcomes[describeDropped(row.schema).length ? 'described' : 'forwarded'] += 1;
  }
  assert.deepEqual(Object.values(outcomes).reduce((a, b) => a + b, 0), rows.length);
});

const problem = (() => { const b = verifyCodexBinary(findCodex()); return b instanceof Error ? b.message : undefined; })();
const skip = problem && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== '1' ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-schema-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test("on the pinned binary, the constraints Codex strips reach the model in the tool's description, and the schema it forwards is the original less exactly those", { skip, timeout: 60_000 }, async () => {
  const schema = { type: 'object', properties: { score: { type: 'integer', minimum: 0, maximum: 4, description: 'A score.' }, id: { type: 'string', pattern: '^[a-z]+$', minLength: 1 } }, required: ['score'] };
  const tool = { name: 'rate', description: 'Rate a thing.', inputSchema: schema, replay: 'safe', call: async () => ({ text: 'ok' }) };
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    const items = seen.length === 1 ? [{ type: 'function_call', name: 'rate', arguments: '{"score":3}', call_id: 'call_rate' }] : [{ type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'done' }] }];
    const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
    const events = [{ type: 'response.created', response: { id: 'r' } }, ...items.map((item) => ({ type: 'response.output_item.done', item })), { type: 'response.completed', response: { id: 'r', usage } }];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const codex = codexAdapter({ model: 'gpt-5.4-mini', provider: { origin: 'https://provider.invalid', credential: () => 'k' }, sessionsDir: join(ROOT, 'sessions'), fetch });
  const spec = { key: 'step:described', label: 'x', system: [], tools: [tool], context: 'fresh' };
  const store = memorySessionStore();
  const session = await codex.open(spec, { writer: await store.open(spec.key), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: AbortSignal.timeout(50_000), onEvent: () => {} });
  await session.send('go');
  assert.equal((await session.turnEnd()).status, 'completed');
  await session.close();
  const offered = seen[0].tools.find((t) => t.name === 'rate');
  assert.ok(offered.description.startsWith('Rate a thing.'), offered.description);
  for (const line of ['- id: string, matches ^[a-z]+$, at least 1 characters', '- score: integer, at least 0, at most 4']) assert.ok(offered.description.includes(line), `${line} in ${JSON.stringify(offered.description)}`);
  assert.deepEqual(offered.parameters, stripDescribed(schema), 'Codex forwarded the original less exactly the described keywords');
});
