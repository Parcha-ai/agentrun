// Not buying an effect twice: a paid call's result is recorded in the run's receipts, a repeat of a call another session
// paid for is answered from them, and a call equal to an unknown effect is refused; neither reaches the tool.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalHash } from '@parcha/agentrun-dsl/recovery';
import { reuseReceipts, ReceiptIndex } from '@parcha/agentrun-pi/durable';

/** pi-durable's call api over a map: `snapshot` reads a document of the family, `commit` runs a transaction that edits one. */
function api(held = new Map()) {
  const doc = (key) => { if (!held.has(key)) held.set(key, { tool: '', argsHash: '', result: null, session: null }); return held.get(key); };
  return {
    held,
    snapshot: async (family, key) => { assert.equal(family, ReceiptIndex); return held.has(key) ? { ...held.get(key) } : undefined; },
    commit: async (write) => write({ doc: async (family, key) => { assert.equal(family, ReceiptIndex); return doc(key); } }),
  };
}
const keyOf = (tool, args) => `${tool}:${canonicalHash(args)}`;
function counted(name, text = 'live') {
  const tool = { name, description: 'd', async execute(args) { tool.calls.push(args); return { content: [{ type: 'text', text }] }; } };
  tool.calls = [];
  return tool;
}
const seed = (held, tool, args, result, session = 'earlier:step') => held.set(keyOf(tool, args), { tool, argsHash: canonicalHash(args), result, session });

test('a repeat of another session\'s paid call makes no second request, and says where its answer came from', async () => {
  const calls = api();
  seed(calls.held, 'search', { q: 'acme' }, '{"hits":3}');
  const reuse = reuseReceipts({ tools: ['search'], sessionId: 'tail', answer: true });
  const search = counted('search');
  const answered = await reuse.wrap(search).execute({ q: 'acme' }, calls, {});
  assert.deepEqual(search.calls, []);
  assert.equal(answered.details.effect_status, 'reused');
  assert.match(answered.content[0].text, /^\{"hits":3\}\n\n\(answered from the paid receipt of earlier:step; the call was not dispatched again\)$/);
  assert.equal((await reuse.wrap(search).execute({ q: 'other' }, calls, {})).content[0].text, 'live');
  assert.deepEqual(search.calls, [{ q: 'other' }]);
  assert.deepEqual({ ...reuse.stats }, { reused: 1, refused: 0 });
});

test('a paid result is recorded under its tool and arguments, by the session that paid; a failure is not a paid result', async () => {
  const calls = api();
  const reuse = reuseReceipts({ tools: ['search', 'broken'], sessionId: 'lead', answer: true });
  await reuse.wrap(counted('search', 'rows')).execute({ q: 'a' }, calls, {});
  assert.deepEqual(calls.held.get(keyOf('search', { q: 'a' })), { tool: 'search', argsHash: canonicalHash({ q: 'a' }), result: 'rows', session: 'lead' });
  const failing = { name: 'broken', execute: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) };
  await reuse.wrap(failing).execute({ q: 'b' }, calls, {});
  const envelope = { name: 'broken', execute: async () => ({ content: [{ type: 'text', text: '{"ok":false,"error":"x"}' }] }) };
  await reuse.wrap(envelope).execute({ q: 'c' }, calls, {});
  assert.equal(calls.held.size, 1);
  // A session never answers from its own receipt: the same call again runs.
  const again = counted('search');
  await reuse.wrap(again).execute({ q: 'a' }, calls, {});
  assert.equal(again.calls.length, 1);
});

test('a run that does not answer still records; a receipt already held is kept', async () => {
  const calls = api();
  seed(calls.held, 'search', { q: 'a' }, 'first', 'other');
  const reuse = reuseReceipts({ tools: ['search'], sessionId: 'lead', answer: false });
  const search = counted('search', 'second');
  await reuse.wrap(search).execute({ q: 'a' }, calls, {});
  assert.equal(search.calls.length, 1);
  assert.equal(calls.held.get(keyOf('search', { q: 'a' })).result, 'first');
});

test('an inherited unknown is refused, never dispatched', async () => {
  const calls = api();
  const reuse = reuseReceipts({ tools: ['pay'], sessionId: 'tail', answer: true, unknown: [{ name: 'pay', argsHash: canonicalHash({ amount: 5 }) }] });
  const pay = counted('pay');
  const refused = await reuse.wrap(pay).execute({ amount: 5 }, calls, {});
  assert.deepEqual(pay.calls, []);
  assert.equal(refused.isError, true);
  assert.equal(refused.details.effect_status, 'unknown');
  await reuse.wrap(pay).execute({ amount: 6 }, calls, {});
  assert.deepEqual(pay.calls, [{ amount: 6 }]);
  assert.deepEqual({ ...reuse.stats }, { reused: 0, refused: 1 });
});

test('a tool the host did not name as paid is returned as it is', () => {
  const read = counted('read');
  assert.equal(reuseReceipts({ tools: ['search'], sessionId: 'tail', answer: true }).wrap(read), read);
});

test('a fetch wrapper is keyed by the gateway tool it names, as the driver keyed the effect', async () => {
  const calls = api();
  seed(calls.held, 'registry_lookup', { id: 7 }, 'row 7');
  const fetch = counted('fetch');
  const answered = await reuseReceipts({ tools: ['fetch'], sessionId: 'tail', answer: true }).wrap(fetch).execute({ tool: 'registry_lookup', args: { id: 7 } }, calls, {});
  assert.equal(answered.details.effect_status, 'reused');
  assert.deepEqual(fetch.calls, []);
});

test('an unknown a workflow node was admitted with is refused by the external call it made', async () => {
  const calls = api();
  const intent = { tool: 'registry_lookup', argsHash: canonicalHash({ id: 7 }) };
  const reuse = reuseReceipts({ tools: ['fetch'], sessionId: 'tail', answer: true, unknown: [{ name: 'lookup-node', argsHash: canonicalHash({ node: 'whole invocation' }), intent }] });
  const fetch = counted('fetch');
  const refused = await reuse.wrap(fetch).execute({ tool: 'registry_lookup', args: { id: 7 } }, calls, {});
  assert.equal(refused.details.effect_status, 'unknown');
  assert.deepEqual(fetch.calls, []);
  await reuse.wrap(fetch).execute({ tool: 'registry_lookup', args: { id: 8 } }, calls, {});
  assert.equal(fetch.calls.length, 1);
});
