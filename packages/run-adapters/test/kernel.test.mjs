// The kernel the copied harness code runs on, over a session store: an effect is recorded before it runs and answered
// from its records after; a process that died inside one leaves it to the next drive, which runs a `safe` one again and
// reports a `never` one interrupted, never running it again. Each "process" here is a drive opened on the same store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EffectFailure, Fatal, foldSession, INTERRUPTED_TEXT, KERNEL_RECORDS, openDrive, readBlobs, Restart, sha256Hex, writeBlob } from '@parcha/agentrun-kernel/kernel';
import { SessionFenced } from '@parcha/agentrun-kernel';
import { BuiltinCalls, NativeJournal, placeSubmissions, readJournal, recoveryNote, toolBridge, toolKey, transcriptOf } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

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

/** A key's records, as a drive writes them: an intent (`attempt` from 0), a release, an outcome. */
const start = (key, attempt, replay = 'never') => ({ kind: KERNEL_RECORDS.start, data: { key, stepId: `${key}#${attempt}`, name: 'tool.x', replay, input: {}, placed: [], attempt, startedAt: new Date(0).toISOString() } });
const release = (key, attempt) => ({ kind: KERNEL_RECORDS.retry, data: { stepId: `${key}#${attempt}` } });
const end = (key, attempt, output) => ({ kind: KERNEL_RECORDS.end, data: { stepId: `${key}#${attempt}`, status: 'completed', output } });

test("a late outcome of a key's earlier attempt never lands on its later one: the effect stays the later attempt's", async () => {
  // Attempt 0 was released (its process died) and attempt 1 started; then attempt 0's outcome arrives late.
  const records = [start('k', 0, 'safe'), release('k', 0), start('k', 1, 'safe'), end('k', 0, 'from attempt 0')];
  const effect = foldSession('s', records).effects.get('k');
  assert.deepEqual([effect.status, effect.stepId, effect.attempt, effect.output], ['running', 'k#1', 1, undefined]);
  // The next drive resolves the open intent as attempt 1's: released to run again, and the run is attempt 2.
  const store = memorySessionStore();
  await (await store.open('run-1')).append(records);
  const next = await open(store);
  assert.equal(next.state().effects.get('k').status, 'pending');
  assert.equal(await next.effect('k', { name: 'tool.x', replay: 'safe' }, async () => 'from attempt 2'), 'from attempt 2');
  const after = (await open(store)).state().effects.get('k');
  assert.deepEqual([after.status, after.attempt, after.output], ['completed', 2, 'from attempt 2']);
});

test("a key's first intent wins: a later intent for a completed key changes nothing", () => {
  const effect = foldSession('s', [start('k', 0), end('k', 0, 'kept'), start('k', 1)]).effects.get('k');
  assert.deepEqual([effect.status, effect.stepId, effect.output], ['completed', 'k#0', 'kept']);
});

test('a second call of an effect while its first is running is refused (Fatal), and its function runs once', async () => {
  const drive = await open(memorySessionStore());
  let runs = 0;
  let entered;
  let finish;
  const inside = new Promise((resolve) => { entered = resolve; });
  const first = drive.effect('k', { name: 'tool.x', replay: 'never' }, () => { runs += 1; entered(); return new Promise((resolve) => { finish = resolve; }); });
  await inside;
  await assert.rejects(drive.effect('k', { name: 'tool.x', replay: 'never' }, async () => { runs += 1; return 'second'; }), Fatal);
  finish('first');
  assert.equal(await first, 'first');
  assert.equal(runs, 1);
});

test('an effect whose function throws Restart or Fatal writes no outcome: the next drive resolves its intent', async () => {
  for (const [Kind, replay, resolved] of [[Restart, 'safe', 'pending'], [Fatal, 'never', 'failed']]) {
    const store = memorySessionStore();
    const drive = await open(store);
    await assert.rejects(drive.effect('k', { name: 'tool.x', replay }, async () => { throw new Kind('rebuild'); }), Kind);
    const records = await store.read('run-1');
    assert.equal(records.filter((r) => r.kind === KERNEL_RECORDS.end).length, 0, `${Kind.name}: no outcome was written`);
    const effect = (await open(store)).state().effects.get('k');
    assert.equal(effect.status, resolved, Kind.name);
    if (resolved === 'failed') assert.equal(effect.error.interrupted, true);
  }
});

// K10 (the DSL TL's probe): the window K5 does not reach. Both calls are issued before either intent is durable, so
// both would read the key as unknown and dispatch; a never effect runs once, and the second call is refused.
test('K10: two overlapping calls of one never effect, issued before either intent is durable, run it once', async () => {
  const drive = await open(memorySessionStore());
  let ran = 0;
  const fn = async () => { ran += 1; return 'paid'; };
  const results = await Promise.allSettled([
    drive.effect('pay', { name: 'pay', replay: 'never' }, fn),
    drive.effect('pay', { name: 'pay', replay: 'never' }, fn),
  ]);
  assert.equal(ran, 1, `fn ran ${ran} times; results ${JSON.stringify(results.map((r) => r.status))}`);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.ok(results[1].reason instanceof Fatal, String(results[1].reason));
});

test('K10, held: the second call is issued while the first intent write is held open; fn runs once and the second call is Fatal', async () => {
  const inner = await memorySessionStore().open('run-1');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let holdNext = false;
  let entered;
  const holding = new Promise((resolve) => { entered = resolve; });
  // The session's writer, with its next append held open until the test releases it.
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => { if (holdNext) { holdNext = false; entered(); await gate; } return inner.append(records); } };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  let ran = 0;
  const fn = async () => { ran += 1; return 'paid'; };
  holdNext = true;
  const first = drive.effect('pay', { name: 'pay', replay: 'never' }, fn);
  await holding;
  const second = drive.effect('pay', { name: 'pay', replay: 'never' }, fn);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(ran, 1, `fn ran ${ran} times`);
  assert.equal(results[0].value, 'paid');
  assert.ok(results[1].reason instanceof Fatal, String(results[1].reason));
});

test('a withdraw that lands between pending() and placing: the placement places nothing and throws Restart, and the next drive sends the rest', async () => {
  const store = memorySessionStore();
  const drive = await open(store);
  for (const id of ['a', 'b']) await drive.submit({ id, kind: 'prompt', text: id });
  const stale = drive.pending();
  await drive.submit({ id: 'w', kind: 'withdraw', target: 'b' });
  let sent = 0;
  await assert.rejects(drive.effect('place:a', { name: 'place', replay: 'safe', input: { ids: ['a', 'b'] }, placed: stale.map((s) => s.id) }, async () => { sent += 1; return true; }), Restart);
  assert.equal(sent, 0, 'the placement did not go on to send');
  assert.deepEqual([...drive.state().placed], [], 'a placement a withdraw beat places nothing, not even the rest');
  // The library call over the same stale list refuses the same way.
  await assert.rejects(placeSubmissions(await open(store), stale), Restart);
  // The rebuilt drive goes on: its fresh pending() no longer names b, so placing it is no second Restart; a is placed
  // and sent once, and b never placed.
  const next = await open(store);
  assert.deepEqual(next.pending().map((s) => s.id), ['a']);
  let sends = 0;
  const send = async (ctx) => { await placeSubmissions(ctx, ctx.pending()); for (const _ of ctx.state().effects.get('place:a').placed) sends += 1; };
  await assert.doesNotReject(send(next));
  assert.equal(sends, 1);
  assert.deepEqual([[...next.state().placed], next.pending()], [['a'], []]);
  // A drive after that has nothing left to place, and the log never placed b.
  const after = await open(store);
  assert.deepEqual([after.pending(), [...after.state().placed], after.state().effects.get('place:a').status], [[], ['a'], 'completed']);
  // The fold only ever adds to placed, so b missing from it now means no record ever placed b.
  assert.equal(after.state().placed.has('b'), false);
});

test('a blob written again with another piece size reads back whole and unmixed, and a reconstruction that does not hash to its name is not returned', async () => {
  const store = memorySessionStore();
  const drive = await open(store);
  const text = 'abcdefghijkl';
  const hash = await sha256Hex(text);
  await writeBlob(drive.world, 'run-1', text, { pieceChars: 4 });
  await writeBlob(drive.world, 'run-1', text, { pieceChars: 6 });
  assert.equal((await readBlobs(drive.world, 'run-1')).get(hash), text);
  // Pieces that join to other text under the hash's name (a corrupt or forged write) are not the blob.
  await (await store.open('forged')).append([{ kind: 'kernel.blob', data: { hash, piece: 0, count: 1, text: 'not it' } }]);
  const forged = await openDrive({ writer: await store.open('forged'), signal: new AbortController().signal });
  assert.equal((await readBlobs(forged.world, 'forged')).has(hash), false);
  // A blob is named by its own content: a hash that is not the text's is refused at the write.
  await assert.rejects(writeBlob(drive.world, 'run-1', text, { hash: '0'.repeat(64) }), TypeError);
});

test('a never placement of a submission already withdrawn in the log is refused before its intent: no start record, nothing for recovery to report', async () => {
  const store = memorySessionStore();
  const drive = await open(store);
  for (const id of ['a', 'b']) await drive.submit({ id, kind: 'prompt', text: id });
  await drive.submit({ id: 'w', kind: 'withdraw', target: 'b' });
  let ran = 0;
  await assert.rejects(drive.effect('send:a', { name: 'send', replay: 'never', placed: ['a', 'b'] }, async () => { ran += 1; }), Restart);
  assert.equal(ran, 0);
  assert.equal((await store.read('run-1')).some((r) => r.kind === KERNEL_RECORDS.start), false, 'no intent was written');
  // The next drive has no abandoned intent to call interrupted, and still has a pending.
  const next = await open(store);
  assert.equal(next.state().effects.has('send:a'), false);
  assert.deepEqual(next.pending().map((s) => s.id), ['a']);
});

test('a withdraw written while the placement is being decided: the placement places nothing, throws Restart and sends nothing', async () => {
  const store = memorySessionStore();
  const inner = await store.open('run-1');
  // A writer that keeps the contract (appends durable, and resolved, in order), with one append held open.
  let chain = Promise.resolve();
  let holdNext = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writer = { key: inner.key, read: () => inner.read(), append: (records) => (chain = chain.then(async () => { if (holdNext) { holdNext = false; await gate; } await inner.append(records); })) };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  for (const id of ['a', 'b']) await drive.submit({ id, kind: 'prompt', text: id });
  const stale = drive.pending();
  holdNext = true;
  const withdrawing = drive.submit({ id: 'w', kind: 'withdraw', target: 'b' });
  // The withdraw is not folded yet, so the check before the intent passes; the intent queues behind the withdraw.
  let sent = 0;
  const placing = drive.effect('place:a', { name: 'place', replay: 'safe', placed: stale.map((s) => s.id) }, async () => { sent += 1; });
  release();
  await withdrawing;
  await assert.rejects(placing, Restart);
  assert.equal(sent, 0);
  assert.deepEqual([...drive.state().placed], [], 'the log placed nothing');
});

test("two appends at once, the first resolved after the second: the live state is the log's, folded in the log's order", async () => {
  const store = memorySessionStore();
  const inner = await store.open('run-1');
  // Each append is durable at once, in call order; the first one's promise resolves only after the second's.
  let calls = 0;
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => {
    const n = (calls += 1);
    const durable = inner.append(records);
    await durable;
    if (n === 3) await firstHeld; // the withdraw (calls 1 and 2 are the two prompts)
    if (n === 4) releaseFirst(); // the placement's intent resolves first, then lets the withdraw resolve
  } };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  for (const id of ['a', 'b']) await drive.submit({ id, kind: 'prompt', text: id });
  const stale = drive.pending();
  let sent = 0;
  const withdrawing = drive.submit({ id: 'w', kind: 'withdraw', target: 'b' });
  const placing = drive.effect('place:a', { name: 'place', replay: 'safe', placed: stale.map((s) => s.id) }, async () => { sent += 1; });
  // Unqueued, the intent's append is called at once: it resolves first, the live state places a and b, and b is sent.
  setTimeout(releaseFirst, 50);
  await withdrawing;
  await placing.catch(() => {});
  const fresh = foldSession('run-1', await inner.read());
  assert.deepEqual([[...drive.state().placed], [...drive.state().withdrawn]], [[...fresh.placed], [...fresh.withdrawn]], "the live state is a fresh fold of the log");
  assert.equal(sent, 0, 'the withdrawn prompt was not sent');
});

test('an append that fails does not stall or fail the ones after it: a later submit lands and is folded', async () => {
  const inner = await memorySessionStore().open('run-1');
  let failNext = false;
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => { if (failNext) { failNext = false; throw new Error('the disk is full'); } await inner.append(records); } };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  failNext = true;
  await assert.rejects(drive.submit({ id: 'x', kind: 'prompt', text: 'lost' }), /the disk is full/, 'the caller gets its own error');
  await drive.submit({ id: 'y', kind: 'prompt', text: 'kept' });
  assert.deepEqual(drive.pending().map((s) => s.id), ['y']);
  assert.deepEqual(foldSession('run-1', await inner.read()).submissions.map((s) => s.id), ['y']);
});

test("a blob write goes through the drive's queue too: it waits behind an append in flight", async () => {
  const inner = await memorySessionStore().open('run-1');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let holdNext = false;
  const calls = [];
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => { calls.push(records[0].kind); if (holdNext) { holdNext = false; await gate; } await inner.append(records); } };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  holdNext = true;
  const submitting = drive.submit({ id: 'p', kind: 'prompt', text: 'hi' });
  const blob = writeBlob(drive.world, 'run-1', 'x'.repeat(10), { pieceChars: 4 });
  for (const end = Date.now() + 5_000; calls.length === 0; await new Promise((resolve) => setTimeout(resolve, 2))) if (Date.now() > end) throw new Error("timed out waiting for the submit's append");
  // A window for the blob's append, which must not come yet; it can only miss one, never fail the test by itself.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [KERNEL_RECORDS.submission], 'the blob waits for the submit');
  release();
  await submitting;
  await blob;
  assert.deepEqual(calls, [KERNEL_RECORDS.submission, 'kernel.blob']);
  assert.equal((await readBlobs(drive.world, 'run-1')).get(await sha256Hex('x'.repeat(10))), 'x'.repeat(10));
});

test("a built-in call its wrapper refuses before letting it go never runs, and is answered refused, so a hook can say it was not run", async () => {
  const inner = await memorySessionStore().open('run-1');
  const drive = await openDrive({ writer: inner, signal: new AbortController().signal });
  const calls = new BuiltinCalls(drive, { live: false, around: async () => { throw new Error('Bash was not run: the session is pausing'); } });
  const start = await calls.begin({ callId: 'c1', name: 'Bash', input: { command: 'pay' }, replay: 'never' });
  assert.equal(start.run, false, 'never told to run');
  assert.equal(start.refused, true, 'answered as refused, not as an outcome the log already had');
  assert.match(start.result.text, /was not run: the session is pausing/);
  assert.equal(start.result.isError, true);
  assert.equal(drive.signal.aborted, false, 'a refusal does not halt the drive');
});

test('a built-in call begun twice before its intent is durable runs once: the second begin waits for its outcome and is never told to run', async () => {
  const inner = await memorySessionStore().open('run-1');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let holdNext = false;
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => { if (holdNext) { holdNext = false; await gate; } await inner.append(records); } };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  const calls = new BuiltinCalls(drive, { live: false });
  const call = { callId: 'c1', name: 'Bash', input: { command: 'pay' }, replay: 'never' };
  holdNext = true; // the call's intent write is held open
  const first = calls.begin(call);
  const second = calls.begin(call);
  release();
  const starts = [await first];
  // The harness runs the call it was told to run, once, and reports it.
  await calls.end('c1', { text: 'paid' });
  starts.push(await second);
  assert.deepEqual(starts.map((s) => s.run), [true, false], 'told to run once');
  assert.deepEqual(starts[1].result, { text: 'paid', isError: false }, "the second begin answers with the first's outcome");
  assert.equal(drive.signal.aborted, false, 'a duplicate delivery does not halt the drive');
  // Begun again after it ended: answered from the log.
  assert.deepEqual(await calls.begin(call), { run: false, result: { text: 'paid', isError: false } });
});

test('refresh() reads nothing: an effect that completes while a read of the session would be in flight stays completed and never runs again', async () => {
  const inner = await memorySessionStore().open('run-1');
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let holdRead = false;
  const writer = { key: inner.key, read: async () => { reads += 1; const records = await inner.read(); if (holdRead) { holdRead = false; await gate; } return records; }, append: (records) => inner.append(records) };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  const atOpen = reads;
  holdRead = true;
  const refreshing = drive.refresh();
  let ran = 0;
  await drive.effect('pay', { name: 'pay', replay: 'never' }, async () => { ran += 1; return 'paid'; });
  release();
  await refreshing;
  assert.equal(drive.state().effects.get('pay')?.status, 'completed');
  assert.equal(await drive.effect('pay', { name: 'pay', replay: 'never' }, async () => { ran += 1; return 'again'; }), 'paid');
  assert.equal(ran, 1);
  assert.equal(reads, atOpen, 'refresh did not read the session');
});

test('a blob whose first write was cut short, written again whole with another piece size, reads back', async () => {
  const drive = await open(memorySessionStore());
  const text = 'abcdefghijkl';
  const hash = await sha256Hex(text);
  // The first write's first two pieces of three (4 characters each), then a crash.
  await drive.world.store.append([{ kind: 'kernel.blob', data: { hash, piece: 0, count: 3, text: 'abcd' } }, { kind: 'kernel.blob', data: { hash, piece: 1, count: 3, text: 'efgh' } }]);
  await writeBlob(drive.world, 'run-1', text, { pieceChars: 6 });
  assert.equal((await readBlobs(drive.world, 'run-1')).get(hash), text);
});

test("a duplicate begin whose first call's outcome could not be written stops with the drive: no result made up", async () => {
  const inner = await memorySessionStore().open('run-1');
  // The writer refuses the call's outcome, as a fenced one does.
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => { if (records.some((r) => r.kind === KERNEL_RECORDS.end)) throw new SessionFenced('run-1'); await inner.append(records); } };
  const drive = await openDrive({ writer, signal: new AbortController().signal });
  const calls = new BuiltinCalls(drive, { live: false });
  const call = { callId: 'c1', name: 'Bash', input: { command: 'pay' }, replay: 'never' };
  assert.equal((await calls.begin(call)).run, true);
  const second = calls.begin(call);
  await calls.end('c1', { text: 'paid' });
  await assert.rejects(second, (error) => error instanceof Restart && error === drive.signal.reason, 'the duplicate stops with the drive');
  assert.equal(drive.signal.aborted, true);
  assert.equal((await inner.read()).some((r) => r.kind === KERNEL_RECORDS.end), false, 'the log has no outcome');
});
