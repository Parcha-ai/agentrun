// The pinned Claude Agent CLI with its own tools on (the adapter's default), through the adapter and the real Agent SDK,
// with a scripted model behind the session's proxy. The model sees the CLI's allowlisted tools and none of the ones off
// whatever a session says; a built-in it calls runs, its intent is in the log before its outcome, and the host hears it
// start before it ends. No network: the provider is a scripted Anthropic API on the loopback interface.
//
// Without the pinned CLI this skips; with AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY=1 (CI) a missing or different one fails.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { CLAUDE_AGENT_SDK_VERSION, claudeAgentAdapter, verifyClaudeAgent } from '@parcha/agentrun-harness-claude';
import { CLAUDE_BUILTINS, CLAUDE_BUILTINS_OFF } from '../dist/harness.js';
import { fakeAnthropic } from '@parcha/agentrun-harness-claude/testing';

const required = process.env.AGENTRUN_CLAUDE_AGENT_REQUIRE_BINARY === '1';
let problem;
try { verifyClaudeAgent({}); } catch (error) { problem = `${error.name}: ${error.message}`; }
const skip = problem && !required ? problem : false;
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-native-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const MODEL = 'claude-sonnet-5-5';
const SMALL = 'claude-haiku-4-5';

test("with the CLI's own tools on, the model sees the allowlist and nothing that is off; a Bash call runs once, its intent logged before its outcome", { skip, timeout: 240_000 }, async (t) => {
  const dir = mkdtempSync(join(ROOT, 'run-'));
  // What the model asks for, one call per main-model request: a command of the CLI's own, then the host's submit.
  const plan = [
    { tool: { name: 'Bash', input: { command: 'printf ran > native.txt', description: 'write a file' } } },
    { tool: { name: 'mcp__hands__submit', input: { value: { answer: 'ok' } } } },
  ].map((step) => ({ thinking: 'The next step.', ...step }));
  let main = 0;
  const provider = await fakeAnthropic({ reply: (r) => (r.model === MODEL ? plan[main++] ?? { text: 'done' } : { text: 'ok' }) });
  t.after(() => provider.close());

  const adapter = claudeAgentAdapter({
    sdk: await import('@anthropic-ai/claude-agent-sdk'),
    sdkVersion: CLAUDE_AGENT_SDK_VERSION,
    model: MODEL,
    smallModel: SMALL,
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    sessionsDir: join(dir, 'sessions'),
    // Stated, never a default: the test runs with no box, the operator's word for a machine whose boundary is elsewhere.
    box: 'unsandboxed',
  });
  const store = memorySessionStore();
  const events = [];
  const runNode = createHarnessRunner(adapter, { store, tools: [], maxTurns: 20, timeoutMs: 200_000, onEvent: (e) => { if (e.type === 'tool_start' || e.type === 'tool_end') events.push(e); } });
  const output = await runNode({ kind: 'agent', label: 'native', system: ['Answer.'], user: 'Write the file, then say ok.', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, tools: [] });
  assert.deepEqual(output, { answer: 'ok' });

  // The model was offered the CLI's allowlisted tools, and none of the ones off whatever a session says.
  const offered = new Set(provider.requests.filter((r) => r.authorized && r.body?.model === MODEL).flatMap((r) => (r.body.tools ?? []).map((tool) => tool.name)));
  for (const name of CLAUDE_BUILTINS) assert.ok(offered.has(name), `the model is offered ${name} (offered: ${[...offered].join(', ')})`);
  for (const name of [...CLAUDE_BUILTINS_OFF, 'WebSearch']) assert.equal(offered.has(name), false, `the model is never offered ${name}`);

  // The command ran, once, in the session's working directory.
  const sessions = join(dir, 'sessions');
  const [session] = readdirSync(sessions);
  const file = join(sessions, session, 'work', 'native.txt');
  assert.ok(existsSync(file), 'the Bash call ran');
  assert.equal(readFileSync(file, 'utf8'), 'ran');

  // Its intent is in the log before its outcome, as a call that may have taken effect, and it ended completed.
  const [key] = store.keys();
  const records = await store.read(key);
  const starts = records.filter((r) => r.kind === 'kernel.start' && r.data.name === 'tool.Bash');
  assert.equal(starts.length, 1, 'one Bash intent');
  assert.equal(starts[0].data.replay, 'never');
  const ends = records.filter((r) => r.kind === 'kernel.end' && r.data.stepId === starts[0].data.stepId);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].data.status, 'completed');
  assert.ok(records.indexOf(starts[0]) < records.indexOf(ends[0]), 'the intent is logged before the outcome');

  // The host heard the call start before it ended.
  const bash = events.filter((e) => e.name === 'Bash');
  assert.deepEqual(bash.map((e) => e.type), ['tool_start', 'tool_end'], JSON.stringify(events));
  assert.equal(bash[1].isError, false);
});
