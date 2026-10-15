// A map that collects its items' failures (`onItemFailure: "collect"`): an item that ends on an item failure is a row of
// `failedAs` and `null` in its slot of `as`, the other items finish, and the slots stay aligned with the items. What is
// never collected stops the map as it does without the field. Under recovery a collected failure commits once and
// answers its item in every later process, in both layouts; every later open of one store stands for a later process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runWorkflow, validateWorkflow, isItemFailure, NODE_FIELDS, EffectFailure, EffectOutcomeUnknownError, EscalationSignal,
  WorkflowCodeError, WorkflowOutputInvalidError, WorkflowStateError, WorkflowVerificationError,
} from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, openJournal, RecoveryError, FROZEN_SNAPSHOT_SCHEMA_V4 } from '@parcha/agentrun-dsl/recovery';

const ITEMS = [{ id: 'a', price: 1 }, { id: 'b', price: 2 }, { id: 'c', price: -1 }, { id: 'd', price: 4 }, { id: 'e', price: 5 }];
const SCHEMAS = {
  Input: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
  Any: { type: 'object' },
  Found: { type: 'object', required: ['id', 'price'], properties: { id: { type: 'string' }, price: { type: 'number' } } },
  Verdict: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } },
};
const flow = (map, after = []) => ({
  v: 2, name: 'collect', schemas: SCHEMAS, input: { schemaId: 'Input' }, output: { schemaId: 'Any' },
  root: { node: 'chain', steps: [{ node: 'map', label: 'each', itemsPath: 'items', as: 'found', ...map }, ...after] },
});
/** Prices an item, and throws for one without a price. */
const priced = { node: 'code', label: 'price', as: 'quote', code: 's => { if (s.item.price < 0) throw new Error("no price for " + s.item.id); return { id: s.item.id, total: s.item.price * 10 }; }' };
const collect = (body, extra = {}) => ({ onItemFailure: 'collect', failedAs: 'failed', body, ...extra });
const quote = (id, price) => ({ id, total: price * 10 });
const codeMessage = (label, message) => `code node "${label}" failed: ${message}; check its state paths, synchronous function body and supported globals`;
const fetch = { node: 'call', label: 'fetch', via: 'tool', tool: 'fetch', args: { id: '{item.id}' }, out: 'Any', as: 'got', deadline_s: 5 };
const unknownOutcome = () => new EffectOutcomeUnknownError('fetch', 'deadline', 1, 'key', Promise.resolve({ status: 'rejected', reason: null }));

test('an item failure is the interpreter\'s own typed node failure or a host\'s declared one, and nothing whose cause is uncertain, the journal\'s, the author\'s stop or an abort', () => {
  const declared = (extra) => Object.assign(new Error('blocked by the content filter'), extra);
  for (const error of [
    new EffectFailure('the tool failed', null, { code: 'effect_exit' }), new EffectFailure('the poll met fail_when', null),
    new WorkflowOutputInvalidError('no match', []), new WorkflowStateError('missing', 'each', 'r', 'missing_map_result'),
    new WorkflowCodeError('price', new Error('no price')), new WorkflowVerificationError('judge', {}, [], 'refused'),
    declared({ code: 'CONTENT_FILTER', itemFailure: true }),
  ]) assert.equal(isItemFailure(error), true, error.message);
  for (const error of [
    new Error('a host error'), declared({ code: 'CONTENT_FILTER' }), declared({ itemFailure: true }), declared({ code: 7, itemFailure: true }),
    unknownOutcome(), new RecoveryError('journal', 'FROZEN_EFFECT_UNKNOWN'), Object.assign(new RecoveryError('journal', 'X'), { itemFailure: true }),
    new EffectFailure('wrapped', null, { cause: new RecoveryError('a failed commit', 'RECEIPTS_FAILURE') }),
    declared({ code: 'X', itemFailure: true, cause: unknownOutcome() }),
    new EscalationSignal({ kind: 'k', stage: 's', summary: 'stop' }), new DOMException('stopped', 'AbortError'),
    new AggregateError([new EffectFailure('one')], 'two at once'), 'not an error', null,
  ]) assert.equal(isItemFailure(error), false, String(error?.message ?? error));
});

test('onItemFailure is "stop" or "collect"; failedAs is required with "collect", refused without it, and is its own key', () => {
  const problems = (map) => { const checked = validateWorkflow(flow(map)); return checked.ok ? '' : checked.errors.join('\n'); };
  assert.equal(problems(collect(priced)), '');
  assert.equal(problems({ onItemFailure: 'stop', body: priced }), '');
  assert.match(problems({ onItemFailure: 'skip', body: priced }), /onItemFailure must be "stop" or "collect"/);
  assert.match(problems({ onItemFailure: 3, body: priced }), /onItemFailure/);
  assert.match(problems({ onItemFailure: 'collect', body: priced }), /onItemFailure "collect" needs failedAs/);
  assert.match(problems(collect(priced, { failedAs: ' ' })), /needs failedAs/);
  assert.match(problems(collect(priced, { failedAs: '$failed' })), /failedAs must not name an engine-owned "\$" state key/);
  assert.match(problems(collect(priced, { failedAs: 'found' })), /failedAs must differ from as/);
  assert.match(problems({ failedAs: 'failed', body: priced }), /failedAs is written only with onItemFailure "collect"/);
  assert.match(problems({ onItemFailure: 'stop', failedAs: 'failed', body: priced }), /failedAs is written only with onItemFailure "collect"/);
  // A build that does not know the fields refuses them as any field it does not know.
  assert.deepEqual(NODE_FIELDS.map.slice(-2), ['onItemFailure', 'failedAs']);
  assert.match(problems(collect(priced, { onItemFailures: 'collect' })), /onItemFailures/);
  // Parallel branches write disjoint keys, failedAs among them.
  const parallel = { ...flow({}), root: { node: 'parallel', label: 'both', branches: [
    { node: 'map', label: 'each', itemsPath: 'items', as: 'found', ...collect(priced) },
    { node: 'code', label: 'other', as: 'failed', code: 's => 1' },
  ] } };
  assert.match(validateWorkflow(parallel).errors.join('\n'), /both write state\.failed/);
});

test('a collecting map keeps as aligned with its items: a later node zips them, and the failed item\'s row holds null', async () => {
  const events = [];
  const workflow = flow(collect(priced), [{ node: 'code', label: 'zip', code: 's => ({ rows: s.items.map((item, i) => ({ id: item.id, result: s.found[i] })) })' }]);
  const run = await runWorkflow(workflow, { items: ITEMS }, { onEvent: (event) => events.push(event) });
  assert.equal(run.status, 'complete');
  assert.deepEqual(run.state.rows, [
    { id: 'a', result: quote('a', 1) }, { id: 'b', result: quote('b', 2) }, { id: 'c', result: null },
    { id: 'd', result: quote('d', 4) }, { id: 'e', result: quote('e', 5) },
  ]);
  assert.equal(run.state.found.length, ITEMS.length, 'one slot per item');
  assert.deepEqual(run.state.failed, [{ item_index: 2, label: 'price', code: 'code_transform_failed', message: codeMessage('price', 'no price for c') }]);
  assert.deepEqual(events.filter((event) => event.type === 'map.item_failed').map((event) => event.detail), [{ item_index: 2, label: 'price', code: 'code_transform_failed' }]);
  assert.ok(!events.some((event) => event.type === 'map.failed'));
});

test('without onItemFailure, or with "stop", the first failing item stops the map and the run, as before', async () => {
  for (const map of [{ body: priced }, { onItemFailure: 'stop', body: priced }]) {
    await assert.rejects(runWorkflow(flow(map), { items: ITEMS }, {}), (error) => error instanceof WorkflowCodeError && /no price for c/.test(error.message));
  }
});

test('the rows are in item order, each naming the node that failed and its code; the other items all finish', async () => {
  const failing = new Set(['a', 'd']);
  const asked = [];
  const workflow = flow(collect({ node: 'chain', steps: [fetch, { node: 'agent', label: 'judge', instructions: 'Judge it.', out: 'Verdict', as: 'verdict' }] }, { maxConcurrency: 2, resultPath: 'verdict' }));
  const run = await runWorkflow(workflow, { items: ITEMS }, {
    runEffect: async ({ input }) => {
      if (input.id === 'd') throw Object.assign(new Error('the provider refused d'), { code: 'PROVIDER_REFUSED', itemFailure: true });
      return { id: input.id };
    },
    runNode: async ({ item }) => { asked.push(item.index); return failing.has(ITEMS[item.index].id) ? { verdict: 7 } : { verdict: 'buy' }; },
  });
  assert.deepEqual(run.state.found, [null, { verdict: 'buy' }, { verdict: 'buy' }, null, { verdict: 'buy' }]);
  assert.deepEqual(run.state.failed.map(({ item_index, label, code }) => ({ item_index, label, code })), [
    { item_index: 0, label: 'judge', code: 'output_invalid' },
    { item_index: 3, label: 'fetch', code: 'PROVIDER_REFUSED' },
  ]);
  assert.equal(run.state.failed[1].message, 'the provider refused d');
  assert.deepEqual(asked.sort(), [0, 1, 2, 4], 'every item that reached its agent was asked; d failed before it');
});

test('a failure that left no step is the map\'s own: a missing resultPath', async () => {
  const run = await runWorkflow(flow(collect({ node: 'code', label: 'shape', code: 's => s.item.price > 3 ? { kept: s.item.id } : { other: 1 }' }, { resultPath: 'kept' })), { items: ITEMS }, {});
  assert.deepEqual(run.state.found, [null, null, null, 'd', 'e']);
  assert.deepEqual(run.state.failed.map((row) => [row.item_index, row.label, row.code]), [[0, 'each', 'state_invalid'], [1, 'each', 'state_invalid'], [2, 'each', 'state_invalid']]);
});

test('a failure inside a child workflow names the child\'s node under the invocation, as its events do', async () => {
  const child = { v: 2, name: 'child', schemas: { In: { type: 'object', required: ['item'], properties: { item: { type: 'object' } } }, Any: { type: 'object' } },
    input: { schemaId: 'In' }, output: { schemaId: 'Any', path: 'quote' }, root: { node: 'code', label: 'price', as: 'quote', code: priced.code } };
  const run = await runWorkflow(flow(collect({ node: 'workflow', label: 'child', workflow: child, input: { item: '{item}' }, out: 'Any', as: 'sub' }, { resultPath: 'sub' })), { items: ITEMS }, {});
  assert.deepEqual(run.state.failed.map((row) => [row.item_index, row.label, row.code]), [[2, 'child/price', 'code_transform_failed']]);
  assert.deepEqual(run.state.found[3], quote('d', 4));
});

test('never collected: an unknown outcome, an undeclared host error, an escalation and an abort stop a collecting map', async () => {
  const run = (body, deps) => runWorkflow(flow(collect(body, { maxConcurrency: 1 })), { items: ITEMS }, deps);
  const throwsAt = (error) => ({ runEffect: async ({ input }) => { if (input.id === 'c') throw error(); return { id: input.id }; } });
  await assert.rejects(run(fetch, throwsAt(unknownOutcome)), (error) => error instanceof EffectOutcomeUnknownError);
  await assert.rejects(run(fetch, throwsAt(() => new Error('a host error'))), /a host error/);
  await assert.rejects(run(fetch, throwsAt(() => Object.assign(new Error('undeclared'), { code: 'X' }))), /undeclared/);
  const escalated = await runWorkflow(flow(collect({ node: 'chain', steps: [
    { node: 'code', label: 'look', as: 'seen', code: 's => ({ price: s.item.price })' },
    { node: 'escalate', label: 'halt', when: { predicate: 'lt', path: 'seen.price', n: 0 }, kind: 'no_price', stage: 'each', summary: 'an item has no price' },
  ] })), { items: ITEMS }, {});
  assert.equal(escalated.status, 'escalated');
  assert.equal(escalated.escalation.kind, 'no_price');
  const stop = new AbortController();
  await assert.rejects(run(fetch, { signal: stop.signal, runEffect: async ({ input }) => {
    if (input.id === 'c') { stop.abort(new Error('the host stopped the run')); throw new EffectFailure('cut by the stop', null, { code: 'effect_exit' }); }
    return { id: input.id };
  } }), /the host stopped the run|cut by the stop/);
});

test('a collecting map under a recovery that cannot commit an item\'s failure is refused before any step runs', async () => {
  let calls = 0;
  const recovery = { supportsExecutionPaths: true, resume: async () => undefined, commit: async () => {}, pollStartedAt: () => Date.now(), wait: async () => {} };
  await assert.rejects(runWorkflow(flow(collect(fetch)), { items: ITEMS }, { recovery, runEffect: async () => { calls += 1; return {}; } }),
    /map node "each" requires recovery\.failItem and recovery\.itemFailure/);
  assert.equal(calls, 0);
});

// Under recovery.

const KEY = 'run-1';
const ITEM = (index) => `/root/steps/0/items/${index}`;
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
const judged = flow(collect({ node: 'chain', steps: [
  { node: 'call', label: 'lookup', via: 'tool', tool: 'lookup', args: { id: '{item.id}' }, out: 'Found', as: 'priced', deadline_s: 30 },
  { node: 'agent', label: 'judge', instructions: 'Judge the price.', out: 'Verdict', as: 'verdict' },
] }, { resultPath: 'verdict' }));
/** One process of the run. `answer` is the model's answer for an item; `cut` names a commit that never lands, as in a
 *  process that dies after the work and before its commit: `each` (the map's own commit) or `failItem`. */
async function process(store, { layout, cut, answer = () => ({ verdict: 'buy' }), calls = [], asks = [], rows = [], effect } = {}) {
  const driver = await openRecovery(store, judged, { key: KEY, ...(layout ? { layout } : {}) });
  const deps = withRecovery(driver, {
    runEffect: effect ?? (async ({ input }) => { calls.push(input.id); return ITEMS.find((item) => item.id === input.id); }),
    runNode: async ({ item }) => { asks.push(item.index); return answer(item.index); },
  });
  if (cut === 'each') deps.recovery = { ...deps.recovery, commit: (node, ...rest) => (node.label === 'each' ? Promise.reject(new Error('cut at each')) : driver.recovery.commit(node, ...rest)) };
  if (cut === 'failItem') deps.recovery = { ...deps.recovery, failItem: async (_node, row) => { rows.push(row); throw new Error('cut at failItem'); } };
  try { return await runWorkflow(judged, { items: ITEMS }, deps); } finally { await driver.close(); }
}
const invalidAt = (failing) => (index) => (index === failing ? { verdict: 42 } : { verdict: 'buy' });
const failedRow = (record, index) => (record.state.schema === FROZEN_SNAPSHOT_SCHEMA_V4 ? record.items[ITEM(index)]?.outcome : record.state.pin.failures?.[ITEM(index)]);

for (const layout of [undefined, 'v4']) {
  const name = layout ?? 'v3 (default)';
  test(`${name}: a collected failure commits with its item, and every later process answers the item from it without running its body`, async () => {
    const kept = inspectable();
    const calls = []; const asks = [];
    await assert.rejects(process(kept.store, { layout, cut: 'each', answer: invalidAt(2), calls, asks }), /cut at each/);
    const record = kept.record();
    const row = failedRow(record, 2);
    assert.deepEqual([row.label, row.code], ['judge', 'output_invalid']);
    assert.match(row.message, /^agent node "judge" submission does not satisfy schema "Verdict"/);
    if (layout === 'v4') {
      assert.deepEqual([record.items[ITEM(2)].status, record.items[ITEM(1)].status], ['failed', 'committed']);
      assert.equal(record.items[ITEM(1)].outcome, undefined, 'only a failed item holds an outcome');
      assert.equal(record.state.pin.failures, undefined, 'the driver record holds no item\'s failure');
    } else assert.deepEqual(Object.keys(record.state.pin.failures), [ITEM(2)], 'one row per failed item, none for the others');
    const run = await process(kept.store, { layout, calls, asks });
    assert.equal(run.status, 'complete');
    assert.deepEqual(run.state.found, [{ verdict: 'buy' }, { verdict: 'buy' }, null, { verdict: 'buy' }, { verdict: 'buy' }]);
    assert.deepEqual(run.state.failed, [{ item_index: 2, label: 'judge', code: 'output_invalid', message: row.message }]);
    assert.deepEqual(calls.sort(), ['a', 'b', 'c', 'd', 'e'], 'every call once, across both processes');
    assert.deepEqual(asks.sort(), [0, 1, 2, 3, 4], 'the failed item is never asked again');
    assert.deepEqual(failedRow(kept.record(), 2), row, 'the row stays with the run after its map commits, as committed paths do');
  });

  test(`${name}: a process killed before the item's failure commits asks again, and the item fails the same way, once`, async () => {
    const kept = inspectable();
    const calls = []; const asks = [];
    await assert.rejects(process(kept.store, { layout, cut: 'failItem', answer: invalidAt(2), calls, asks }), /cut at failItem/);
    assert.equal(failedRow(kept.record(), 2), undefined, 'nothing of the failure landed');
    await assert.rejects(process(kept.store, { layout, cut: 'each', answer: invalidAt(2), calls, asks }), /cut at each/);
    assert.equal(failedRow(kept.record(), 2).code, 'output_invalid');
    const run = await process(kept.store, { layout, answer: invalidAt(2), calls, asks });
    assert.deepEqual(run.state.failed.map((row) => row.item_index), [2]);
    assert.equal(asks.filter((index) => index === 2).length, 2, 'asked in the first process and again in the second, never in the third');
    assert.deepEqual(calls.sort(), ['a', 'b', 'c', 'd', 'e'], 'the item\'s call is answered from its receipt');
  });

  test(`${name}: a step that failed for good on an item failure ends its item the same way in the next process, without asking`, async () => {
    const kept = inspectable();
    const asks = []; const rows = [];
    const refused = (index) => { if (index === 2) throw Object.assign(new Error('judge: the model did not answer (model_error)'), { code: 'NODE_NOT_DELIVERED', final: true, itemFailure: true }); return { verdict: 'buy' }; };
    await assert.rejects(process(kept.store, { layout, cut: 'failItem', answer: refused, asks, rows }), /cut at failItem/);
    assert.deepEqual(rows, [{ item_index: 2, label: 'judge', code: 'NODE_NOT_DELIVERED', message: 'judge: the model did not answer (model_error)' }]);
    const run = await process(kept.store, { layout, answer: refused, asks });
    assert.deepEqual(run.state.failed, rows, 'the row the first process would have written');
    assert.equal(asks.filter((index) => index === 2).length, 1, 'the failed step is refused, never asked again');
  });

  test(`${name}: a call that threw inside an item leaves its outcome unknown; the item is never a row, and the map stops`, async () => {
    const kept = inspectable();
    const effect = async ({ input }) => { if (input.id === 'c') throw new EffectFailure('the tool failed', null, { code: 'effect_exit' }); return ITEMS.find((item) => item.id === input.id); };
    await assert.rejects(process(kept.store, { layout, effect }), (error) => error instanceof RecoveryError && error.code === 'FROZEN_EFFECT_UNKNOWN');
    assert.equal(failedRow(kept.record(), 2), undefined);
  });
}

test('a run stored whole with a failed item moves to the keyed layout with the item\'s outcome in its record, and completes', async () => {
  const kept = inspectable();
  const asks = [];
  await assert.rejects(process(kept.store, { cut: 'each', answer: invalidAt(2), asks }), /cut at each/);
  const held = kept.record().state.pin.failures[ITEM(2)];
  const run = await process(kept.store, { layout: 'v4', asks });
  assert.equal(kept.record().state.schema, FROZEN_SNAPSHOT_SCHEMA_V4);
  assert.deepEqual([kept.record().items[ITEM(2)].status, kept.record().items[ITEM(2)].outcome], ['failed', held]);
  assert.deepEqual(run.state.failed, [{ item_index: 2, ...{ label: held.label, code: held.code, message: held.message } }]);
  assert.equal(asks.filter((index) => index === 2).length, 1);
});

test('a failed item\'s record or row that is not one the driver wrote is refused, never run around', async () => {
  for (const layout of [undefined, 'v4']) {
    for (const corrupt of [
      (record) => { if (layout) delete record.items[ITEM(2)].outcome; else record.state.pin.failures[ITEM(2)].code = 7; },
      (record) => { if (layout) record.items[ITEM(1)].outcome = record.items[ITEM(2)].outcome; else record.state.pin.failures['/root/steps/0'] = record.state.pin.failures[ITEM(2)]; },
    ]) {
      const kept = inspectable();
      await assert.rejects(process(kept.store, { layout, cut: 'each', answer: invalidAt(2) }), /cut at each/);
      const record = kept.record();
      corrupt(record);
      kept.set(record);
      await assert.rejects(process(kept.store, { layout }), (error) => error instanceof RecoveryError && error.code === 'FROZEN_CHECKPOINT_INVALID');
    }
  }
});
