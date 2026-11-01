// What a host holds for a paid request (its beforeRequest answers `{holdUsd}`, the worst case its cap kept room for) is
// written on the request's record before it leaves. A request whose cost never comes in then counts at that figure in the
// spend the host is shown: one cut short in this process (its cost booked unknown), and one a crash cut off, read by a
// later process. A request with no such figure (an older session, or a host that holds none) stays unknown, as before.
// The booked cost itself is unchanged: such a request is still booked at an unknown price.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessRunError, modelPortFor, RUNNER_RECORDS } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const key = 'chat:c1';
/** The booking of session `key` in a new process, its host holding `hold` for each request (none when undefined). */
const port = async (store, hold, asked = []) => modelPortFor(await store.open(key), {
  key,
  beforeRequest: (r) => {
    asked.push(r.spentUsd);
    return hold === undefined ? undefined : { holdUsd: hold };
  },
});
const runnerRecords = async (store) => (await store.read(key)).filter((r) => r.kind.startsWith('runner.')).map((r) => [r.kind, r.data]);

test('the figure a host holds for a request is written on its record before it leaves; a request answered at a known cost counts at that cost', async () => {
  const store = memorySessionStore();
  const booking = await port(store, 0.25);
  await booking.models.beforeRequest({ model: 'm' });
  assert.deepEqual(await runnerRecords(store), [[RUNNER_RECORDS.request, { turn: 1, model: 'm', heldUsd: 0.25 }]]);
  await booking.models.afterRequest({ input: 10, output: 2, cacheRead: 0, usd: 0.01 });
  assert.equal(booking.spentUsd(), 0.01, 'its own cost, not the held figure');
});

test('a request cut short in this process (its cost booked unknown) counts at the figure held for it, and the next host check sees that spend', async () => {
  const store = memorySessionStore();
  const asked = [];
  const booking = await port(store, 0.25, asked);
  await booking.models.beforeRequest({ model: 'm' });
  await booking.models.afterRequest({ input: 0, output: 0, cacheRead: 0, usd: null });
  assert.equal(booking.spentUsd(), 0.25);
  await booking.models.beforeRequest({ model: 'm' });
  assert.deepEqual(asked, [0, 0.25]);
  await booking.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 });
  assert.equal(booking.spentUsd(), 0.26);
  assert.deepEqual((await runnerRecords(store)).filter(([kind]) => kind === RUNNER_RECORDS.turn), [[RUNNER_RECORDS.turn, { turn: 1, usd: null }], [RUNNER_RECORDS.turn, { turn: 2, usd: 0.01 }]], 'the cut one booked at an unknown price, as before');
  // A later process reads the same: the turn's unknown cost at the figure its request held.
  assert.equal((await port(store, 0.25)).spentUsd(), 0.26);
});

test('a request a crash cut off counts at the figure held for it in the next process, booked once as cut, counted once however often the session is opened', async () => {
  const store = memorySessionStore();
  const first = await port(store, 0.25);
  await first.models.beforeRequest({ model: 'm' });
  await first.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 });
  await first.models.beforeRequest({ model: 'm' }); // left, and the process died before its answer
  const asked = [];
  const second = await port(store, 0.25, asked);
  assert.equal(second.spentUsd(), 0.26, 'the answered one at its cost, the cut one at its held figure');
  await second.bookCut();
  await second.bookCut();
  assert.equal(second.spentUsd(), 0.26, 'booking the cut changes nothing');
  await second.models.beforeRequest({ model: 'm' });
  assert.deepEqual(asked, [0.26]);
  await second.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.02 });
  const third = await port(store, 0.25);
  await third.bookCut();
  assert.equal(Math.round(third.spentUsd() * 1e6) / 1e6, 0.28, "the first at its cost, the cut one at its figure, the second process's at its cost");
  const cuts = (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.turn && r.data.cut === true).map((r) => r.data);
  assert.deepEqual(cuts, [{ usd: null, cut: true, turn: 2 }], 'booked once, at an unknown price');
});

test('a session written before held figures (no figure on the request) reads unknown, cut by a crash or cut short; a host that holds none keeps it so', async () => {
  for (const hold of [undefined]) {
    const crashed = memorySessionStore();
    const first = await port(crashed, hold);
    await first.models.beforeRequest({ model: 'm' });
    assert.deepEqual(await runnerRecords(crashed), [[RUNNER_RECORDS.request, { turn: 1, model: 'm' }]], 'no figure on the record');
    assert.equal((await port(crashed, 0.25)).spentUsd(), null, 'cut by a crash: unknown, whatever the host holds now');
    const short = memorySessionStore();
    const booking = await port(short, hold);
    await booking.models.beforeRequest({ model: 'm' });
    await booking.models.afterRequest({ input: 0, output: 0, cacheRead: 0, usd: null });
    assert.equal(booking.spentUsd(), null, 'cut short: unknown');
  }
});

test('a host that refuses still refuses, and a figure that is not a finite amount of 0 or more is held as none', async () => {
  const store = memorySessionStore();
  const refusing = await modelPortFor(await store.open(key), { key, beforeRequest: () => ({ refuse: 'no room' }) });
  await assert.rejects(refusing.models.beforeRequest({ model: 'm' }), (e) => e instanceof HarnessRunError && e.reason === 'refused');
  for (const hold of [Number.NaN, -1, Infinity]) {
    const odd = memorySessionStore();
    const booking = await port(odd, hold);
    await booking.models.beforeRequest({ model: 'm' });
    assert.deepEqual(await runnerRecords(odd), [[RUNNER_RECORDS.request, { turn: 1, model: 'm' }]], String(hold));
  }
});
