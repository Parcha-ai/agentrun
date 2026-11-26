// A model on the host's own machine (an Ollama model) sends nothing on its stream while it loads, reads its prompt or
// thinks (the route holds a thinking block to redact it whole), which on a slow machine passes the CLI's five-minute
// stream idle limit: the CLI then drops the streamed request and asks again without streaming. The host says so
// (`streamIdleMs`, LOCAL_STREAM_IDLE_MS) and the CLI waits its longest (CLAUDE_STREAM_IDLE_TIMEOUT_MS, 30 minutes). Any
// other route, a translated paid one (the host's `fetch`) included, keeps the CLI's own limit, so a hung stream holds the
// run's slot and cap no longer than that. On the scripted Agent SDK (./testing): no key, no network, no Claude Agent CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter, LOCAL_STREAM_IDLE_MS } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-idle-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const Out = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false };

/** The environment the CLI is started with, on a provider's own Messages or (`translated`) through the host's route,
 *  with the adapter's `streamIdleMs` if given. */
async function cliEnv(t, translated, streamIdleMs) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const seen = [];
  const sdk = fakeSdk({ remoteModel: true, mirrorLagMs: 10, script: ['call submit {"value":{"answer":"ok"}}'], onQuery: (options) => seen.push(options) });
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    price: () => 0,
    sessionsDir: join(scratch(), 'sessions'),
    standIn: { command: process.execPath },
    sdk,
    ...(translated ? { fetch: (url, init) => fetch(url, init) } : {}),
    ...(streamIdleMs ? { streamIdleMs } : {}),
  });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'q', system: ['Be brief.'], user: 'Go.', schema: Out, tools: [] }), { answer: 'ok' });
  return seen[0].env;
}

test("a local model's CLI waits 30 minutes on a silent stream before it gives the stream up", async (t) => {
  assert.equal(LOCAL_STREAM_IDLE_MS, 30 * 60_000);
  assert.equal((await cliEnv(t, true, LOCAL_STREAM_IDLE_MS)).CLAUDE_STREAM_IDLE_TIMEOUT_MS, '1800000');
});

test("a translated route the host does not call local (a paid one) keeps the CLI's own stream idle limit", async (t) => {
  assert.equal((await cliEnv(t, true)).CLAUDE_STREAM_IDLE_TIMEOUT_MS, undefined);
});

test("a provider's own Messages keeps the CLI's own stream idle limit", async (t) => {
  assert.equal((await cliEnv(t, false)).CLAUDE_STREAM_IDLE_TIMEOUT_MS, undefined);
});
