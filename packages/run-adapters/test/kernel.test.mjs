// The kernel the copied harness code runs on, over a session store: an effect is recorded before it runs and answered
// from its records after; a process that died inside one leaves it to the next drive, which runs a `safe` one again and
// reports a `never` one interrupted, never running it again. Each "process" here is a drive opened on the same store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EffectFailure, foldSession, INTERRUPTED_TEXT, openDrive, readBlobs, Restart } from '@parcha/agentrun-adapters/kernel';
import { SessionFenced } from '@parcha/agentrun-adapters';
import { NativeJournal, placeSubmissions, readJournal, recoveryNote, toolBridge, toolKey, transcriptOf } from '@parcha/agentrun-adapters/process';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';

/** One process's drive: it takes the session (every earlier drive's writer is fenced from now on), then opens on it. */
const open = async (store, signal = new AbortController().signal) => openDrive({ writer: await store.open('run-1'), signal });
/** A process that dies inside `fn`: its drive is abandoned with the effect's intent written and no outcome. */
async function diesInside(drive, key, options) {
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  void drive.effect(key, options, () => { entered(); return new Promise(() => {}); }).catch(() => {});
  await inside;
}

test('an effect runs once: its intent, then its outcome; a later call is answered from the records', async () => {
  const store = memorySessionStore();
  let runs = 0;
  const first = await open(store);
  assert.deepEqual(await first.effect('k', { name: 'lookup', replay: 'never', input: { q: 1 } }, async () => { runs += 1; return { found: true }; }), { found: true });
  const second = await open(store);
  assert.equal(second.isMemoized('k'), true);
  assert.deepEqual(await second.effect('k', { name: 'lookup', replay: 'never', input: { q: 1 } }, async () => { runs += 1; return { found: false }; }), { found: true });
  await assert.rejects(second.effect('bad', { name: 'x', replay: 'never', input: {} }, async () => { throw new Error('no'); }), (error) => error instanceof EffectFailure && error.error.message === 'no');
  await assert.rejects((await open(store)).effect('bad', { name: 'x', replay: 'never', input: {} }, async () => 'never runs'), EffectFailure);
  assert.equal(runs, 1);
});

test("a process that died inside a never effect leaves it interrupted: the next drive reports it and never runs it again", async () => {
  const store = memorySessionStore();
  await diesInside(await open(store), 'tool:c1', { name: 'tool.pay', replay: 'never', input: { amount: 5 } });
  const next = await open(store);
  const record = next.state().effects.get('tool:c1');
  assert.deepEqual([record.status, record.error], ['failed', { message: INTERRUPTED_TEXT, interrupted: true }]);
  let ran = false;
  await assert.rejects(next.effect('tool:c1', { name: 'tool.pay', replay: 'never', input: { amount: 5 } }, async () => { ran = true; }), (error) => error.error.interrupted === true);
  assert.equal(ran, false);
});

test('a process that died inside a safe effect leaves it to run again, as its next attempt', async () => {
  const store = memorySessionStore();
  await diesInside(await open(store), 'tool:r1', { name: 'tool.read', replay: 'safe', input: {} });
  const next = await open(store);
  assert.equal(next.state().effects.get('tool:r1').status, 'pending');
  assert.equal(await next.effect('tool:r1', { name: 'tool.read', replay: 'safe', input: {} }, async () => 'read'), 'read');
  const record = (await open(store)).state().effects.get('tool:r1');
  assert.deepEqual([record.status, record.attempt, record.output], ['completed', 1, 'read']);
});

test('input is placed before it is sent, and a withdraw that lands first wins', async () => {
  const store = memorySessionStore();
  const drive = await open(store);
  for (const id of ['a', 'b']) await drive.submit({ id, kind: 'prompt', text: id });
  await drive.submit({ id: 'w', kind: 'withdraw', target: 'b' });
  assert.deepEqual(drive.pending().map((s) => s.id), ['a']);
  await placeSubmissions(drive, drive.pending());
  assert.deepEqual(drive.pending(), []);
  await drive.submit({ id: 'w2', kind: 'withdraw', target: 'a' });
  const later = await open(store);
  assert.deepEqual([[...later.state().placed], [...later.state().withdrawn]], [['a'], ['b']], 'a withdraw after the placement does not land');
});

test('a new submission wakes a drive that waits for one', async () => {
  const drive = await open(memorySessionStore());
  let woke = 0;
  const off = drive.onHint(() => { woke += 1; });
  await drive.submit({ id: 'x', kind: 'prompt', text: 'hi' });
  off();
  await drive.submit({ id: 'y', kind: 'prompt', text: 'again' });
  assert.equal(woke, 1);
});

test('the copied journal keeps native records across drives, a large one as a blob in the session\'s own records', async () => {
  const store = memorySessionStore();
  const big = 'x'.repeat(40_000);
  const first = await open(store);
  const journal = new NativeJournal(first, { blobPieceChars: 10_000 });
  journal.append('rollout:t', { line: 1 });
  journal.append('rollout:t', { line: big });
  journal.message({ type: 'message', role: 'user', text: 'hello' });
  await journal.flush();
  const next = await open(store);
  const records = await readJournal(next, 'rollout:t');
  assert.deepEqual(records.map((r) => r.data), [{ line: 1 }, { line: big }]);
  assert.equal((await readBlobs(next.world, 'run-1')).size, 1);
  assert.deepEqual(transcriptOf(next.state()).map((r) => r.data.text), ['hello']);
  // The journal resumes where the log left off.
  assert.equal(new NativeJournal(next).length('rollout:t'), 2);
});

test('the copied tool bridge runs a never call once, and after a crash the recovery note says it may have taken effect', async () => {
  const store = memorySessionStore();
  let pays = 0;
  const pay = { name: 'pay', description: 'Pay.', inputSchema: { type: 'object' }, replay: 'never', execute: async () => { pays += 1; return new Promise(() => {}); } };
  const first = await open(store);
  const journal = new NativeJournal(first);
  await placeSubmissions(first, [await first.submit({ id: 's1', kind: 'prompt', text: 'Pay the invoice.' }).then(() => first.pending()[0])]);
  journal.message({ type: 'message', role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'pay' }] });
  await journal.flush();
  void toolBridge(first, [pay], { live: false }).call('pay', { amount: 5 }, 'c1').catch(() => {});
  while (pays < 1) await new Promise((resolve) => setImmediate(resolve));
  // The next process: the call is interrupted, never run again, and the note says so.
  const next = await open(store);
  const result = await toolBridge(next, [pay], { live: false }).call('pay', { amount: 5 }, 'c1');
  assert.equal(result.isError, true);
  assert.equal(pays, 1);
  assert.equal(next.state().effects.get(toolKey('c1')).error.interrupted, true);
  const note = recoveryNote(next.state());
  assert.ok(note, 'the turn the crash cut off is owed a recovery note');
  assert.match(note.text, /may have taken effect/);
});

test('the store fences a writer once a newer open of its session resolves, before the newer one writes anything', async () => {
  const store = memorySessionStore();
  const a = await store.open('s');
  await a.append([{ kind: 'x', data: 'a1' }]);
  const b = await store.open('s');
  await assert.rejects(a.append([{ kind: 'x', data: 'a2' }]), (error) => error instanceof SessionFenced && error.key === 's');
  await b.append([{ kind: 'x', data: 'b1' }]);
  assert.deepEqual((await store.read('s')).map((r) => r.data), ['a1', 'b1'], "the fenced append wrote nothing");
  // Another session's writers are untouched.
  const other = await store.open('t');
  await b.append([{ kind: 'x', data: 'b2' }]);
  await other.append([{ kind: 'x', data: 't1' }]);
  assert.deepEqual([(await store.read('s')).length, (await store.read('t')).length], [3, 1]);
});

// K1: a process whose lease lapsed while it was still alive. Once a newer drive opens the session (and writes nothing),
// the stale drive must not dispatch a new `never` effect: its intent is refused, and it gets a Restart, not a result.
test('K1: a stale drive does not dispatch a never effect after a newer drive opened', async () => {
  const store = memorySessionStore();
  const a = await open(store);
  await open(store);
  let ran = 0;
  await assert.rejects(a.effect('send-email', { name: 'send', replay: 'never' }, async () => { ran += 1; return 'sent'; }), Restart);
  assert.equal(ran, 0, 'the stale drive dispatched a never effect after it lost the session');
});

// K2: two drives that each write the same key's first intent would share a stepId, so one drive's outcome would be
// applied to the other's intent. The stale one's intent is refused instead: only the drive whose output the log holds
// returns normally.
test("K2: an outcome is never applied to another drive's intent", async () => {
  const store = memorySessionStore();
  const a = await open(store);
  const b = await open(store);
  let releaseA;
  const aDone = a.effect('journal:0', { name: 'journal', replay: 'safe' }, () => new Promise((r) => { releaseA = () => r('A-batch'); })).catch((e) => e);
  await new Promise((r) => setTimeout(r, 10));
  const bOut = await b.effect('journal:0', { name: 'journal', replay: 'safe' }, async () => 'B-batch').catch((e) => e);
  releaseA?.();
  const aOut = await aDone;
  const folded = foldSession('run-1', await store.read('run-1')).effects.get('journal:0');
  const winners = [aOut, bOut].filter((o) => typeof o === 'string');
  assert.deepEqual(winners, [folded.output], `A returned ${String(aOut)}, B returned ${String(bOut)}, the log holds ${folded.output}`);
  assert.ok(aOut instanceof Restart, `the stale drive was told to rebuild: ${aOut}`);
});
