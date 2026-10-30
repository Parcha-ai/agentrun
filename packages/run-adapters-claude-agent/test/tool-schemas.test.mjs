// The host's tools as the model meets them on the pinned Claude Agent CLI, through the adapter and the real Agent SDK,
// with a scripted model behind the session's proxy: each tool's JSON Schema reaches the model as the host gave it,
// every key and value (the CLI puts some of the root's keys first); a description longer than the CLI's default cut reaches it whole; and the arguments the model sends,
// an open object's keys included, reach the host's tool as sent.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing or different one fails.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-schemas-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const MODEL = 'claude-sonnet-5-5';

// A schema with what a generated one carries: bounds, a pattern, a format, a nullable union, a $ref into $defs, an
// open object, and descriptions inside it. And one whose root is an open object only, as a tool described in
// TypeScript is given.
const RECORD = {
  type: 'object',
  description: 'One record.',
  properties: {
    id: { type: 'string', pattern: '^[a-z]+$', minLength: 1, maxLength: 12, description: 'Lower-case letters.' },
    score: { type: 'integer', minimum: 0, maximum: 4 },
    tags: { type: 'array', items: { type: 'string' }, uniqueItems: true, maxItems: 3 },
    when: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], default: null },
    owner: { $ref: '#/$defs/Owner' },
    value: { type: 'object', additionalProperties: true, description: 'Any keys at all.' },
  },
  required: ['id', 'value'],
  additionalProperties: false,
  $defs: { Owner: { type: 'object', title: 'Owner', properties: { name: { type: 'string' } }, required: ['name'] } },
};
const OPEN = { type: 'object', additionalProperties: true };
// Longer than the CLI's default cut (2048), with its end marked: a cut description loses the marker.
const LONG = `${'Write one record. '.repeat(1_700)}The last line: END-OF-DESCRIPTION.`;

// The CLI writes a tool's root as `{ type, properties, required, ...the rest }`: those keys first (when there), everything
// else in the host's order, every key and value the host's (measured over the public schema corpus on the pinned CLI).
// JSON Schema has no key order, so the bar is the host's schema after sorting keys at every depth: key order is the only
// thing this comparison forgives.
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

const RECORD_ARGS = { id: 'abc', score: 3, tags: ['x'], when: null, owner: { name: 'Zoë' }, value: { nested: { deep: [1, { x: null }] }, 'ünï': 'ç', empty: {} } };
const OPEN_ARGS = { anything: { a: 1, b: [true, 'two'] }, text: 'naïve — ok' };

test("the host's tool schemas reach the model with every key and value, a long description reaches it whole, and an open object's arguments reach the tool as sent", { skip, timeout: 240_000 }, async (t) => {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  const plan = [
    { tool: { name: 'mcp__hands__record', input: RECORD_ARGS } },
    { tool: { name: 'mcp__hands__open', input: OPEN_ARGS } },
    { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } },
  ];
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({ builtins: false, model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions') });
  const ran = { record: [], open: [] };
  const record = { name: 'record', description: LONG, inputSchema: RECORD, replay: 'safe', call: async (args) => { ran.record.push(args); return { text: 'kept' }; } };
  const open = { name: 'open', description: 'Take anything.', inputSchema: OPEN, replay: 'safe', call: async (args) => { ran.open.push(args); return { text: 'taken' }; } };
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [record, open], maxTurns: 20, timeoutMs: 200_000 });
  const output = await runNode({ kind: 'agent', label: 'schemas', system: ['Answer.'], user: 'Record it.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['record', 'open'] });

  assert.deepEqual(output, { answer: 'ok' });
  assert.deepEqual(ran.record, [RECORD_ARGS], "the record tool's arguments, as the model sent them");
  assert.deepEqual(ran.open, [OPEN_ARGS], "the open object's keys, as the model sent them");

  const requests = provider.requests.filter((r) => r.authorized && r.path === '/v1/messages' && r.model === MODEL);
  assert.ok(requests.length >= plan.length, `every main-model request (${requests.length})`);
  const wire = (requests[0]?.body.tools ?? []).find((x) => x.name === 'mcp__hands__record')?.input_schema ?? {};
  t.diagnostic(`the record tool's root on the wire: ${Object.keys(wire).join(', ')}; $defs ${JSON.stringify(wire.$defs)}`);
  for (const r of requests) {
    const offered = new Map((r.body.tools ?? []).map((x) => [x.name, x]));
    assert.equal(canonical(offered.get('mcp__hands__record')?.input_schema), canonical(RECORD), "the record tool's schema, every key and value the host's");
    assert.equal(JSON.stringify(offered.get('mcp__hands__open')?.input_schema), JSON.stringify(OPEN), "the open tool's schema, byte for byte");
    assert.equal(offered.get('mcp__hands__record')?.description, LONG, `the long description whole (${offered.get('mcp__hands__record')?.description?.length} of ${LONG.length} characters)`);
    assert.equal(offered.get('mcp__hands__open')?.description, 'Take anything.');
  }
  t.diagnostic(`main-model requests: ${requests.length}; description ${LONG.length} characters`);
});
