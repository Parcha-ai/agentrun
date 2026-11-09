// An answer the model cut at its output limit (stop_reason max_tokens), on the scripted Agent SDK (./testing): the Claude
// CLI recovers from it itself, asking again with its recovery note up to 3 times in the same turn. A turn whose answer
// was cut and then finished ends as any turn: its turn_end says no stop reason. A turn whose recovery is spent (its last
// answer still cut) ends completed, its turn_end saying stopReason "length" with the output tokens its result reports.
// No key, no network, no Claude Agent CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { facts } from '@parcha/agentrun-harness-claude/facts';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-cut-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

/** One turn whose "model" gives `answers` (each `{ text, cut? }`) in order, as the scripted SDK's `cut` command plays them. */
async function turnOf(t, answers) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const messages = [];
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ script: [`cut ${JSON.stringify(answers)}`], onMessage: (m) => messages.push(m) }),
  });
  const store = memorySessionStore();
  const events = [];
  const io = { writer: await store.open('s1'), models: { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} }, signal: new AbortController().signal, dir: scratch(), onEvent: (event) => events.push(event) };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, io);
  try {
    await session.send('go');
    const end = await session.turnEnd();
    return { end, events, records: await store.read('s1') };
  } finally {
    await session.close();
  }
}

test("its facts say the CLI recovers from a cut answer up to 3 times", () => {
  assert.equal(facts.recoversCutAnswers, 3);
});

test('a cut answer the CLI recovers from ends the turn as any: no stop reason, both answers said', async (t) => {
  const { end, events } = await turnOf(t, [{ text: 'Part of it', cut: true }, { text: 'done' }]);
  assert.equal(end.status, 'completed');
  assert.deepEqual(events.filter((event) => event.type === 'turn_end'), [{ type: 'turn_end', status: 'completed' }]);
  assert.equal(events.filter((event) => event.type === 'text').map((event) => event.delta).join(''), 'Part of itdone');
});

test('a turn whose recovery is spent ends completed, its turn_end saying stopReason "length" with the output tokens', async (t) => {
  const { end, events, records } = await turnOf(t, [{ text: 'The answer is', cut: true }]);
  assert.equal(end.status, 'completed');
  assert.deepEqual(events.filter((event) => event.type === 'turn_end'), [{ type: 'turn_end', status: 'completed', stopReason: 'length', outputTokens: 12 }]);
  assert.match(JSON.stringify(records), /"type":"turn","status":"completed","stopReason":"length","outputTokens":12/, "the turn's end in the session's records says it was cut");
});
