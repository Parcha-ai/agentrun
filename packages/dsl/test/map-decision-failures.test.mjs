// Decisions inside a collecting map (`onItemFailure: "collect"`): a provider's failure (rate_limited, http,
// invalid_response, timeout, invalid_request, connection) fails that item; a decision sent whose outcome was lost, or one
// its provider refused, marks the item needs_review; the other items finish either way, and the run completes. A
// configuration or auth failure still stops the map. Twenty items run at once with maxConcurrency 20.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionProviderError, judgeFromProvider, runWorkflow, isItemFailure } from '../dist/index.js';
import { openJournal, openRecovery, withRecovery } from '../dist/recovery/index.js';

const SCHEMAS = {
  Input: { type: 'object', required: ['docs'], properties: { docs: { type: 'array' } } },
  Any: { type: 'object' },
  Valid: { type: 'object', required: ['valid'], properties: { valid: { type: 'boolean', description: 'Is the document valid?' } } },
};
const flow = (map = {}) => ({
  v: 2, name: 'batch', schemas: SCHEMAS, input: { schemaId: 'Input' }, output: { schemaId: 'Any' },
  root: { node: 'map', label: 'each', itemsPath: 'docs', as: 'verdicts', resultPath: 'verdict', onItemFailure: 'collect', failedAs: 'failed', maxConcurrency: 20,
    body: { node: 'judge', label: 'valid', state: { doc: '{item}' }, out: 'Valid', as: 'verdict' }, ...map },
});
const DOCS = Array.from({ length: 20 }, (_, i) => `doc-${i}`);

/** A provider whose answer for each document `outcome(doc)` decides: undefined answers yes, an error code throws it,
 *  "refusal" refuses. It counts the requests in flight at once. */
function scripted(outcome, { delayMs = 20 } = {}) {
  const stats = { inFlight: 0, peak: 0, calls: 0 };
  const provider = {
    id: 'jev', needs: [], capabilities: { types: ['noul'], inputs: ['text', 'json'], evidence: 'none', probability: 'model', grounding: false, replay: 'never', maxQuestions: null, maxStateBytes: null },
    decide: async (request) => {
      stats.calls++; stats.inFlight++; stats.peak = Math.max(stats.peak, stats.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const what = outcome(request.state.doc);
        if (what === 'refusal') return { answers: { valid: { type: 'refusal' } }, evidence: [], model: 'm', usage: null, cost_usd: null, cost_basis: 'unknown', provider_request_id: null };
        if (what) throw new DecisionProviderError(what, `scripted ${what}`, { attempts: 1 });
        return { answers: { valid: { type: 'noul', noul: 0.9 } }, evidence: [], model: 'm', usage: null, cost_usd: 0.0001, cost_basis: 'estimate', provider_request_id: null };
      } finally { stats.inFlight--; }
    },
  };
  return { provider, stats };
}

test('a provider failure is an item failure for the codes that fail one item, never configuration, auth, aborted or outcome_unknown', () => {
  for (const code of ['rate_limited', 'http', 'invalid_response', 'timeout', 'invalid_request', 'connection']) assert.equal(isItemFailure(new DecisionProviderError(code, code)), true, code);
  for (const code of ['configuration', 'auth', 'aborted', 'outcome_unknown']) assert.equal(isItemFailure(new DecisionProviderError(code, code)), false, code);
});

test('twenty items run at once; failed items are rows, lost and refused decisions are rows marked needs_review, and the run completes', async () => {
  const plan = { 'doc-3': 'rate_limited', 'doc-5': 'http', 'doc-7': 'invalid_response', 'doc-9': 'timeout', 'doc-11': 'outcome_unknown', 'doc-13': 'refusal' };
  const { provider, stats } = scripted((doc) => plan[doc]);
  const events = [];
  const result = await runWorkflow(flow(), { docs: DOCS }, { runJudge: judgeFromProvider(provider), onEvent: (e) => events.push(e) });
  assert.equal(result.status, 'complete');
  assert.equal(stats.peak, 20, 'every item was asked at once');
  assert.equal(stats.calls, 20, 'no request was sent twice');
  const failed = Object.fromEntries(result.state.failed.map((row) => [row.item_index, row]));
  assert.deepEqual(Object.keys(failed).map(Number).sort((a, b) => a - b), [3, 5, 7, 9, 11, 13]);
  for (const [index, code] of [[3, 'rate_limited'], [5, 'http'], [7, 'invalid_response'], [9, 'timeout']]) {
    assert.equal(failed[index].code, code);
    assert.equal(failed[index].needs_review, undefined);
  }
  assert.deepEqual([failed[11].code, failed[11].needs_review, failed[11].label], ['decision_interrupted', true, 'valid']);
  assert.deepEqual([failed[13].code, failed[13].needs_review], ['decision_refused', true]);
  assert.equal(result.state.verdicts.filter((v) => v === null).length, 6);
  assert.deepEqual(result.state.verdicts[0], { valid: true });
  const reviewEvents = events.filter((e) => e.type === 'map.item_failed' && e.detail.needs_review);
  assert.deepEqual(reviewEvents.map((e) => e.detail.item_index).sort((a, b) => a - b), [11, 13]);
});

test('a configuration or auth failure stops the map as before', async () => {
  for (const code of ['configuration', 'auth']) {
    const { provider } = scripted((doc) => (doc === 'doc-2' ? code : undefined));
    await assert.rejects(runWorkflow(flow(), { docs: DOCS }, { runJudge: judgeFromProvider(provider) }), (error) => error instanceof DecisionProviderError && error.code === code);
  }
});

test('outside a collecting map a lost decision still escalates the run', async () => {
  const { provider } = scripted((doc) => (doc === 'doc-1' ? 'outcome_unknown' : undefined));
  const result = await runWorkflow(flow({ onItemFailure: 'stop', failedAs: undefined }), { docs: DOCS.slice(0, 3) }, { runJudge: judgeFromProvider(provider) });
  assert.equal(result.status, 'escalated');
  assert.equal(result.escalation.kind, 'decision_interrupted');
});

test('under recovery a reviewed item is committed once, and a later process answers it from its row without asking again', async () => {
  let record; let owned = false;
  const backend = {
    acquire: async () => { if (owned) throw new Error('Run already has a live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); },
  };
  const store = { open: (bound) => openJournal(backend, bound) };
  const docs = DOCS.slice(0, 4);
  const plan = { 'doc-1': 'outcome_unknown', 'doc-2': 'http' };
  const asked = [];
  const run = async (cutMap) => {
    const { provider } = scripted((doc) => { asked.push(doc); return plan[doc]; }, { delayMs: 1 });
    const driver = await openRecovery(store, flow(), { key: 'batch-run' });
    const deps = withRecovery(driver, { runJudge: judgeFromProvider(provider) });
    if (cutMap) deps.recovery = { ...deps.recovery, commit: (node, ...rest) => (node.label === 'each' ? Promise.reject(new Error('cut at each')) : driver.recovery.commit(node, ...rest)) };
    try { return await runWorkflow(flow(), { docs }, deps); } finally { await driver.close(); }
  };
  await assert.rejects(run(true), /cut at each/);
  const result = await run(false);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.state.failed.map((r) => [r.item_index, r.code, r.needs_review ?? false]), [[1, 'decision_interrupted', true], [2, 'http', false]]);
  assert.deepEqual(asked.filter((doc) => doc === 'doc-1' || doc === 'doc-2').sort(), ['doc-1', 'doc-2'], 'neither failed item was asked again');
});
