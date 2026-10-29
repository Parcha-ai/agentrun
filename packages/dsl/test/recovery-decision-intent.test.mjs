// A decision under the recovery driver is never paid for twice across a crash: its request is committed before the
// host's judge is asked, and a later open that finds it asked and never answered routes the run to review instead of
// asking again. Every open of one store stands for a later process of the same run; the crash is a store that refuses
// every write from the moment the judge answers, as a process that dies right after the provider's answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { memoryStore, openRecovery, recoveryBound, withRecovery } from '@parcha/agentrun-dsl/recovery';

const KEY = 'run-1';
const INPUT = { text: 'a filing' };
const SCHEMAS = {
  Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
  Check: { type: 'object', required: ['legit'], properties: { legit: { type: 'boolean', description: 'Is this filing a legitimate certificate of incorporation?' } } },
};
const workflow = { v: 2, name: 'decision-intent', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' },
  root: { node: 'chain', steps: [
    { node: 'judge', label: 'check', state: { text: '{text}' }, out: 'Check', as: 'verdict' },
    { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' },
  ] } };
const answer = { answers: { legit: { type: 'noul', noul: 0.91 } }, model: 'judge-1', usage: { input_tokens: 40, output_tokens: 0 }, cost_usd: 0.003, request_sha256: 'provider-request-1' };
const LAYOUTS = ['v3', 'v4'];

/** A store over `inner` that refuses every write while `dead()` holds: what a process that died leaves unwritten. */
const dying = (inner, dead) => ({ open: async (bound) => {
  const journal = await inner.open(bound);
  const held = Object.create(journal);
  for (const write of ['save', 'note', 'admit', 'complete', 'called']) held[write] = async (...args) => { if (dead()) throw new Error('the process died'); return journal[write](...args); };
  return held;
} });

/** A host's decision receipts, kept across processes: `recordDecision` and the `recovery.decision` it answers from. */
function receiptStore() {
  const receipts = [];
  return {
    receipts,
    recordDecision: async (receipt) => { receipts.push(structuredClone(receipt)); },
    decision: async (id) => receipts.findLast((receipt) => receipt.id === id && receipt.status === 'answered'),
  };
}

/** One process of the run under the driver, with the host's receipts. */
async function run(store, deps, kept, layout) {
  const driver = await openRecovery(store, workflow, { key: KEY, layout });
  const wrapped = withRecovery(driver, { ...deps, recordDecision: kept.recordDecision });
  wrapped.recovery = { ...wrapped.recovery, decision: kept.decision };
  try { return await runWorkflow(workflow, INPUT, wrapped); } finally { await driver.close(); }
}

/** The decision requests the run's last commit holds. */
async function decisionsOf(inner, layout, document = workflow) {
  const driver = await openRecovery(inner, document, { key: KEY, layout });
  try { return Object.values(driver.decisionRequests?.() ?? {}); } finally { await driver.close(); }
}

for (const layout of LAYOUTS) {
  test(`a decision asked and never answered is not asked again: the next process books it once at an unknown cost and routes the run to review (${layout})`, async () => {
    const inner = memoryStore(); let dead = false; let asked = 0;
    const store = dying(inner, () => dead);
    const kept = receiptStore();
    // The provider answers, and the process dies before anything after the answer is committed.
    const first = { runJudge: async () => { asked += 1; dead = true; return structuredClone(answer); } };
    await assert.rejects(run(store, first, kept, layout), /the process died/);
    dead = false;
    const before = kept.receipts.length;
    const second = { runJudge: async () => { asked += 1; return structuredClone(answer); } };
    const result = await run(store, second, kept, layout);
    assert.equal(asked, 1, 'runJudge is called exactly once across the two processes');
    assert.equal(result.status, 'escalated', 'the run routes to review');
    assert.deepEqual([result.escalation.kind, result.escalation.stage, result.escalation.label], ['decision_interrupted', 'decision', 'check'], 'the escalation says the decision was interrupted');
    const [request, ...more] = await decisionsOf(inner, layout);
    assert.equal(more.length, 0, 'one decision request');
    assert.deepEqual({ record: request?.record, kind: request?.kind, label: request?.label, attempt: request?.attempt, status: request?.status, cost_usd: request?.cost_usd },
      { record: 'decision.request', kind: 'judge', label: 'check', attempt: 1, status: 'interrupted', cost_usd: null }, 'the interrupted request is booked at an unknown cost, never 0');
    // A store that refuses writes leaves its process alive long enough to record the cut call; a dead one records nothing.
    const receipts = kept.receipts.filter((receipt) => receipt.id === request?.decision_id);
    assert.ok(receipts.length > 0 && receipts.every((receipt) => receipt.cost_usd === null), 'every receipt of the decision is at an unknown cost');
    assert.deepEqual(kept.receipts.slice(before).map((receipt) => [receipt.id, receipt.status, receipt.cost_usd]), [[request?.decision_id, 'failed', null]], 'the next process books it once, at an unknown cost');
  });

  test(`a decision answered before a crash replays from its receipt at no cost and is not asked again (${layout})`, async () => {
    const inner = memoryStore(); let dead = false; let asked = 0;
    const store = dying(inner, () => dead);
    const kept = receiptStore();
    // The answer and its receipt land; the process dies at the next commit, before the node's own.
    const first = { runJudge: async () => { asked += 1; return structuredClone(answer); } };
    const recordThenDie = { ...kept, recordDecision: async (receipt) => { await kept.recordDecision(receipt); if (receipt.status === 'answered') dead = true; } };
    await assert.rejects(run(store, first, recordThenDie, layout), /the process died/);
    dead = false;
    const result = await run(store, { runJudge: async () => { asked += 1; return structuredClone(answer); } }, kept, layout);
    assert.equal(asked, 1, 'runJudge is called exactly once across the two processes');
    assert.equal(result.status, 'complete');
    assert.equal(result.state.verdict.legit, true);
    const [request] = await decisionsOf(inner, layout);
    assert.deepEqual([request?.status, request?.cost_usd, request?.attempt], ['answered', 0.003, 1], 'the answered request keeps its cost');
  });

  test(`a request that failed in its own process is asked again by the next as its next attempt (${layout})`, async () => {
    const store = memoryStore(); let asked = 0;
    const kept = receiptStore();
    await assert.rejects(run(store, { runJudge: async () => { asked += 1; throw new Error('the provider refused'); } }, kept, layout), /the provider refused/);
    const result = await run(store, { runJudge: async () => { asked += 1; return structuredClone(answer); } }, kept, layout);
    assert.deepEqual([asked, result.status], [2, 'complete'], 'a request that ended in its process is asked again');
    const [request] = await decisionsOf(store, layout);
    assert.deepEqual([request?.status, request?.attempt, request?.cost_usd], ['answered', 2, 0.003], 'the second ask is the request\'s second attempt');
  });

  test(`a call the host cuts in flight has no outcome: the next process does not ask again, books it interrupted at an unknown cost and routes the run to review (${layout})`, async () => {
    const store = memoryStore(); let asked = 0;
    const kept = receiptStore();
    // A cancel the journal holds ends the run for good; the host's own signal (its shutdown) cuts the call and leaves
    // the run to resume. The judge's call ends on its signal, as an HTTP client's does.
    const host = new AbortController();
    let called; const inFlight = new Promise((resolve) => { called = resolve; });
    const held = { signal: host.signal, runJudge: (params) => { asked += 1; called(); return new Promise((_, reject) => params.signal.addEventListener('abort', () => reject(params.signal.reason), { once: true })); } };
    const cut = run(store, held, kept, layout);
    await inFlight;
    host.abort(new Error('the host cut the call'));
    await assert.rejects(cut, /the host cut the call/);
    const result = await run(store, { runJudge: async () => { asked += 1; return structuredClone(answer); } }, kept, layout);
    assert.equal(asked, 1, 'a call cut in flight is not asked again');
    assert.equal(result.status, 'escalated', 'the run routes to review');
    assert.equal(result.escalation.kind, 'decision_interrupted');
    const [request] = await decisionsOf(store, layout);
    assert.deepEqual([request?.status, request?.cost_usd, request?.attempt], ['interrupted', null, 1], 'the cut call is booked interrupted at an unknown cost');
  });

  test(`a pause waits for a decision in flight and is taken once it settles (${layout})`, async () => {
    const inner = memoryStore();
    const driver = await openRecovery(inner, workflow, { key: KEY, layout });
    let called, release;
    const inFlight = new Promise((resolve) => { called = resolve; });
    const answered = new Promise((resolve) => { release = resolve; });
    const wrapped = withRecovery(driver, { runJudge: async () => { called(); await answered; return structuredClone(answer); } });
    const running = runWorkflow(workflow, INPUT, wrapped).then((result) => result.status, (error) => error.code ?? String(error));
    await inFlight;
    driver.stop({ action: 'pause', source: 'operator' });
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(driver.signal.aborted, false, 'the pause waits while the decision is in flight');
    release();
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('no pause by the deadline'), 2000); });
    const ended = await Promise.race([running, deadline]);
    clearTimeout(timer);
    assert.equal(ended, 'FROZEN_PAUSED', 'the pause completes once the decision in flight settles');
    await driver.close();
    const [request] = await decisionsOf(inner, layout);
    assert.deepEqual([request?.status, request?.cost_usd], ['answered', 0.003], 'the decision in flight ended answered before the pause was taken');
  });

  test(`a loop's judged until is asked once per iteration under the driver, and each ask is booked (${layout})`, async () => {
    const looped = { v: 2, name: 'decision-loop', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' },
      root: { node: 'chain', steps: [
        { node: 'loop', label: 'retry', maxIters: 3, until: { predicate: 'ask', instructions: 'Is the filing complete?', gte: 0.6 }, body: { node: 'code', label: 'tick', code: '(s) => ({ n: (s.n ?? 0) + 1 })' } },
        { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' },
      ] } };
    const store = memoryStore(); let asked = 0;
    const driver = await openRecovery(store, looped, { key: KEY, layout });
    const deps = withRecovery(driver, { runJudge: async () => { asked += 1; return { answers: { holds: { type: 'noul', noul: asked >= 2 ? 0.9 : 0.1 } }, cost_usd: 0.001 }; } });
    let result;
    try { result = await runWorkflow(looped, INPUT, deps).catch((error) => ({ status: 'threw', message: String(error?.message) })); } finally { await driver.close(); }
    assert.equal(result.status, 'complete', `the loop's until question is admitted: ${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(asked, 2, 'asked once per iteration until it holds');
    const requests = await decisionsOf(store, layout, looped);
    assert.deepEqual(requests.map((request) => [request.kind, request.status, request.cost_usd]), [['ask', 'answered', 0.001], ['ask', 'answered', 0.001]]);
  });

  test(`an answered decision's outcome and its spend are one commit: no checkpoint holds the one without the other (${layout})`, async () => {
    const saved = [];
    const inner = memoryStore();
    const watching = { open: async (bound) => {
      const journal = await inner.open(bound);
      const held = Object.create(journal);
      held.save = async (state, ...rest) => { if (typeof state !== 'function') saved.push(structuredClone(state)); return journal.save(state, ...rest); };
      return held;
    } };
    const driver = await openRecovery(watching, workflow, { key: KEY, layout });
    const deps = withRecovery(driver, { runJudge: async () => structuredClone(answer) });
    try { assert.equal((await runWorkflow(workflow, INPUT, deps)).status, 'complete'); } finally { await driver.close(); }
    const answered = saved.filter((state) => Object.values(state?.pin?.decisions ?? {}).some((requests) => Object.values(requests).some((request) => request.status === 'answered')));
    assert.ok(answered.length > 0, 'a checkpoint holds the answered request');
    assert.deepEqual(answered.map((state) => state.questionSpendUsd), answered.map(() => 0.003), 'every checkpoint that holds the answered request holds its spend');
  });

  test(`killed right after the answered outcome commits, the reopened run's spend holds the answer's cost, never less (${layout})`, async () => {
    const inner = memoryStore(); let dead = false;
    const answeredIn = (state) => Object.values(state?.pin?.decisions ?? {}).some((requests) => Object.values(requests).some((request) => request.status === 'answered'));
    // The process dies the moment the commit that holds the answered request has landed.
    const store = { open: async (bound) => {
      const journal = await inner.open(bound);
      const held = Object.create(journal);
      held.save = async (state, ...rest) => { if (dead) throw new Error('the process died'); const landed = await journal.save(state, ...rest); if (typeof state !== 'function' && answeredIn(state)) dead = true; return landed; };
      for (const write of ['note', 'admit', 'complete', 'called']) held[write] = async (...args) => { if (dead) throw new Error('the process died'); return journal[write](...args); };
      return held;
    } };
    const driver = await openRecovery(store, workflow, { key: KEY, layout });
    try { await assert.rejects(runWorkflow(workflow, INPUT, withRecovery(driver, { runJudge: async () => structuredClone(answer) })), /the process died/); } finally { await driver.close().catch(() => undefined); }
    const journal = await inner.open(recoveryBound(workflow));
    try { assert.equal(journal.state.questionSpendUsd, 0.003, 'the run\'s recorded spend holds the answer it was paid for'); } finally { await journal.close(); }
  });

  test(`a decision at a path no node holds, other than a loop's until, is refused at admission (${layout})`, async () => {
    const driver = await openRecovery(memoryStore(), workflow, { key: KEY, layout });
    const request = (id) => ({ decision_id: id, kind: 'judge', label: 'check', model: null, request_sha256: 'r' });
    try {
      for (const path of ['/root/steps/0/bogus', '/root/steps/0/iterations/0', '/root/steps/9']) {
        assert.throws(() => driver.admitDecision(path, request(path)), (error) => error.code === 'FROZEN_PATH_INVALID', `${path} is refused`);
      }
      assert.equal(driver.admitDecision('/root/steps/0', request('real')), undefined, 'a node\'s own path is admitted');
    } finally { await driver.close(); }
  });
}
