// Every typed question the interpreter asks is one decision: a receipt recorded, and awaited, before its
// answers reach state, an event or a branch. The receipt carries the rule and the action, so the action can
// be recomputed from it; its id is on the event that acted on it; a split sift makes one receipt per
// request; and a resumed run decides what the interrupted run decided.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow, rederiveDecision, WorkflowDecisionRecordError, DECISION_RECEIPT_VERSION } from '../dist/index.js';

const noul = (p) => ({ type: 'noul', noul: p });
const choice = (options, chosen, confidence = 0.9) => ({
  type: 'choice', choice: chosen, confidence,
  probabilities: Object.fromEntries(options.map((o) => [o, o === chosen ? confidence : (1 - confidence) / (options.length - 1)])),
});
const schemas = {
  Flags: { type: 'object', required: ['urgent'], properties: { urgent: { type: 'boolean', description: 'Is the request urgent?' } } },
  Keep: { type: 'object', required: ['keep'], properties: { keep: { type: 'boolean', description: 'Should this item be kept?' } } },
  Out: { type: 'object' },
};
const flow = (root, extra = {}) => ({ v: 2, name: 'decisions', schemas: { ...schemas, ...extra }, output: { schemaId: 'Out', path: 'out' }, root });
const code = (label, body) => ({ node: 'code', label, code: body });

/** A recorder that keeps receipts with their exchanges, and the order of receipts and decision events. */
function recorder() {
  const receipts = [], exchanges = [], order = [], events = [];
  return {
    receipts, exchanges, order, events,
    deps: {
      recordDecision: async (receipt, exchange) => {
        // A durable write takes time: an answer applied before it is awaited would show in `order`.
        await new Promise((resolve) => setImmediate(resolve));
        receipts.push(structuredClone(receipt)); exchanges.push(exchange); order.push(`receipt:${receipt.id}`);
      },
      onEvent: (event) => {
        events.push(event);
        for (const id of event.detail?.decision_ids ?? (event.detail?.decision_id ? [event.detail.decision_id] : [])) order.push(`event:${id}`);
      },
    },
  };
}

test('each typed question is one receipt, recorded before its answer is acted on, and the action re-derives from it', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'judge', label: 'flags', state: { text: '{text}' }, out: 'Flags', as: 'flags' },
    { node: 'pick', label: 'best', itemsPath: 'items', describe: '{item}', instructions: 'Choose the best item.', allowNone: true, as: 'best' },
    { node: 'sift', label: 'screen', itemsPath: 'items', out: 'Keep', as: 'screened', keep: { path: 'keep', gte: 0.7 } },
    { node: 'route', label: 'lane', state: { text: '{text}' }, instructions: 'Which lane?', unsure: { gte: 0.8, branch: 'slow' }, as: 'lane', branches: {
      fast: { criteria: 'simple', body: code('fast-step', '() => ({ out: { via: "fast" } })') },
      slow: { criteria: 'needs care', body: code('slow-step', '() => ({ out: { via: "slow" } })') },
    } },
    { node: 'escalate', label: 'stop', when: { predicate: 'ask', instructions: 'Is a person needed?', gte: 0.6 }, kind: 'review', stage: 'gate', summary: 'A person is needed.' },
  ] });
  const returned = [];
  const judge = async (params) => {
    const answers = {};
    for (const [key, question] of Object.entries(params.questions)) {
      if (params.kind === 'judge') answers[key] = noul(0.8);
      else if (params.kind === 'pick') answers[key] = choice(Object.keys(question.criteria), 'item_1');
      // Item 0 is kept at 0.9, item 1 dropped at 0.6 (below the author's 0.7), item 2 kept at exactly 0.7.
      else if (params.kind === 'sift') answers[key] = noul([0.9, 0.6, 0.7][Number(key.split('.')[0])]);
      // The choice is "fast" at 0.7 confidence, below the unsure threshold of 0.8.
      else if (params.kind === 'route') answers[key] = choice(Object.keys(question.criteria), 'fast', 0.7);
      else answers[key] = noul(0.2);
    }
    const result = { answers, model: 'judge-test', usage: { input_tokens: 11, output_tokens: 3 }, cost_usd: 0.002, request_sha256: `sha-${params.kind}`, host_note: params.kind };
    returned.push({ params, result });
    return result;
  };
  const r = recorder();
  const run = await runWorkflow(workflow, { text: 'please hurry', items: ['a', 'b', 'c'] }, { runJudge: judge, ...r.deps });
  assert.equal(run.status, 'complete');
  assert.deepEqual(run.output, { via: 'slow' });

  assert.deepEqual(r.receipts.map((x) => x.kind), ['judge', 'pick', 'sift', 'route', 'ask']);
  for (const receipt of r.receipts) {
    assert.equal(receipt.v, DECISION_RECEIPT_VERSION);
    assert.equal(receipt.status, 'answered');
    assert.match(receipt.id, /^[0-9a-f]{64}$/);
    assert.match(receipt.state_sha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt.model, 'judge-test');
    assert.deepEqual(receipt.usage, { input_tokens: 11, output_tokens: 3 });
    assert.equal(receipt.cost_usd, 0.002);
    assert.equal(receipt.request_sha256, `sha-${receipt.kind}`);
    assert.equal(receipt.item, null);
    assert.equal(receipt.error, undefined);
    assert.deepEqual(rederiveDecision(receipt), receipt.action, `${receipt.kind}: the action re-derives from the receipt alone`);
    // The receipt precedes the event that names it.
    assert.ok(r.order.indexOf(`receipt:${receipt.id}`) < r.order.indexOf(`event:${receipt.id}`), `${receipt.kind}: recorded before its event`);
    assert.equal(r.order.filter((entry) => entry === `event:${receipt.id}`).length, 1, `${receipt.kind}: one event names it`);
  }
  const [flags, best, screen, lane, stop] = r.receipts;
  assert.deepEqual([flags.node, flags.execution_path, flags.request], ['flags', '/root/steps/0', { index: 0, count: 1 }]);
  assert.deepEqual(flags.rule, { kind: 'judge' });
  assert.deepEqual(flags.action, { urgent: true });
  assert.deepEqual(best.rule, { kind: 'pick', options: ['item_0', 'item_1', 'item_2'], none: 'none_of_these' });
  assert.deepEqual(best.action, { index: 1, none: false });
  assert.deepEqual(screen.request, { index: 0, count: 1, items: [0, 1, 2] });
  assert.deepEqual(screen.rule, { kind: 'sift', items: 3, ids: ['keep'], keep: { id: 'keep', measure: 'value', gte: 0.7 } });
  assert.deepEqual(screen.action, { kept: [0, 2] });
  assert.deepEqual(lane.rule, { kind: 'route', unsure: { gte: 0.8, branch: 'slow' } });
  assert.deepEqual(lane.action, { branch: 'fast', taken: 'slow', unsure: true });
  assert.deepEqual(stop.rule, { kind: 'ask', gte: 0.6 });
  assert.deepEqual(stop.action, { holds: false });
  assert.equal(stop.execution_path, '/root/steps/4');

  // The recorder gets the request as the judge received it and the very object the judge returned.
  r.exchanges.forEach((exchange, i) => {
    assert.equal(exchange.result, returned[i].result);
    assert.equal(exchange.result.host_note, r.receipts[i].kind);
    assert.equal(exchange.request.decisionId, r.receipts[i].id);
    assert.equal(returned[i].params.decisionId, r.receipts[i].id);
    assert.equal(exchange.request.executionPath, r.receipts[i].execution_path);
  });
  // The events say the same things they always did, plus the id.
  const answered = r.events.filter((e) => e.type === 'judge.answered');
  assert.deepEqual(answered.map((e) => e.detail.kind), ['judge', 'pick', 'sift']);
  assert.equal(answered[0].detail.decision_id, flags.id);
  assert.deepEqual(answered[2].detail.decision_ids, [screen.id]);
  assert.equal(answered[2].detail.decision_id, undefined);
  assert.equal(r.events.find((e) => e.type === 'route.chosen').detail.decision_id, lane.id);
  assert.equal(r.events.find((e) => e.type === 'ask.evaluated').detail.decision_id, stop.id);
});

test('the same request has the same id in another run; another state has another id', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'judge', label: 'flags', state: { text: '{text}' }, out: 'Flags', as: 'flags' },
    code('done', '() => ({ out: {} })'),
  ] });
  const ids = [];
  const deps = { runJudge: async () => ({ answers: { urgent: noul(0.9) } }), recordDecision: async (receipt) => { ids.push(receipt.id); } };
  await runWorkflow(workflow, { text: 'one' }, deps);
  await runWorkflow(workflow, { text: 'one' }, deps);
  await runWorkflow(workflow, { text: 'two' }, deps);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
});

test('a split sift records one receipt per request, and its event lists their ids in request order', async () => {
  const workflow = flow({ node: 'sift', label: 'screen', itemsPath: 'items', out: 'Keep', as: 'out', keep: { path: 'keep' } });
  // Odd-numbered items are kept. Two questions fit one request, so five items make three requests.
  const judge = async ({ state, questions }) => ({
    answers: Object.fromEntries(Object.keys(questions).map((key) => [key, noul(state.items[Number(key.split('.')[0])].item.n % 2 ? 0.9 : 0.1)])),
    model: 'judge-test', cost_usd: 0.001,
  });
  const r = recorder();
  const run = await runWorkflow(workflow, { items: [0, 1, 2, 3, 4].map((n) => ({ n })) }, { runJudge: judge, maxQuestionsPerRequest: 2, ...r.deps });
  assert.deepEqual(run.output.kept, [1, 3]);
  const byIndex = [...r.receipts].sort((a, b) => a.request.index - b.request.index);
  assert.deepEqual(byIndex.map((x) => x.request), [
    { index: 0, count: 3, items: [0, 1] },
    { index: 1, count: 3, items: [2, 3] },
    { index: 2, count: 3, items: [4] },
  ]);
  // A request's action names its kept items by their position in that request.
  assert.deepEqual(byIndex.map((x) => x.action), [{ kept: [1] }, { kept: [1] }, { kept: [] }]);
  assert.deepEqual(byIndex.map((x) => x.rule.items), [2, 2, 1]);
  assert.deepEqual(byIndex.map((x) => Object.keys(x.questions)), [['0.keep', '1.keep'], ['0.keep', '1.keep'], ['0.keep']]);
  for (const receipt of byIndex) {
    assert.equal(receipt.execution_path, '/root');
    assert.deepEqual(rederiveDecision(receipt), receipt.action);
    // Its positions map back to the list through `request.items`.
    assert.ok(receipt.action.kept.every((j) => run.output.kept.includes(receipt.request.items[j])));
  }
  assert.equal(new Set(byIndex.map((x) => x.id)).size, 3);
  const event = r.events.find((e) => e.type === 'judge.answered');
  assert.deepEqual(event.detail.decision_ids, byIndex.map((x) => x.id));
  assert.equal(event.detail.requests, 3);
  // Every receipt was recorded before the one event that names them all.
  assert.ok(byIndex.every((x) => r.order.indexOf(`receipt:${x.id}`) < r.order.indexOf(`event:${x.id}`)));
});

test('when a split sift request fails, its siblings in flight are recorded as cancelled and the answered one keeps its receipt', async () => {
  const workflow = flow({ node: 'sift', label: 'screen', itemsPath: 'items', out: 'Keep', as: 'out', keep: { path: 'keep' } });
  // One question per request: six items, six requests, four in flight. Item 0 answers at once. Item 1 fails once
  // item 4's request has started (the first worker's second request). Items 2, 3 and 4 wait until cancelled.
  let fourthStarted;
  const started = new Promise((resolve) => { fourthStarted = resolve; });
  const asked = [];
  const judge = async ({ state, questions, signal }) => {
    const n = state.items[0].item.n;
    asked.push(n);
    if (n === 0) return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, noul(0.9)])), cost_usd: 0.001 };
    if (n === 4) fourthStarted();
    if (n === 1) { await started; throw new Error('judge unavailable for item 1'); }
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(`request for item ${n} aborted`)), { once: true }));
  };
  const r = recorder();
  await assert.rejects(
    runWorkflow(workflow, { items: [0, 1, 2, 3, 4, 5].map((n) => ({ n })) }, { runJudge: judge, maxQuestionsPerRequest: 1, ...r.deps }),
    /judge unavailable for item 1/,
  );
  assert.deepEqual([...asked].sort(), [0, 1, 2, 3, 4], 'the sixth request is never sent');
  const byIndex = [...r.receipts].sort((a, b) => a.request.index - b.request.index);
  assert.deepEqual(byIndex.map((x) => [x.request.index, x.status]), [[0, 'answered'], [1, 'failed'], [2, 'cancelled'], [3, 'cancelled'], [4, 'cancelled']]);
  assert.deepEqual(byIndex[0].action, { kept: [0] });
  assert.equal(byIndex[0].cost_usd, 0.001);
  assert.match(byIndex[1].error, /judge unavailable for item 1/);
  for (const cancelled of byIndex.slice(2)) {
    assert.deepEqual([cancelled.answers, cancelled.rule, cancelled.action], [{}, null, null]);
    assert.match(cancelled.error, /aborted/);
  }
  // The sift decided nothing, so no event names any of these receipts.
  assert.equal(r.events.filter((e) => e.type === 'judge.answered').length, 0);
});

test('a split sift stops at its first failure, however long that failure takes to record', async () => {
  const workflow = flow({ node: 'sift', label: 'screen', itemsPath: 'items', out: 'Keep', as: 'out', keep: { path: 'keep' } });
  // Six requests, four in flight. Item 1 fails at once and its receipt is slow to write. Item 0 answers at
  // once, which frees a worker. Item 2 would fail a little later, with a fast receipt. Item 3 waits.
  const asked = [];
  const judge = async ({ state, questions, signal }) => {
    const n = state.items[0].item.n;
    asked.push(n);
    if (n === 0) return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, noul(0.9)])) };
    if (n === 1) throw new Error('first failure');
    return new Promise((_, reject) => {
      const timer = n === 2 ? setTimeout(() => reject(new Error('second failure')), 5) : undefined;
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error(`request for item ${n} aborted`)); }, { once: true });
    });
  };
  const receipts = [];
  await assert.rejects(
    runWorkflow(workflow, { items: [0, 1, 2, 3, 4, 5].map((n) => ({ n })) }, {
      runJudge: judge, maxQuestionsPerRequest: 1,
      recordDecision: async (receipt) => {
        if (receipt.request.index === 1) await new Promise((resolve) => setTimeout(resolve, 40));
        receipts.push(receipt);
      },
    }),
    /first failure/,
  );
  assert.deepEqual([...asked].sort(), [0, 1, 2, 3], 'no request is sent once one has failed');
  const byIndex = [...receipts].sort((a, b) => a.request.index - b.request.index);
  assert.deepEqual(byIndex.map((x) => [x.request.index, x.status]), [[0, 'answered'], [1, 'failed'], [2, 'cancelled'], [3, 'cancelled']]);
});

test('a state that is not plain JSON still reaches the judge, with or without a recorder', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'judge', label: 'flags', state: { blob: '{blob}' }, out: 'Flags', as: 'flags' },
    code('done', '() => ({ out: {} })'),
  ] });
  const blob = { big: 10n, seen: new Set(['a']), when: new Date(0) };
  blob.self = blob;
  const got = [];
  const ids = [];
  const deps = { runJudge: async ({ state }) => { got.push(state.blob); return { answers: { urgent: noul(0.9) } }; } };
  assert.equal((await runWorkflow(workflow, { blob }, deps)).status, 'complete');
  assert.equal((await runWorkflow(workflow, { blob }, { ...deps, recordDecision: async (receipt) => { ids.push(receipt.id); } })).status, 'complete');
  assert.equal(got[0].big, 10n);
  assert.equal(got[0].self, got[0], 'the cycle arrives as a cycle');
  // The same state has the same id, and a state that differs only in a value JSON cannot spell has another.
  const other = { ...blob, big: 11n };
  other.self = other;
  await runWorkflow(workflow, { blob }, { ...deps, recordDecision: async (receipt) => { ids.push(receipt.id); } });
  await runWorkflow(workflow, { blob: other }, { ...deps, recordDecision: async (receipt) => { ids.push(receipt.id); } });
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
});

test('a receipt that cannot be recorded fails the node before its answer is applied; a failed judge and a failed recorder surface both', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'judge', label: 'flags', state: { text: '{text}' }, out: 'Flags', as: 'flags' },
    code('after', '() => ({ out: {} })'),
  ] });
  const events = [];
  let stored;
  await assert.rejects(
    runWorkflow(workflow, { text: 'x' }, {
      runJudge: async () => ({ answers: { urgent: noul(0.9) } }),
      recordDecision: async (receipt) => { stored = receipt; throw new Error('disk full'); },
      onEvent: (e) => events.push(e),
    }),
    (error) => error instanceof WorkflowDecisionRecordError && error.decisionId === stored.id && error.label === 'flags' && /disk full/.test(error.message) && error.cause?.message === 'disk full',
  );
  assert.equal(events.filter((e) => e.type === 'judge.answered' || e.type === 'code.patch').length, 0, 'nothing acted on the answer');
  await assert.rejects(
    runWorkflow(workflow, { text: 'x' }, {
      runJudge: async () => { throw new Error('judge down'); },
      recordDecision: async () => { throw new Error('disk full'); },
    }),
    (error) => error instanceof AggregateError && error.errors[0].message === 'judge down' && error.errors[1] instanceof WorkflowDecisionRecordError,
  );
});

test('answers the interpreter refuses are a failed receipt that keeps what came back; a request cut by the run is cancelled', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'judge', label: 'flags', state: { text: '{text}' }, out: 'Flags', as: 'flags' },
    code('after', '() => ({ out: {} })'),
  ] });
  const r = recorder();
  // A probability outside [0, 1] is not an answer.
  await assert.rejects(runWorkflow(workflow, { text: 'x' }, { runJudge: async () => ({ answers: { urgent: noul(1.5) }, model: 'judge-test', cost_usd: 0.004 }), ...r.deps }));
  assert.equal(r.receipts.length, 1);
  assert.deepEqual([r.receipts[0].status, r.receipts[0].rule, r.receipts[0].action], ['failed', null, null]);
  assert.deepEqual(r.receipts[0].answers, { urgent: noul(1.5) });
  assert.equal(r.receipts[0].cost_usd, 0.004);
  assert.ok(r.receipts[0].error);
  assert.equal(rederiveDecision(r.receipts[0]), null);

  const c = recorder();
  const stop = new AbortController();
  await assert.rejects(runWorkflow(workflow, { text: 'x' }, {
    signal: stop.signal,
    runJudge: ({ signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('cut')), { once: true }); stop.abort(new Error('run stopped')); }),
    ...c.deps,
  }));
  assert.deepEqual(c.receipts.map((x) => x.status), ['cancelled']);
});

test('receipts inside a map and a child workflow carry the item, the prefixed label and their own path', async () => {
  const child = { v: 2, name: 'child', schemas: { Flags: schemas.Flags, In: { type: 'object' } }, input: { schemaId: 'In' }, output: { schemaId: 'Flags', path: 'flags' },
    root: { node: 'judge', label: 'inner', state: { text: '{text}' }, out: 'Flags', as: 'flags' } };
  const workflow = flow({ node: 'chain', steps: [
    { node: 'map', label: 'each', itemsPath: 'texts', as: 'results', body: { node: 'workflow', label: 'call-child', workflow: child, input: { text: '{item}' }, out: 'Flags', as: 'flags' } },
    code('done', '() => ({ out: {} })'),
  ] });
  const r = recorder();
  const seen = [];
  await runWorkflow(workflow, { texts: ['calm', 'urgent now'] }, {
    runJudge: async (params) => { seen.push({ label: params.label, item: params.item?.index, path: params.executionPath }); return { answers: { urgent: noul(params.state.text.includes('urgent') ? 0.9 : 0.1) } }; },
    ...r.deps,
  });
  const byItem = [...r.receipts].sort((a, b) => a.item - b.item);
  assert.deepEqual(byItem.map((x) => [x.node, x.item, x.action]), [['call-child/inner', 0, { urgent: false }], ['call-child/inner', 1, { urgent: true }]]);
  assert.notEqual(byItem[0].id, byItem[1].id);
  for (const receipt of byItem) {
    const call = seen.find((x) => x.item === receipt.item);
    assert.deepEqual([receipt.node, receipt.execution_path], [call.label, call.path], 'the receipt names what the judge was told');
    assert.ok(receipt.execution_path.startsWith(`/root/steps/0/items/${receipt.item}/body`));
    const exchange = r.exchanges[r.receipts.findIndex((x) => x.id === receipt.id)];
    assert.equal(exchange.request.label, 'call-child/inner');
  }
  const events = r.events.filter((e) => e.type === 'judge.answered');
  assert.deepEqual(events.map((e) => e.detail.decision_id).sort(), byItem.map((x) => x.id).sort());
});

test('each verify review is its own decision, recorded with its thresholds', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'agent', label: 'write', instructions: 'Write a short answer.', out: 'Draft', as: 'draft', verify: { out: 'Review', maxDrives: 3 } },
    code('done', '() => ({ out: {} })'),
  ] }, {
    Draft: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' }, source: { type: ['string', 'null'] } } },
    Review: { type: 'object', required: ['text', 'cited'], properties: {
      text: { type: 'boolean', description: 'Is the text supported by the evidence?' },
      cited: { type: 'boolean', description: 'Does the draft cite a source?' },
    } },
  });
  const r = recorder();
  // The first candidate's text is doubted (0.1 is below the floor of 0.3) and nothing is cited (0.2 is below 0.5).
  const run = await runWorkflow(workflow, {}, {
    runNode: async ({ review }) => {
      assert.equal((await review({ text: 'first', source: null })).accepted, false);
      const second = { text: 'second', source: 'a page' };
      assert.deepEqual(await review(second), { accepted: true });
      return second;
    },
    runJudge: async ({ state }) => ({ answers: state.submission.text === 'first' ? { text: noul(0.1), cited: noul(0.2) } : { text: noul(0.8), cited: noul(0.9) } }),
    ...r.deps,
  });
  assert.equal(run.status, 'complete');
  assert.deepEqual(r.receipts.map((x) => [x.kind, x.node, x.request]), [
    ['verify', 'write (verify)', { index: 0, count: 3 }],
    ['verify', 'write (verify)', { index: 1, count: 3 }],
  ]);
  assert.notEqual(r.receipts[0].id, r.receipts[1].id);
  // `text` is a field the submission holds, judged at the floor; `cited` is not a field, judged at 0.5.
  assert.deepEqual(r.receipts[0].rule, { kind: 'verify', thresholds: { text: 0.3, cited: 0.5 }, present: ['text'] });
  assert.deepEqual(r.receipts[0].action, { accepted: false, doubted: ['text'], unmet: ['cited'] });
  assert.deepEqual(r.receipts[1].action, { accepted: true, doubted: [], unmet: [] });
  for (const receipt of r.receipts) assert.deepEqual(rederiveDecision(receipt), receipt.action);
  const reviews = r.events.filter((e) => e.type === 'verify.answered');
  assert.deepEqual(reviews.map((e) => e.detail.decision_id), r.receipts.map((x) => x.id));
});

test('a receipt states every threshold its rule applied, so the decision can be evaluated again under another', async () => {
  const workflow = flow({ node: 'chain', steps: [
    // No keep rule: every item is kept. Then a keep on the answer's confidence, with no threshold of the author's.
    { node: 'sift', label: 'all', itemsPath: 'items', out: 'Keep', as: 'all' },
    { node: 'sift', label: 'sure', itemsPath: 'items', out: 'Tone', as: 'sure', keep: { path: 'tone.confidence' } },
    { node: 'sift', label: 'bar', itemsPath: 'items', out: 'Keep', as: 'bar', keep: { path: 'keep', gte: 0.5 } },
    { node: 'pick', label: 'one', itemsPath: 'items', describe: '{item}', instructions: 'Choose one.', as: 'one' },
    { node: 'pick', label: 'maybe', itemsPath: 'items', describe: '{item}', instructions: 'Choose one, or none.', allowNone: true, as: 'maybe' },
    { node: 'agent', label: 'write', instructions: 'Write.', out: 'Draft', as: 'draft', verify: { out: 'Review', override: { below: 0.25 } } },
    code('done', '() => ({ out: {} })'),
  ] }, {
    Tone: { type: 'object', required: ['tone'], properties: { tone: { type: 'string', enum: ['calm', 'tense'], description: 'What is the tone?' } } },
    Draft: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, note: { type: ['string', 'null'] } } },
    Review: { type: 'object', required: ['text', 'note'], properties: {
      text: { type: 'boolean', description: 'Is the text supported?' },
      note: { type: 'boolean', description: 'Is the note supported?' },
    } },
  });
  const r = recorder();
  await runWorkflow(workflow, { items: ['a', 'b'] }, {
    runNode: async ({ review }) => { const draft = { text: 'fine', note: null }; await review(draft); return draft; },
    runJudge: async ({ label, questions }) => ({ answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key,
      label === 'sure' ? choice(Object.keys(question.criteria), 'calm', key.startsWith('0.') ? 0.9 : 0.55)
        : label === 'bar' ? noul(key.startsWith('0.') ? 0.8 : 0.2)
        : label === 'one' ? choice(Object.keys(question.criteria), 'item_1')
        : label === 'maybe' ? choice(Object.keys(question.criteria), 'none_of_these')
        // The note is empty, so it is not judged, whatever its answer (0.4 here, above the floor of 0.25).
        : label === 'write (verify)' ? noul(key === 'text' ? 0.3 : 0.4)
        : noul(0.1)])) }),
    ...r.deps,
  });
  const by = Object.fromEntries(r.receipts.map((x) => [x.node, x]));
  assert.deepEqual([by.all.rule.keep, by.all.action], [null, { kept: [0, 1] }]);
  assert.deepEqual([by.sure.rule.keep, by.sure.action], [{ id: 'tone', measure: 'confidence', gte: 0 }, { kept: [0, 1] }]);
  assert.deepEqual(rederiveDecision({ ...by.sure, rule: { ...by.sure.rule, keep: { ...by.sure.rule.keep, gte: 0.6 } } }), { kept: [0] }, 'a bar of 0.6 on confidence drops the unsure item');
  assert.deepEqual(by.bar.action, { kept: [0] });
  assert.deepEqual(rederiveDecision({ ...by.bar, rule: { ...by.bar.rule, keep: { ...by.bar.rule.keep, gte: 0.1 } } }), { kept: [0, 1] }, 'a lower bar keeps both');
  assert.deepEqual([by.one.rule, by.one.action], [{ kind: 'pick', options: ['item_0', 'item_1'], none: null }, { index: 1, none: false }]);
  assert.deepEqual([by.maybe.rule.none, by.maybe.action], ['none_of_these', { index: null, none: true }]);
  const verify = by['write (verify)'];
  assert.deepEqual(verify.rule, { kind: 'verify', thresholds: { text: 0.25, note: null }, present: ['text', 'note'] }, 'the floor on a field it holds, nothing on a field it holds empty');
  assert.deepEqual(verify.action, { accepted: true, doubted: [], unmet: [] });
  // Evaluated again under a floor of 0.5, the text (0.3) is doubted and the empty note (0.4) still is not.
  assert.deepEqual(rederiveDecision({ ...verify, rule: { ...verify.rule, thresholds: Object.fromEntries(Object.entries(verify.rule.thresholds).map(([id, at]) => [id, at === null ? null : 0.5])) } }), { accepted: false, doubted: ['text'], unmet: [] });
  for (const receipt of r.receipts) assert.deepEqual(rederiveDecision(receipt), receipt.action);
});

/** A host's recovery over memory: a node's committed state by execution path, and decisions by id. */
function recovery() {
  const committed = new Map(), decisions = new Map();
  return {
    committed, decisions,
    deps: {
      recovery: {
        supportsExecutionPaths: true,
        resume: async (_node, _state, _item, path) => (committed.has(path) ? structuredClone(committed.get(path)) : undefined),
        commit: async (_node, state, _item, path) => { committed.set(path, structuredClone(state)); },
        pollStartedAt: () => Date.now(),
        wait: async () => {},
        decision: async (id) => decisions.get(id),
      },
      recordDecision: async (receipt) => { decisions.set(receipt.id, structuredClone(receipt)); },
    },
  };
}

test("a resumed loop takes its until-ask from the recorded decision: the judge's second opinion cannot end the loop early", async () => {
  // Each pass adds one. The loop ends when the judge says the count is enough.
  const workflow = flow({ node: 'chain', steps: [
    { node: 'loop', label: 'grow', maxIters: 4, body: { node: 'code', label: 'add', as: 'count', code: '(s) => ({ n: (s.count?.n ?? 0) + 1 })' }, until: { predicate: 'ask', instructions: 'Is the count enough?' } },
    code('finish', '(s) => ({ out: { n: s.count.n } })'),
  ] });
  const store = recovery();
  // First process: "not enough" after pass 0, then it dies while asking after pass 1.
  const first = [];
  await assert.rejects(runWorkflow(workflow, {}, {
    ...store.deps,
    runJudge: async ({ state }) => { first.push(state.count.n); if (state.count.n === 1) return { answers: { holds: noul(0.1) } }; throw new Error('process died'); },
  }), /process died/);
  assert.deepEqual(first, [1, 2]);
  assert.ok(store.committed.has('/root/steps/0/iterations/1/body'), 'pass 1 committed before the process died');

  // Second process: this judge would now say "enough" to anything. Pass 0's question was already decided, so
  // it is not asked; pass 1's is, and ends the loop on pass 1's state.
  const second = [], events = [];
  const run = await runWorkflow(workflow, {}, {
    ...store.deps,
    runJudge: async ({ state }) => { second.push(state.count.n); return { answers: { holds: noul(0.9) } }; },
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(second, [2], 'only the undecided question is asked');
  assert.deepEqual(run.output, { n: 2 });
  assert.deepEqual(events.find((e) => e.type === 'loop.exited').detail, { reason: 'condition_met', iterations: 2 });
  const asks = events.filter((e) => e.type === 'ask.evaluated');
  assert.deepEqual(asks.map((e) => [e.detail.holds, e.detail.replayed === true, e.detail.cost_usd]), [[false, true, 0], [true, false, null]]);
  // The failed request of the first process left a failed receipt, which answers nothing.
  assert.deepEqual([...store.decisions.values()].map((x) => x.status).sort(), ['answered', 'answered']);
});

test('a resumed route follows its recorded decision without asking again', async () => {
  const workflow = flow({ node: 'route', label: 'lane', state: { text: '{text}' }, instructions: 'Which lane?', branches: {
    a: { criteria: 'lane a', body: { node: 'chain', steps: [{ node: 'judge', label: 'in-a', state: { text: '{text}' }, out: 'Flags', as: 'flags' }, code('a-out', '() => ({ out: { lane: "a" } })')] } },
    b: { criteria: 'lane b', body: code('b-out', '() => ({ out: { lane: "b" } })') },
  } });
  const store = recovery();
  await assert.rejects(runWorkflow(workflow, { text: 't' }, {
    ...store.deps,
    runJudge: async ({ kind, questions }) => { if (kind === 'route') return { answers: { branch: choice(Object.keys(questions.branch.criteria), 'a') } }; throw new Error('process died'); },
  }), /process died/);
  const asked = [];
  const run = await runWorkflow(workflow, { text: 't' }, {
    ...store.deps,
    // Asked again, this judge would choose lane b.
    runJudge: async ({ kind, questions }) => { asked.push(kind); return kind === 'route' ? { answers: { branch: choice(Object.keys(questions.branch.criteria), 'b') } } : { answers: { urgent: noul(0.9) } }; },
  });
  assert.deepEqual(asked, ['judge']);
  assert.deepEqual(run.output, { lane: 'a' });
});

test('a recorded review answers only the candidate it reviewed', async () => {
  const workflow = flow({ node: 'chain', steps: [
    { node: 'agent', label: 'write', instructions: 'Write.', out: 'Draft', as: 'draft', verify: { out: 'Review' } },
    code('done', '() => ({ out: {} })'),
  ] }, {
    Draft: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    Review: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', description: 'Is the draft complete?' } } },
  });
  const store = recovery();
  const reviewed = [];
  const deps = (candidate) => ({
    ...store.deps,
    // Nothing commits, so the node runs again in the second run.
    recovery: { ...store.deps.recovery, commit: async () => {} },
    runNode: async ({ review }) => { await review(candidate); return candidate; },
    runJudge: async ({ state }) => { reviewed.push(state.submission.text); return { answers: { ok: noul(0.9) } }; },
  });
  await runWorkflow(workflow, {}, deps({ text: 'one' }));
  await runWorkflow(workflow, {}, deps({ text: 'two' }));
  await runWorkflow(workflow, {}, deps({ text: 'one' }));
  // The second run's first review is of another candidate: it is asked. The third run's is the first run's: it is not.
  assert.deepEqual(reviewed, ['one', 'two']);
});
