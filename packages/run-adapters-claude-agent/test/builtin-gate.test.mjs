// The PreToolUse gate on the CLI's own calls: a built-in that comes while the session pauses is refused as not run (never
// counted, never run, and the pause does not wait for it); a session skill's own failure is its own, never read as the
// CLI turning the call down; and with built-ins on, the CLI's own sandbox is required unless the caller says otherwise.
//
// On the scripted Agent SDK (./testing). No key, no network.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createHarnessRunner } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { fakeAnthropic, fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-gate-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };

async function adapterOf(t, { script, sdk = {}, ...extra }) {
  const provider = await fakeAnthropic({ reply: () => ({ text: 'ok' }) });
  t.after(() => provider.close());
  const sessionsDir = join(scratch(), 'sessions');
  const logs = [];
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: provider.url, credential: () => 'provider-secret' },
    sessionsDir,
    standIn: { command: process.execPath },
    sdk: fakeSdk({ remoteModel: true, mirrorLagMs: 10, script, ...sdk }),
    log: (message) => logs.push(message),
    ...extra,
  });
  return { adapter, sessionsDir, logs };
}

/** Two built-ins in flight together; the host pauses on the first's tool_start. */
async function pauseThenAsk(t) {
  const decisions = [];
  const { adapter, sessionsDir } = await adapterOf(t, {
    script: ['builtins [["Bash",{"command":"sleep 0.4; printf one > one.txt","description":"a"}],["Bash",{"command":"printf two > two.txt","description":"b"}]]'],
    sdk: { onDecision: (d) => decisions.push(d) },
    unsandboxedCommands: true,
  });
  const spec = { key: 'step:gate', label: 'task', system: [], tools: [], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  let session;
  let pausing;
  const onEvent = (e) => { if (e.type === 'tool_start' && e.name === 'Bash' && !pausing) pausing = session.interrupt({ drainMs: 10_000 }); };
  session = await adapter.open(spec, { store, writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent });
  t.after(async () => { await Promise.race([session.interrupt().catch(() => {}).then(() => session.close()), new Promise((resolve) => setTimeout(resolve, 5_000))]); });
  await session.send('go');
  for (let i = 0; !pausing; i++) {
    assert.ok(i < 500, 'the host heard the first command start');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const returned = await Promise.race([pausing.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20_000))]);
  assert.ok(returned, 'the pause returned');
  for (let i = 0; i < 200 && decisions.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const [dir] = readdirSync(sessionsDir);
  return { decisions, work: join(sessionsDir, dir, 'work'), records: await store.read(spec.key) };
}

test('a built-in that comes while the session pauses is refused before it is counted: it never runs, and the pause waits only for the one in flight', async (t) => {
  const { decisions, work, records } = await pauseThenAsk(t);
  assert.equal(decisions[0]?.decision, 'allow', 'the first command was in flight when the pause began');
  assert.equal(decisions[1]?.decision, 'deny', `the second is refused: ${JSON.stringify(decisions[1])}`);
  assert.ok(existsSync(join(work, 'one.txt')), 'the pause waited for the command in flight');
  assert.equal(existsSync(join(work, 'two.txt')), false, 'the refused command never ran');
  const starts = records.filter((r) => r.kind === 'kernel.start' && r.data.name === 'tool.Bash');
  const ends = starts.map((start) => records.find((r) => r.kind === 'kernel.end' && r.data.stepId === start.data.stepId)?.data);
  assert.equal(ends[0]?.status, 'completed', 'the command in flight ran to its recorded outcome');
  assert.deepEqual([ends[1]?.status, ends[1]?.error?.message], ['failed', 'Bash was not run: the session is pausing'], 'the refused one is recorded as not run, its outcome final');
});

test('a refused built-in is told it was not run, because the session is pausing, never that it already ran', async (t) => {
  const { decisions } = await pauseThenAsk(t);
  const reason = String(decisions[1]?.reason ?? '');
  assert.match(reason, /^Not run: .*the session is pausing/, reason);
  assert.doesNotMatch(reason, /already ran/, reason);
});

test("a session skill's own failure is its own: never read as the CLI turning the call down", async (t) => {
  const skill = { name: 'x', files: { 'SKILL.md': '---\nname: x\ndescription: d\n---\nbody\n' } };
  const decisions = [];
  const { adapter, logs } = await adapterOf(t, { script: ['builtin Skill {"skill":"agentrun:x"}', 'call submit {"value":{"answer":"ok"}}'], skills: [skill], builtins: false, sdk: { onDecision: (d) => decisions.push(d) } });
  const events = [];
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [], onEvent: (e) => events.push(e) });
  // The run reaches the skill, the gate allows it, and the turn goes on to its answer: a run that failed before the skill,
  // or a gate that turned it down, would not get here.
  assert.deepEqual(await runNode({ kind: 'agent', label: 'q', system: ['Be brief.'], user: 'Go.', schema: SCHEMA, tools: [] }), { answer: 'ok' });
  assert.deepEqual(decisions.filter((d) => d.name === 'Skill').map((d) => d.decision), ['allow'], JSON.stringify(decisions));
  assert.equal(logs.filter((line) => /turned down a call/.test(line)).length, 0, logs.join('\n'));
});

test('built-ins in flight together, the first of which fails before it starts: its error is its result, and the turn goes on', async (t) => {
  // A Write under a directory that is not there fails in the call itself, before it says it started.
  const { adapter } = await adapterOf(t, {
    script: ['builtins [["Write",{"file_path":"no/such/dir/x.txt","content":"x"}],["Bash",{"command":"printf two > two.txt","description":"b"}]]', 'call submit {"value":{"answer":"ok"}}'],
    unsandboxedCommands: true,
  });
  const events = [];
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [], onEvent: (e) => events.push(e) });
  const ended = await Promise.race([
    runNode({ kind: 'agent', label: 'q', system: ['Be brief.'], user: 'Go.', schema: SCHEMA, tools: [] }).then((output) => ({ output }), (error) => ({ error: String(error?.message ?? error) })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 15_000)),
  ]);
  assert.deepEqual(ended, { output: { answer: 'ok' } }, 'the turn ended, and went on to its answer');
  const write = events.find((e) => e.type === 'tool_end' && e.name === 'Write');
  assert.ok(write?.isError, `the Write is told as failed: ${JSON.stringify(write)}`);
});

test('with built-ins on and no word from the caller, the CLI must have its own sandbox: where it cannot start, the turn fails by name; set, it runs without', async (t) => {
  const node = { kind: 'agent', label: 'q', system: ['Be brief.'], user: 'Go.', schema: SCHEMA, tools: [] };
  const seen = [];
  const { adapter } = await adapterOf(t, { script: ['call submit {"value":{"answer":"ok"}}'], sdk: { onQuery: (options) => seen.push(options) } });
  const result = await createHarnessRunner(adapter, { store: memorySessionStore(), tools: [] })(node).then((output) => ({ output }), (error) => ({ error }));
  if (result.error) {
    // Here bubblewrap does not start (stock Ubuntu 24.04): the named refusal, and the CLI never asked.
    assert.match(String(result.error?.message ?? result.error), /the CLI's own command sandbox \(bubblewrap\) doesn't start on this machine/);
    assert.equal(seen.length, 0);
    const { adapter: opted } = await adapterOf(t, { script: ['call submit {"value":{"answer":"ok"}}'], unsandboxedCommands: true });
    assert.deepEqual(await createHarnessRunner(opted, { store: memorySessionStore(), tools: [] })(node), { answer: 'ok' }, 'set by the caller, it runs');
  } else {
    // Where bubblewrap starts, the CLI is given its own sandbox.
    assert.ok(seen[0]?.sandbox?.enabled, 'the CLI runs under its own sandbox');
  }
});
