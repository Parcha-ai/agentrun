// On a resume, a host-tool call the Claude transcript left dangling that never started (the host's gate parked it, so
// no intent of it is on the log) runs before the CLI starts again: the gate is asked once more under the id the model
// gave it, the call runs once, and its result is in the transcript the CLI loads, so the CLI never answers it
// "[Tool call interrupted]". A call that started (its intent is on the log) is never run again: the CLI's own repair
// answers it, as before. On the scripted Agent SDK (./testing) behind the session's real proxy: no key, no network, no
// Claude Agent CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';
import { danglingCalls } from '../dist/resume.js';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-resume-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const MODELS = { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} };
const lookupStarts = (records) => records.filter((record) => record.kind === 'kernel.start' && JSON.stringify(record.data).includes('tool.lookup'));
/** The Claude transcript's lines on the log (each journal batch's `claude` stream), as a resume loads them. */
const claudeLines = (records) =>
  records.flatMap((record) => (record.kind === 'kernel.start' && record.data?.name === 'journal' ? (record.data.input?.streams?.claude?.entries ?? []).map((entry) => entry.data) : []));
/** The transcript lines that answer `callId`. */
const answers = (records, callId) =>
  claudeLines(records).filter((line) => line?.type === 'user' && Array.isArray(line.message?.content) && line.message.content.some((c) => c?.tool_use_id === callId));

/** A session of the adapter over `store`, whose "model" calls `lookup` on "go" (and says the rest). */
async function openOn(t, store, { gate, lookup, signal }) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ mirrorLagMs: 10, script: (text) => (text === 'go' ? 'call lookup {"q":"x"}' : undefined) }),
  });
  const tool = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'never', call: lookup };
  const io = { writer: await store.open('s1'), models: MODELS, signal, dir: scratch(), onEvent: () => {}, gate };
  return adapter.open({ key: 's1', label: 'root', system: [], tools: [tool], context: 'fresh' }, io);
}

test('a call the gate parked runs on the resume, once, under its own id, and its result is in the transcript the CLI loads', async (t) => {
  const store = memorySessionStore();
  const ran = [];
  const lookup = async (args) => {
    ran.push(args);
    return { text: 'found it' };
  };
  // First claim: the gate parks the call, and the run's signal stops the session (as the runner does on a park).
  const parking = new AbortController();
  const asked = [];
  const first = await openOn(t, store, { signal: parking.signal, lookup, gate: async (call) => { asked.push(call.callId); setImmediate(() => parking.abort(new Error('parked'))); return { park: true }; } });
  await first.send('go');
  await first.turnEnd().catch(() => undefined);
  await first.close();
  assert.equal(asked.length, 1, 'asked once');
  assert.deepEqual(ran, [], 'held by the park');
  assert.deepEqual(lookupStarts(await store.read('s1')), [], 'nothing of the parked call written');

  // The resume: the person's answer is in, the gate allows.
  const second = await openOn(t, store, { signal: new AbortController().signal, lookup, gate: async (call) => { asked.push(call.callId); return 'allow'; } });
  try {
    assert.equal(second.state, 'open_turn', 'the cut-off turn is open');
    await second.recover();
    const end = await second.turnEnd();
    assert.equal(end.status, 'completed');
  } finally {
    await second.close();
  }
  const records = await store.read('s1');
  assert.deepEqual(asked, [asked[0], asked[0]], 'asked again under the id the model gave it');
  assert.deepEqual(ran, [{ q: 'x' }], 'ran once, on the resume');
  assert.equal(lookupStarts(records).length, 1, 'one intent');
  const lines = answers(records, asked[0]);
  assert.equal(lines.length, 1, 'one result line for the call in the transcript');
  assert.match(JSON.stringify(lines[0]), /found it/, 'its result, as the CLI loads it');
  assert.doesNotMatch(JSON.stringify(lines[0]), /Tool call interrupted/);
});

test('a call that started before the process died is never run again: the CLI answers it interrupted, as before', async (t) => {
  const store = memorySessionStore();
  const ran = [];
  // First claim: the call starts (its intent is written), and the claim is lost while it runs; it stops with its signal.
  const lost = new AbortController();
  const first = await openOn(t, store, {
    signal: lost.signal,
    gate: async () => 'allow',
    lookup: (args, context) => {
      ran.push(args);
      setImmediate(() => lost.abort(new Error('claim lost')));
      return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    },
  });
  await first.send('go');
  await first.turnEnd().catch(() => undefined);
  await first.close();
  assert.equal(ran.length, 1);
  const asked = [];
  const second = await openOn(t, store, {
    signal: new AbortController().signal,
    gate: async (call) => { asked.push(call.callId); return 'allow'; },
    lookup: async (args) => { ran.push(args); return { text: 'again' }; },
  });
  try {
    await second.recover();
    await second.turnEnd();
  } finally {
    await second.close();
  }
  assert.deepEqual(asked, [], 'no gate asked: the call is not taken up');
  assert.equal(ran.length, 1, 'never run again');
  const records = await store.read('s1');
  const callId = lookupStarts(records)[0]?.data?.key?.replace(/^tool:/, '');
  assert.ok(callId, 'its intent from the first claim');
  assert.match(JSON.stringify(answers(records, callId)), /Tool call interrupted/, "the CLI's own repair");
});

test("the dangling calls are the last turn's host-tool calls with no result, in the model's order", () => {
  const assistant = (uuid, ...blocks) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: blocks } });
  const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
  const result = (uuid, id) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const prompt = (uuid) => ({ type: 'user', uuid, message: { role: 'user', content: 'hello' } });
  const lines = [
    prompt('p1'),
    assistant('a1', use('old', 'mcp__hands__lookup')),
    prompt('p2'),
    assistant('a2', use('done', 'mcp__hands__lookup')),
    result('r2', 'done'),
    assistant('a3', use('b1', 'mcp__hands__lookup', { q: 1 }), use('builtin', 'Bash')),
    assistant('a4', use('b2', 'mcp__hands__peek', { q: 2 })),
    { type: 'queue-operation', operation: 'enqueue' },
  ];
  assert.deepEqual(danglingCalls(lines), [
    { callId: 'b1', tool: 'lookup', args: { q: 1 } },
    { callId: 'b2', tool: 'peek', args: { q: 2 } },
  ]);
  assert.deepEqual(danglingCalls([...lines, result('r3', 'b1'), result('r4', 'b2')]), []);
});
