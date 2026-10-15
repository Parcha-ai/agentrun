// The keyed layout (agentrun.frozen_run.v4) on a memory journal: what lies in each map item is kept in that item's
// record beside the state, and a state the driver references once by its digest. Every later open of one store stands
// for a later process of the same run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import {
  openRecovery, withRecovery, openJournal, canonicalHash, stateDelta, applyStateDelta,
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
 *  lists it in `settled`. */
async function run(store, workflow, { input, cut, layout, calls, settled } = {}) {
  const driver = await openRecovery(store, workflow, { key: KEY, ...(layout ? { layout } : {}),
    reconcile: async (unknown, complete) => { for (const effect of unknown) { settled?.push(effect.args.id); await complete(effect.id, answerOf(effect.args.id)); } } });
  const wrapped = withRecovery(driver, {
    runEffect: async ({ input: args }) => { calls?.push(args.id); return answerOf(args.id); },
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
