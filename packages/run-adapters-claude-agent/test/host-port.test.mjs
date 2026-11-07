// A claude-agent session's host port (AdapterSession.port): the session's one route for the host's own requests beside the
// CLI's, on a listener the session holds. It is up from the open, never handed to the CLI, closed with the session or when
// the host lets the session go (its signal), and a port asked for after that is refused, never started again.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeSdk } from '@parcha/agentrun-harness-claude/testing';

// The scripted SDK's "CLI" is a node child, a stand-in no pin is checked against (tests only).
process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';

const listening = (url) => new Promise((resolve) => {
  const { hostname, port } = new URL(url);
  const socket = connect({ host: hostname, port: Number(port) }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

for (const how of ['close', 'signal']) {
  test(`a claude-agent session's host port is up from its open, for side keys only, and gone once ${how === 'close' ? 'the session closes' : 'the host lets it go'}: a port asked for after is refused, never started again`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentrun-claude-host-'));
    const adapter = claudeAgentAdapter({ model: 'claude-test', provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' }, sessionsDir: join(dir, 'sessions'), standIn: { command: process.execPath }, sdk: fakeSdk() });
    const store = memorySessionStore();
    const spec = { key: 'run:r', label: 'r', system: [], tools: [], context: 'fresh' };
    const letGo = new AbortController();
    const session = await adapter.open(spec, { writer: await store.open(spec.key), models: { beforeRequest: async () => {}, afterRequest: async () => {} }, signal: letGo.signal, onEvent: () => {} });
    const port = session.port('learned_workflow');
    assert.deepEqual([typeof port?.url, port?.model, port?.api], ['string', 'claude-test', 'anthropic-messages'], JSON.stringify(port));
    assert.equal(await listening(port.url), true, 'up before any turn');
    if (how === 'close') await session.close();
    else letGo.abort(new Error('the run was cancelled'));
    for (let i = 0; i < 100 && (await listening(port.url)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await listening(port.url), false, 'no listener outlives its session');
    assert.equal(session.port('learned_workflow'), undefined, 'refused after, never started again');
    if (how === 'signal') await session.close();
  });
}
