// A message steered into a claude-agent session's turn in flight (AdapterSession.steer), on the scripted Agent SDK: the
// harness sends it to the CLI at priority `next`, the CLI hands it to the model at its next step (after the tool call in
// flight), in the same turn, and the session says when the model took it (message_taken). Placed again under the same id,
// it places nothing. Placed as the turn ends, it is never lost: it goes in that turn or starts the next.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { foldSession, pendingSubmissions } from '@parcha/agentrun-kernel/kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { claudeAgentAdapter } from '@parcha/agentrun-harness-claude';
import { facts } from '@parcha/agentrun-harness-claude/facts';
import { fakeSdk } from '@parcha/agentrun-harness-claude/testing';

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = '1';
const test = (name, fn) => nodeTest(name, { timeout: 120_000 }, fn);
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-claude-steer-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const models = { beforeRequest: async () => {}, afterRequest: async () => {} };

/** A session on the scripted SDK whose input makes one `wait` call, held until `release()`; after the call the "model"
 *  says the last steer it was given, else "no steer". Anything else it is handed it echoes. */
async function session(t, key = 'step:steer') {
  let release;
  let inside;
  const started = new Promise((resolve) => (inside = resolve));
  const released = new Promise((resolve) => (release = resolve));
  const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => { inside(); await released; return { text: 'waited' }; } };
  const seen = [];
  const sdk = fakeSdk({ mirrorLagMs: 10, script: (text) => (text.endsWith('go') ? 'call wait {}' : undefined), reply: ({ steers }) => steers.at(-1) ?? 'no steer', onMessage: (m) => seen.push(m) });
  const adapter = claudeAgentAdapter({
    model: 'claude-test',
    provider: { origin: 'https://faux.invalid', credential: () => 'not-a-secret' },
    price: () => 0,
    sessionsDir: join(ROOT, `s${n++}`),
    standIn: { command: process.execPath },
    sdk,
  });
  const store = memorySessionStore();
  const events = [];
  const s = await adapter.open({ key, label: 'steer', system: [], tools: [wait], context: 'fresh' }, { store, writer: await store.open(key), models, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  t.after(() => s.close());
  return { s, store, key, events, seen, started, release };
}

const said = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');

test('claude-agent declares that it steers: a message sent while it works lands mid-turn', () => {
  assert.equal(facts.steer, true);
});

test('a steer placed while a tool call runs reaches the model at its next step, after the call ends, in the same turn, and the session says when the model took it', async (t) => {
  const { s, store, key, events, seen, started, release } = await session(t);
  await s.send('go');
  await started;
  await s.steer('check the totals', 'req-1');
  // The call is still running: the model has not been given the steer yet.
  assert.equal(events.some((e) => e.type === 'message_taken' && e.ids.includes('req-1')), false, 'not taken while the call runs');
  release();
  assert.equal((await s.turnEnd()).status, 'completed');

  const steer = seen.find((m) => m.text === 'check the totals');
  assert.equal(steer?.priority, 'next', `the CLI was handed it at priority next: ${JSON.stringify(seen)}`);
  const callEnd = events.findIndex((e) => e.type === 'tool_end' && e.name === 'wait');
  const taken = events.findIndex((e) => e.type === 'message_taken' && e.ids.includes('req-1'));
  assert.ok(callEnd >= 0 && taken > callEnd, `taken after the call it was sent during ended: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.match(said(events), /check the totals$/, 'the next step answered it');
  assert.equal(events.filter((e) => e.type === 'turn_end').length, 1, 'one turn: the steer went into the turn in flight');
  const folded = foldSession(key, await store.read(key));
  assert.deepEqual(folded.submissions.filter((x) => x.id === 'req-1').map((x) => x.kind), ['steer'], 'one submission, a steer');
  assert.deepEqual(pendingSubmissions(folded), [], 'nothing left pending');
});

test('a steer placed again under the same id (a runner lost after placing it hands the row on again) places nothing and starts no turn, and the session says the model has it', async (t) => {
  const { s, store, key, events, seen, started, release } = await session(t);
  await s.send('go');
  await started;
  await s.steer('check the totals', 'req-1');
  release();
  await s.turnEnd();
  // The CLI's transcript lines reach the session's log once their coalesce window has passed.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const takenBefore = events.filter((e) => e.type === 'message_taken' && e.ids.includes('req-1')).length;

  await s.steer('check the totals', 'req-1');
  assert.equal((await s.turnEnd()).status, 'completed');
  assert.equal(events.filter((e) => e.type === 'turn_end').length, 1, 'no second turn');
  assert.equal(seen.filter((m) => m.text === 'check the totals').length, 1, 'the CLI was handed it once');
  const folded = foldSession(key, await store.read(key));
  assert.equal(folded.submissions.filter((x) => x.id === 'req-1').length, 1, 'one submission under the id');
  assert.equal(events.filter((e) => e.type === 'message_taken' && e.ids.includes('req-1')).length, takenBefore + 1, 'said again: the model has it');
});

test('a steer placed with no turn in flight starts a turn of its own, which the session tracks to its end', async (t) => {
  const { s, events, seen, started, release } = await session(t);
  await s.send('go');
  await started;
  release();
  await s.turnEnd();
  await s.steer('and the dates', 'req-2');
  assert.equal((await s.turnEnd()).status, 'completed');
  assert.equal(seen.filter((m) => m.text.endsWith('and the dates')).length, 1, `the CLI was handed it once: ${JSON.stringify(seen)}`);
  assert.equal(events.filter((e) => e.type === 'turn_end').length, 2);
  assert.ok(events.some((e) => e.type === 'message_taken' && e.ids.includes('req-2')));
  assert.match(said(events), /echo: [^]*and the dates$/, 'the model answered it');
});

test('a steer placed as the turn ends, at every point of its ending: the model is handed it once, and the turn the session reports then covers it', async (t) => {
  // From the call's end through the turn's last write: the steer lands mid-turn, as the drive's inbox closes, or after.
  for (const delay of [0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 200]) {
    const { s, store, key, events, seen, started, release } = await session(t, `step:race-${delay}`);
    await s.send('go');
    await started;
    release();
    await new Promise((resolve) => setTimeout(resolve, delay));
    await s.steer('check the totals', `req-${delay}`);
    // The turn in flight when the steer was placed, or the one it started: either way it ends having handed it on.
    for (let end = await s.turnEnd(); ; ) {
      assert.equal(end.status, 'completed', `delay ${delay}`);
      const next = await s.turnEnd();
      if (next === end) break;
      end = next;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const folded = foldSession(key, await store.read(key));
    assert.deepEqual(pendingSubmissions(folded), [], `delay ${delay}: nothing left pending`);
    const handed = seen.filter((m) => m.text.endsWith('check the totals'));
    assert.equal(handed.length, 1, `delay ${delay}: the CLI was handed it once: ${JSON.stringify(seen)}`);
    assert.ok(events.some((e) => e.type === 'message_taken' && e.ids.includes(`req-${delay}`)), `delay ${delay}: the session said the model took it`);
    assert.match(said(events), /check the totals$/, `delay ${delay}: the model answered it`);
    await s.close();
  }
});

test('a session opened after the steer\'s turn ended (a runner lost before it recorded the steer): the steer placed again starts no turn, the session says the model has it, and turnEnd() gives the turn that answered it', async (t) => {
  const first = await session(t, 'step:steer-reopen');
  await first.s.send('go');
  await first.started;
  await first.s.steer('check the totals', 'req-1');
  first.release();
  assert.equal((await first.s.turnEnd()).status, 'completed');
  // The CLI's transcript lines reach the session's log once their coalesce window has passed.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await first.s.close();

  // The next runner's session, over the same records.
  const sdk = fakeSdk({ mirrorLagMs: 10, script: () => undefined, onMessage: (m) => first.seen.push(m) });
  const adapter = claudeAgentAdapter({ model: 'claude-test', provider: { origin: 'https://faux.invalid', credential: () => 'not-a-secret' }, price: () => 0, sessionsDir: join(ROOT, `s${n++}`), standIn: { command: process.execPath }, sdk });
  const events = [];
  const s = await adapter.open({ key: first.key, label: 'steer', system: [], tools: [], context: 'fresh' }, { store: first.store, writer: await first.store.open(first.key), models, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  t.after(() => s.close());
  assert.equal(s.state, 'idle', 'the turn ended before this session opened');
  await s.steer('check the totals', 'req-1');
  assert.ok(events.some((e) => e.type === 'message_taken' && e.ids.includes('req-1')), 'the session says the model has it');
  assert.equal((await s.turnEnd()).status, 'completed', 'the turn that answered it');
  assert.equal(events.filter((e) => e.type === 'turn_end').length, 0, 'no turn started');
  assert.equal(first.seen.filter((m) => m.text === 'check the totals').length, 1, 'the CLI was handed it once');
});
