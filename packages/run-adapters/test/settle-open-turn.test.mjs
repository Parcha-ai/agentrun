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

// A stop can land after the harness placed a prompt and before its CLI was sent it (the window between placeSubmissions
// and the send): the prompt is placed, so no withdraw takes it, and nothing sent it. The adapter reads whether its CLI
// recorded it; a placed prompt it never recorded is unsent, and settleTurn carries it (`unsent`) as it carries one
// stopped before it was placed. A prompt the host wrote (a follow-up's,
// `host`) is withdrawn and never carried: a host prompt that never ran is dropped (follow-up.ts).

test("a prompt placed but never sent, stopped: settleTurn's `unsent` carries it into the next one, and it stays placed, so nothing sends it on its own", async () => {
  const store = memorySessionStore();
  const drive = await openOn(store);
  await drive.submit({ id: 's1', kind: 'prompt', text: 'Write five files.' });
  await processKit.placeSubmissions(drive, drive.pending());
  await processKit.settleTurn(drive, { unsent: ['s1'] });
  await drive.submit({ id: 's2', kind: 'followUp', text: 'Go on.' });
  const state = drive.state();
  assert.deepEqual(
    { pending: drive.pending().map((s) => s.text), placed: state.placed.has('s1') },
    { pending: [`Write five files.\n\n${STOPPED_ONE}\n\nGo on.`], placed: true },
    'the placed prompt is carried into the next one, and stays placed',
  );
  // A later process folds the same.
  assert.deepEqual((await openOn(store)).pending().map((s) => s.text), [`Write five files.\n\n${STOPPED_ONE}\n\nGo on.`]);
});

test("a placed prompt and a pending one, both stopped: carried in the order they came, the placed one first; a placed prompt not named unsent (sent) is not carried, nor is a placed steer", async () => {
  const store = memorySessionStore();
  const drive = await openOn(store);
  await drive.submit({ id: 'a', kind: 'prompt', text: 'First.' });
  await processKit.placeSubmissions(drive, drive.pending());
  await drive.submit({ id: 'b', kind: 'followUp', text: 'Second.' });
  await processKit.settleTurn(drive, { unsent: ['a'] });
  await drive.submit({ id: 'c', kind: 'followUp', text: 'Third.' });
  assert.deepEqual(drive.pending().map((s) => s.text), [`First.\n\nSecond.\n\n${STOPPED_MANY}\n\nThird.`]);
  const sent = await openOn(memorySessionStore());
  await sent.submit({ id: 'x', kind: 'prompt', text: 'Sent.' });
  await sent.submit({ id: 'y', kind: 'steer', text: 'Faster.' });
  await processKit.placeSubmissions(sent, sent.pending());
  await processKit.settleTurn(sent, { unsent: ['y'] });
  await sent.submit({ id: 'z', kind: 'followUp', text: 'Next.' });
  assert.deepEqual(sent.pending().map((s) => s.text), ['Next.'], 'a sent prompt and a steer carry nothing');
});

test("a host's follow-up prompt named to the settle (`host`) is withdrawn and never carried, pending or placed and unsent; a person's message pending beside it is left as it is", async () => {
  const store = memorySessionStore();
  const drive = await openOn(store);
  await drive.submit({ id: 'follow-up:k', kind: 'prompt', text: 'Summarize the run.' });
  await drive.submit({ id: 'person', kind: 'followUp', text: "A person's message." });
  await processKit.settleTurn(drive, { host: 'follow-up:k' });
  assert.deepEqual(drive.pending().map((s) => [s.id, s.text]), [['person', "A person's message."]], "only the host's prompt is withdrawn, and nothing carries it");
  const placed = await openOn(memorySessionStore());
  await placed.submit({ id: 'follow-up:k', kind: 'prompt', text: 'Summarize the run.' });
  await processKit.placeSubmissions(placed, placed.pending());
  await processKit.settleTurn(placed, { host: 'follow-up:k', unsent: ['follow-up:k'] });
  await placed.submit({ id: 'next', kind: 'followUp', text: 'and now?' });
  assert.deepEqual(placed.pending().map((s) => s.text), ['and now?'], "a host prompt placed and never sent is not carried either");
});

// Why the settle and the next drive read the same log after a stop: a stopped drive writes nothing more. Its effects
// are refused before they write (drive.ts, `effect` on an aborted signal), so no journal batch, mirror line or mark
// of it lands; and a batch whose intent landed without its outcome counts for nothing (records.ts journalBatches), so
// a batch cut by the stop leaves no records.
test("a stopped drive's effect is refused before it writes anything: no journal batch, mirror line or mark of it lands", async () => {
  const store = memorySessionStore();
  const drive = await openOn(store);
  const before = (await store.read('run-carry')).length;
  drive.halt?.(new Error('stopped'));
  await assert.rejects(drive.effect('journal:0', { name: 'journal', replay: 'safe', input: {} }, async () => true), /stopped/);
  const journal = new processKit.NativeJournal(drive, { onPoison: () => {} });
  journal.append('claude', { type: 'user', uuid: 'u1' });
  await assert.rejects(journal.flush());
  assert.equal((await store.read('run-carry')).length, before, 'nothing written');
});

test("a journal batch whose intent landed and whose outcome did not (a drive cut between the two) counts for nothing: its records are not in the log", async () => {
  // A batch as a drive writes it: its intent and its outcome.
  const whole = memorySessionStore();
  const drive = await openOn(whole);
  const journal = new processKit.NativeJournal(drive);
  journal.append('claude', { type: 'user', uuid: 'u1' });
  await journal.flush();
  const records = await whole.read('run-carry');
  assert.equal(processKit.journalRecords(kernel.foldSession('run-carry', records)).length, 1, 'setup: the whole batch counts');
  // The same log with the batch's outcome cut off.
  const cut = records.filter((r) => !(r.kind === 'kernel.end' && String(r.data?.stepId ?? '').startsWith('journal:0')));
  assert.equal(cut.length, records.length - 1, 'setup: one outcome cut');
  const state = kernel.foldSession('run-carry', cut);
  assert.deepEqual([processKit.journalBatches(state).length, processKit.journalRecords(state).length], [0, 0]);
});
