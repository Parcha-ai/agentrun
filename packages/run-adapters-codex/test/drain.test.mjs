// A pause on the Codex adapter: interrupt with drainMs lets a call in flight run on until its outcome is in the session's
// records, so the session resumes from it and the call never runs again; and a session draining sends no new turn.
// The same rule as the Claude Agent adapter's (its test/drain.test.mjs), now that both run on the kernel's session.
// On the stand-in app-server (fake-app-server.mjs). No key, no network, no Codex binary.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-drain-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const scratch = () => mkdtempSync(join(ROOT, `t${n++}-`));

/** A Codex adapter on the stand-in for a bare session (no provider traffic): its turn follows `script`. */
function bare(script) {
  const dir = scratch();
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify(script));
  return codexAdapter({
    model: 'luna-test',
    provider: { origin: 'https://provider.invalid', credential: () => 'provider-secret' },
    sessionsDir: join(dir, 'sessions'),
    standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_SCRIPT: file } },
  });
}

/** A charge that takes `ms`, and stops (failing) if its signal aborts first, as a request in flight does. */
function charge(ms) {
  const tool = { runs: 0 };
  let started;
  tool.started = new Promise((resolve) => { started = resolve; });
  tool.tool = {
    name: 'charge', description: 'Charge the card.', inputSchema: { type: 'object' }, replay: 'never',
    call: (_args, { signal }) => {
      tool.runs += 1;
      started();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ text: 'charged' }), ms);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('the charge was cut off')); }, { once: true });
      });
    },
  };
  return tool;
}

async function open(t, tool) {
  const codex = bare(['call charge {"amount":5}']);
  const spec = { key: 'step:pause', label: 'pay', system: [], tools: [tool], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const session = await codex.open(spec, { writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent: () => {} });
  // Closed whatever the assertions find, so a turn this test did not expect never outlives it.
  t.after(async () => { await session.interrupt().catch(() => {}); await session.close(); });
  return { session, store };
}

test('a pause lets the call in flight run on to its recorded outcome: never cut, never interrupted', async (t) => {
  const pay = charge(400);
  const { session, store } = await open(t, pay.tool);
  await session.send('pay');
  await pay.started;
  await session.interrupt({ drainMs: 5_000 });
  assert.equal(pay.runs, 1, 'the charge ran once');
  const all = await store.read('step:pause');
  const ends = all.filter((r) => r.kind === 'kernel.end' && r.data.stepId?.startsWith('tool:')).map((r) => r.data);
  assert.equal(ends.length, 1, JSON.stringify(ends));
  assert.notEqual(ends[0].status, 'failed', `the charge's outcome is recorded, not cut: ${JSON.stringify(ends[0])}`);
});

test('a session draining sends no new turn: send is refused until the pause is over', async (t) => {
  const pay = charge(400);
  const { session } = await open(t, pay.tool);
  await session.send('pay');
  await pay.started;
  const pausing = session.interrupt({ drainMs: 5_000 });
  await assert.rejects(session.send('and another'), /^Error: agentrun-harness-codex: the session is pausing; no new turn$/);
  await pausing;
  assert.equal(pay.runs, 1);
});

test('a pause the host starts on a tool_start waits for that call: it runs once, to its recorded outcome, never "was not run"', async (t) => {
  const pay = charge(300);
  const codex = bare(['call charge {"amount":5}']);
  const spec = { key: 'step:pause', label: 'pay', system: [], tools: [pay.tool], context: 'fresh' };
  const store = memorySessionStore();
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  let session;
  let pausing;
  // The host pauses the moment it hears the call started, as the runner's stop can.
  const onEvent = (e) => { if (e.type === 'tool_start' && !pausing) pausing = session.interrupt({ drainMs: 5_000 }); };
  session = await codex.open(spec, { writer: await store.open(spec.key), models, signal: new AbortController().signal, onEvent });
  t.after(async () => { await session.interrupt().catch(() => {}); await session.close(); });
  await session.send('pay');
  for (let i = 0; !pausing; i++) {
    assert.ok(i < 300, 'the host heard the call start');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await pausing;
  assert.equal(pay.runs, 1, 'the call the host was told started ran once');
  const ends = (await store.read('step:pause')).filter((r) => r.kind === 'kernel.end' && r.data.stepId?.startsWith('tool:')).map((r) => r.data);
  assert.equal(ends.length, 1, JSON.stringify(ends));
  assert.notEqual(ends[0].status, 'failed', `the call's outcome is recorded, not refused: ${JSON.stringify(ends[0])}`);
});
