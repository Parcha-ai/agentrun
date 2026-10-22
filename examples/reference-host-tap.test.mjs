// The supervisor's tap of a place's host boxes (H3), on its own: the unheld window's pending entry, the refusals that keep a
// host box from ever being made without a label, and the lines held until the bound label is read. A stub provider stands for
// the host driver's (disk's boxHost over transport's).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { hostTap } = await import('../packages/harness/dist/host-tap.js');
const ctx = {};

/** A provider of in-memory boxes: what a host driver would ask, recorded. */
function stubProvider(name = 'host', { failCreates = 0 } = {}) {
  const made = [];
  let failing = failCreates;
  return {
    made,
    provider: {
      name,
      async create(spec) {
        if (failing > 0) { failing -= 1; return { ok: false, error: Object.assign(new Error('capacity'), { code: 'capacity' }) }; }
        const box = { id: `${name}-${made.length + 1}`, spec, facts: () => ({ provider: name, isolation: 'vm', cpus: 2, gpu: null }), async exec() { return { ok: true, value: { wait: async () => ({ ok: true, value: 0 }) } }; }, async status() { return { ok: true, value: { state: 'running' } }; }, async destroy() { return { ok: true, value: undefined }; } };
        made.push(box);
        return { ok: true, value: box };
      },
      async attach(id) { return { ok: true, value: made.find((box) => box.id === id) }; },
      async list() { return { ok: true, value: [] }; },
    },
  };
}

/** A K9-shaped window over a Map: create-only puts. */
function aWindow(files = new Map()) {
  return {
    files,
    run: {
      signal: new AbortController().signal,
      read: async (path) => (files.has(path) ? new TextEncoder().encode(files.get(path)) : null),
      list: async () => [],
      put: async (path, text) => { if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EXISTS' }); files.set(path, text); },
    },
  };
}

function aTap() {
  const lines = [];
  const tap = hostTap({ line: (kind, data) => lines.push([kind, data]), runLabelKey: 'agentrun-run', runLabel: 'life-1' });
  return { tap, lines };
}
const start = (attempt, key = '0', provider = 'host') => ({ attempt, box: { provider, key, run: 'life-1' } });

test('a host box no unheld window announced is refused BEFORE any box is made: no window, or a window for another provider', async () => {
  const { tap } = aTap();
  const { provider, made } = stubProvider();
  const tapped = tap.provider(provider);
  const refused = await tapped.create({ maxLifetimeMs: 1 }, ctx);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'invalid');
  assert.match(refused.error.message, /outside the place's unheld window has no label/);
  await tap.unheld(aWindow().run, start(1, '0', 'another'));
  assert.equal((await tapped.create({ maxLifetimeMs: 1 }, ctx)).ok, false);
  assert.equal(made.length, 0, 'no box was made');
});

test('the unheld window writes only a pending entry of its own start\'s, never a label; a start with no host box is refused', async () => {
  const { tap } = aTap();
  const window = aWindow();
  await tap.unheld(window.run, start(1));
  assert.deepEqual([...window.files.keys()], ['box-ids.internal/pending/life-1-1.json']);
  assert.deepEqual(JSON.parse(window.files.get('box-ids.internal/pending/life-1-1.json')), { provider: 'host', key: '0', run: 'life-1' });
  await assert.rejects(() => tap.unheld(window.run, { attempt: 2 }), /hands the run's process no host box/);
  await assert.rejects(() => tap.unheld(window.run, { attempt: 2, box: { provider: 'host', key: '0', run: 'not/plain' } }), /not a plain name/);
});

test('a retried start finds its own pending entry (EXISTS, read back, the same) and goes on; one that holds another box is refused', async () => {
  const { tap } = aTap();
  const window = aWindow();
  await tap.unheld(window.run, start(1));
  await tap.unheld(window.run, start(1));
  window.files.set('box-ids.internal/pending/life-1-2.json', `${JSON.stringify({ provider: 'host', key: '7', run: 'life-1' })}\n`);
  await assert.rejects(() => tap.unheld(window.run, start(2)), /holds another box: refused/);
});

test('the host box\'s lines wait for its bound label, then come in order with their own times (from, at); later ones are written at once', async () => {
  const { tap, lines } = aTap();
  const { provider, made } = stubProvider();
  const tapped = tap.provider(provider);
  await tap.unheld(aWindow().run, start(1));
  const box = (await tapped.create({ maxLifetimeMs: 1 }, ctx)).value;
  assert.equal(made[0].spec.labels['agentrun-run'], 'life-1', 'the run\'s label is on the host box');
  await box.exec(['true'], undefined, ctx);
  assert.deepEqual(lines, [], 'nothing before the label is bound');
  tap.bound('0', 'box-1');
  assert.deepEqual(lines.map(([kind, data]) => [kind, data.box, data.gen]), [['box.created', 'box-1', 1], ['box.exec', 'box-1', 1]]);
  assert.deepEqual(lines[0][1], { gen: 1, box: 'box-1', provider: 'host', facts: { isolation: 'vm', cpus: 2, gpu: null }, role: 'host', from: lines[0][1].from });
  assert.ok(Date.parse(lines[1][1].at) >= Date.parse(lines[0][1].from));
  await box.exec(['true'], undefined, ctx);
  await box.destroy(ctx);
  assert.deepEqual(lines.slice(2).map(([kind]) => kind), ['box.exec', 'box.ended']);
  assert.deepEqual(lines.at(-1)[1], { gen: 1, box: 'box-1', provider: 'host', killed: false });
});

test('a create that failed keeps the start pending, so the box made next (or found and attached) takes it; a box no window of this life announced is not recorded', async () => {
  const { tap, lines } = aTap();
  const { provider, made } = stubProvider('host', { failCreates: 1 });
  const tapped = tap.provider(provider);
  await tap.unheld(aWindow().run, start(1));
  assert.equal((await tapped.create({ maxLifetimeMs: 1 }, ctx)).ok, false);
  const second = await tapped.create({ maxLifetimeMs: 1 }, ctx);
  assert.equal(second.ok, true, 'the start stayed pending');
  tap.bound('0', 'box-1');
  assert.equal(lines.filter(([kind]) => kind === 'box.created').length, 1);
  // An attach of a box this life never announced is passed through, unrecorded.
  const earlier = { id: 'earlier-life-box' };
  made.push({ ...made[0], id: earlier.id });
  const found = await tapped.attach(earlier.id, ctx);
  assert.equal(found.value, made.at(-1), 'the provider\'s own box, not a tapped one');
});

test('a box the supervisor took away (a kill of kind box) ends as killed', async () => {
  const { tap, lines } = aTap();
  const { provider } = stubProvider();
  const tapped = tap.provider(provider);
  await tap.unheld(aWindow().run, start(1));
  const box = (await tapped.create({ maxLifetimeMs: 1 }, ctx)).value;
  tap.bound('0', 'box-1');
  tap.killing(1);
  await box.destroy(ctx);
  assert.deepEqual(lines.at(-1), ['box.ended', { gen: 1, box: 'box-1', provider: 'host', killed: true }]);
});
