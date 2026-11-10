// The Claude Agent adapter asks the host's gate (SessionIO.gate) about each host-tool call before the call is written or
// run, on the scripted Agent SDK (./testing) behind the session's real proxy. No key, no network, no Claude Agent CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-gate-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
/** The intents of the `lookup` tool's calls among a session's records. */
const lookupStarts = (records) => records.filter((record) => record.kind === 'kernel.start' && JSON.stringify(record.data).includes('tool.lookup'));

/** One turn of a session whose "model" calls `lookup` once, with `gate` as the host's gate. */
async function turnWithGate(t, gate) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ mirrorLagMs: 10, script: ['call lookup {"q":"x"}'] }),
  });
  const ran = [];
  const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'never', call: async (args) => { ran.push(args); return { text: 'found' }; } };
  const store = memorySessionStore();
  const events = [];
  // The gate is handed the session's records as they stand when it is asked.
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, dir: scratch(), onEvent: (event) => events.push(event), gate: async (call) => gate(call, await store.read('s1')) };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [lookup], context: 'fresh' }, io);
  try {
    await session.send('go');
    const end = await session.turnEnd();
    return { end, ran, events, records: await store.read('s1') };
  } finally {
    await session.close();
  }
}

test("a deny: the call never runs and nothing of it is written; the model reads the host's words", async (t) => {
  const asked = [];
  const { end, ran, events, records } = await turnWithGate(t, async (call) => {
    asked.push(call);
    return { deny: 'Permission denied: lookup is set to deny.' };
  });
  assert.equal(end.status, 'completed');
  assert.equal(asked.length, 1, 'asked once');
  assert.equal(asked[0].tool, 'lookup');
  assert.deepEqual(asked[0].args, { q: 'x' });
  assert.match(asked[0].callId, /^toolu_/, "the CLI's own id for the call");
  assert.deepEqual(ran, [], 'never ran');
  assert.deepEqual(lookupStarts(records), [], 'no intent');
  assert.equal(events.some((event) => event.type === 'tool_start'), false, 'the host saw no call start');
  // The scripted CLI quotes the result it was handed in its reply, which the session's transcript keeps.
  assert.match(JSON.stringify(records), /lookup returned: Permission denied: lookup is set to deny\./, "the model read the host's words");
});

test('allow: the call runs, after the gate saw it with no intent written yet', async (t) => {
  let intentsWhenAsked;
  const { ran, records } = await turnWithGate(t, async (_call, recordsNow) => {
    intentsWhenAsked = lookupStarts(recordsNow).length;
    return 'allow';
  });
  assert.equal(intentsWhenAsked, 0, 'asked before its intent');
  assert.deepEqual(ran, [{ q: 'x' }]);
  assert.equal(lookupStarts(records).length, 1, 'its intent, once allowed');
});
