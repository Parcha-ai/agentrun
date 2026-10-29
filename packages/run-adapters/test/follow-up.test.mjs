// A follow-up: once a session has answered, one more turn in the same session, sent at most once. Its intent is durable
// before the prompt leaves; a process that dies inside it leaves it interrupted, and the next process neither sends the
// prompt again nor resumes the cut turn. Its paid requests are held to a reserve of their own, counted from its own start,
// and an unknown spend is refused. Each "process" here is a store open, a booking and a faux session on one memory store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelPortFor } from '@parcha/agentrun-adapters';
import { FAUX_RECORDS, fauxAdapter, memorySessionStore } from '@parcha/agentrun-adapters/testing';

const PROMPT = 'One more thing before you finish.';
const SESSION = 'chat:r1';
// Each test imports the step itself, so a missing export fails that test by name.
const kernel = () => import('@parcha/agentrun-adapters/kernel');

/** One process: the session's writer, its booking with the follow-up's guard ahead of the host's, and its faux session.
 *  `commits` counts the runs of a `never` tool, the follow-up's own side effect. */
async function processOn(store, adapter, { followUp, commits = { n: 0 } } = {}) {
  const controller = new AbortController();
  const writer = await store.open(SESSION);
  const booking = await modelPortFor(writer, { key: SESSION, beforeRequest: (request) => followUp?.beforeRequest(request) });
  await booking.bookCut();
  const tools = [{ name: 'commit', description: 'Commit the work.', inputSchema: { type: 'object' }, replay: 'never', call: async () => { commits.n += 1; return { text: 'committed' }; } }];
  const session = await adapter.open({ key: SESSION, label: 'r1', system: [], tools, context: 'fresh' }, { writer, models: booking.models, signal: controller.signal, onEvent: () => {} });
  return { session, booking, signal: controller.signal, kill: () => controller.abort(new Error('killed')) };
}
const prompts = async (store) => (await store.read(SESSION)).filter((r) => r.kind === FAUX_RECORDS.user && r.data.text === PROMPT).length;
const intents = async (store, key) => (await store.read(key)).filter((r) => r.kind === 'kernel.start').length;
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
/** The session as the follow-up drives it, with a settle the test counts. */
const targetOf = (session, counts = { settled: 0 }) => ({
  get state() { return session.state; },
  send: (text) => session.send(text),
  turnEnd: () => session.turnEnd(),
  settleOpenTurn: async () => { counts.settled += 1; },
});
const answered = async (p) => {
  await p.session.send('the task');
  assert.equal((await p.session.turnEnd()).status, 'completed');
};
const options = (store, extra = {}) => ({ store, session: SESSION, name: 'check', prompt: PROMPT, reserveUsd: 0.1, worstUsd: 0.01, ...extra });

test('after the answer, one follow-up turn in the same session: its intent first, then its prompt, sent once', async () => {
  const { followUpOnce, followUpKey, followUpState } = await kernel();
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'the answer' }, { end: true }, { call: 'commit' }, { say: 'noted' }, { end: true }] });
  const commits = { n: 0 };
  const followUp = followUpOnce(options(store));
  assert.equal(followUp.key, followUpKey(SESSION, 'check'));
  assert.equal(followUp.key, 'chat:r1:follow-up:check');
  const p = await processOn(store, adapter, { followUp, commits });
  await answered(p);
  assert.deepEqual(await followUp.run(targetOf(p.session), new AbortController().signal), { status: 'done' });
  assert.deepEqual([await prompts(store), commits.n, adapter.requests], [1, 1, 5]);
  assert.equal(await intents(store, followUp.key), 1);
  assert.equal(followUpState(await store.read(followUp.key)), 'done');
  // Asked again, by a later process: answered from the record, nothing sent.
  const later = followUpOnce(options(store));
  assert.deepEqual(await later.run(targetOf(p.session), new AbortController().signal), { status: 'done' });
  assert.deepEqual([await prompts(store), adapter.requests], [1, 5]);
});

test('a session with no follow-up record and a turn still open is refused: the host recovers its own turn first', async () => {
  const { followUpOnce } = await kernel();
  const store = memorySessionStore();
  const followUp = followUpOnce(options(store));
  let sent = 0;
  const target = { state: 'open_turn', send: async () => { sent += 1; }, turnEnd: async () => ({ status: 'completed' }), settleOpenTurn: async () => {} };
  await assert.rejects(followUp.run(target, new AbortController().signal), /open turn/);
  assert.equal(sent, 0);
  assert.equal(await intents(store, followUp.key), 0);
});

test('a crash after the intent and before the prompt left: the next process reports interrupted and never sends it', async () => {
  const { followUpOnce, followUpState } = await kernel();
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'the answer' }, { end: true }, { say: 'never asked' }, { end: true }] });
  const first = await processOn(store, adapter);
  await answered(first);
  const dying = followUpOnce(options(store));
  // This process dies inside send: the intent is written, the prompt never leaves.
  void dying.run({ ...targetOf(first.session), state: 'idle', send: () => new Promise(() => {}) }, first.signal).catch(() => {});
  await settle();
  assert.equal(await intents(store, dying.key), 1);
  first.kill();
  assert.equal(followUpState(await store.read(dying.key)), 'running');

  const next = await processOn(store, adapter);
  let sent = 0;
  const counts = { settled: 0 };
  const result = await followUpOnce(options(store)).run({ ...targetOf(next.session, counts), state: next.session.state, send: async () => { sent += 1; } }, new AbortController().signal);
  assert.equal(result.status, 'interrupted');
  assert.deepEqual([sent, counts.settled, await prompts(store), adapter.requests], [0, 0, 0, 2]);
  assert.equal(followUpState(await store.read(dying.key)), 'interrupted');
});

test('a crash after the follow-up\'s tool ran and before its turn ended: one prompt, one commit, the cut turn settled, never resumed', async () => {
  const { followUpOnce, followUpState } = await kernel();
  const store = memorySessionStore();
  const commits = { n: 0 };
  const adapter = fauxAdapter({ script: () => [{ say: 'the answer' }, { end: true }, { call: 'commit' }, { cut: true }, { say: 'resumed: must never be asked' }, { end: true }] });
  const first = await processOn(store, adapter, { commits });
  await answered(first);
  const dying = followUpOnce(options(store));
  void dying.run(targetOf(first.session), first.signal).catch(() => {});
  // Held here: the commit's outcome is durable and the next paid request has left, unanswered.
  for (let i = 0; i < 500 && adapter.requests < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([commits.n, adapter.requests], [1, 4]);
  first.kill();

  const next = await processOn(store, adapter, { commits });
  assert.equal(next.session.state, 'open_turn');
  // What a host reads before it resumes an open turn: this one is the follow-up's, so it is settled, not recovered.
  assert.equal(followUpState(await store.read(dying.key)), 'running');
  let recovered = 0;
  const counts = { settled: 0 };
  const target = { ...targetOf(next.session, counts), state: next.session.state, recover: async () => { recovered += 1; } };
  const result = await followUpOnce(options(store)).run(target, new AbortController().signal);
  assert.equal(result.status, 'interrupted');
  assert.deepEqual([recovered, counts.settled], [0, 1]);
  assert.deepEqual([await prompts(store), commits.n, adapter.requests], [1, 1, 4]);
  // The request the crash cut is booked once at an unknown price: the session's spend is unknown, never that request at $0.
  assert.equal(next.booking.spentUsd(), null);
  // Run once more: the turn is settled already, so nothing is asked of the session again.
  await followUpOnce(options(store)).run({ ...target, state: 'idle' }, new AbortController().signal);
  assert.equal(counts.settled, 1);
});

test('a follow-up turn the host interrupts is recorded interrupted: a later process settles nothing and sends nothing', async () => {
  const { followUpOnce, followUpState } = await kernel();
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'the answer' }, { end: true }, { hang: true }] });
  const followUp = followUpOnce(options(store));
  const p = await processOn(store, adapter, { followUp });
  await answered(p);
  const running = followUp.run(targetOf(p.session), new AbortController().signal);
  await settle();
  await p.session.interrupt();
  assert.deepEqual(await running, { status: 'interrupted' });
  assert.equal(followUpState(await store.read(followUp.key)), 'interrupted');
  const counts = { settled: 0 };
  assert.deepEqual(await followUpOnce(options(store)).run(targetOf(p.session, counts), new AbortController().signal), { status: 'interrupted' });
  assert.deepEqual([await prompts(store), counts.settled], [1, 0]);
});

test('an unknown spend is refused in the follow-up: its turn fails on the budget and no request leaves', async () => {
  const { followUpOnce, followUpState, FOLLOW_UP_BUDGET_REACHED } = await kernel();
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'the answer', usd: null }, { end: true }, { say: 'must not be sent' }, { end: true }] });
  const followUp = followUpOnce(options(store));
  const p = await processOn(store, adapter, { followUp });
  await answered(p);
  assert.equal(p.booking.spentUsd(), null);
  const result = await followUp.run(targetOf(p.session), new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.ok(result.error.startsWith(FOLLOW_UP_BUDGET_REACHED), result.error);
  assert.deepEqual([adapter.requests, await prompts(store)], [2, 1]);
  assert.equal(followUpState(await store.read(followUp.key)), 'failed');
});

test('the reserve counts from the follow-up\'s own start: the task\'s spend does not count, and requests stop at its edge', async () => {
  const { followUpOnce } = await kernel();
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'the answer', usd: 1 }, { end: true, usd: 1 }, { say: 'a', usd: 0.04 }, { say: 'b', usd: 0.04 }, { say: 'c', usd: 0.04 }, { end: true }] });
  const followUp = followUpOnce(options(store, { worstUsd: 0.04 }));
  const p = await processOn(store, adapter, { followUp });
  await answered(p);
  const result = await followUp.run(targetOf(p.session), new AbortController().signal);
  // $0.08 spent since it began, and the next could cost $0.04 more, past $0.10: the third request is refused.
  assert.equal(result.status, 'failed');
  assert.equal(adapter.requests, 4);
});

test('outside the follow-up the guard admits and refuses nothing: the host decides the task\'s requests', async () => {
  const { followUpOnce } = await kernel();
  const followUp = followUpOnce(options(memorySessionStore()));
  assert.equal(followUp.beforeRequest({ key: SESSION, label: 'r1', model: 'faux', turn: 1, maxTurns: null, spentUsd: null, inFlight: [] }), undefined);
});

test('the reserve must be a number of dollars above 0', async () => {
  const { followUpOnce } = await kernel();
  for (const reserveUsd of [0, -1, Number.NaN, Infinity, '0.1']) assert.throws(() => followUpOnce(options(memorySessionStore(), { reserveUsd })), /reserveUsd/);
});

test('the worst case of a request is required: a host with none passes 0, never leaves it out', async () => {
  const { followUpOnce } = await kernel();
  const { worstUsd: _omitted, ...without } = options(memorySessionStore());
  assert.throws(() => followUpOnce(without), /worstUsd/);
  for (const worstUsd of [-0.01, Number.NaN, Infinity, '0.01', null]) assert.throws(() => followUpOnce(options(memorySessionStore(), { worstUsd })), /worstUsd/);
  assert.equal(typeof followUpOnce(options(memorySessionStore(), { worstUsd: 0 })).run, 'function');
});

test('the kernel knows no learning: its exports and the follow-up\'s source name no reflection, learning or memo', async () => {
  const words = /reflect|learn|memo/i;
  const exported = Object.keys(await kernel());
  assert.ok(exported.includes('followUpOnce'), 'the follow-up is exported');
  assert.deepEqual(exported.filter((name) => words.test(name)), []);
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/kernel/follow-up.ts', import.meta.url), 'utf8');
  assert.deepEqual(source.split('\n').filter((line) => words.test(line)), []);
});
