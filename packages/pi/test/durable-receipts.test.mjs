// Not buying an effect twice: a call equal to an inherited receipt is answered from it, one equal to an inherited
// unknown is refused, and neither reaches the tool.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalHash } from '@parcha/agentrun-dsl/recovery';
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
