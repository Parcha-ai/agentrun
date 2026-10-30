// The adapter session every harness adapter opens (session.ts), on a scripted harness: a turn's drive rebuilt after a
// `Restart`, at most `restarts` times; a pause that waits for the calls in flight; and a draining session that sends no
// new turn. Each adapter suite covers the same session through its own harness; this one holds the shared code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallsInFlight, openAdapterSession } from '@parcha/agentrun-kernel';
import { foldSession, openDrive, pendingSubmissions, Restart } from '@parcha/agentrun-kernel/kernel';
import { journalBatches, NativeJournal, placeSubmissions, transcriptOf } from '@parcha/agentrun-kernel/process';
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
  await first.session.send('the cut turn\'s prompt', { id: 'cut' });
  await turnSoon();
  first.kill();

  const harness = counting();
  const second = await openOn(store, harness.drive);
  assert.equal(second.session.state, 'open_turn');
  await second.session.settleOpenTurn({ opening: 'cut' });
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

test('the faux harness keeps a send\'s id: an id it already holds is refused, at once or after a reopen, with nothing written', async () => {
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ end: true }] });
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const spec = { key: 'step:f', label: 'f', system: [], tools: [], context: 'fresh' };
  const openIt = async () => adapter.open(spec, { writer: await store.open('step:f'), models, signal: new AbortController().signal, onEvent: () => {} });
  const first = await openIt();
  const sends = await Promise.allSettled([first.send('one', { id: 'x' }), first.send('two', { id: 'x' })]);
  assert.deepEqual(sends.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(sends[1].reason.name, 'SubmissionExists');
  await first.turnEnd();
  const second = await openIt();
  const before = (await store.read('step:f')).length;
  await assert.rejects(second.send('three', { id: 'x' }), { name: 'SubmissionExists', id: 'x' });
  assert.equal((await store.read('step:f')).length, before, 'nothing written');
  assert.deepEqual((await store.read('step:f')).filter((r) => r.kind === 'faux.user').map((r) => r.data), [{ id: 'x', text: 'one' }]);
});

/** A submission that reached the session while no process ran it (a test seam: today's send cannot leave a second one
 *  pending): written through a drive of its own, as the next process to open the session would find it. */
async function submittedMeanwhile(store, text) {
  const drive = await openDrive({ writer: await store.open('step:s'), signal: new AbortController().signal });
  await drive.submit({ id: `meanwhile-${text}`, kind: 'prompt', text });
}
/** A process that sends `text` as submission `id`, and dies before its harness places it. */
async function cutBeforePlacing(store, id, text = 'the cut turn\'s prompt') {
  const first = await openOn(store, () => new Promise(() => {}));
  await first.session.send(text, { id });
  await turnSoon();
  first.kill();
}
/** The session's last turn entry, as its records hold it. */
const lastTurn = async (store) => transcriptOf(foldSession('step:s', await store.read('step:s'))).filter((r) => r.data?.type === 'turn').at(-1)?.data;
const SETTLED = 'settled: the turn a crash cut off was ended, not resumed';

test('a settle withdraws only what opened the cut turn: a second message pending at the crash stays, and is the next turn\'s input', async () => {
  const store = memorySessionStore();
  // The cut turn's prompt never reached the transcript: it is the oldest pending submission.
  await cutBeforePlacing(store, 'cut');
  await submittedMeanwhile(store, 'a person\'s message');
  const harness = counting();
  const second = await openOn(store, harness.drive);
  assert.equal(second.session.state, 'open_turn');
  await second.session.settleOpenTurn({ opening: 'cut' });
  await second.session.send('next');
  await second.session.turnEnd();
  assert.deepEqual(harness.given, ['a person\'s message', 'next']);
});

test('a cut turn that placed its prompt withdraws nothing at its settle: a message pending beside it is the next turn\'s input', async () => {
  const store = memorySessionStore();
  const first = await openOn(store, async (drive) => {
    await placeSubmissions(drive, drive.pending());
    await drive.effect('tool:c1', { name: 'tool.commit', replay: 'never', input: {} }, () => new Promise(() => {}));
  });
  await first.session.send('go', { id: 'go' });
  await turnSoon();
  first.kill();
  await submittedMeanwhile(store, 'a person\'s message');
  const harness = counting();
  const second = await openOn(store, harness.drive);
  // Named, but placed: the cut turn is ended and nothing is withdrawn.
  await second.session.settleOpenTurn({ opening: 'go' });
  await second.session.send('next');
  await second.session.turnEnd();
  assert.deepEqual(harness.given, ['a person\'s message', 'next']);
});

test('the settled turn is recorded interrupted, saying it was settled, and its turn_end says so', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'go');
  const second = await openOn(store, counting().drive);
  await second.session.settleOpenTurn({ opening: 'go' });
  assert.deepEqual(await lastTurn(store), { type: 'turn', status: 'interrupted', error: SETTLED });
  assert.deepEqual(second.events, [{ type: 'turn_end', status: 'interrupted' }]);
});

test('a settle again, with no turn cut since the last one, withdraws nothing: a message left pending by then is never dropped', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'cut');
  await submittedMeanwhile(store, 'a person\'s message');
  await (await openOn(store, counting().drive)).session.settleOpenTurn({ opening: 'cut' });
  // A later process finds the person's message pending, so the session open, and is asked to settle again.
  const harness = counting();
  const third = await openOn(store, harness.drive);
  assert.equal(third.session.state, 'open_turn');
  await third.session.settleOpenTurn();
  await third.session.recover();
  await third.session.turnEnd();
  assert.deepEqual(harness.given, ['a person\'s message']);
});

test('a turn cut after an earlier settle is a new cut turn: its unplaced prompt is withdrawn, never sent later', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'first', 'the first cut prompt');
  await (await openOn(store, counting().drive)).session.settleOpenTurn({ opening: 'first' });
  // A later process sends again, and dies before its harness places the prompt.
  await cutBeforePlacing(store, 'second', 'the second cut prompt');
  const harness = counting();
  const next = await openOn(store, harness.drive);
  assert.equal(next.session.state, 'open_turn');
  await next.session.settleOpenTurn({ opening: 'second' });
  await next.session.send('next');
  await next.session.turnEnd();
  assert.deepEqual(harness.given, ['next']);
});

test('a settle is one write: the withdraw and the turn\'s end land together, so a retry after it withdraws nothing more', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'cut');
  await submittedMeanwhile(store, 'a person\'s message');
  // The next process's writer, counting its appends.
  const appends = [];
  const counted = { ...store, open: async (key) => {
    const writer = await store.open(key);
    return { ...writer, append: (records) => (appends.push(records.map((r) => r.kind)), writer.append(records)) };
  } };
  const second = await openOn(counted, counting().drive);
  await second.session.settleOpenTurn({ opening: 'cut' });
  assert.deepEqual(appends, [['kernel.submission', 'kernel.start', 'kernel.end']], 'one append: the withdraw, then the turn end\'s batch');
  // A process that dies right after that write finds the settle whole: a retry withdraws nothing more.
  const harness = counting();
  const third = await openOn(store, harness.drive);
  await third.session.settleOpenTurn();
  await third.session.recover();
  await third.session.turnEnd();
  assert.deepEqual(harness.given, ['a person\'s message']);
});

test('the faux harness says a settled turn ended, and refuses to settle a turn it recovered', async () => {
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'working' }, { hang: true }, { say: 'resumed' }, { end: true }] });
  const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
  const spec = { key: 'step:f', label: 'f', system: [], tools: [], context: 'fresh' };
  const cut = async () => {
    const dying = new AbortController();
    const first = await adapter.open(spec, { writer: await store.open('step:f'), models, signal: dying.signal, onEvent: () => {} });
    await first.send('go');
    await turnSoon();
    dying.abort(new Error('killed'));
  };
  await cut();
  const events = [];
  const second = await adapter.open(spec, { writer: await store.open('step:f'), models, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  await second.settleOpenTurn();
  assert.deepEqual(events, [{ type: 'turn_end', status: 'interrupted' }]);
  await cut();
  const third = await adapter.open(spec, { writer: await store.open('step:f'), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(third.state, 'open_turn');
  // Recovered: its turn runs again, so there is no cut turn left to settle.
  await third.recover();
  await assert.rejects(third.settleOpenTurn(), /no turn to settle/);
  await third.close();
});

test('a settle withdraws the submission it is named only while that is pending and the oldest pending: else it withdraws nothing', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'cut');
  await submittedMeanwhile(store, 'a person\'s message');
  const second = await openOn(store, counting().drive);
  const before = (await store.read('step:s')).length;
  // Named, but younger than the cut prompt; then named, but no submission has that id: nothing is written.
  await second.session.settleOpenTurn({ opening: 'meanwhile-a person\'s message' });
  await second.session.settleOpenTurn({ opening: 'no such submission' });
  assert.equal((await store.read('step:s')).length, before, 'nothing written');
  // Named, and the oldest pending: withdrawn, and only it.
  await second.session.settleOpenTurn({ opening: 'cut' });
  const state = foldSession('step:s', await store.read('step:s'));
  assert.deepEqual([...state.withdrawn], ['cut']);
  assert.deepEqual(pendingSubmissions(state).map((s) => s.id), ['meanwhile-a person\'s message']);
});

test('unnamed, a settle withdraws nothing: a message pending with no turn cut is left for the next turn, and nothing is written', async () => {
  const store = memorySessionStore();
  const harness = counting();
  const first = await openOn(store, harness.drive);
  await first.session.send('the task');
  await first.session.turnEnd();
  await submittedMeanwhile(store, 'a person\'s message');
  const second = await openOn(store, harness.drive);
  assert.equal(second.session.state, 'open_turn');
  const before = (await store.read('step:s')).length;
  await second.session.settleOpenTurn();
  assert.equal((await store.read('step:s')).length, before, 'nothing written');
  assert.deepEqual(second.events, [], 'no turn ended');
  await second.session.recover();
  await second.session.turnEnd();
  assert.deepEqual(harness.given, ['the task', 'a person\'s message']);
});

test('a settle named again after it landed withdraws nothing: a message that arrived after it stays pending', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'cut');
  await (await openOn(store, counting().drive)).session.settleOpenTurn({ opening: 'cut' });
  // The caller dies before it records the settle; a person's message arrives; the next process settles again.
  await submittedMeanwhile(store, 'a person\'s message');
  const harness = counting();
  const third = await openOn(store, harness.drive);
  assert.equal(third.session.state, 'open_turn');
  const before = (await store.read('step:s')).length;
  await third.session.settleOpenTurn({ opening: 'cut' });
  assert.equal((await store.read('step:s')).length, before, 'nothing written');
  await third.session.recover();
  await third.session.turnEnd();
  assert.deepEqual(harness.given, ['a person\'s message']);
});

test('after a settle the session\'s state is its records\': open while a message is still pending, so that turn can be recovered', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'cut');
  await submittedMeanwhile(store, 'a person\'s message');
  const harness = counting();
  const second = await openOn(store, harness.drive);
  await second.session.settleOpenTurn({ opening: 'cut' });
  assert.equal(second.session.state, 'open_turn', 'as a fresh open of the same records says');
  await second.session.recover();
  await second.session.turnEnd();
  assert.deepEqual(harness.given, ['a person\'s message']);
});

test('a send names its submission when asked, and an id the session already holds is refused with nothing written', async () => {
  const store = memorySessionStore();
  const harness = counting();
  const { session } = await openOn(store, harness.drive);
  await session.send('first', { id: 'mine' });
  await session.turnEnd();
  assert.deepEqual(foldSession('step:s', await store.read('step:s')).submissions.map((s) => [s.id, s.text]), [['mine', 'first']]);
  const before = (await store.read('step:s')).length;
  await assert.rejects(session.send('again', { id: 'mine' }), { name: 'SubmissionExists', code: 'SUBMISSION_EXISTS', id: 'mine', message: 'agentrun-test: the session already holds a submission with id mine' });
  assert.equal((await store.read('step:s')).length, before, 'nothing written');
  assert.equal(foldSession('step:s', await store.read('step:s')).submissions.length, 1, 'the log holds one submission');
  assert.deepEqual(harness.given, ['first']);
});

test('two sends of one id at once: exactly one submission lands, and the other is refused, though neither is folded yet', async () => {
  const store = memorySessionStore();
  const harness = counting();
  const { session } = await openOn(store, harness.drive);
  const sends = await Promise.allSettled([session.send('first', { id: 'x' }), session.send('second', { id: 'x' })]);
  await session.turnEnd();
  assert.deepEqual(sends.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(sends[1].reason.name, 'SubmissionExists');
  const written = (await store.read('step:s')).filter((r) => r.kind === 'kernel.submission' && r.data.id === 'x');
  assert.deepEqual(written.map((r) => r.data.text), ['first'], 'one submission x in the log');
  assert.deepEqual(harness.given, ['first']);
});

test('a settle on a halted session writes nothing, and throws the halt\'s error', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'cut');
  const second = await openOn(store, counting().drive);
  const before = (await store.read('step:s')).length;
  second.kill();
  await assert.rejects(second.session.settleOpenTurn({ opening: 'cut' }), /^Error: killed$/);
  assert.equal((await store.read('step:s')).length, before, 'nothing written');
  assert.equal(second.session.state, 'open_turn');
});

test('a settle by a process a newer one has fenced is refused by its writer, and writes nothing', async () => {
  const store = memorySessionStore();
  await cutBeforePlacing(store, 'cut');
  const older = await openOn(store, counting().drive);
  await openOn(store, counting().drive);
  const before = (await store.read('step:s')).length;
  await assert.rejects(older.session.settleOpenTurn({ opening: 'cut' }), Restart);
  assert.equal((await store.read('step:s')).length, before, 'nothing written');
});

test('a settle\'s batch is the journal\'s own: its records and their fold match a NativeJournal batch of the same entry', async () => {
  const entry = { type: 'turn', status: 'interrupted', error: SETTLED };
  // The same log before the batch: a turn that completed, then a prompt cut before its harness placed it.
  const cutAfterATurn = async () => {
    const store = memorySessionStore();
    const done = await openOn(store, counting().drive);
    await done.session.send('the task');
    await done.session.turnEnd();
    await cutBeforePlacing(store, 'cut');
    return store;
  };
  const settled = await cutAfterATurn();
  await (await openOn(settled, counting().drive)).session.settleOpenTurn({ opening: 'cut' });
  const journaled = await cutAfterATurn();
  const journal = new NativeJournal(await openDrive({ writer: await journaled.open('step:s'), signal: new AbortController().signal }));
  journal.message(entry);
  await journal.flush();
  // Every field of the batch's intent and outcome, but when it was written and the writer's own id.
  const batch = async (store) => (await store.read('step:s')).filter((r) => r.kind === 'kernel.start' || r.kind === 'kernel.end').slice(-2).map(({ kind, data }) => {
    const { startedAt, ...rest } = data;
    return { kind, ...rest, ...(rest.output ? { output: { ...rest.output, writer: 'any' } } : {}) };
  });
  assert.deepEqual(await batch(settled), await batch(journaled));
  const folded = async (store) => {
    const state = foldSession('step:s', await store.read('step:s'));
    return { batches: journalBatches(state).map(({ batch: input, record, at }) => ({ input, at, key: record.key, stepId: record.stepId, attempt: record.attempt, status: record.status })), transcript: transcriptOf(state) };
  };
  assert.deepEqual(await folded(settled), await folded(journaled));
});
