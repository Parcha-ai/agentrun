// The Claude Agent adapter's check(): what every harness refuses in a tool's input schema (SCHEMA_CHECK_CASES, the
// shared table), then what the pinned CLI was measured to drop. And on the pinned CLI, the reason the root check comes
// first: one tool whose root is not an object loses every tool of the session, the submit tool too, so a run with one
// is refused before it starts and makes no request at all.
//
// Without the pinned CLI the real-CLI test skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) it runs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-adapters';
import { memorySessionStore, SCHEMA_CHECK_CASES } from '@parcha/agentrun-adapters/testing';
import { claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-claude-agent';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-claude-agent/testing';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-check-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// The scripted SDK's "CLI" is a node child, a stand-in no pin is checked against (tests only): check() needs no CLI.
process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const adapter = claudeAgentAdapter({ sdk: fakeSdk(), standIn: { command: process.execPath }, model: 'claude-sonnet-5-5', provider: { origin: 'http://127.0.0.1:1', credential: () => 'x' }, sessionsDir: ROOT });
const spec = (inputSchema) => ({ key: 'k', label: 'l', system: [], context: 'fresh', tools: [{ name: 'lookup', description: 'Look.', inputSchema, replay: 'safe', call: async () => ({ text: '' }) }] });
const pointers = (problems) => problems.map((p) => (p.startsWith('lookup: ') ? p.slice('lookup: '.length).split(': ')[0] : `(not by tool) ${p}`));

for (const c of SCHEMA_CHECK_CASES) {
  test(`check(): ${c.name}: ${c.refusedAt.length ? `refused at ${c.refusedAt.join(', ')}` : 'used as given'}`, () => {
    assert.deepEqual(pointers(adapter.check(spec(c.schema))), c.refusedAt);
  });
}

// Measured on the pinned CLI: a root `{ type: 'object' }` with anyOf, allOf or oneOf never reaches the model, while the
// session's other tools do. A root with not, if/then, a $ref or an enum does.
for (const key of ['anyOf', 'allOf', 'oneOf']) {
  test(`check(): a root with ${key} is refused at /${key}, which the CLI would drop without a word`, () => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, [key]: [{ required: ['a'] }, { required: ['b'] }] };
    assert.deepEqual(pointers(adapter.check(spec(schema))), [`/${key}`]);
  });
}
test('check(): a root with not, if/then or an enum is used as given', () => {
  for (const extra of [{ not: { required: ['b'] } }, { if: { required: ['a'] }, then: { required: ['b'] } }, { enum: [{ a: 'x' }] }]) {
    assert.deepEqual(adapter.check(spec({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, ...extra })), [], JSON.stringify(extra));
  }
});

test('the pinned CLI: a run with one tool whose root is not an object is refused before it starts, naming the tool and "/", and makes no request', { skip, timeout: 120_000 }, async (t) => {
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === 'claude-sonnet-5-5' && main++ === 0 ? { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } } : { text: 'done' }) });
  t.after(() => provider.close());
  const real = claudeAgentAdapter({ model: 'claude-sonnet-5-5', provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: mkdtempSync(join(ROOT, 'run-')) });
  const good = { name: 'lookup', description: 'Look.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async () => ({ text: 'found' }) };
  const bad = { name: 'either', description: 'One of two.', inputSchema: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'string' } } }] }, replay: 'safe', call: async () => ({ text: 'ok' }) };
  const runNode = createHarnessRunner(real, { store: memorySessionStore(), tools: [good, bad], maxTurns: 6, timeoutMs: 100_000 });
  await assert.rejects(
    runNode({ kind: 'agent', label: 'bad-root', system: ['Answer.'], user: 'Say ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['lookup', 'either'] }),
    (error) => /either: \/: the root must be \{"type": "object"\}/.test(String(error?.message)),
    'refused by the tool and "/"',
  );
  assert.equal(provider.requests.filter((r) => r.authorized).length, 0, 'no model request was made');
});
