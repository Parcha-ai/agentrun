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
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';

import { boxedOptions, boxedSession, boxSkip } from './boxed.mjs';
const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-refused-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODEL = 'claude-sonnet-5-5';

test("a tool the session doesn't have is refused by the CLI, kept in the store, and shown to the host as a failed call by its name; the node still delivers", { skip: skip || boxSkip, timeout: 120_000 }, async (t) => {
  // A prompt that names a browser tool the session lacks, another server's tool, and a built-in that is off.
  const plan = [
    { tool: { name: 'browser_navigate', input: { url: 'https://example.com' } } },
    { tool: { name: 'mcp__browser__navigate', input: { url: 'https://example.com' } } },
    { tool: { name: 'WebFetch', input: { url: 'https://example.com', prompt: 'x' } } },
    { tool: { name: 'mcp__hands__lookup', input: { q: 'x' } } },
    // The session's own tool answering an error: a call that ran, shown once, never as one the CLI turned down.
    { tool: { name: 'mcp__hands__broken', input: {} } },
    { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } },
  ];
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());
  const store = memorySessionStore();
  const events = [];
  const logged = [];
  // The CLI's own tools off (they are on by default), so WebFetch is a built-in the session lacks.
  const sessionsDir = join(mkdtempSync(join(ROOT, 'run-')), 'sessions');
  const boxed = await boxedOptions(t, sessionsDir, undefined);
  const adapter = claudeAgentAdapter({ model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir, ...(boxed.box ? { box: boxed.box } : {}), log: (message, detail) => logged.push({ message, ...detail }), builtins: false });
  const lookup = { name: 'lookup', description: 'Look.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async () => ({ text: 'found' }) };
  const broken = { name: 'broken', description: 'Fails.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'the backend is down', isError: true }) };
  const runNode = createHarnessRunner(adapter, { ...boxed.runner, store, tools: [lookup, broken], maxTurns: 20, timeoutMs: 100_000, onEvent: (e) => events.push(e) });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'refused', system: ['Answer.'], user: 'Go.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['lookup', 'broken'] }), { answer: 'ok' });

  // Shown: each refused call is a tool call that failed, by its name, with the call id the model used.
  const ends = events.filter((e) => e.type === 'tool_end');
  for (const name of ['browser_navigate', 'mcp__browser__navigate', 'WebFetch']) {
    const start = events.find((e) => e.type === 'tool_start' && e.name === name);
    assert.ok(start, `${name} is shown as a call: ${JSON.stringify(events.filter((e) => e.type?.startsWith('tool_')).map((e) => [e.type, e.name]))}`);
    assert.ok(ends.some((e) => e.callId === start.callId && e.name === name && e.isError === true), `${name} is shown as failed`);
  }
  assert.ok(ends.some((e) => e.name === 'lookup' && e.isError === false), "the session's own tool still runs");
  // The model's input is on the refused call's start, as it gave it.
  assert.deepEqual(events.find((e) => e.type === 'tool_start' && e.name === 'browser_navigate')?.args, { url: 'https://example.com' });
  // A session tool that answered an error ran: one start and one failed end, never also a turned-down call.
  assert.deepEqual(events.filter((e) => e.name === 'broken').map((e) => [e.type, e.isError]), [['tool_start', undefined], ['tool_end', true]]);
  // One log line per turned-down call, naming the tool and the CLI's reason; none for the tool that ran and failed.
  const turnedDown = logged.filter((l) => /turned down a call/.test(l.message));
  assert.deepEqual(turnedDown.map((l) => l.name), ['browser_navigate', 'mcp__browser__navigate', 'WebFetch']);
  for (const l of turnedDown) assert.match(l.reason, new RegExp(`No such tool available: ${l.name.replace(/[$^.*+?()[\]{}|\\]/g, '\\$&')}`));
  // Kept: the CLI's refusal is in the session's store.
  const records = JSON.stringify(await Promise.all(store.keys().map((k) => store.read(k))));
  for (const name of ['browser_navigate', 'mcp__browser__navigate', 'WebFetch']) assert.ok(records.includes(`No such tool available: ${name}`), `${name}'s refusal is in the store`);
});

test("a session tool's own error is heard once, whatever its text: a call the session's tool server ran is never one the CLI turned down", { skip, timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: { name: 'mcp__hands__plain', input: {} } },
    // An error whose text looks like the CLI's own refusal: the call still ran, so it is the tool's answer.
    { tool: { name: 'mcp__hands__tagged', input: {} } },
    { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } },
  ];
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());
  const events = [];
  const logged = [];
  const adapter = claudeAgentAdapter({ builtins: false, model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir: join(mkdtempSync(join(ROOT, 'run-')), 'sessions'), log: (message, detail) => logged.push({ message, ...detail }) });
  const plain = { name: 'plain', description: 'Fails.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'the backend is down', isError: true }) };
  const tagged = { name: 'tagged', description: 'Fails.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: '<tool_use_error>x</tool_use_error>', isError: true }) };
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [plain, tagged], maxTurns: 20, timeoutMs: 100_000, onEvent: (e) => events.push(e) });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'own-errors', system: ['Answer.'], user: 'Go.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: ['plain', 'tagged'] }), { answer: 'ok' });

  for (const name of ['plain', 'tagged']) {
    const mine = events.filter((e) => (e.type === 'tool_start' || e.type === 'tool_end') && e.name === name);
    const ids = [...new Set(mine.map((e) => e.callId))];
    assert.equal(ids.length, 1, `${name} is one call: ${JSON.stringify(mine)}`);
    assert.deepEqual(mine.map((e) => [e.type, e.isError]), [['tool_start', undefined], ['tool_end', true]], `${name} is heard once, as failed`);
  }
  assert.deepEqual(logged.filter((l) => /turned down a call/.test(l.message)), [], 'no call that ran is logged as turned down');
});

test("a refusal the CLI made reaches the host only once the session's store holds it", { skip: skip || boxSkip, timeout: 120_000 }, async (t) => {
  const plan = [
    { tool: { name: 'browser_navigate', input: { url: 'https://example.com' } } },
    { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } },
  ];
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());
  // The store's writer is held on the batch that carries the refusal, and let go a while later, by the test.
  const inner = memorySessionStore();
  const order = [];
  let held = false;
  const store = {
    ...inner,
    async open(key) {
      const handle = await inner.open(key);
      return {
        ...handle,
        async append(records) {
          if (!held && JSON.stringify(records).includes('No such tool available: browser_navigate')) {
            held = true;
            order.push('held');
            await new Promise((resolve) => setTimeout(resolve, 1500));
            order.push('released');
          }
          return handle.append(records);
        },
      };
    },
  };
  let atEnd;
  const sessionsDir = join(mkdtempSync(join(ROOT, 'run-')), 'sessions');
  const boxed = await boxedOptions(t, sessionsDir, undefined);
  const adapter = claudeAgentAdapter({ builtins: false, model: MODEL, provider: { origin: provider.url, credential: () => 'provider-secret' }, sessionsDir, ...(boxed.box ? { box: boxed.box } : {}) });
  const runNode = createHarnessRunner(adapter, {
    ...boxed.runner,
    store,
    tools: [],
    maxTurns: 20,
    timeoutMs: 100_000,
    onEvent: (e) => {
      if (e.name !== 'browser_navigate') return;
      order.push(e.type);
      // What the store holds at the moment the host hears the refusal end (read takes its copy at once).
      if (e.type === 'tool_end') atEnd = Promise.all(inner.keys().map((k) => inner.read(k)));
    },
  });
  assert.deepEqual(await runNode({ kind: 'agent', label: 'refused-durable', system: ['Answer.'], user: 'Go.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] }), { answer: 'ok' });

  assert.ok(held, 'the refusal went through the held writer');
  assert.deepEqual(order, ['held', 'released', 'tool_start', 'tool_end'], 'the host hears the refusal only after its record is written');
  assert.ok(JSON.stringify(await atEnd).includes('No such tool available: browser_navigate'), "at the refusal's tool_end, the store holds it");
});
