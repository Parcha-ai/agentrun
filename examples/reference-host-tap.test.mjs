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
  assert.deepEqual(lines[2][1], { gen: 1, box: 'box-1' }, 'a command after the bind is written at once, with no at');
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

test('a held exec\'s `at` is the time it was CALLED: not its answer\'s, and earlier than its own line', async () => {
  const lines = [];
  const tap = hostTap({ line: (kind, data) => lines.push([kind, data, Date.now()]), runLabelKey: 'agentrun-run', runLabel: 'life-1' });
  const { provider } = stubProvider();
  let answeredAt;
  // The box answers 60 ms after the call: a tap that took its time at the answer would be 60 ms late.
  const slow = { ...provider, async create(spec) { const made = await provider.create(spec); made.value.exec = () => new Promise((resolve) => setTimeout(() => { answeredAt = Date.now(); resolve({ ok: true, value: { wait: async () => ({ ok: true, value: 0 }) } }); }, 60)); return made; } };
  const tapped = tap.provider(slow);
  await tap.unheld(aWindow().run, start(1));
  const box = (await tapped.create({ maxLifetimeMs: 1 }, ctx)).value;
  const calledFrom = Date.now();
  const pending = box.exec(['true'], undefined, ctx);
  const calledTo = Date.now();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 20));
  tap.bound('0', 'box-1');
  const [, data, lineAt] = lines.find(([kind]) => kind === 'box.exec');
  const at = Date.parse(data.at);
  // ISO times are whole milliseconds: the call's own time falls between the two clock reads around it.
  assert.ok(at >= calledFrom && at <= calledTo, `at ${data.at} is the call's time (${calledFrom}..${calledTo})`);
  assert.ok(at < answeredAt, `at ${at} is earlier than the answer ${answeredAt}`);
  assert.ok(at < lineAt, `at ${at} is earlier than its line ${lineAt}`);
});

test('an exec that BEGAN before the bind keeps its time (at) though its answer comes after it', async () => {
  const { tap, lines } = aTap();
  const { provider } = stubProvider();
  let answer;
  const slow = { ...provider, async create(spec) { const made = await provider.create(spec); made.value.exec = () => new Promise((resolve) => { answer = resolve; }); return made; } };
  const tapped = tap.provider(slow);
  await tap.unheld(aWindow().run, start(1));
  const box = (await tapped.create({ maxLifetimeMs: 1 }, ctx)).value;
  const pending = box.exec(['true'], undefined, ctx);
  tap.bound('0', 'box-1');
  answer({ ok: true, value: { wait: async () => ({ ok: true, value: 0 }) } });
  await pending;
  const exec = lines.find(([kind]) => kind === 'box.exec');
  assert.ok(exec && typeof exec[1].at === 'string', `the exec keeps its own time: ${JSON.stringify(exec)}`);
});

/** A provider whose boxes keep their labels, with a list() that answers by them (and counts its calls): a keyed host driver's. */
function keyedProvider(name = 'host') {
  const made = [];
  const calls = { list: 0 };
  const boxOf = (id, labels) => ({ id, labels, destroyed: false, facts: () => ({ provider: name, isolation: 'vm', cpus: 2, gpu: null }), async exec() { return { ok: true, value: { wait: async () => ({ ok: true, value: 0 }) } }; }, async status() { return { ok: true, value: { state: 'running' } }; }, async destroy() { this.destroyed = true; return { ok: true, value: undefined }; } });
  return {
    made,
    calls,
    /** A box this life did not make (an earlier process's, or a leftover), with these labels. */
    plant(id, labels) { const box = boxOf(id, labels); made.push(box); return box; },
    provider: {
      name,
      async create(spec) { const box = boxOf(`${name}-${made.length + 1}`, { ...spec.labels }); made.push(box); return { ok: true, value: box }; },
      async attach(id) { return { ok: true, value: made.find((box) => box.id === id && !box.destroyed) }; },
      async list(labels) { calls.list += 1; return { ok: true, value: made.filter((box) => !box.destroyed && Object.entries(labels).every(([k, v]) => box.labels[k] === v)).map((box) => ({ id: box.id, labels: box.labels })) }; },
    },
  };
}
const KEY = 'agentrun-host-key';
const keyed = (key) => ({ maxLifetimeMs: 1, labels: { [KEY]: key } });
function aGenTap() {
  const lines = [];
  const now = { gen: 1 };
  const tap = hostTap({ line: (kind, data) => lines.push([kind, data]), runLabelKey: 'agentrun-run', runLabel: 'life-1', gen: () => now.gen });
  return { tap, lines, now };
}

test('the box\'s key is the one its host driver minted for its create (its agentrun-host-key label): the label binds by THAT key, never the window\'s index', async () => {
  const { tap, lines } = aGenTap();
  const { provider, made } = keyedProvider();
  const tapped = tap.provider(provider);
  await tap.unheld(aWindow().run, start(1));
  await tapped.create(keyed('life-1/0/0123456789abcdef'), ctx);
  assert.equal(made[0].labels[KEY], 'life-1/0/0123456789abcdef', 'the tap writes no key of its own: the driver\'s label is on the box');
  tap.bound('0', 'box-1');
  assert.deepEqual(lines, [], 'the window\'s provisional index binds nothing');
  tap.bound('life-1/0/0123456789abcdef', 'box-1');
  assert.deepEqual(lines.map(([kind, data]) => [kind, data.box, data.gen]), [['box.created', 'box-1', 1]]);
});

test('a later process that takes over this life\'s box writes NO second box.created; its commands and the box\'s end carry ITS gen (Amendment 2)', async () => {
  const { tap, lines, now } = aGenTap();
  const { provider } = keyedProvider();
  const tapped = tap.provider(provider);
  await tap.unheld(aWindow().run, start(1));
  const made = (await tapped.create(keyed('life-1/0/aa'), ctx)).value;
  tap.bound('life-1/0/aa', 'box-1');
  now.gen = 2;
  const adopted = (await tapped.attach(made.id, ctx)).value;
  await adopted.exec(['true'], undefined, ctx);
  await adopted.destroy(ctx);
  assert.deepEqual(lines.map(([kind, data]) => [kind, data.box, data.gen]), [['box.created', 'box-1', 1], ['box.exec', 'box-1', 2], ['box.ended', 'box-1', 2]]);
});

test('a keyed host box of this run that this life did not make is ADOPTED by its key: matched from a tapped list() (no further list) or from one list(); no box.created; its lines carry the adopting gen', async () => {
  for (const listedFirst of [true, false]) {
    const { tap, lines, now } = aGenTap();
    const host = keyedProvider();
    const tapped = tap.provider(host.provider);
    host.plant('earlier-1', { 'agentrun-run': 'life-1', [KEY]: 'life-1/0/bb' });
    now.gen = 3;
    if (listedFirst) await tapped.list({ 'agentrun-run': 'life-1' }, ctx);
    const before = host.calls.list;
    const adopted = (await tapped.attach('earlier-1', ctx)).value;
    assert.equal(host.calls.list - before, listedFirst ? 0 : 1, listedFirst ? 'the tapped list taught the key' : 'one list() found the key');
    tap.bound('life-1/0/bb', 'box-1');
    await adopted.exec(['true'], undefined, ctx);
    await adopted.destroy(ctx);
    assert.deepEqual(lines.map(([kind, data]) => [kind, data.box, data.gen]), [['box.exec', 'box-1', 3], ['box.ended', 'box-1', 3]], `adopted (${listedFirst ? 'listed' : 'not listed'} first): no box.created`);
  }
});

test('a box WITHOUT the key label, or keyed for another run, is never taken as this run\'s host box: it passes through, unrecorded', async () => {
  const { tap, lines } = aGenTap();
  const host = keyedProvider();
  const tapped = tap.provider(host.provider);
  const bare = host.plant('bare-1', { 'agentrun-run': 'life-1' });
  const other = host.plant('other-1', { 'agentrun-run': 'life-9', [KEY]: 'life-9/0/cc' });
  for (const box of [bare, other]) {
    const found = (await tapped.attach(box.id, ctx)).value;
    assert.equal(found, box, `${box.id}: the provider's own box, not a tapped one`);
    await found.destroy(ctx);
  }
  tap.bound('life-9/0/cc', 'box-1');
  assert.deepEqual(lines, []);
});

test('end(id) ends a keyed host box THROUGH the tap, its box.ended written, one this life holds or one it adopts by its key; a box with no key is not the tap\'s to end', async () => {
  const { tap, lines, now } = aGenTap();
  const host = keyedProvider();
  const tapped = tap.provider(host.provider);
  await tap.unheld(aWindow().run, start(1));
  await tapped.create(keyed('life-1/0/dd'), ctx);
  tap.bound('life-1/0/dd', 'box-1');
  host.plant('earlier-2', { 'agentrun-run': 'life-1', [KEY]: 'life-1/1/ee' });
  const tool = host.plant('tool-1', { 'agentrun-run': 'life-1' });
  now.gen = 2;
  tap.killing(2);
  assert.deepEqual(await tap.end('host-1', ctx), { ok: true, host: true });
  assert.deepEqual(await tap.end('earlier-2', ctx), { ok: true, host: true });
  tap.bound('life-1/1/ee', 'box-2');
  assert.deepEqual(await tap.end('tool-1', ctx), { ok: true, host: false });
  assert.equal(tool.destroyed, false, 'the tool box is the caller\'s to end');
  assert.deepEqual(lines.filter(([kind]) => kind === 'box.ended').map(([, data]) => data), [
    { gen: 2, box: 'box-1', provider: 'host', killed: true },
    { gen: 2, box: 'box-2', provider: 'host', killed: true },
  ]);
});

test('one box, one label: a host key bound under two labels refuses the read, naming both; one key under one label reads, and a key with no label reads none', async () => {
  const { hostLabelIn } = await import('../packages/harness/dist/boxes.js');
  const entry = (key) => JSON.stringify({ owner: 'place', provider: 'host', key, run: 'life-1' });
  const files = (named) => ({ listRunFiles: async () => Object.keys(named).sort(), readRunFile: async (path) => { const name = path.split('/').pop(); return name in named ? new TextEncoder().encode(named[name]) : null; } });
  const box = (key) => ({ provider: 'host', key, run: 'life-1' });
  const one = files({ 'box-1.json': entry('life-1/0/aa'), 'box-2.json': entry('life-1/1/bb') });
  assert.equal(await hostLabelIn(one, 'ids', box('life-1/1/bb')), 'box-2');
  assert.equal(await hostLabelIn(one, 'ids', box('life-1/2/cc')), undefined);
  const twice = files({ 'box-1.json': entry('life-1/0/aa'), 'box-3.json': entry('life-1/0/aa') });
  await assert.rejects(() => hostLabelIn(twice, 'ids', box('life-1/0/aa')), /bound under 2 labels \(box-1, box-3\): one box with two names/);
});
