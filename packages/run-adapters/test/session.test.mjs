// The adapter session every harness adapter opens (session.ts), on a scripted harness: a turn's drive rebuilt after a
// `Restart`, at most `restarts` times; a pause that waits for the calls in flight; and a draining session that sends no
// new turn. Each adapter suite covers the same session through its own harness; this one holds the shared code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallsInFlight, openAdapterSession } from '@parcha/agentrun-kernel';
import { Restart } from '@parcha/agentrun-kernel/kernel';
import { NativeJournal, placeSubmissions } from '@parcha/agentrun-kernel/process';
import { fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';

/** A harness whose drive throws `Restart` for its first `restarts` drives, then records the turn as completed. */
function restarting(restarts) {
  const harness = { drives: 0, attempts: [] };
  harness.drive = async (drive) => {
    harness.drives += 1;
    harness.attempts.push(drive.attempt);
    if (harness.drives <= restarts) throw new Restart('the process exited mid-turn');
    const journal = new NativeJournal(drive);
    journal.message({ type: 'turn', status: 'completed' });
    await journal.flush();
  };
  return harness;
}

async function open(drive, extra = {}) {
  const store = memorySessionStore();
  const events = [];
  const calls = new CallsInFlight();
  const io = { writer: await store.open('step:s'), models: {}, signal: new AbortController().signal, onEvent: (e) => events.push(e) };
  const session = await openAdapterSession({ name: 'agentrun-test', io, drive, live: () => {}, calls, ...extra });
  return { session, events, calls };
}

test('a drive that ends in a Restart is rebuilt from the log and the turn resumes, each rebuild a new attempt', async () => {
  const harness = restarting(2);
  const { session, events } = await open(harness.drive);
  assert.equal(session.state, 'new');
  await session.send('go');
  assert.deepEqual(await session.turnEnd(), { status: 'completed' });
  assert.equal(harness.drives, 3);
  assert.deepEqual(harness.attempts, [0, 1, 2]);
  assert.deepEqual(events, [{ type: 'turn_end', status: 'completed' }]);
});

test('past `restarts` rebuilds the turn fails, naming the last error', async () => {
  const harness = restarting(5);
  const { session } = await open(harness.drive, { restarts: 2 });
  await session.send('go');
  const end = await session.turnEnd();
  assert.equal(end.status, 'failed');
  assert.match(end.error, /the process exited mid-turn/);
  assert.equal(harness.drives, 3, 'the first drive and two rebuilds');
});

test('any other error fails the turn at once, with no rebuild', async () => {
  let drives = 0;
  const { session } = await open(async () => { drives += 1; throw new Error('boom'); });
  await session.send('go');
  assert.deepEqual(await session.turnEnd(), { status: 'failed', error: 'boom' });
  assert.equal(drives, 1);
});

test('a pause waits for the calls in flight, sends no new turn meanwhile, then stops the turn', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls;
  let finished = false;
  const { session, calls: c } = await open(async (drive) => {
    calls.begin('call-1');
    // The call stops if the drive is halted first, as a call the pause cut off does.
    const cut = new Promise((_, reject) => drive.signal.addEventListener('abort', () => reject(new Error('cut off')), { once: true }));
    await Promise.race([held, cut]);
    finished = true;
    calls.end('call-1');
    await cut;
  });
  calls = c;
  await session.send('go');
  await new Promise((resolve) => setImmediate(resolve));
  const pausing = session.interrupt({ drainMs: 5_000 });
  // Bounded: a send the session lets through would wait on the turn in flight, not fail.
  const late = await Promise.race([session.send('another').then(() => 'sent', (error) => error), new Promise((resolve) => setTimeout(() => resolve('not refused'), 200))]);
  assert.match(String(late), /^Error: agentrun-test: the session is pausing; no new turn$/);
  assert.equal(finished, false, 'the call is still in flight');
  release();
  await pausing;
  assert.equal(finished, true, 'the pause let the call in flight finish: it was not cut');
  assert.deepEqual(await session.turnEnd(), { status: 'interrupted' });
  assert.equal(calls.draining, false, 'the next turn starts clean');
});

test('after an interrupt, the next send runs on a fresh drive and its turn completes, recorded', async () => {
  let drives = 0;
  const halted = [];
  const { session, events } = await open(async (drive) => {
    drives += 1;
    // The first turn waits until it is stopped; any later one completes.
    if (drives === 1) return new Promise((_, reject) => drive.signal.addEventListener('abort', () => reject(new Error('halted')), { once: true }));
    halted.push(drive.signal.aborted);
    const journal = new NativeJournal(drive);
    journal.message({ type: 'turn', status: 'completed' });
    await journal.flush();
  });
  await session.send('first');
  await new Promise((resolve) => setImmediate(resolve));
  await session.interrupt();
  assert.deepEqual(await session.turnEnd(), { status: 'interrupted' });
  await session.send('second');
  assert.deepEqual(await session.turnEnd(), { status: 'completed' });
  assert.deepEqual(halted, [false], 'the second turn ran on a drive that was not halted');
  assert.deepEqual(events.map((e) => e.status), ['interrupted', 'completed']);
});

test('drainMs is checked, and a closed session refuses a new turn', async () => {
  const { session } = await open(restarting(0).drive);
  await assert.rejects(session.interrupt({ drainMs: -1 }), /^Error: agentrun-test: drainMs must be a non-negative number of milliseconds$/);
  await assert.rejects(session.recover(), /^Error: agentrun-test: there is no turn to recover$/);
  await assert.rejects(session.turnEnd(), /^Error: agentrun-test: no turn is in flight$/);
  await session.close();
  await assert.rejects(session.send('go'), /^Error: agentrun-test: the session is closed$/);
});

/** One process's session on `store`: the next open of the key fences this one, as a later process's does. */
async function openOn(store, drive) {
  const events = [];
  const controller = new AbortController();
  const io = { writer: await store.open('step:s'), models: {}, signal: controller.signal, onEvent: (e) => events.push(e) };
  const session = await openAdapterSession({ name: 'agentrun-test', io, drive, live: () => {}, calls: new CallsInFlight() });
  return { session, events, kill: () => controller.abort(new Error('killed')) };
}
/** A harness that records each turn it runs, and the text of what it was given to place. */
function counting() {
  const harness = { drives: 0, given: [] };
  harness.drive = async (drive) => {
    harness.drives += 1;
    const pending = drive.pending();
    harness.given.push(...pending.map((s) => s.text));
    await placeSubmissions(drive, pending);
    const journal = new NativeJournal(drive);
    journal.message({ type: 'turn', status: 'completed' });
    await journal.flush();
  };
  return harness;
}
const turnSoon = () => new Promise((resolve) => setImmediate(resolve));

test('a turn a crash cut off is settled: recorded ended interrupted, nothing is sent, and no later open resumes it', async () => {
  const store = memorySessionStore();
  // The first process places its input, starts a call that is not safe to repeat, and dies inside it.
  const first = await openOn(store, async (drive) => {
    await placeSubmissions(drive, drive.pending());
    await drive.effect('tool:c1', { name: 'tool.commit', replay: 'never', input: {} }, () => new Promise(() => {}));
  });
  await first.session.send('go');
  await turnSoon();
  first.kill();

  const harness = counting();
  const second = await openOn(store, harness.drive);
  assert.equal(second.session.state, 'open_turn');
  await second.session.settleOpenTurn();
  assert.equal(second.session.state, 'idle');
  assert.equal(harness.drives, 0, 'settling runs no turn of the harness');
  assert.deepEqual(second.events, [{ type: 'turn_end', status: 'interrupted' }]);
  await assert.rejects(second.session.recover(), /^Error: agentrun-test: there is no turn to recover$/);

  const third = await openOn(store, harness.drive);
  assert.equal(third.session.state, 'idle', 'the settled turn is over in the records');
  await third.session.send('next');
  assert.deepEqual(await third.session.turnEnd(), { status: 'completed' });
  assert.deepEqual([harness.drives, harness.given], [1, ['next']]);
});

test('input sent and not yet placed when the crash came is withdrawn by the settle: it never reaches the harness', async () => {
  const store = memorySessionStore();
  const first = await openOn(store, () => new Promise(() => {}));
  await first.session.send('the cut turn\'s prompt');
  await turnSoon();
  first.kill();

  const harness = counting();
  const second = await openOn(store, harness.drive);
  assert.equal(second.session.state, 'open_turn');
  await second.session.settleOpenTurn();
  const third = await openOn(store, harness.drive);
  assert.equal(third.session.state, 'idle');
  await third.session.send('next');
  await third.session.turnEnd();
  assert.deepEqual(harness.given, ['next']);
});

test('only an open turn is settled: a new or idle session refuses, and writes nothing', async () => {
  const store = memorySessionStore();
  const harness = counting();
  const fresh = await openOn(store, harness.drive);
  await assert.rejects(fresh.session.settleOpenTurn(), /^Error: agentrun-test: there is no turn to settle$/);
  await fresh.session.send('go');
  await fresh.session.turnEnd();
  const before = (await store.read('step:s')).length;
  await assert.rejects(fresh.session.settleOpenTurn(), /^Error: agentrun-test: there is no turn to settle$/);
  assert.equal((await store.read('step:s')).length, before);
});

test('the faux harness settles a turn a crash cut off: its end is recorded, and no request is made again', async () => {
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'working' }, { hang: true }, { say: 'never sent' }] });
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const spec = { key: 'step:f', label: 'f', system: [], tools: [], context: 'fresh' };
  const dying = new AbortController();
  const first = await adapter.open(spec, { writer: await store.open('step:f'), models, signal: dying.signal, onEvent: () => {} });
  await first.send('go');
  await turnSoon();
  dying.abort(new Error('killed'));

  const second = await adapter.open(spec, { writer: await store.open('step:f'), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(second.state, 'open_turn');
  await second.settleOpenTurn();
  const third = await adapter.open(spec, { writer: await store.open('step:f'), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(third.state, 'idle');
  assert.equal(adapter.requests, 1);
});
