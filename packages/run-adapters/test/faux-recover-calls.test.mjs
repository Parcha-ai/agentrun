// The faux harness's recovered turn runs only the calls of a request whose reply came back: one its gate parked runs
// once the session is opened again, but one whose request was cut off while held at its `until` (no reply yet) never
// runs on the recovery, before or after that file exists, as a real CLI's resume runs only the tool calls its
// transcript holds.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FAUX_RECORDS, fauxAdapter, memorySessionStore } from '@parcha/agentrun-kernel/testing';

const models = { beforeRequest: async () => {}, afterRequest: async () => {} };
const spec = (key, ran) => ({
  key,
  label: 'faux',
  system: ['Answer.'],
  tools: [{ name: 'lookup', description: 'Look it up.', inputSchema: { type: 'object' }, replay: 'never', call: async (args) => { ran.push(args); return { text: 'found' }; } }],
  context: 'fresh',
});
const until = async (done, what) => {
  for (const end = Date.now() + 10_000; !(await done()); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > end) throw new Error(`not within 10 s: ${what}`);
  }
};

/** Opens a session of `script` on `store`, with `gate`; its io's signal is the returned controller's. The text it streams
 *  goes to `said`, when given. */
async function opened(store, key, script, ran, gate, said) {
  const controller = new AbortController();
  const onEvent = (event) => { if (event.type === 'text') said?.push(event.delta); };
  const session = await fauxAdapter({ script: () => script }).open(spec(key, ran), { store, writer: await store.open(key), models, signal: controller.signal, onEvent, ...(gate ? { gate } : {}) });
  return { session, controller };
}

test('a call whose request was cut off at its until, before the reply, is not run when the turn is recovered', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'faux-recover-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const held = join(dir, 'reply');
  const script = [{ call: 'lookup', args: { q: 'x' }, until: held }, { say: 'went on' }, { end: true }];
  const store = memorySessionStore();
  const ran = [];
  let asked = 0;
  const gate = async () => { asked += 1; return 'allow'; };
  const first = await opened(store, 'step:cut', script, ran, gate);
  await first.session.send('go');
  // The request is sent and held at its until: then the process goes.
  await until(async () => (await store.read('step:cut')).some((r) => r.kind === FAUX_RECORDS.request), 'the request held in flight');
  first.controller.abort(new Error('the process went'));
  await first.session.close();
  const second = await opened(store, 'step:cut', script, ran, gate);
  assert.equal(second.session.state, 'open_turn');
  await second.session.recover();
  assert.equal((await second.session.turnEnd()).status, 'completed');
  await second.session.close();
  assert.equal(existsSync(held), false, 'its reply never came');
  assert.deepEqual([ran, asked], [[], 0], 'the call was never asked about nor run: its request had no reply');
  const records = await store.read('step:cut');
  assert.deepEqual(records.filter((r) => r.kind === FAUX_RECORDS.answered), [], 'no reply recorded');
});

test('a call its gate parked after its request was answered runs once when the turn is recovered, asked again first', async () => {
  const script = [{ call: 'lookup', args: { q: 'x' } }, { end: true }];
  const store = memorySessionStore();
  const ran = [];
  const asked = [];
  const first = await opened(store, 'step:parked', script, ran, async (call) => { asked.push(['first', call.callId]); return { park: true }; });
  await first.session.send('go');
  await until(() => asked.length === 1, 'the call reached its gate');
  first.controller.abort(new Error('the run parked'));
  await first.session.close();
  assert.deepEqual(ran, [], 'nothing ran while it was parked');
  const second = await opened(store, 'step:parked', script, ran, async (call) => { asked.push(['again', call.callId]); return 'allow'; });
  assert.equal(second.session.state, 'open_turn');
  await second.session.recover();
  assert.equal((await second.session.turnEnd()).status, 'completed');
  await second.session.close();
  assert.deepEqual(asked, [['first', 'step:parked:0'], ['again', 'step:parked:0']], 'asked again under its own id');
  assert.deepEqual(ran, [{ q: 'x' }], 'ran once');
});

test('a reply of two calls whose first parked says each call\'s text once: the parked call\'s before the park, the second\'s on the recovery', async () => {
  const script = [{ calls: [{ call: 'lookup', args: { q: 'a' }, say: 'Looking up a.' }, { call: 'lookup', args: { q: 'b' }, say: 'Looking up b.' }] }, { end: true }];
  const store = memorySessionStore();
  const ran = [];
  const [before, after] = [[], []];
  let parkedAt;
  const first = await opened(store, 'step:two', script, ran, async (call) => { parkedAt = call.callId; return { park: true }; }, before);
  await first.session.send('go');
  await until(() => parkedAt !== undefined, 'the first call reached its gate');
  first.controller.abort(new Error('the run parked'));
  await first.session.close();
  assert.deepEqual([parkedAt, before], ['step:two:0.0', ['Looking up a.']], 'parked on the first call, its text said, the second\'s not yet');
  const second = await opened(store, 'step:two', script, ran, async () => 'allow', after);
  await second.session.recover();
  assert.equal((await second.session.turnEnd()).status, 'completed');
  await second.session.close();
  assert.deepEqual(after, ['Looking up b.'], 'the recovery says the second call\'s text, and never the parked one\'s again');
  assert.deepEqual(ran, [{ q: 'a' }, { q: 'b' }], 'both ran once, in order');
});

// A call a crash cut off mid-call (its intent in the log, no outcome), as a run's process left it.
async function cutMidCall(store, key) {
  const writer = await store.open(key);
  await writer.append([
    { kind: FAUX_RECORDS.user, data: { text: 'go' } },
    { kind: FAUX_RECORDS.turn, data: { n: 1 } },
    { kind: FAUX_RECORDS.request, data: { index: 0 } },
    { kind: FAUX_RECORDS.answered, data: { index: 0 } },
    { kind: FAUX_RECORDS.call, data: { callId: `${key}:0`, name: 'lookup' } },
  ]);
}

test('a call a crash cut off mid-call, its action marked `again`, is issued again on the recovery, its gate asked with `replayed`; unmarked, it is answered interrupted and never asked', async () => {
  for (const again of [true, false]) {
    const key = `step:cut-${again}`;
    const script = [{ call: 'lookup', args: { q: 'x' }, ...(again ? { again } : {}) }, { end: true }];
    const store = memorySessionStore();
    await cutMidCall(store, key);
    const ran = [];
    const asked = [];
    const session = (await opened(store, key, script, ran, async (call) => (asked.push(call), { deny: 'denied on the replay' }))).session;
    assert.equal(session.state, 'open_turn');
    await session.recover();
    assert.equal((await session.turnEnd()).status, 'completed');
    await session.close();
    const results = (await store.read(key)).filter((r) => r.kind === FAUX_RECORDS.result).map((r) => r.data);
    if (again) {
      assert.deepEqual(asked, [{ callId: `${key}:0`, tool: 'lookup', args: { q: 'x' }, replayed: true }], 'asked again under its id, as replayed');
      assert.deepEqual(results, [{ callId: `${key}:0`, isError: true, refused: true }], 'the deny is its answer');
    } else {
      assert.deepEqual(asked, [], 'never asked again');
      assert.deepEqual(results, [{ callId: `${key}:0`, interrupted: true }], 'answered interrupted');
    }
    assert.deepEqual(ran, [], 'never run again');
  }
});
