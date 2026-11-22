// The actual pinned Codex resumes an approved host call from its journal. The model is a scripted fetch behind the
// local proxy: no provider credentials, external network or paid request. Native rollout ordering is part of the proof.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { NativeJournal } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { findCodex } from '../dist/binary.js';
import { verifyCodexBinary } from '../dist/verify.js';
import { CLASSIC_MODEL } from './offer.mjs';

const binary = verifyCodexBinary(findCodex());
const problem = binary instanceof Error ? binary.message : undefined;
const required = process.env.AGENTRUN_CODEX_REQUIRE_BINARY === '1';
const skip = problem && !required ? problem : false;
const MODELS = { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} };
const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
const sse = (n, items) => [
  { type: 'response.created', response: { id: `resp_${n}` } },
  ...items.map((item) => ({ type: 'response.output_item.done', item })),
  { type: 'response.completed', response: { id: `resp_${n}`, usage } },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

for (const priorInvalidOutput of [false, true]) test(priorInvalidOutput
  ? 'pinned Codex refuses an old mixed-ordinal journal before an approved effect can start'
  : 'pinned Codex resumes a parked host call with one ordered durable output and does not rerun it on the next attach', { skip, timeout: 90_000 }, async (t) => {
  assert.ok(!problem, problem);
  const dir = mkdtempSync(join(tmpdir(), 'agentrun-codex-resume-real-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const adapter = codexAdapter({
    model: CLASSIC_MODEL,
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    price: () => 0,
    sessionsDir: join(dir, 'sessions'),
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      const n = seen.length;
      const item = n === 1
        ? { type: 'function_call', name: 'lookup', arguments: '{"q":"x"}', call_id: 'call_1' }
        : { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'done' }] };
      return new Response(sse(n, [item]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const ran = [];
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'never', call: async (args) => { ran.push(args); return { text: 'found once' }; } };
  const spec = { key: 's1', label: 'root', system: [], tools: [lookup], context: 'fresh' };
  const store = memorySessionStore();
  const asked = [];
  let parked;
  const wasParked = new Promise((resolve) => { parked = resolve; });
  const first = new AbortController();
  const a = await adapter.open(spec, { writer: await store.open('s1'), models: MODELS, signal: first.signal, onEvent: () => {}, gate: async (call) => { asked.push(call); parked(); return { park: true }; } });
  t.after(() => a.close());
  await a.send('go');
  await wasParked;
  first.abort();
  await a.turnEnd().catch(() => undefined);
  await a.close();
  assert.equal(asked.length, 1);
  assert.deepEqual(ran, []);
  const starts = (records) => records.filter((record) => record.kind === 'kernel.start' && JSON.stringify(record.data).includes('tool.lookup'));
  assert.equal(starts(await store.read('s1')).length, 0, 'a parked call has no intent');
  if (priorInvalidOutput) {
    const drive = await openDrive({ writer: await store.open('s1'), signal: new AbortController().signal });
    const journal = new NativeJournal(drive);
    const thread = journal.records('codex.thread').at(-1).data;
    journal.append(`rollout:${thread.threadId}`, JSON.stringify({ timestamp: new Date(0).toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'older_settled_call', output: 'saved outcome' } }));
    await journal.flush();
  }
  const b = await adapter.open(spec, { writer: await store.open('s1'), models: MODELS, signal: new AbortController().signal, onEvent: () => {}, gate: async (call) => { asked.push(call); return 'allow'; } });
  t.after(() => b.close());
  assert.equal(b.state, 'open_turn');
  await b.recover();
  const resumed = await b.turnEnd();
  if (priorInvalidOutput) {
    assert.equal(resumed.status, 'failed');
    assert.match(JSON.stringify(resumed), /rollout.*ordinal/i);
    assert.deepEqual(ran, [], 'refuse unprovable ordering before dispatching an approved effect');
    assert.equal(asked.length, 1, 'do not ask the gate again on an unreadable journal');
    assert.equal(starts(await store.read('s1')).length, 0);
    assert.equal(seen.length, 1, 'no model continuation was dispatched');
    await b.close();
    return;
  }
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  await b.close();
  assert.deepEqual(ran, [{ q: 'x' }]);
  assert.deepEqual(asked.map((call) => call.callId), ['call_1', 'call_1']);
  assert.equal(starts(await store.read('s1')).length, 1);
  const supplied = seen.flatMap((body) => body.input ?? []).filter((item) => item.type === 'function_call_output' && item.call_id === 'call_1');
  assert.equal(supplied.length, 1, 'native resumed with the approved result');
  assert.equal(supplied[0].output, 'found once');

  // A later attach reads the already settled journal. It must not approve or dispatch that call again.
  const c = await adapter.open(spec, { writer: await store.open('s1'), models: MODELS, signal: new AbortController().signal, onEvent: () => {}, gate: async () => { assert.fail('settled call was offered again'); } });
  t.after(() => c.close());
  await c.send('continue');
  assert.equal((await c.turnEnd()).status, 'completed');
  await c.close();
  assert.deepEqual(ran, [{ q: 'x' }]);
  assert.equal(starts(await store.read('s1')).length, 1);
  const drive = await openDrive({ writer: await store.open('s1'), signal: new AbortController().signal });
  const journal = new NativeJournal(drive);
  const thread = journal.records('codex.thread').at(-1)?.data;
  assert.ok(thread);
  const lines = (await journal.read(`rollout:${thread.threadId}`)).map((record) => JSON.parse(record.data));
  assert.equal(lines[0].payload.cli_version, '0.164.0');
  assert.equal(lines.filter((line) => line.payload?.type === 'function_call_output' && line.payload.call_id === 'call_1').length, 1);
  assert.ok(lines.every((line, i) => Number.isSafeInteger(line.ordinal) && (i === 0 || line.ordinal > lines[i - 1].ordinal)), 'every native or settled row has ordered pagination metadata');
});
