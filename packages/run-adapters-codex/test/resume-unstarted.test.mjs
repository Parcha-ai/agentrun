// A resumed Codex session settles a host call that never started before Codex starts on its thread: the call goes through
// the bridge under its own id (the host's gate, its intent, the run, its result), and its output is a line of the rollout
// Codex resumes from. The call ran once, after the park, and Codex never reads that it was not executed. On the stand-in
// app-server (fake-app-server.mjs) behind the session's real proxy. No key, no network, no Codex.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { NativeJournal } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-resume-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODELS = { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} };
/** The intents of the `lookup` tool's calls among a session's records. */
const lookupStarts = (records) => records.filter((record) => record.kind === 'kernel.start' && JSON.stringify(record.data).includes('tool.lookup'));
/** The rollout lines the session mirrored (its last thread's), parsed, as the next Codex would be resumed from them. */
async function rolloutOf(store, key) {
  const drive = await openDrive({ writer: await store.open(key), signal: new AbortController().signal });
  const journal = new NativeJournal(drive);
  const thread = journal.records('codex.thread').at(-1)?.data;
  return thread ? (await journal.read(`rollout:${thread.threadId}`)).map((record) => JSON.parse(record.data)) : [];
}

test('a call parked before its intent runs once on resume, under its own id, and Codex resumes with its output', async (t) => {
  const dir = mkdtempSync(join(ROOT, 'park-'));
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify(['call lookup {"q":"x"}']));
  const adapter = codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    price: () => 0,
    sessionsDir: join(dir, 'sessions'),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_SCRIPT: file } },
  });
  const ran = [];
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'never', call: async (args) => { ran.push(args); return { text: 'found' }; } };
  const spec = { key: 's1', label: 'root', system: [], tools: [lookup], context: 'fresh' };
  const store = memorySessionStore();

  // The first claim: the gate parks the call, and the run lets the session go.
  const asked = [];
  const first = new AbortController();
  let parked;
  const wasParked = new Promise((resolve) => (parked = resolve));
  const a = await adapter.open(spec, { writer: await store.open('s1'), models: MODELS, signal: first.signal, onEvent: () => {}, gate: async (call) => { asked.push(call); parked(); return { park: true }; } });
  t.after(() => a.close());
  await a.send('go');
  await wasParked;
  first.abort();
  await a.turnEnd().catch(() => undefined);
  await a.close();
  assert.equal(asked.length, 1);
  const callId = asked[0].callId;
  assert.deepEqual(ran, [], 'parked, it did not run');
  assert.deepEqual(lookupStarts(await store.read('s1')), [], 'parked, no intent');

  // The next claim: the gate allows it. The call runs before Codex starts, under its own id.
  const b = await adapter.open(spec, { writer: await store.open('s1'), models: MODELS, signal: new AbortController().signal, onEvent: () => {}, gate: async (call) => { asked.push(call); return 'allow'; } });
  t.after(() => b.close());
  assert.equal(b.state, 'open_turn');
  await b.recover();
  const end = await b.turnEnd();
  assert.equal(end.status, 'completed');
  assert.deepEqual(ran, [{ q: 'x' }], 'it ran once');
  assert.deepEqual(asked.map((call) => call.callId), [callId, callId], 'asked again under its own id');
  const records = await store.read('s1');
  assert.equal(lookupStarts(records).length, 1, 'one intent');
  await b.close();
  const outputs = (await rolloutOf(store, 's1')).filter((line) => line.payload?.type === 'function_call_output' && line.payload.call_id === callId);
  assert.deepEqual(outputs.map((line) => line.payload.output), ['found'], 'its output, once, in the rollout Codex resumed');
  assert.doesNotMatch(JSON.stringify(records), /Not executed/, 'Codex never read that it was not executed');
});
