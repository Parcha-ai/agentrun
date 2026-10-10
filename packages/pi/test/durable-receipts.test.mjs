// Not buying an effect twice: a call equal to an inherited receipt is answered from it, one equal to an inherited
// unknown is refused, and neither reaches the tool.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { canonicalHash, inheritableReceipts, inheritableUnknowns, memoryStore, openRecovery, recoveryBound, withRecovery } from '@parcha/agentrun-dsl/recovery';
import { reuseReceipts } from '@parcha/agentrun-pi/durable';

const receipt = (tool, args, result, session = 'earlier:step') => ({ id: `e-${tool}`, name: tool, tool, argsHash: canonicalHash(args), result, session });
function counted(name) {
  const tool = { name, description: 'd', async execute(args) { tool.calls.push(args); return { content: [{ type: 'text', text: 'live' }] }; } };
  tool.calls = [];
  return tool;
}

test('a reused call makes no second request, and says where its answer came from', async () => {
  const reuse = reuseReceipts({ tools: ['search'], receipts: [receipt('search', { q: 'acme' }, { hits: 3 })] });
  const search = counted('search');
  const wrapped = reuse.wrap(search);
  const answered = await wrapped.execute({ q: 'acme' });
  assert.deepEqual(search.calls, []);
  assert.equal(answered.details.effect_status, 'reused');
  assert.match(answered.content[0].text, /^\{"hits":3\}\n\n\(answered from the paid receipt of earlier:step; the call was not dispatched again\)$/);
  const other = await wrapped.execute({ q: 'other' });
  assert.deepEqual(search.calls, [{ q: 'other' }]);
  assert.equal(other.content[0].text, 'live');
  assert.deepEqual({ ...reuse.stats }, { reused: 1, refused: 0 });
});

test('an inherited unknown is refused, never dispatched', async () => {
  const reuse = reuseReceipts({ tools: ['pay'], receipts: [], unknown: [{ id: 'e3', name: 'pay', argsHash: canonicalHash({ amount: 5 }), session: null }] });
  const pay = counted('pay');
  const refused = await reuse.wrap(pay).execute({ amount: 5 });
  assert.deepEqual(pay.calls, []);
  assert.equal(refused.isError, true);
  assert.equal(refused.details.effect_status, 'unknown');
  await reuse.wrap(pay).execute({ amount: 6 });
  assert.deepEqual(pay.calls, [{ amount: 6 }]);
  assert.deepEqual({ ...reuse.stats }, { reused: 0, refused: 1 });
});

test('a tool the host did not name as paid is returned as it is', async () => {
  const reuse = reuseReceipts({ tools: ['search'], receipts: [receipt('read', { path: 'a' }, 'cached')] });
  const read = counted('read');
  assert.equal(reuse.wrap(read), read);
});

test('a fetch wrapper is keyed by the gateway tool it names, as the driver keyed the effect', async () => {
  const reuse = reuseReceipts({ tools: ['fetch'], receipts: [receipt('registry_lookup', { id: 7 }, 'row 7')] });
  const fetch = counted('fetch');
  const answered = await reuse.wrap(fetch).execute({ tool: 'registry_lookup', args: { id: 7 } });
  assert.equal(answered.details.effect_status, 'reused');
  assert.deepEqual(fetch.calls, []);
});

test('a receipt without a result is no answer', async () => {
  const reuse = reuseReceipts({ tools: ['search'], receipts: [receipt('search', { q: 'a' }, null)] });
  const search = counted('search');
  await reuse.wrap(search).execute({ q: 'a' });
  assert.equal(search.calls.length, 1);
});

test('a continuation\'s call that matches a tool effect the driver left unknown is refused, directly or through a fetch wrapper', async () => {
  const workflow = { v: 2, name: 'tail', schemas: { Any: { type: 'object' } }, output: { schemaId: 'Any', path: 'lookup' }, root: { node: 'chain', steps: [
    { node: 'code', label: 'seed', code: '() => ({ id: 7 })' },
    { node: 'call', label: 'lookup', via: 'tool', tool: 'registry_lookup', args: { id: '{id}' }, out: 'Any', as: 'lookup', deadline_s: 5 },
  ] } };
  // The run's process is cut while the paid call is out: the journal holds the effect, unknown.
  const store = memoryStore();
  const driver = await openRecovery(store, workflow, { key: 'run-1' });
  await assert.rejects(runWorkflow(workflow, {}, withRecovery(driver, { runEffect: async () => { throw new Error('connection reset'); } })), /connection reset/);
  await driver.close();
  const journal = await store.open(recoveryBound(workflow));
  const effects = journal.effects();
  await journal.close();
  assert.deepEqual(effects.map((e) => [e.name, e.status]), [['lookup', 'unknown']]);
  // The continuation inherits it as the handoff hands it over, and makes the same call itself.
  const reuse = reuseReceipts({ tools: ['registry_lookup', 'fetch'], receipts: inheritableReceipts(effects), unknown: inheritableUnknowns(effects) });
  const lookup = counted('registry_lookup');
  const fetch = counted('fetch');
  const direct = await reuse.wrap(lookup).execute({ id: 7 });
  const wrapped = await reuse.wrap(fetch).execute({ tool: 'registry_lookup', args: { id: 7 } });
  assert.deepEqual([lookup.calls, fetch.calls], [[], []]);
  assert.deepEqual([direct.details, wrapped.details], [{ effect_status: 'unknown', refused: true }, { effect_status: 'unknown', refused: true }]);
  // A different call is the continuation's own.
  await reuse.wrap(lookup).execute({ id: 8 });
  assert.deepEqual([lookup.calls, { ...reuse.stats }], [[{ id: 8 }], { reused: 0, refused: 2 }]);
});

test('an unknown a journal admitted before intents were recorded is matched by its name and hash only, as before', async () => {
  const legacy = { id: 'e1', name: 'lookup', argsHash: canonicalHash({ input: { id: 7 } }), session: null };
  const reuse = reuseReceipts({ tools: ['registry_lookup'], receipts: [], unknown: [legacy] });
  const lookup = counted('registry_lookup');
  await reuse.wrap(lookup).execute({ id: 7 });
  assert.deepEqual([lookup.calls, { ...reuse.stats }], [[{ id: 7 }], { reused: 0, refused: 0 }]);
});
