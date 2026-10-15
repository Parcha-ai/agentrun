// The keyed layout (agentrun.frozen_run.v4) on a memory journal: what lies in each map item is kept in that item's
// record beside the state, and a state the driver references once by its digest. Every later open of one store stands
// for a later process of the same run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '@parcha/agentrun-dsl';
import {
  openRecovery, withRecovery, openJournal, workspaceFiles, canonicalHash, stateDelta, applyStateDelta, itemState, partialResults,
  FROZEN_SNAPSHOT_SCHEMA, FROZEN_SNAPSHOT_SCHEMA_V4,
} from '@parcha/agentrun-dsl/recovery';

const KEY = 'run-1';
const MAP = '/root/steps/0';
const itemsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `item-${String(i).padStart(4, '0')}`, rank: i }));
const body = { node: 'chain', steps: [
  { node: 'call', label: 'lookup', via: 'tool', tool: 'lookup', args: { id: '{item.id}' }, out: 'Found', as: 'found', deadline_s: 30 },
  { node: 'code', label: 'tally', code: 's => ({ score: s.found.score * 2 })' },
] };
const workflowOf = (inner = body) => ({
  v: 2, name: 'keyed',
  schemas: {
    Input: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
    Found: { type: 'object', required: ['id', 'score'], properties: { id: { type: 'string' }, score: { type: 'number' } } },
    Result: { type: 'object', required: ['count', 'total'], properties: { count: { type: 'integer' }, total: { type: 'number' } } },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'map', label: 'each', itemsPath: 'items', as: 'found', maxConcurrency: 4, body: inner },
    { node: 'code', label: 'count', code: 's => ({ result: { count: s.found.length, total: s.found.reduce((sum, item) => sum + item.score, 0) } })' },
  ] },
});

/** A memory journal whose record the test can read and change, as an operator with the store's file would. */
function inspectable() {
  let record; let owned = false;
  const backend = {
    acquire: async () => { if (owned) throw new Error('Run already has a live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); },
  };
  return { store: { open: (bound) => openJournal(backend, bound) }, record: () => record, set: (next) => { record = next; } };
}
/** The same store, its journal without the reads that declare parts: a store that keeps none. */
const withoutParts = (store) => ({ open: async (bound) => {
  const journal = await store.open(bound);
  return new Proxy(journal, { get: (target, name) => (name === 'items' || name === 'stateOf' ? undefined : Reflect.get(target, name, target)) });
} });
/** A store that records the size of every state and part each write lays. */
const measured = (store, sizes) => ({ open: async (bound) => {
  const journal = await store.open(bound);
  const laid = (state, parts, revision) => {
    const value = typeof state === 'function' ? state(revision) : state;
    sizes.state = Math.max(sizes.state ?? 0, JSON.stringify(value ?? null).length);
    for (const item of Object.values(parts?.(revision)?.items ?? {})) sizes.item = Math.max(sizes.item ?? 0, JSON.stringify(item).length);
  };
  return Object.assign(Object.create(journal), {
    save: (state, note, parts) => { laid(state, parts, journal.revision + 1); return journal.save(state, note, parts); },
    admit: (id, name, argsHash, state, session, intent, args, parts, owner) => { laid(state, parts, journal.revision + 1); return journal.admit(id, name, argsHash, state, session, intent, args, parts, owner); },
    complete: (id, result, state, parts) => { laid(state, parts, journal.revision + 1); return journal.complete(id, result, state, parts); },
  });
} });

const answerOf = (id) => ({ id, score: Number(String(id).replace(/\D/g, '')) });
/** One process of the run. `cut` names a node whose commits never land, as in a process that dies after the node ran
 *  and before its commit: the run stops there, and a call still in flight is left admitted and unknown. The host settles
 *  such a call at the next open, from the arguments the journal kept, as a host whose provider answers by key does; it
 *  lists it in `settled`. `hang` names items whose call never answers in this process: it is in flight when the run stops. */
async function run(store, workflow, { input, cut, layout, calls, settled, hang } = {}) {
  const driver = await openRecovery(store, workflow, { key: KEY, ...(layout ? { layout } : {}),
    reconcile: async (unknown, complete) => { for (const effect of unknown) { settled?.push(effect.args.id); await complete(effect.id, answerOf(effect.args.id)); } } });
  const wrapped = withRecovery(driver, {
    runEffect: async ({ input: args }) => { calls?.push(args.id); if (hang?.includes(args.id)) { calls.pop(); return new Promise(() => {}); } return answerOf(args.id); },
  });
  if (cut) wrapped.recovery = { ...wrapped.recovery, commit: (node, ...rest) => (node.label === cut ? Promise.reject(new Error(`cut at ${cut}`)) : driver.recovery.commit(node, ...rest)) };
  try { return { output: await runWorkflow(workflow, input, wrapped), layout: driver.layout }; } finally { await driver.close(); }
}
const uncutOutput = async (n, inner) => (await run(inspectable().store, workflowOf(inner), { input: { items: itemsOf(n) } })).output;

test('a state against its base: the keys it sets and the base keys it lacks, rebuilt in its own key order', () => {
  const base = { items: [1, 2, 3], context: 'c', keep: { deep: true } };
  const state = { items: base.items, context: 'other', keep: { deep: true }, item: { id: 'a' }, item_index: 0, found: { score: 2 } };
  const delta = stateDelta(base, state, canonicalHash(state));
  assert.deepEqual(delta.set, { context: 'other', item: { id: 'a' }, item_index: 0, found: { score: 2 } });
  assert.deepEqual(delta.unset, []);
  assert.deepEqual(Object.keys(applyStateDelta(base, delta)), Object.keys(state));
  assert.equal(canonicalHash(applyStateDelta(base, delta)), delta.sha256);
  const without = { items: base.items, item: 1 };
  assert.deepEqual(applyStateDelta(base, stateDelta(base, without, canonicalHash(without))), without);
});

test('a map run in the keyed layout keeps each item in its own record and the base once, and the result is the uncut one', async () => {
  const kept = inspectable();
  const calls = [];
  const { output, layout } = await run(kept.store, workflowOf(), { input: { items: itemsOf(12) }, layout: 'v4', calls });
  assert.deepEqual(output, await uncutOutput(12));
  assert.equal(layout.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
  assert.equal(calls.length, 12);
  const record = kept.record();
  assert.equal(record.state.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
  const entry = record.state.maps[MAP];
  assert.deepEqual([entry.length, entry.items], [12, 12]);
  assert.equal(canonicalHash(record.states[entry.base]), entry.base, 'the base is stored once, under its digest');
  const items = Object.entries(record.items);
  assert.equal(items.length, 12);
  for (const [path, item] of items) {
    assert.equal(path, `${MAP}/items/${item.index}`);
    assert.deepEqual([item.map, item.base, item.status, item.driver], [MAP, entry.base, 'committed', KEY]);
    assert.equal(item.effects.length, 1, 'an item lists the effect admitted in it');
    assert.ok(item.frame.done.every((at) => at.startsWith(`${path}/body`)));
    for (const delta of Object.values(item.frame.states)) assert.ok(!('items' in delta.set), 'an item keeps no copy of the list it was mapped from');
  }
  assert.ok(!JSON.stringify(record.state.pin).includes('/items/'), 'the driver record holds nothing that lies in a map item');
});

test('in the keyed layout the driver record and an item record stay the same size however many items the map has; whole, they grow', async () => {
  const sizesOf = async (n, layout) => { const sizes = {}; await run(measured(inspectable().store, sizes), workflowOf(), { input: { items: itemsOf(n) }, layout }); return sizes; };
  const [keyedSmall, keyedLarge] = [await sizesOf(10, 'v4'), await sizesOf(60, 'v4')];
  assert.ok(keyedLarge.state - keyedSmall.state < 200, `the driver record grew from ${keyedSmall.state} to ${keyedLarge.state} bytes`);
  assert.ok(keyedLarge.item - keyedSmall.item < 100, `an item record grew from ${keyedSmall.item} to ${keyedLarge.item} bytes`);
  const [wholeSmall, wholeLarge] = [await sizesOf(10), await sizesOf(60)];
  assert.ok(wholeLarge.state > 10 * wholeSmall.state, `whole, the record grows with the square of the items: ${wholeSmall.state} to ${wholeLarge.state} bytes`);
});

/** Every item called at most once across the processes, and every item's call made or settled. */
const onceEach = (calls, settled, ids) => {
  assert.equal(new Set(calls).size, calls.length, `a call made twice: ${calls}`);
  assert.deepEqual([...new Set([...calls, ...settled])].sort(), [...ids].sort());
};

test('a process killed inside the map resumes from the item records, calls nothing twice, and ends with the uncut result', async () => {
  const kept = inspectable();
  const calls = []; const settled = [];
  const input = { items: itemsOf(9) };
  await assert.rejects(run(kept.store, workflowOf(), { input, layout: 'v4', calls, settled, cut: 'tally' }), /cut at tally/);
  const running = kept.record();
  assert.equal(running.state.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
  assert.ok(Object.values(running.items).some((item) => item.status === 'running'));
  const { output } = await run(kept.store, workflowOf(), { input, layout: 'v4', calls, settled });
  assert.deepEqual(output, await uncutOutput(9));
  onceEach(calls, settled, itemsOf(9).map((item) => item.id));
});

/** The same store as the pi document store hands its state over: the open's state is the store's own object, and a
 *  completion that names no state writes that object back. */
const aliasing = (store) => ({ open: async (bound) => {
  const journal = await store.open(bound);
  const opened = journal.state;
  return Object.assign(Object.create(journal), {
    get state() { return opened; },
    complete: (id, result, state = opened, parts) => journal.complete(id, result, state, parts),
  });
} });

test('a resumed process that settles a call writes nothing of a map item into the driver record, on a store that hands over its own state', async () => {
  const kept = inspectable();
  const written = [];
  const store = { open: async (bound) => { const journal = await aliasing(kept.store).open(bound);
    // What each completion writes, as it is written: a store keeps the state as it was at its write.
    return Object.assign(Object.create(journal), { complete: (id, result, state, parts) => { written.push(structuredClone(state === undefined ? journal.state : state)); return journal.complete(id, result, state, parts); } }); } };
  const input = { items: itemsOf(9) };
  const calls = []; const settled = [];
  await assert.rejects(run(store, workflowOf(), { input, layout: 'v4', calls, settled, cut: 'tally', hang: ['item-0001'] }), /cut at tally|uncertain effects/);
  const before = kept.record();
  assert.ok(Object.values(before.items).some((item) => Object.keys(item.frame.chains).length > 0), 'an item committed a step before the cut');
  written.length = 0;
  const { output } = await run(store, workflowOf(), { input, layout: 'v4', calls, settled });
  assert.ok(settled.length > 0, 'the resumed process settled a call the cut left unknown');
  assert.deepEqual(output, await uncutOutput(9));
  onceEach(calls, settled, itemsOf(9).map((item) => item.id));
  const leaked = written.filter((state) => state?.schema === FROZEN_SNAPSHOT_SCHEMA_V4 && JSON.stringify(state.pin).includes('/items/'));
  assert.equal(leaked.length, 0, `a completion wrote map-item paths into the driver record: ${String(JSON.stringify(leaked[0]?.pin)).slice(0, 300)}`);
});

test('itemState rebuilds every state an item keeps from its record and the base, and says why when it cannot, never guessing', async () => {
  const kept = inspectable();
  const input = { items: itemsOf(8) };
  await assert.rejects(run(kept.store, workflowOf(), { input, layout: 'v4', cut: 'tally' }));
  const record = kept.record();
  // The store's `agentrun.states` values, by digest, as a reader of a recording has them.
  const states = Object.fromEntries(Object.entries(record.states).map(([sha256, state]) => [sha256, { driver: KEY, sha256, state }]));
  let rebuilt = 0;
  for (const item of Object.values(record.items)) {
    for (const [at, delta] of Object.entries(item.frame.states)) {
      const read = itemState(item, states, at);
      assert.ok('state' in read, `${at}: ${read.unreadable}`);
      assert.equal(canonicalHash(read.state), delta.sha256);
      assert.equal(read.state.item_index, item.index);
      assert.deepEqual(read.state.items, input.items, 'the base supplies what the item did not change');
      rebuilt += 1;
    }
  }
  assert.ok(rebuilt > 0, 'some item kept a state');
  const [item, at] = Object.values(record.items).flatMap((it) => Object.keys(it.frame.states).map((path) => [it, path]))[0];
  assert.deepEqual(itemState(item, new Map(Object.entries(states)), at), itemState(item, states, at), 'a Map of the states reads the same');
  assert.match(itemState(item, {}, at).unreadable, /base .* is missing/);
  assert.match(itemState(item, states, `${at}/elsewhere`).unreadable, /keeps no state/);
  const forged = structuredClone(item); forged.frame.states[at].set.found = { id: 'forged', score: 999 };
  assert.match(itemState(forged, states, at).unreadable, /does not rebuild/);
  const swapped = { ...states, [item.base]: { ...states[item.base], state: { ...states[item.base].state, extra: true } } };
  assert.match(itemState(item, swapped, at).unreadable, /base does not match/);
  assert.match(itemState(null, states, at).unreadable, /not a map item's record/);
});

test('the module that defines itemState imports nothing, and with a caller\'s SHA-256 rebuilds what the default does', async () => {
  const at = new URL('../dist/recovery/item-state.js', import.meta.url);
  const text = readFileSync(at, 'utf8');
  assert.deepEqual(text.match(/^\s*(import|export\s.*\sfrom)\b.*$/gm) ?? [], [], 'a static viewer inlines this module: it may import nothing');
  assert.doesNotMatch(text, /\bimport\s*\(|\brequire\s*\(/);
  const pure = await import(at.href);
  const kept = inspectable();
  await assert.rejects(run(kept.store, workflowOf(), { input: { items: itemsOf(5) }, layout: 'v4', cut: 'tally' }));
  const record = kept.record();
  const states = Object.fromEntries(Object.entries(record.states).map(([sha256, state]) => [sha256, { driver: KEY, sha256, state }]));
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');
  const pairs = Object.values(record.items).flatMap((item) => Object.keys(item.frame.states).map((path) => [item, path]));
  assert.ok(pairs.length > 0);
  for (const [item, path] of pairs) assert.deepEqual(pure.itemState(item, states, path, { sha256 }), itemState(item, states, path));
  assert.equal(sha256(pure.canonicalJson({ b: 1, a: { d: 2, c: [3] } })), canonicalHash({ a: { c: [3], d: 2 }, b: 1 }), 'the digest is taken over the same JSON');
  assert.throws(() => pure.itemState(pairs[0][0], states, pairs[0][1], {}), TypeError);
});

test('a map that fails in the keyed layout keeps its finished results by digest, and the next process reads the same ones', async () => {
  const kept = inspectable();
  const input = { items: itemsOf(8) };
  // One process: an item's call fails, the map ends on it, and the process ends with it.
  const driver = await openRecovery(kept.store, workflowOf(), { key: KEY, layout: 'v4' });
  const wrapped = withRecovery(driver, { runEffect: async ({ input: args }) => { if (args.id === 'item-0005') throw new Error('item-0005 failed'); return answerOf(args.id); } });
  await assert.rejects(runWorkflow(workflowOf(), input, wrapped), /item-0005 failed/);
  const failed = JSON.parse(JSON.stringify(driver.lastState()));
  await driver.close();
  assert.ok(failed.found.some((result) => result !== null), 'some items finished before the map failed');
  const record = kept.record();
  assert.equal(record.state.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
  const { partial } = record.state.pin;
  assert.deepEqual([partial.path, partial.as], [MAP, 'found']);
  assert.ok(typeof partial.results === 'string' && /^[a-f0-9]{64}$/.test(partial.results), `the driver record keeps one digest for a failed map's results, not ${JSON.stringify(partial.results).slice(0, 80)}`);
  const slots = record.states[partial.results];
  assert.equal(canonicalHash(slots), partial.results, 'the list of slots is kept once, under its digest');
  assert.equal(slots.length, 8);
  for (const slot of slots) {
    assert.ok(slot === null || (typeof slot === 'string' && /^[a-f0-9]{64}$/.test(slot)), `a result kept inline: ${JSON.stringify(slot).slice(0, 80)}`);
    if (slot !== null) assert.equal(canonicalHash(record.states[slot]), slot, 'each result is kept once, under its digest');
  }
  assert.deepEqual(slots.map((slot) => slot === null), failed.found.map((result) => result === null), 'a slot with no result stays null');
  // A reader of a recording reads the same results with partialResults, and marks what it cannot read.
  const values = Object.fromEntries(Object.entries(record.states).map(([sha256, state]) => [sha256, { driver: KEY, sha256, state }]));
  const read = partialResults(partial, values);
  assert.deepEqual(JSON.parse(JSON.stringify(read.slots.map((slot) => (slot === null ? null : slot.result)))), failed.found);
  const pure = await import(new URL('../dist/recovery/item-state.js', import.meta.url).href);
  assert.deepEqual(pure.partialResults(partial, values, { sha256: (text) => createHash('sha256').update(text).digest('hex') }), read);
  const one = slots.findIndex((slot) => slot !== null);
  const tampered = { ...values, [slots[one]]: { ...values[slots[one]], state: { forged: true } } };
  assert.match(partialResults(partial, tampered).slots[one].unreadable, /does not match/);
  const { [partial.results]: _list, ...withoutList } = values;
  assert.match(partialResults(partial, withoutList).unreadable, /list of results .* is missing/);
  assert.deepEqual(partialResults({ path: MAP, as: 'found', results: [{ a: 1 }, null] }, {}).slots, [{ result: { a: 1 } }, null], 'a whole-state run keeps its list inline');
  // The next process rebuilds the same results from their digests.
  const next = await openRecovery(kept.store, workflowOf(), { key: KEY, layout: 'v4' });
  try { assert.deepEqual(JSON.parse(JSON.stringify(next.lastState())), failed); } finally { await next.close(); }
  // A result that does not match its digest refuses the open.
  const forged = kept.record();
  const at = forged.states[forged.state.pin.partial.results].find((slot) => slot !== null);
  forged.states[at] = { ...forged.states[at], forged: true };
  kept.set(forged);
  await assert.rejects(openRecovery(kept.store, workflowOf(), { key: KEY, layout: 'v4' }), (error) => error.code === 'FROZEN_CHECKPOINT_INVALID');
});

test('a failed map adds the same to the driver record however many items it has', async () => {
  const partialBytes = async (n) => {
    const kept = inspectable();
    const driver = await openRecovery(kept.store, workflowOf(), { key: KEY, layout: 'v4' });
    const wrapped = withRecovery(driver, { runEffect: async ({ input: args }) => { if (args.id === `item-${String(n - 1).padStart(4, '0')}`) throw new Error('last item failed'); return answerOf(args.id); } });
    await assert.rejects(runWorkflow(workflowOf(), { items: itemsOf(n) }, wrapped), /last item failed/);
    await driver.close();
    return JSON.stringify(kept.record().state.pin.partial).length;
  };
  assert.equal(await partialBytes(40), await partialBytes(8));
});

test('two calls admitted together in one map item are both listed in its record, so the next process finds both', async () => {
  const both = { node: 'parallel', label: 'both', branches: [
    { node: 'call', label: 'lookup-a', via: 'tool', tool: 'lookup', args: { id: '{item.id}' }, out: 'Found', as: 'a', deadline_s: 30 },
    { node: 'call', label: 'lookup-b', via: 'tool', tool: 'lookup', args: { id: '{item.id}' }, out: 'Found', as: 'b', deadline_s: 30 },
  ] };
  const workflow = workflowOf(both);
  const kept = inspectable();
  // One process: both calls of the first item are admitted and in flight when it dies.
  const driver = await openRecovery(kept.store, workflow, { key: KEY, layout: 'v4' });
  void runWorkflow(workflow, { items: itemsOf(1) }, withRecovery(driver, { runEffect: () => new Promise(() => {}) })).catch(() => undefined);
  for (let wait = 0; wait < 200 && (kept.record()?.effects?.length ?? 0) < 2; wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const record = structuredClone(kept.record());
  assert.equal(record.effects.length, 2, 'both calls were admitted');
  const item = record.items[`${MAP}/items/0`];
  assert.deepEqual([...item.effects].sort(), record.effects.map((effect) => effect.id).sort(), 'the item lists every call admitted in it');
  // The next process opens a copy of the store as the kill left it, and finds both calls unknown.
  const next = inspectable(); next.set(record);
  const settled = [];
  const reopened = await openRecovery(next.store, workflow, { key: KEY, layout: 'v4', reconcile: async (unknown, complete) => { for (const effect of unknown) { settled.push(effect.id); await complete(effect.id, answerOf(effect.args.id)); } } });
  await reopened.close();
  assert.deepEqual(settled.sort(), record.effects.map((effect) => effect.id).sort());
});

test('a file a map item produced and a later step replaced is restored with its latest hash', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'keyed-files-')); const files = workspaceFiles(cwd);
  const render = (label) => ({ node: 'call', label, via: 'shell', command: 'render', produces: ['report.json'], deadline_s: 5, as: label });
  const workflow = {
    v: 2, name: 'keyed-files',
    schemas: { Input: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } }, Result: { type: 'object' } },
    input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' },
    root: { node: 'chain', steps: [
      { node: 'map', label: 'each', itemsPath: 'items', as: 'found', resultPath: 'render-item', body: render('render-item') },
      render('render-final'),
      { node: 'code', label: 'done', code: "() => ({ result: { done: true } })" },
    ] },
  };
  const deps = { runEffect: async ({ node }) => { writeFileSync(join(cwd, 'report.json'), node.label === 'render-item' ? 'item bytes' : 'final bytes'); return { code: 0, stdout: '', stderr: '' }; } };
  const kept = inspectable();
  const process = async (cut) => {
    const driver = await openRecovery(kept.store, workflow, { key: KEY, layout: 'v4', files });
    const wrapped = withRecovery(driver, deps);
    if (cut) wrapped.recovery = { ...wrapped.recovery, commit: (node, ...rest) => (node.label === cut ? Promise.reject(new Error(`cut at ${cut}`)) : driver.recovery.commit(node, ...rest)) };
    try { return await runWorkflow(workflow, { items: [{ id: 'x' }] }, wrapped); } finally { await driver.close(); }
  };
  await assert.rejects(process('done'), /cut at done/);
  assert.equal(readFileSync(join(cwd, 'report.json'), 'utf8'), 'final bytes');
  const resumed = await process();
  assert.equal(resumed.status, 'complete');
});

test('a state that does not rebuild to the digest it was committed with refuses the open', async () => {
  const kept = inspectable();
  const input = { items: itemsOf(6) };
  await assert.rejects(run(kept.store, workflowOf(), { input, layout: 'v4', cut: 'tally' }));
  const record = kept.record();
  const [path, item] = Object.entries(record.items).find(([, it]) => Object.keys(it.frame.states).length > 0);
  const at = Object.keys(item.frame.states)[0];
  record.items[path].frame.states[at].set.found = { id: 'forged', score: 999 };
  kept.set(record);
  await assert.rejects(run(kept.store, workflowOf(), { input, layout: 'v4' }), (error) => error.code === 'FROZEN_CHECKPOINT_INVALID' && /does not rebuild/.test(error.message));
});

test('the default layout is the whole state in one record, on a store that keeps parts too', async () => {
  const kept = inspectable();
  const { layout } = await run(kept.store, workflowOf(), { input: { items: itemsOf(4) } });
  assert.deepEqual(layout, { schema: FROZEN_SNAPSHOT_SCHEMA });
  assert.equal(kept.record().state.schema, FROZEN_SNAPSHOT_SCHEMA);
  assert.equal(kept.record().items, undefined);
});

test('the keyed layout asked for on a store that keeps no parts stays whole, says why in one layout note per open, and tells the host', async () => {
  const kept = inspectable();
  const input = { items: itemsOf(5) };
  await assert.rejects(run(withoutParts(kept.store), workflowOf(), { input, layout: 'v4', cut: 'tally' }));
  const { output, layout } = await run(withoutParts(kept.store), workflowOf(), { input, layout: 'v4' });
  assert.deepEqual(output, await uncutOutput(5));
  assert.equal(layout.schema, FROZEN_SNAPSHOT_SCHEMA);
  assert.match(layout.reason, /keeps no parts/);
  const record = kept.record();
  assert.equal(record.state.schema, FROZEN_SNAPSHOT_SCHEMA);
  assert.equal(record.items, undefined);
  const notes = record.notes.filter((note) => note.kind === 'layout');
  assert.equal(notes.length, 2, 'one layout note for each of the two opens');
  assert.deepEqual(notes[0].detail, { schema: FROZEN_SNAPSHOT_SCHEMA, reason: layout.reason });
});

test('a run in the keyed layout stays in it when a later process asks for none', async () => {
  const kept = inspectable();
  const input = { items: itemsOf(7) };
  await assert.rejects(run(kept.store, workflowOf(), { input, layout: 'v4', cut: 'tally' }));
  const { output, layout } = await run(kept.store, workflowOf(), { input });
  assert.equal(layout.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
  assert.deepEqual(output, await uncutOutput(7));
  assert.equal(kept.record().state.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
});

test('a run stored whole moves to the keyed layout once it knows its running maps\' bases, and calls nothing twice', async () => {
  const kept = inspectable();
  const calls = []; const settled = [];
  const input = { items: itemsOf(8) };
  await assert.rejects(run(kept.store, workflowOf(), { input, calls, settled, cut: 'tally' }));
  assert.equal(kept.record().state.schema, FROZEN_SNAPSHOT_SCHEMA);
  // The open alone cannot move it: a map is still running, and its base is the state it starts from, which the whole
  // record does not hold. The map names it when it resumes, and the next commit moves the run.
  const driver = await openRecovery(kept.store, workflowOf(), { key: KEY, layout: 'v4', reconcile: async (unknown, complete) => { for (const effect of unknown) { settled.push(effect.args.id); await complete(effect.id, answerOf(effect.args.id)); } } });
  assert.equal(kept.record().state.schema, FROZEN_SNAPSHOT_SCHEMA);
  await driver.close();
  const { output, layout } = await run(kept.store, workflowOf(), { input, layout: 'v4', calls, settled });
  assert.equal(layout.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
  assert.equal(kept.record().state.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
  assert.ok(Object.keys(kept.record().items).length > 0);
  assert.deepEqual(output, await uncutOutput(8));
  onceEach(calls, settled, itemsOf(8).map((item) => item.id));
});

test('a run in the keyed layout on a store that keeps no parts is refused, never run with its items missing', async () => {
  const kept = inspectable();
  const input = { items: itemsOf(4) };
  await assert.rejects(run(kept.store, workflowOf(), { input, layout: 'v4', cut: 'tally' }));
  await assert.rejects(run(withoutParts(kept.store), workflowOf(), { input }), (error) => error.code === 'FROZEN_CHECKPOINT_INVALID' && /keeps no parts/.test(error.message));
});

test('a map inside a map item keeps its own items in records of their own, and a killed run resumes with the uncut result', async () => {
  const nested = { node: 'chain', steps: [
    { node: 'code', label: 'parts', code: 's => ({ parts: [1, 2, 3].map((n) => ({ id: `${s.item.id}-${n}` })) })' },
    { node: 'map', label: 'inner', itemsPath: 'parts', as: 'scored', maxConcurrency: 2, body: { node: 'chain', steps: [
      { node: 'call', label: 'lookup', via: 'tool', tool: 'lookup', args: { id: '{item.id}' }, out: 'Found', as: 'found', deadline_s: 30 },
    ] } },
    { node: 'code', label: 'tally', code: 's => ({ score: s.scored.reduce((sum, part) => sum + part.found.score, 0) })' },
  ] };
  const kept = inspectable();
  const calls = []; const settled = [];
  const input = { items: itemsOf(4) };
  await assert.rejects(run(kept.store, workflowOf(nested), { input, layout: 'v4', calls, settled, cut: 'tally' }));
  const innerItems = Object.keys(kept.record().items).filter((path) => path.split('/items/').length === 3);
  assert.ok(innerItems.length > 0, 'an inner map item has a record of its own');
  const { output } = await run(kept.store, workflowOf(nested), { input, layout: 'v4', calls, settled });
  assert.deepEqual(output, await uncutOutput(4, nested));
  onceEach(calls, settled, itemsOf(4).flatMap((item) => [1, 2, 3].map((n) => `${item.id}-${n}`)));
});

test('a run stored in a schema newer than this build knows is refused with its own code, naming both; a schema that is no version stays invalid', async () => {
  const kept = inspectable();
  const input = { items: itemsOf(3) };
  await assert.rejects(run(kept.store, workflowOf(), { input, cut: 'tally' }));
  const record = kept.record();
  kept.set({ ...record, state: { ...record.state, schema: 'agentrun.frozen_run.v99' } });
  await assert.rejects(run(kept.store, workflowOf(), { input, layout: 'v4' }), (error) => {
    assert.equal(error.code, 'RECOVERY_SCHEMA_NEWER');
    assert.equal(error.found, 'agentrun.frozen_run.v99');
    assert.deepEqual(error.known, [FROZEN_SNAPSHOT_SCHEMA, FROZEN_SNAPSHOT_SCHEMA_V4]);
    return true;
  });
  assert.equal(kept.record().state.schema, 'agentrun.frozen_run.v99', 'the refusal writes no state');
  kept.set({ ...record, state: { ...record.state, schema: 'agentrun.frozen_run.later' } });
  await assert.rejects(run(kept.store, workflowOf(), { input }), (error) => error.code === 'FROZEN_CHECKPOINT_INVALID');
});
