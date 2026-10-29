// The adapter session every harness adapter opens (session.ts), on a scripted harness: a turn's drive rebuilt after a
// `Restart`, at most `restarts` times; a pause that waits for the calls in flight; and a draining session that sends no
// new turn. Each adapter suite covers the same session through its own harness; this one holds the shared code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallsInFlight, openAdapterSession } from '@parcha/agentrun-kernel';
import { Restart } from '@parcha/agentrun-kernel/kernel';
import { NativeJournal } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

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

test('drainMs is checked, and a closed session refuses a new turn', async () => {
  const { session } = await open(restarting(0).drive);
  await assert.rejects(session.interrupt({ drainMs: -1 }), /^Error: agentrun-test: drainMs must be a non-negative number of milliseconds$/);
  await assert.rejects(session.recover(), /^Error: agentrun-test: there is no turn to recover$/);
  await assert.rejects(session.turnEnd(), /^Error: agentrun-test: no turn is in flight$/);
  await session.close();
  await assert.rejects(session.send('go'), /^Error: agentrun-test: the session is closed$/);
});
