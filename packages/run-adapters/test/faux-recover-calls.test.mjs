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
