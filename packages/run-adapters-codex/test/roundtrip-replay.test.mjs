// A real round trip, replayed offline: the pinned Codex binary, through the adapter, answers a DSL agent node that calls
// the host's `lookup` tool and then submits. The provider is the three streams Codex 0.164.0 and gpt-5.4-mini exchanged
// through a Responses provider, recorded with their ids, paths and cache key replaced (test/fixtures/roundtrip-*). The
// adapter's requests must keep the recorded shape, and each request's usage must be booked as the stream reported it.
// No network.
//
// Without the binary this skips; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) a missing or different binary fails.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const required = env.AGENTRUN_CODEX_REQUIRE_BINARY === '1';
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-replay-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const RECORDED = [1, 2, 3].map((n) => ({ request: JSON.parse(fixture(`roundtrip-request-${n}.json`)), stream: fixture(`roundtrip-stream-${n}.sse`) }));
/** What a request's shape is: its keys, the tools it offers, and its input items' types in order. */
const shape = (body) => ({ keys: Object.keys(body).sort(), tools: body.tools.map((t) => `${t.type}:${t.name}`), input: body.input.map((item) => item.type ?? item.role) });

const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
const doc = { v: 2, name: 'codex-roundtrip', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'agent', label: 'task', instructions: 'Call the lookup tool once with the question "capital of France", then answer with the city it names.', out: 'Out', as: 'final', tools: ['lookup'] } };

test('a recorded lookup-then-submit round trip, replayed through the adapter: the same requests, the answer, and each usage booked', { skip, timeout: 180_000 }, async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    const recorded = RECORDED[sent.length - 1];
    assert.ok(recorded, `request ${sent.length} was not in the recording`);
    return new Response(recorded.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const calls = [];
  const lookup = { name: 'lookup', description: 'Look up a fact by its question.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, replay: 'safe', call: async (args) => { calls.push(args); return { text: 'The capital of France is Paris.' }; } };
  const events = [];
  const codex = codexAdapter({ model: 'gpt-5.4-mini', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: mkdtempSync(join(ROOT, 'sessions-')), fetch, price: (_model, u) => (u.input * 2 + u.cacheRead * 0.2 + u.output * 8) / 1e6 });
  const runNode = createHarnessRunner(codex, { store: memorySessionStore(), tools: [lookup], timeoutMs: 120_000, onEvent: (e) => events.push(e) });
  const result = await runWorkflow(doc, {}, { runNode });

  assert.deepEqual(result.output ?? result, { answer: 'Paris' });
  assert.deepEqual(calls, [{ q: 'capital of France' }]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_start').map((e) => e.name), ['lookup', 'submit']);
  assert.equal(sent.length, 3);
  sent.forEach((s, i) => {
    assert.equal(s.path, '/v1/responses');
    assert.deepEqual(shape(s.body), shape(RECORDED[i].request), `request ${i + 1} keeps the recorded shape`);
  });
  // The second request carries the lookup call and its output; the third, the submit too.
  assert.deepEqual(sent[1].body.input.filter((it) => it.type === 'function_call_output').map((it) => it.call_id), ['call_replay_1']);
  // The provider's cache served most of the later requests' input: booked apart, never charged as fresh input.
  const booked = events.filter((e) => e.type === 'request_end').map((e) => e.usage);
  assert.deepEqual(booked.map(({ input, output, cacheRead }) => ({ input, output, cacheRead })), [
    { input: 4299, output: 19, cacheRead: 0 },
    { input: 111, output: 19, cacheRead: 4224 },
    { input: 146, output: 5, cacheRead: 4224 },
  ]);
  for (const u of booked) assert.equal(typeof u.usd, 'number', 'each request is priced, none unknown');
});
