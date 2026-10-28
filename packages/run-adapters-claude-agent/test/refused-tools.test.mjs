// A tool the session doesn't have, called by the model, on the pinned CLI: the CLI refuses it itself ("No such tool
// available"), before any hook or the session's tool server sees the call. The refusal is told to the model, kept in the
// session's store (the CLI's own transcript, mirrored), and shown to the host as a tool call that failed, by name.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) it runs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-adapters';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-claude-agent';
import { fakeAnthropic } from '@parcha/agentrun-claude-agent/testing';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-refused-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODEL = 'claude-sonnet-5-5';

test("a tool the session doesn't have is refused by the CLI, kept in the store, and shown to the host as a failed call by its name; the node still delivers", { skip, timeout: 120_000 }, async (t) => {
  // A prompt that names a browser tool the session lacks, another server's tool, and a built-in that is off.
  const plan = [
    { tool: { name: 'browser_navigate', input: { url: 'https://example.com' } } },
    { tool: { name: 'mcp__browser__navigate', input: { url: 'https://example.com' } } },
    { tool: { name: 'WebFetch', input: { url: 'https://example.com', prompt: 'x' } } },
    { tool: { name: 'mcp__hands__lookup', input: { q: 'x' } } },
    { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } },
  ];
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());
  const store = memorySessionStore();
  const events = [];
  const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(mkdtempSync(join(ROOT, 'run-')), 'sessions') });
  const lookup = { name: 'lookup', description: 'Look.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async () => ({ text: 'found' }) };
  const runNode = createHarnessRunner(adapter, { store, tools: [lookup], maxTurns: 20, timeoutMs: 100_000, onEvent: (e) => events.push(e) });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'refused', system: ['Answer.'], user: 'Go.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['lookup'] }), { answer: 'ok' });

  // Shown: each refused call is a tool call that failed, by its name, with the call id the model used.
  const ends = events.filter((e) => e.type === 'tool_end');
  for (const name of ['browser_navigate', 'mcp__browser__navigate', 'WebFetch']) {
    const start = events.find((e) => e.type === 'tool_start' && e.name === name);
    assert.ok(start, `${name} is shown as a call: ${JSON.stringify(events.filter((e) => e.type?.startsWith('tool_')).map((e) => [e.type, e.name]))}`);
    assert.ok(ends.some((e) => e.callId === start.callId && e.name === name && e.isError === true), `${name} is shown as failed`);
  }
  assert.ok(ends.some((e) => e.name === 'lookup' && e.isError === false), "the session's own tool still runs");
  // Kept: the CLI's refusal is in the session's store.
  const records = JSON.stringify(await Promise.all(store.keys().map((k) => store.read(k))));
  for (const name of ['browser_navigate', 'mcp__browser__navigate', 'WebFetch']) assert.ok(records.includes(`No such tool available: ${name}`), `${name}'s refusal is in the store`);
});
