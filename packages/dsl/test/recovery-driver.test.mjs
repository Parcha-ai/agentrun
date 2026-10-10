// The recovery driver on a memory store with scripted adapters: what a run commits, what a later open is answered
// from, and what it refuses. Every later open of one store stands for a later process of the same run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import {
  openRecovery, withRecovery, memoryStore, openJournal, workspaceFiles, recoveryBinding, recoveryBound, RecoveryError, nodeAt,
  frozenEffectId, frozenStepSessionId, frozenStepId, FROZEN_SNAPSHOT_SCHEMA,
} from '@parcha/agentrun-dsl/recovery';

const scratch = mkdtempSync(join(tmpdir(), 'agentrun-recovery-driver-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const KEY = 'run-1';
const INPUT = { question: 'q' };
const SCHEMAS = { Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, Any: { type: 'object' } };
const code = (label, body) => ({ node: 'code', label, code: body });
const finish = code('finish', '() => ({ final: { ok: true } })');
const doc = (steps, extra = {}) => ({ v: 2, name: 'driver', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [...steps, finish] }, ...extra });
const tool = (label, args = {}, extra = {}) => ({ node: 'call', label, via: 'tool', tool: 'paid', args, out: 'Any', as: label, deadline_s: 5, ...extra });
const shell = (label, produces) => ({ node: 'call', label, via: 'shell', command: 'render', produces, deadline_s: 5, as: label });
const step = (...indexes) => `/root${indexes.map((index) => `/steps/${index}`).join('')}`;
const effect = (path, ordinal = 0) => frozenEffectId('step', path, ordinal);
const fault = (code, message) => (error) => {
  assert.equal(error.code, code, error.message);
  if (message instanceof RegExp) assert.match(error.message, message); else if (message !== undefined) assert.equal(error.message, message);
  return true;
};

const open = (store, workflow, options = {}) => openRecovery(store, workflow, { key: KEY, ...options });
/** One process of the run: open, run the workflow under the driver, let go. `cut` names a node whose commit never
 *  lands, as in a process that dies after the node ran and before its commit. */
async function run(store, workflow, deps = {}, { cut, input = INPUT, ...options } = {}) {
  const driver = await open(store, workflow, options);
  const wrapped = withRecovery(driver, deps);
  if (cut) wrapped.recovery = { ...wrapped.recovery, commit: (node, ...rest) => node.label === cut ? Promise.reject(new Error(`cut at ${cut}`)) : driver.recovery.commit(node, ...rest) };
  try { return await runWorkflow(workflow, input, wrapped); } finally { await driver.close(); }
}
/** The journal in an operator's hands: opened under the run's binding, outside any driver. Resolves to what it held. */
async function operator(store, workflow, act = () => {}, bind) {
  const journal = await store.open(recoveryBound(workflow, bind));
  try { await act(journal); return { state: journal.state, effects: journal.effects(), notes: journal.notes(), revision: journal.revision }; }
  finally { await journal.close(); }
}
/** A store whose journal reports each write before it makes it; a report that throws is the write's failure. */
const watched = (store, report) => ({ open: async (bound) => {
  const journal = await store.open(bound);
  const watching = Object.create(journal);
  for (const write of ['save', 'note', 'admit', 'complete', 'called']) watching[write] = async (...args) => { await report(write, ...args); return journal[write](...args); };
  return watching;
} });
/** A store with no owner lock, as one whose dead owner's lock the system released: a later open takes the journal
 *  while an earlier one still holds its handle. */
const unlocked = () => {
  let record;
  const backend = { acquire: async () => async () => {}, read: async () => record && structuredClone(record), write: async (next) => { record = structuredClone(next); } };
  return { open: (bound) => openJournal(backend, bound) };
};
/** What the interpreter hands an effect adapter for the call at `path`. */
const params = (workflow, path, extra = {}) => ({ node: nodeAt(workflow, path), input: {}, produces: [], attempt: 1, idempotencyKey: 'key', signal: new AbortController().signal, executionPath: path, ...extra });

test('an effect is admitted before it is dispatched and dispatched once; a later open is answered from the journal', async () => {
  const order = []; let paid = 0;
  const store = watched(memoryStore(), (write, id) => { if (write !== 'save') order.push(`${write} ${id}`); });
  const workflow = doc([code('seed', '() => ({ n: 2 })'), tool('lookup', { n: '{n}' })]);
  const deps = { runEffect: async ({ input }) => { order.push('dispatch'); paid += 1; return { value: input.n * 21 }; } };
  const first = await run(store, workflow, deps);
  assert.deepEqual([first.status, first.state.lookup, first.output, paid], ['complete', { value: 42 }, { ok: true }, 1]);
  assert.deepEqual(order, [`admit ${effect(step(1))}`, 'dispatch', `complete ${effect(step(1))}`]);
  const journal = await operator(store, workflow);
  assert.deepEqual(journal.effects, [{ id: effect(step(1)), name: 'lookup', argsHash: journal.effects[0].argsHash, status: 'completed', session: KEY, result: { value: { value: 42 }, files: {}, intent: { tool: 'paid', args: { n: 2 } } } }]);
  assert.deepEqual([journal.state.schema, journal.state.status, journal.state.pin.done], [FROZEN_SNAPSHOT_SCHEMA, 'running', [step(0), step(1), step(2)]]);
  const again = await run(store, workflow, deps);
  assert.deepEqual([again.status, again.output, paid, order.length], ['complete', { ok: true }, 1, 3]);
  // The effect completed and its node never committed: the next process is answered from the receipt.
  const cut = memoryStore(); await assert.rejects(run(cut, workflow, deps, { cut: 'lookup' }), /cut at lookup/);
  const held = await operator(cut, workflow);
  assert.deepEqual([held.effects[0].status, held.state.pin.done, paid], ['completed', [step(0)], 2]);
  const resumed = await run(cut, workflow, deps);
  assert.deepEqual([resumed.status, resumed.state.lookup, paid], ['complete', { value: 42 }, 2]);
});

test('an effect that threw is unknown: no later open dispatches it again, and an operator who completes it answers it', async () => {
  const kept = []; let calls = 0;
  const store = watched(memoryStore(), (write, id, held) => { if (write === 'called') kept.push([id, held]); });
  const workflow = doc([tool('lookup')]);
  const failing = { runEffect: async ({ call }) => { calls += 1; call({ tool: 'paid', attempt: calls }); throw new Error('connection reset'); } };
  await assert.rejects(run(store, workflow, failing), /connection reset/);
  assert.deepEqual(kept, [[effect(step(0)), [{ tool: 'paid', attempt: 1 }]]]);
  assert.deepEqual((await operator(store, workflow)).effects.map((e) => [e.id, e.status, e.result]), [[effect(step(0)), 'unknown', null]]);
  for (let later = 0; later < 2; later += 1) await assert.rejects(run(store, workflow, failing), fault('FROZEN_EFFECT_UNKNOWN', `Reconcile ${effect(step(0))} before resuming; it will not be repeated`));
  assert.equal(calls, 1);
  await operator(store, workflow, (journal) => journal.complete(effect(step(0)), { value: { found: true }, files: {} }));
  const resumed = await run(store, workflow, failing);
  assert.deepEqual([resumed.status, resumed.state.lookup, calls], ['complete', { found: true }, 1]);
});

test('a process that dies inside an effect leaves it unknown, and one that lost the run commits nothing more', async () => {
  const store = unlocked(); const workflow = doc([tool('lookup')]); let calls = 0, answer;
  const first = await open(store, workflow);
  const dying = runWorkflow(workflow, INPUT, withRecovery(first, { runEffect: () => { calls += 1; return new Promise((resolve) => { answer = resolve; }); } }));
  while (!answer) await new Promise((resolve) => setImmediate(resolve));
  // The next process finds the admission and no receipt: it refuses, and sends nothing.
  await assert.rejects(run(store, workflow, { runEffect: async () => { calls += 1; return {}; } }), fault('FROZEN_EFFECT_UNKNOWN', `Reconcile ${effect(step(0))} before resuming; it will not be repeated`));
  // The first process was only slow: its answer arrives after it lost the run, and its commit is refused.
  answer({ late: true });
  await assert.rejects(dying, fault('RECEIPTS_FAILURE', 'Run owner generation is not acquired'));
  assert.deepEqual([first.signal.aborted, calls, (await operator(store, workflow)).effects.map((e) => [e.status, e.result])], [true, 1, [['unknown', null]]]);
  await first.close();
});

test('an effect resumes with the arguments it was admitted with, and a run with the input it started from', async () => {
  const workflow = doc([tool('lookup')]);
  const store = memoryStore(); let driver = await open(store, workflow);
  await assert.rejects(driver.wrapEffect(async () => { throw new Error('lost'); })(params(workflow, step(0), { input: { q: 1 } })), /lost/);
  await driver.close();
  let dispatched = 0;
  for (const changed of [{ input: { q: 2 } }, { input: { q: 1 }, idempotencyKey: 'other' }, { input: { q: 1 }, node: { ...nodeAt(workflow, step(0)), tool: 'other' } }]) {
    driver = await open(store, workflow);
    await assert.rejects(driver.wrapEffect(async () => { dispatched += 1; })(params(workflow, step(0), changed)), fault('FROZEN_INPUT_CHANGED', 'Recovered effect arguments changed'));
    await driver.close();
  }
  assert.deepEqual([dispatched, (await operator(store, workflow)).effects.map((e) => [e.id, e.status])], [0, [[effect(step(0)), 'unknown']]]);
  // An ask is counted even when it is refused: the next ask at the same path in the same open is the path's next effect.
  driver = await open(store, workflow);
  await assert.rejects(driver.wrapEffect(async () => { dispatched += 1; })(params(workflow, step(0), { input: { q: 1 } })), fault('FROZEN_EFFECT_UNKNOWN'));
  assert.deepEqual(await driver.wrapEffect(async () => { dispatched += 1; return { second: true }; })(params(workflow, step(0), { input: { q: 1 } })), { second: true });
  await driver.close();
  assert.deepEqual([dispatched, (await operator(store, workflow)).effects.map((e) => [e.id, e.status])], [1, [[effect(step(0)), 'unknown'], [effect(step(0), 1), 'completed']]]);
  const started = memoryStore(); const deps = { runEffect: async () => { dispatched += 1; return {}; } };
  await run(started, workflow, deps);
  await assert.rejects(run(started, workflow, deps, { input: { question: 'another' } }), fault('FROZEN_INPUT_CHANGED', `Materialized workflow input changed: ${step(0)}`));
  assert.equal(dispatched, 2);
});

for (const [place, observed] of Object.entries({
  outcome: { outcome: 'unknown', request: 'request-17' }, effect_status: { effect_status: 'unknown' },
  'details.outcome': { details: { outcome: 'unknown', request: 'request-17' }, message: 'Submitted' }, 'details.effect_status': { details: { effect_status: 'unknown' } },
})) {
  test(`a result whose ${place} is unknown is kept as observed and refused until the host reconciles it`, async () => {
    const store = memoryStore(); const workflow = doc([tool('submit-order')]); let calls = 0;
    const deps = { runEffect: async () => { calls += 1; return observed; } };
    await assert.rejects(run(store, workflow, deps), fault('FROZEN_EFFECT_UNKNOWN', `Reconcile ${effect(step(0))}: tool returned an unknown outcome`));
    const journal = await operator(store, workflow);
    assert.deepEqual([journal.state.unknownResponses[effect(step(0))], journal.effects[0].status, journal.effects[0].result, journal.state.pin.done], [observed, 'unknown', null, []]);
    await assert.rejects(run(store, workflow, deps), fault('FROZEN_EFFECT_UNKNOWN', `Reconcile ${effect(step(0))} before resuming; it will not be repeated`));
    await operator(store, workflow, (held) => held.complete(effect(step(0)), { value: { confirmed: true }, files: {} }));
    const resumed = await run(store, workflow, deps);
    assert.deepEqual([resumed.state['submit-order'], calls], [{ confirmed: true }, 1]);
    assert.deepEqual((await operator(store, workflow)).state.unknownResponses[effect(step(0))], observed);
  });
}

test("an effect's own deadline is its only clock: it cuts the adapter and leaves the effect unknown, and no time before it counts", async () => {
  const workflow = doc([tool('slow', {}, { deadline_s: 0.05 })]);
  let calls = 0, cut = 0;
  const hanging = { runEffect: ({ signal }) => { calls += 1; return new Promise((_, reject) => signal.addEventListener('abort', () => { cut += 1; reject(signal.reason); }, { once: true })); } };
  const store = memoryStore(); await assert.rejects(run(store, workflow, hanging));
  assert.deepEqual([calls, cut, (await operator(store, workflow)).effects.map((e) => e.status)], [1, 1, ['unknown']]);
  // A clock that ran out before the dispatch refuses the effect unsent.
  const expired = memoryStore(); await (await open(expired, workflow)).close();
  await operator(expired, workflow, (journal) => journal.save({ ...journal.state, clocks: { [`attempt:${effect(step(0))}`]: Date.now() - 1 } }));
  await assert.rejects(run(expired, workflow, hanging), fault('FROZEN_EFFECT_DEADLINE', 'Effect exceeded its own deadline'));
  assert.deepEqual([calls, (await operator(expired, workflow)).effects], [1, []]);
  // A run that started long ago still dispatches: the run has no clock of its own.
  const old = memoryStore(); await (await open(old, workflow)).close();
  await operator(old, workflow, (journal) => journal.save({ ...journal.state, startedAt: 1 }));
  const late = await run(old, workflow, { runEffect: async () => ({ fast: true }) });
  assert.deepEqual([late.status, late.state.slow], ['complete', { fast: true }]);
});

test('each call is its own effect by execution path: the same arguments at two paths, and each item of a map', async () => {
  const workflow = doc([tool('first', { q: 'same' }), tool('second', { q: 'same' }), code('seed', "() => ({ items: ['a', 'b'] })"),
    { node: 'map', label: 'each', itemsPath: 'items', as: 'hits', maxConcurrency: 1, body: tool('per-item', { q: 'same' }) }]);
  const store = memoryStore(); let calls = 0;
  const deps = { runEffect: async () => ({ n: calls += 1 }) };
  assert.equal((await run(store, workflow, deps)).status, 'complete');
  const paths = [step(0), step(1), `${step(3)}/items/0/body`, `${step(3)}/items/1/body`];
  assert.deepEqual((await operator(store, workflow)).effects.map((e) => [e.id, e.status, e.session, e.result.value]), paths.map((path, index) => [effect(path), 'completed', KEY, { n: index + 1 }]));
  assert.deepEqual(paths.map((path) => effect(path)), paths.map((path) => `step:${path}#call:0`));
  assert.equal((await run(store, workflow, deps)).status, 'complete');
  assert.equal(calls, 4);
});

test('declared files are hashed when they commit and verified at every later open', async () => {
  const cwd = mkdtempSync(join(scratch, 'files-')); const files = workspaceFiles(cwd); const file = join(cwd, 'out.txt');
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const workflow = { v: 2, name: 'files', schemas: { Artifact: { type: 'object' } }, output: { schemaId: 'Artifact', path: 'artifact' },
    root: { node: 'chain', steps: [shell('render', ['out.txt']), { node: 'artifact', label: 'deliver', type: 'text', path: 'out.txt' }] } };
  let calls = 0;
  const deps = { runEffect: async () => { calls += 1; writeFileSync(file, 'first bytes'); return { code: 0, stdout: '', stderr: '' }; } };
  const store = memoryStore(); const first = await run(store, workflow, deps, { files });
  assert.deepEqual([first.status, first.output], ['complete', { path: 'out.txt', filename: 'out.txt', type: 'text' }]);
  const journal = await operator(store, workflow);
  assert.deepEqual([journal.state.files, journal.effects[0].result.files, journal.state.pin.done], [{ 'out.txt': sha('first bytes') }, { 'out.txt': sha('first bytes') }, [step(0), step(1)]]);
  writeFileSync(file, 'other bytes');
  await assert.rejects(run(store, workflow, deps, { files }), fault('FROZEN_ARTIFACT_INVALID', 'Committed artifact bytes changed; effect will not be repeated'));
  rmSync(file);
  await assert.rejects(run(store, workflow, deps, { files }), fault('FROZEN_ARTIFACT_INVALID', 'Recovery artifact is missing from the workspace: out.txt'));
  assert.equal(calls, 1);
  // A receipt answers its effect only while the files it names hold the bytes it hashed.
  const cut = memoryStore(); await assert.rejects(run(cut, workflow, deps, { files, cut: 'render' }), /cut at render/);
  writeFileSync(file, 'other bytes');
  await assert.rejects(run(cut, workflow, deps, { files }), fault('FROZEN_ARTIFACT_INVALID', 'Committed artifact bytes changed; effect will not be repeated'));
  writeFileSync(file, 'first bytes');
  assert.deepEqual([(await run(cut, workflow, deps, { files })).status, calls], ['complete', 2]);
  writeFileSync(join(scratch, 'outside.txt'), 'outside');
  assert.throws(() => files.hashes(['../outside.txt']), fault('FROZEN_ARTIFACT_INVALID', 'Recovery artifact escaped workspace'));
  assert.deepEqual([files.same('./out.txt', 'out.txt'), files.same('out.txt', 'other.txt')], [true, false]);
});

test('a workflow that declares a file the host owns, or one label on two nodes, opens with the refusal the host escalates', async () => {
  const reservedOutputs = ['report.md', 'structured_output.json']; const files = workspaceFiles(scratch);
  const refusalOf = async (workflow, options) => { const driver = await open(memoryStore(), workflow, options); await driver.close(); return driver.preStepRefusal; };
  for (const written of ['report.md', './report.md', 'structured_output.json']) {
    assert.deepEqual(await refusalOf(doc([shell('render', [written])]), { reservedOutputs, files }), { code: 'RUN_CONTROL_UNSUPPORTED', kind: 'host_owned_output', label: 'workflow',
      message: `Recovered artifacts must not overwrite report.md or structured_output.json; the host owns those files, and the pin writes ${written}` });
  }
  assert.equal((await refusalOf(doc([shell('render', ['report.md'])]), { reservedOutputs: ['report.md'], files })).message, 'Recovered artifacts must not overwrite report.md; the host owns those files, and the pin writes report.md');
  assert.equal(await refusalOf(doc([shell('render', ['report.md'])]), { files }), null);
  assert.equal(await refusalOf(doc([shell('render', ['notes.md'])]), { reservedOutputs, files }), null);
  // A name that only the run's state completes is refused when the effect is asked for, before any admission.
  const templated = doc([shell('render', ['{name}'])]);
  const store = memoryStore(); const driver = await open(store, templated, { reservedOutputs, files });
  let dispatched = 0;
  assert.equal(driver.preStepRefusal, null);
  await assert.rejects(driver.wrapEffect(async () => { dispatched += 1; })(params(templated, step(0), { produces: ['report.md'] })), fault('RUN_CONTROL_UNSUPPORTED', 'Effect declares a host-owned output path'));
  await driver.close();
  assert.deepEqual([dispatched, (await operator(store, templated)).effects], [0, []]);
  const duplicate = (label) => ({ code: 'RUN_CONTROL_UNSUPPORTED', kind: 'duplicate_label', label, message: `Frozen workflow recovery requires unique labels; "${label}" names two nodes` });
  const child = (steps) => ({ node: 'workflow', label: 'child', workflow: doc(steps, { name: 'child', input: { schemaId: 'Any' } }), input: {}, out: 'Out', as: 'childOut' });
  const seed = code('seed', '() => ({ n: 1 })');
  assert.deepEqual(await refusalOf(doc([seed, seed])), duplicate('seed'));
  assert.deepEqual(await refusalOf(doc([seed, shell('seed', ['report.md'])]), { reservedOutputs, files }), duplicate('seed'));
  assert.equal(await refusalOf(doc([seed, child([seed])])), null);
  assert.deepEqual(await refusalOf(doc([seed, child([seed, seed])])), duplicate('child/seed'));
  assert.deepEqual(await refusalOf(doc([code('child/seed', '() => ({})'), child([seed])])), duplicate('child/seed'));
});

const routed = doc([code('seed', "() => ({ text: 'hello' })"), { node: 'route', label: 'triage', state: { text: '{text}' }, instructions: 'Which desk takes this?', unsure: { branch: 'calm', gte: 0.8 }, as: 'desk',
  branches: { calm: { criteria: 'a routine request', body: code('calm-step', "() => ({ went: 'calm' })") }, angry: { criteria: 'an escalating complaint', body: code('angry-step', "() => ({ went: 'angry' })") } } }]);
const choice = (chosen, confidence, cost_usd = 0.002) => ({ cost_usd, request_sha256: 'request-1',
  answers: { branch: { type: 'choice', choice: chosen, confidence, probabilities: { calm: chosen === 'calm' ? confidence : 1 - confidence, angry: chosen === 'angry' ? confidence : 1 - confidence } } } });

test("a route's answer is committed as its decision before its branch runs, and a later open follows it without asking", async () => {
  const store = memoryStore(); let asked = 0;
  const judge = (answer) => ({ runJudge: async () => { asked += 1; return answer; } });
  await assert.rejects(run(store, routed, judge(choice('angry', 0.95)), { cut: 'angry-step' }), /cut at angry-step/);
  const driver = await open(store, routed);
  assert.deepEqual(driver.routeDecision(step(1)), { label: 'triage', branch: 'angry', choice: 'angry', unsure: false, request_sha256: 'request-1', result: choice('angry', 0.95), receipts: null });
  await driver.close();
  const resumed = await run(store, routed, judge(choice('calm', 0.99)));
  assert.deepEqual([resumed.status, resumed.state.went, resumed.state.desk, asked], ['complete', 'angry', { branch: 'angry', taken: 'angry', unsure: false }, 1]);
  const journal = await operator(store, routed);
  assert.deepEqual([journal.state.questionSpendUsd, journal.state.pin.routes], [0.002, {}]);
  // An answer below the route's confidence floor decides for the unsure branch and keeps the choice it made.
  const unsure = memoryStore();
  await assert.rejects(run(unsure, routed, judge(choice('angry', 0.5)), { cut: 'calm-step' }), /cut at calm-step/);
  const decided = (await operator(unsure, routed)).state.pin.routes[step(1)];
  assert.deepEqual([decided.branch, decided.choice, decided.unsure], ['calm', 'angry', true]);
  assert.deepEqual([(await run(unsure, routed, judge(choice('angry', 0.99)))).state.went, asked], ['calm', 2]);
  // An answer the interpreter would refuse is spent at its price and is never a decision: the next process asks again.
  const invalid = memoryStore(); await assert.rejects(run(invalid, routed, judge(choice('nowhere', 0.9, 0.004))));
  const spent = await operator(invalid, routed);
  assert.deepEqual([spent.state.questionSpendUsd, spent.state.pin.routes, asked], [0.004, {}, 3]);
  assert.deepEqual([(await run(invalid, routed, judge(choice('calm', 0.9, 0.001)))).state.went, asked], ['calm', 4]);
  assert.equal((await operator(invalid, routed)).state.questionSpendUsd, 0.005);
});

test('a route is decided once, only a route is decided, and its receipts are carried until the host has written them', async () => {
  const store = memoryStore(); const receipts = { invocation: 'question:triage:0@1', request_bytes: 120, latency_ms: 30 };
  let driver = await open(store, routed);
  driver.recordQuestionSpend(0.002, { executionPath: step(1), label: 'triage', result: choice('angry', 0.95), receipts });
  assert.throws(() => driver.recordQuestionSpend(0.002, { executionPath: step(1), label: 'triage', result: choice('calm', 0.95), receipts }), fault('FROZEN_PATH_INVALID', /A route is decided once/));
  assert.throws(() => driver.recordQuestionSpend(null, { executionPath: step(0), label: 'seed', result: choice('calm', 0.95), receipts }), fault('FROZEN_PATH_INVALID', /Only a route's answer is a decision/));
  for (const unpriced of [null, Number.NaN, -1]) driver.recordQuestionSpend(unpriced);
  await driver.close(); driver = await open(store, routed);
  assert.deepEqual([driver.routeDecision(step(1)).receipts, driver.routeDecision(step(0))], [receipts, undefined]);
  driver.routeReceipted(step(1));
  driver.routeReceipted(step(0));
  await driver.charge(0.5);
  await driver.close(); const journal = await operator(store, routed);
  assert.deepEqual([journal.state.pin.routes[step(1)].receipts, journal.state.pin.routes[step(1)].branch, journal.state.questionSpendUsd], [null, 'angry', 0.502]);
});

test('an LLM step is admitted before it runs, gets two attempts across the run, and is refused after the second failure', async () => {
  const order = [];
  const store = watched(memoryStore(), (write, state) => { const status = write === 'save' ? state?.pin?.steps?.[step(0)]?.status : undefined; if (status && order.at(-1) !== `saved ${status}`) order.push(`saved ${status}`); });
  const workflow = doc([{ node: 'extract', label: 'read', instructions: 'Read it.', out: 'Any', as: 'record' }, code('after', '() => ({ n: 1 })')]);
  const session = (attempt) => frozenStepSessionId(KEY, 'read', 'step', step(0), attempt);
  const options = { closeStepSession: async (id) => { order.push(`close ${id}`); } };
  let ran = 0, admitted;
  const failing = { runNode: async () => { ran += 1; throw new Error('the model said nothing'); } };
  await assert.rejects(run(store, workflow, failing, options), /the model said nothing/);
  assert.deepEqual(order, ['saved running', `close ${session(0)}`, 'saved closed']);
  assert.deepEqual((await operator(store, workflow)).state.pin.steps, { [step(0)]: { label: 'read', attempt: 0, attemptsAllowed: 2, status: 'closed' } });
  let driver = await open(store, workflow, options);
  assert.deepEqual([driver.stepAdmitted(step(0)), driver.stepId(step(0)), driver.stepId(step(1))], [true, frozenStepId('step', step(0)), null]);
  assert.throws(() => driver.stepSession(step(1), 'after', { attemptsAllowed: 2 }), fault('FROZEN_PATH_INVALID', /Only an LLM step has a session/));
  await driver.close();
  const reading = { runNode: async ({ executionPath, label }) => { ran += 1; admitted = driver.stepSession(executionPath, label); throw new Error('the model said nothing'); } };
  driver = await open(store, workflow, options);
  await assert.rejects(runWorkflow(workflow, INPUT, withRecovery(driver, reading)), /the model said nothing/);
  await driver.close();
  assert.deepEqual(admitted, { label: 'read', attempt: 1, attemptsAllowed: 2, status: 'running', stepId: frozenStepId('step', step(0)), sessionId: session(1), earlierSessionIds: [session(0)] });
  assert.deepEqual(order.slice(3), ['saved running', `close ${session(1)}`, 'saved failed']);
  await assert.rejects(run(store, workflow, failing, options), /^Error: read failed after 2 attempts$/);
  assert.equal(ran, 2);
  // A step that submits is recorded as submitted, and a later open never runs it again.
  const submitting = memoryStore(); let submitted = 0;
  const deps = { runNode: async () => { submitted += 1; return { found: true }; } };
  assert.deepEqual((await run(submitting, workflow, deps)).state.record, { found: true });
  assert.deepEqual((await operator(submitting, workflow)).state.pin.steps[step(0)], { label: 'read', attempt: 0, attemptsAllowed: 2, status: 'submitted' });
  assert.deepEqual([(await run(submitting, workflow, deps)).status, submitted], ['complete', 1]);
  // A stop the driver took ends the step where it is: no attempt is spent.
  const stopped = memoryStore(); driver = await open(stopped, workflow);
  await assert.rejects(runWorkflow(workflow, INPUT, withRecovery(driver, { runNode: async () => { driver.stop({ action: 'pause' }); throw driver.signal.reason; } })), fault('FROZEN_PAUSED'));
  await driver.close();
  assert.deepEqual((await operator(stopped, workflow)).state.pin.steps[step(0)], { label: 'read', attempt: 0, attemptsAllowed: 2, status: 'running' });
});

test('a submission the interpreter refuses spends its attempt: the step is run once more, then refused', async () => {
  const strict = { ...SCHEMAS, Strict: { type: 'object', required: ['found'], properties: { found: { type: 'boolean' } }, additionalProperties: false } };
  const workflow = doc([{ node: 'extract', label: 'read', instructions: 'Read it.', out: 'Strict', as: 'record' }], { schemas: strict });
  const session = (attempt) => frozenStepSessionId(KEY, 'read', 'step', step(0), attempt);
  const closed = []; const options = { closeStepSession: async (id) => { closed.push(id); } };
  const store = memoryStore(); let ran = 0;
  const invalid = { runNode: async () => { ran += 1; return { found: 'yes' }; } };
  await assert.rejects(run(store, workflow, invalid, options));
  assert.deepEqual([(await operator(store, workflow)).state.pin.steps[step(0)], closed], [{ label: 'read', attempt: 0, attemptsAllowed: 2, status: 'submitted' }, []]);
  await assert.rejects(run(store, workflow, invalid, options));
  assert.deepEqual([(await operator(store, workflow)).state.pin.steps[step(0)], closed], [{ label: 'read', attempt: 1, attemptsAllowed: 2, status: 'submitted' }, [session(0)]]);
  await assert.rejects(run(store, workflow, invalid, options), /^Error: read failed after 2 attempts$/);
  assert.deepEqual([ran, closed, (await operator(store, workflow)).state.pin.steps[step(0)].status], [2, [session(0), session(1)], 'failed']);
  // The second attempt may deliver what the first did not.
  const mended = memoryStore(); let attempts = 0;
  const deps = { runNode: async () => ({ found: (attempts += 1) > 1 ? true : 'yes' }) };
  await assert.rejects(run(mended, workflow, deps));
  assert.deepEqual([(await run(mended, workflow, deps)).state.record, attempts], [{ found: true }, 2]);
  assert.deepEqual((await operator(mended, workflow)).state.pin.steps[step(0)], { label: 'read', attempt: 1, attemptsAllowed: 2, status: 'submitted' });
});

test("a step's record and a route's decision are committed before the step runs and before the branch starts", async () => {
  const read = (label) => ({ node: 'extract', label, instructions: 'Read it.', out: 'Any', as: 'record' });
  const workflow = doc([{ node: 'route', label: 'triage', state: { text: 'hello' }, instructions: 'Which desk takes this?', branches: { calm: { criteria: 'a routine request', body: read('calm-read') }, angry: { criteria: 'an escalating complaint', body: read('angry-read') } } }]);
  const branch = `${step(0)}/branches/angry/body`;
  const order = [];
  // A store whose saves take a moment and say what had landed when they did.
  const slow = { open: async (bound) => {
    const journal = await memoryStore().open(bound); const held = Object.create(journal);
    held.save = async (state, note) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const revision = await journal.save(state, note);
      order.push({ routes: Object.keys(state?.pin?.routes ?? {}), steps: Object.fromEntries(Object.entries(state?.pin?.steps ?? {}).map(([path, record]) => [path, record.status])) });
      return revision;
    };
    return held;
  } };
  const result = await run(slow, workflow, { runJudge: async () => { order.push('asked'); return choice('angry', 0.95); }, runNode: async ({ label }) => { order.push(`ran ${label}`); return { found: true }; } });
  assert.equal(result.status, 'complete');
  const ran = order.indexOf('ran angry-read');
  const decided = order.findIndex((entry) => entry.routes?.includes(step(0)));
  const admitted = order.findIndex((entry) => entry.steps?.[branch] === 'running');
  assert.ok(order.indexOf('asked') < decided && decided < ran, `the decision lands before its branch starts: ${JSON.stringify(order)}`);
  assert.ok(admitted !== -1 && admitted < ran, `the step's record lands before the step runs: ${JSON.stringify(order)}`);
});

test('a pause is committed and the next open runs again; a cancel outranks it and is never resumed; nothing follows a stop', async () => {
  const workflow = doc([tool('lookup')]); let dispatched = 0;
  const deps = { runEffect: async () => { dispatched += 1; return {}; } };
  const store = memoryStore(); let driver = await open(store, workflow);
  driver.stop({ action: 'pause', source: 'operator' });
  const paused = driver.signal.reason;
  assert.ok(paused instanceof RecoveryError && driver.signal.aborted);
  assert.deepEqual([paused.code, paused.message, paused.source], ['FROZEN_PAUSED', 'Frozen run paused', 'operator']);
  assert.throws(() => driver.checkStop(), (error) => error === paused);
  await assert.rejects(driver.wrapEffect(deps.runEffect)(params(workflow, step(0))), (error) => error === paused);
  await assert.rejects(driver.charge(1), (error) => error === paused);
  await assert.rejects(runWorkflow(workflow, INPUT, withRecovery(driver, deps)), (error) => error === paused);
  await driver.close(); let journal = await operator(store, workflow);
  assert.deepEqual([journal.state.status, journal.effects, journal.revision, dispatched], ['paused', [], 2, 0]);
  driver = await open(store, workflow);
  driver.checkStop();
  assert.equal((await runWorkflow(workflow, INPUT, withRecovery(driver, deps))).status, 'complete');
  driver.stop({ action: 'pause' });
  driver.stop({ action: 'cancel', source: 'owner' });
  driver.stop({ action: 'pause', source: 'late' });
  const cancelled = driver.signal.reason;
  assert.deepEqual([cancelled.code, cancelled.message, cancelled.source], ['FROZEN_CANCELLED', 'Frozen run cancelled', 'owner']);
  await driver.close(); journal = await operator(store, workflow);
  assert.deepEqual([journal.state.status, dispatched], ['cancelled', 1]);
  driver = await open(store, workflow);
  assert.throws(() => driver.checkStop(), fault('FROZEN_CANCELLED', 'Frozen run cancelled'));
  await driver.close();
  await assert.rejects(run(store, workflow, deps), fault('FROZEN_CANCELLED', 'Frozen run cancelled'));
  assert.equal(dispatched, 1);
  // A stop cuts an effect in flight through its signal: whatever the adapter answers after it, the effect stays unknown.
  const flying = memoryStore(); driver = await open(flying, workflow);
  const cut = { runEffect: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ answered: 'late' }), { once: true }); setImmediate(() => driver.stop({ action: 'pause' })); }) };
  await assert.rejects(runWorkflow(workflow, INPUT, withRecovery(driver, cut)), fault('FROZEN_PAUSED', 'Frozen run paused'));
  await driver.close(); journal = await operator(flying, workflow);
  assert.deepEqual([journal.state.status, journal.effects.map((e) => [e.status, e.result])], ['paused', [['unknown', null]]]);
  await assert.rejects(run(flying, workflow, deps), fault('FROZEN_EFFECT_UNKNOWN', `Reconcile ${effect(step(0))} before resuming; it will not be repeated`));
});

test('an escalation is one commit that names its own revision; every later open returns the same row and the same continuation', async () => {
  const workflow = doc([{ node: 'extract', label: 'read', instructions: 'Read it.', out: 'Any', as: 'record' }]);
  const row = { kind: 'gate', stage: 'review', summary: 'A person has to look.', state: { seen: 1 }, workflow_sha_used: 'sha-w', pin_sha256: 'sha-w', step_label: 'read', step_exec_id: null, cost_usd: 0.5, turns: 3, effect_calls: 1, evidence_dir: 'evidence' };
  const store = memoryStore(); let driver = await open(store, workflow);
  await assert.rejects(driver.handoff({ cost_usd: 1, turns: 1, effect_calls: 0 }), fault('FROZEN_CHECKPOINT_INVALID', 'A handoff follows an escalation; none is recorded'));
  const escalated = await driver.escalate(row);
  assert.match(escalated.tail, new RegExp(`^${KEY}:escalated:[a-z0-9]{1,8}$`));
  assert.deepEqual(escalated, { ...row, tail: escalated.tail, revision: 2 });
  assert.equal(await driver.escalate({ ...row, kind: 'failure', summary: 'Fired again.' }), escalated);
  await driver.close(); let journal = await operator(store, workflow);
  assert.deepEqual(journal.notes.map((note) => [note.revision, note.kind, note.detail]), [[2, 'escalation', { kind: 'gate', stage: 'review', summary: 'A person has to look.', step_label: 'read', step_exec_id: null,
    workflow_sha_used: 'sha-w', cost_usd: 0.5, tail: escalated.tail, state_keys: ['seen'] }]]);
  assert.deepEqual(journal.state.escalation, escalated);
  driver = await open(store, workflow);
  assert.deepEqual([driver.escalation(), await driver.escalate({ ...row, kind: 'failure' })], [escalated, escalated]);
  assert.deepEqual(await driver.handoff({ cost_usd: 0.5, turns: 3, effect_calls: 1 }), escalated);
  const moved = await driver.handoff({ cost_usd: 0.75, turns: 4, effect_calls: 1 });
  assert.deepEqual([moved.cost_usd, moved.turns, moved.revision, moved.tail], [0.75, 4, 2, escalated.tail]);
  await driver.annotateHandoff({ escalation_revision: 2, tail: escalated.tail, inherit: 'full', block_chars: 10, digest_chars: 20 });
  await driver.close(); journal = await operator(store, workflow);
  assert.deepEqual(journal.notes.map((note) => note.kind), ['escalation', 'handoff', 'inherited']);
  assert.deepEqual(journal.notes[1].detail, { escalation_revision: 2, previous_cost_usd: 0.5, cost_usd: 0.75, turns: 4, effect_calls: 1 });
  // A step's identity names the continuation when the escalation is about a step.
  const named = memoryStore(); driver = await open(named, workflow);
  assert.equal((await driver.escalate({ ...row, step_exec_id: frozenStepId('step', step(0)) })).tail, `${KEY}:escalated:${frozenStepId('step', step(0))}`);
  await driver.close();
  // A row whose revision is no escalation commit is refused, and the refused open lets go of the journal.
  await operator(store, workflow, (held) => held.save({ ...held.state, escalation: { ...held.state.escalation, revision: 99 } }));
  await assert.rejects(open(store, workflow), fault('FROZEN_CHECKPOINT_INVALID', 'The escalation row names revision 99, which is not an escalation commit'));
  assert.equal((await operator(store, workflow)).state.escalation.revision, 99);
});

test("a commit that fails is the run's failure: every later call throws it, and no effect is admitted or dispatched after it", async () => {
  const workflow = doc([tool('lookup')]); const disk = new Error('disk full');
  let saves = 0, dispatched = 0;
  const inner = memoryStore();
  const driver = await open(watched(inner, (write) => { if (write === 'save' && (saves += 1) === 2) throw disk; }), workflow);
  await assert.rejects(driver.recovery.resume(nodeAt(workflow, step(0)), INPUT, undefined, step(0)), (error) => error === disk);
  assert.deepEqual([driver.signal.aborted, driver.signal.reason], [true, disk]);
  assert.throws(() => driver.checkStop(), (error) => error === disk);
  await assert.rejects(driver.wrapEffect(async () => { dispatched += 1; })(params(workflow, step(0))), (error) => error === disk);
  await assert.rejects(driver.recovery.commit(nodeAt(workflow, step(0)), INPUT, undefined, step(0)), (error) => error === disk);
  await assert.rejects(runWorkflow(workflow, INPUT, withRecovery(driver, { runEffect: async () => { dispatched += 1; } })), (error) => error === disk);
  await driver.close(); const journal = await operator(inner, workflow);
  assert.deepEqual([dispatched, journal.effects, journal.state.pin.input, journal.revision], [0, [], null, 1]);
});

test('a checkpoint is opened only when the driver could have written it for this run', async () => {
  const workflow = doc([tool('lookup')]);
  const fresh = memoryStore(); await operator(fresh, workflow);
  let driver = await open(fresh, workflow);
  assert.deepEqual([driver.resumed, driver.started, driver.generation], [true, false, 2]);
  await driver.close();
  assert.equal((await run(fresh, workflow, { runEffect: async () => ({}) })).status, 'complete');
  const orphaned = memoryStore();
  await operator(orphaned, workflow, (journal) => journal.admit('step:/root/steps/0#call:0', 'lookup', 'args', null));
  await assert.rejects(open(orphaned, workflow), fault('FROZEN_CHECKPOINT_INVALID', 'Existing frozen run has no checkpoint; retained workspace requires reconciliation'));
  const doctored = async (change) => {
    const store = memoryStore();
    await (await open(store, workflow)).close();
    await operator(store, workflow, (journal) => change(journal, journal.state));
    return store;
  };
  for (const change of [(journal, state) => journal.save({ ...state, schema: 'agentrun.frozen_run.v2' }), (journal, state) => journal.save({ ...state, adaptation: { done: [] } }),
    (journal, state) => journal.save({ ...state, pin: { ...state.pin, done: ['/root/steps/9'] } }), (journal, state) => journal.save({ ...state, status: 'finished' })]) {
    await assert.rejects(open(await doctored(change), workflow), fault('FROZEN_CHECKPOINT_INVALID', 'Invalid frozen recovery checkpoint'));
  }
  // A key the driver no longer writes opens, and the open's own save drops it.
  const retired = await doctored((journal, state) => journal.save({ ...state, effectCalls: 7, lookSpendUsd: 0.25 }));
  assert.equal((await operator(retired, workflow)).state.effectCalls, 7);
  await (await open(retired, workflow)).close();
  const kept = (await operator(retired, workflow)).state;
  assert.deepEqual(['effectCalls' in kept, 'lookSpendUsd' in kept, kept.schema], [false, false, FROZEN_SNAPSHOT_SCHEMA]);
  // An effect with no input checkpoint behind it is a run the driver cannot place.
  const unplaced = await doctored((journal, state) => journal.admit('step:/root/steps/0#call:0', 'lookup', 'args', state));
  driver = await open(unplaced, workflow);
  assert.throws(() => driver.started, fault('FROZEN_CHECKPOINT_INVALID', 'Effects exist before the frozen input checkpoint'));
  await assert.rejects(driver.recovery.commit(nodeAt(workflow, step(0)), { n: Number.POSITIVE_INFINITY }, undefined, step(0)), fault('FROZEN_CHECKPOINT_INVALID', 'Non-finite workflow state'));
  await driver.close();
});

test('a run is bound to its workflow and to what the host binds beside it; a view moves paths, never the binding', async () => {
  const workflow = doc([tool('lookup')]); const bind = { config: { question: 'first', budget: 5 }, cwd: 'workspace' };
  const store = memoryStore(); let driver = await open(store, workflow, { bind });
  assert.deepEqual([driver.binding === recoveryBinding(workflow, bind), driver.binding === recoveryBinding(workflow)], [true, false]);
  await driver.close();
  await assert.rejects(open(store, workflow, { bind: { ...bind, config: { question: 'second', budget: 5 } } }), (error) => {
    fault('RUN_STORE_BINDING_MISMATCH', 'Run store binding mismatch: config.question changed since the run was bound')(error);
    assert.deepEqual(error.moved, ['config.question']);
    return true;
  });
  await assert.rejects(open(store, { ...workflow, name: 'renamed' }, { bind }), fault('RUN_STORE_BINDING_MISMATCH', 'Run store binding mismatch: workflow.name changed since the run was bound'));
  await assert.rejects(open(store, workflow), fault('RUN_STORE_BINDING_MISMATCH', 'Run store binding mismatch: config.budget (gone), config.question (gone), cwd (gone) changed since the run was bound'));
  await (await open(store, workflow, { bind: { cwd: 'workspace', config: { budget: 5, question: 'first' } } })).close();
  // The host runs a rewritten document: its paths resolve in the view, and the run stays bound to what was authored.
  const authored = doc([{ node: 'artifact', label: 'memo', type: 'brief', instructions: 'Write the memo.' }]);
  const view = doc([{ node: 'report', label: 'memo', instructions: 'Write the memo.' }]);
  driver = await open(memoryStore(), authored);
  assert.throws(() => driver.stepSession(step(0), 'memo', { attemptsAllowed: 2 }), fault('FROZEN_PATH_INVALID', /Only an LLM step has a session/));
  await driver.close(); driver = await open(memoryStore(), authored, { view });
  assert.deepEqual([driver.binding, driver.stepSession(step(0), 'memo', { attemptsAllowed: 2 }).status], [recoveryBinding(authored), 'running']);
  await driver.close();
});

test('every node kind runs under the driver and commits at its execution path; a chain never commits itself', async () => {
  const child = doc([code('child-seed', '() => ({ n: 1 })')], { name: 'child', input: { schemaId: 'Any' } });
  const workflow = doc([
    code('seed', "() => ({ items: ['a', 'b'], kind: 'left', count: 0 })"),
    tool('lookup'),
    { node: 'map', label: 'each', itemsPath: 'items', as: 'mapped', maxConcurrency: 1, body: code('per-item', '(s) => ({ seen: s.item })') },
    { node: 'loop', label: 'twice', body: code('count', '(s) => ({ count: s.count + 1 })'), until: { predicate: 'field_equals', path: 'count', value: 2 }, maxIters: 2 },
    { node: 'parallel', label: 'both', branches: [code('one', '() => ({ a: 1 })'), code('two', '() => ({ b: 2 })')] },
    { node: 'route', label: 'side', valuePath: 'kind', branches: { left: { body: code('went-left', "() => ({ went: 'left' })") }, right: { body: code('went-right', "() => ({ went: 'right' })") } } },
    { node: 'workflow', label: 'child', workflow: child, input: {}, out: 'Out', as: 'childOut' },
    { node: 'chain', steps: [code('nested', '() => ({ nested: true })')] },
    { node: 'extract', label: 'read', instructions: 'Read it.', out: 'Any', as: 'record' },
  ]);
  const store = memoryStore(); const committed = []; let adapters = 0;
  const deps = { runEffect: async () => { adapters += 1; return {}; }, runNode: async () => { adapters += 1; return { found: true }; } };
  const driver = await open(store, workflow);
  const wrapped = withRecovery(driver, deps);
  wrapped.recovery = { ...wrapped.recovery, commit: (node, state, item, path) => { committed.push(path); return driver.recovery.commit(node, state, item, path); } };
  const result = await runWorkflow(workflow, INPUT, wrapped);
  await driver.close();
  assert.deepEqual([result.status, result.state.went, result.state.count, result.state.childOut, adapters], ['complete', 'left', 2, { ok: true }, 2]);
  const journal = await operator(store, workflow);
  assert.deepEqual(journal.state.pin.done, committed);
  assert.equal(new Set(committed).size, committed.length);
  const kinds = committed.map((path) => nodeAt(workflow, path)?.node);
  assert.ok(!kinds.includes(undefined) && !kinds.includes('chain'), kinds.join(' '));
  assert.deepEqual([...new Set(kinds)].sort(), ['call', 'code', 'extract', 'loop', 'map', 'parallel', 'route', 'workflow']);
  for (const path of [step(0), step(1), `${step(2)}/items/1/body`, `${step(3)}/iterations/1/body`, `${step(4)}/branches/0`, `${step(5)}/branches/left/body`, `${step(6)}/workflow/root/steps/0`, step(7, 0), step(8), step(9)]) assert.ok(committed.includes(path), path);
  assert.deepEqual([(await run(store, workflow, deps)).status, adapters], ['complete', 2]);
});
