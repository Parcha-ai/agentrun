// A turn its session interrupted (a person's stop) is still open when the next process opens the session: an interrupt
// writes no end. settleOpenTurn() records it as ended, interrupted, and sends nothing, so it is never resumed: the session
// is idle in this process and in the next one, and the next message is a turn of its own. The faux adapter, in-memory
// store; each "process" is a store open and a faux session.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FAUX_RECORDS, fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';

const SESSION = 'chat:stop';
const models = { beforeRequest: async () => {}, afterRequest: async () => {} };

test("the faux session settles a turn its interrupt left open: ended interrupted, nothing sent, idle here and in the next process; the next message is a turn of its own", async () => {
  const store = memorySessionStore();
  let inside;
  const reached = new Promise((resolve) => { inside = resolve; });
  const wait = { name: 'wait', description: 'Wait.', inputSchema: { type: 'object' }, replay: 'safe', call: (_args, { signal }) => { inside(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cut')), { once: true })); } };
  // The first process's turn holds at the stop: its call is cut, and nothing after it runs (faux answers a cut call as an
  // error and would go on). A later process's script goes on to the next turn's answer.
  let stopped = false;
  const adapter = fauxAdapter({ script: () => [{ call: 'wait' }, ...(stopped ? [{ say: 'the next turn' }, { end: true }] : [{ hang: true }])] });
  const spec = { key: SESSION, label: 'stop', system: [], tools: [wait], context: 'fresh' };
  const open = async () => adapter.open(spec, { writer: await store.open(SESSION), models, signal: new AbortController().signal, onEvent: () => {} });

  const first = await open();
  await first.send('go');
  await reached;
  const ending = first.turnEnd();
  await first.interrupt();
  assert.equal((await ending).status, 'interrupted');
  await first.close();
  stopped = true;

  const next = await open();
  assert.equal(next.state, 'open_turn', 'the interrupted turn is open to the next process');
  const requests = adapter.requests;
  await next.settleOpenTurn();
  assert.equal(next.state, 'idle');
  assert.equal(adapter.requests, requests, 'nothing sent');
  const ends = (await store.read(SESSION)).filter((r) => r.kind === FAUX_RECORDS.turnEnd).map((r) => r.data.status);
  assert.deepEqual(ends, ['interrupted'], 'the turn ended, interrupted, in the session');
  await next.close();

  const text = [];
  const later = await adapter.open(spec, { writer: await store.open(SESSION), models, signal: new AbortController().signal, onEvent: (e) => { if (e.type === 'text') text.push(e.delta); } });
  assert.equal(later.state, 'idle', 'settled for good: the next process finds no open turn');
  await later.send('and now?');
  assert.equal((await later.turnEnd()).status, 'completed');
  assert.equal(text.join(''), 'the next turn', 'the next message is answered by its own turn');
  await later.close();
});

test('settleOpenTurn() refuses a session with no open turn', async () => {
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'hi' }, { end: true }] });
  const session = await adapter.open({ key: SESSION, label: 'stop', system: [], tools: [], context: 'fresh' }, { writer: await store.open(SESSION), models, signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(session.state, 'new');
  await assert.rejects(session.settleOpenTurn(), /no turn to settle/);
  await session.close();
});

test("a settled turn's end is the kernel's abortedOutcome of the session's own stop: settleTurn and faux's settle keep no interrupted end of their own", () => {
  // Structural, as each adapter's guard: one path for an interrupted turn's end, the kernel's abortedOutcome.
  for (const file of ['../src/process/settle.ts', '../src/testing.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /abortedOutcome\(AbortSignal\.abort\(new SessionHalt\("interrupted"\)\)\)/, file);
    assert.doesNotMatch(source, /status:\s*"interrupted"/, file);
  }
});

// A prompt the person stopped before the harness placed it is kept for the conversation: settleTurn's withdraw carries
// its text, and the next prompt or follow-up the harness takes (`pending()`) has it first, then a line saying it was
// stopped before any work on it began, then its own text. Carried once, in order; a steer never carries.
const kernel = await import('@parcha/agentrun-kernel/kernel');
const processKit = await import('@parcha/agentrun-kernel/process');
const openOn = async (store) => kernel.openDrive({ writer: await store.open('run-carry'), signal: new AbortController().signal });
const STOPPED_ONE = '(The message above was stopped before any work on it began.)';
const STOPPED_MANY = '(The messages above were stopped before any work on them began.)';

test("a prompt stopped before it was placed is carried into the next one: its text, the stopped line, then the follow-up's; once only", async () => {
  const store = memorySessionStore();
  const drive = await openOn(store);
  await drive.submit({ id: 's1', kind: 'prompt', text: 'Write five files.' });
  await processKit.settleTurn(drive);
  assert.deepEqual(drive.pending(), [], 'nothing of the stopped turn is left to run on its own');
  await drive.submit({ id: 's2', kind: 'followUp', text: 'Go on.' });
  const [next] = drive.pending();
  assert.equal(next?.text, `Write five files.\n\n${STOPPED_ONE}\n\nGo on.`);
  await processKit.placeSubmissions(drive, [next]);
  await drive.submit({ id: 's3', kind: 'followUp', text: 'And then?' });
  assert.deepEqual(drive.pending().map((s) => s.text), ['And then?'], 'carried once: the message after it has its own text alone');
  // A later process folds the same.
  const again = await openOn(store);
  assert.deepEqual(again.pending().map((s) => s.text), ['And then?']);
});

test('several stopped prompts are carried in order into the next one; a stopped steer is not carried', async () => {
  const store = memorySessionStore();
  const drive = await openOn(store);
  await drive.submit({ id: 'a', kind: 'prompt', text: 'First.' });
  await processKit.settleTurn(drive);
  await drive.submit({ id: 'b', kind: 'followUp', text: 'Second.' });
  await processKit.settleTurn(drive);
  await drive.submit({ id: 'c', kind: 'steer', text: 'Faster.' });
  await processKit.settleTurn(drive);
  await drive.submit({ id: 'd', kind: 'followUp', text: 'Third.' });
  assert.deepEqual(drive.pending().map((s) => s.text), [`First.\n\nSecond.\n\n${STOPPED_MANY}\n\nThird.`]);
});

test("a follow-up placed with a carry holds the carried text in the session's state, for every reader of a placed submission (a crash's recovery)", async () => {
  const store = memorySessionStore();
  const drive = await openOn(store);
  await drive.submit({ id: 's1', kind: 'prompt', text: 'Write five files.' });
  await processKit.settleTurn(drive);
  await drive.submit({ id: 's2', kind: 'followUp', text: 'Go on.' });
  await processKit.placeSubmissions(drive, drive.pending());
  // The process dies before the harness's CLI records the follow-up: the next one reads it from the session's state.
  const state = (await openOn(store)).state();
  const placed = state.submissions.filter((s) => state.placed.has(s.id)).map((s) => s.text);
  const note = processKit.recoveryNote(state, { prompts: true });
  assert.deepEqual([placed, note?.text.includes(`> Write five files.`)], [[`Write five files.\n\n${STOPPED_ONE}\n\nGo on.`], true]);
});
