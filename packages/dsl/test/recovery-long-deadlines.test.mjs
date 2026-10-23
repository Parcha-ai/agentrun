// The driver's own timers over an effect's deadline and a poll's wait. A deadline_s or interval_s is any finite number
// of seconds: one with a fraction of a millisecond, or one past Node's 2^31-1 ms timer limit (~24.8 days), still waits
// out its time. Before, a fractional deadline threw ERR_OUT_OF_RANGE after the effect was admitted and left it unknown,
// and a deadline or wait past the limit fired at once (a TimeoutOverflowWarning): the effect was aborted as soon as it
// started, and a poll checked again with no wait at all.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { memoryStore, openRecovery, recoveryBound, withRecovery } from '@parcha/agentrun-dsl/recovery';

const SCHEMAS = { Any: { type: 'object' }, Status: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } };
const doc = (call) => ({ v: 2, name: 'long-deadlines', schemas: SCHEMAS, output: { schemaId: 'Any' }, root: { node: 'chain', steps: [call, { node: 'code', label: 'after', code: 's => ({ done: true })' }] } });
const called = (deadline_s) => doc({ node: 'call', label: 'look', via: 'tool', tool: 'look', args: {}, out: 'Any', as: 'got', deadline_s });
const effects = async (store, workflow) => { const journal = await store.open(recoveryBound(workflow)); try { return journal.effects().map((effect) => effect.status); } finally { await journal.close(); } };

/** The timers the process holds: a driver's timer left behind holds the process open until it fires. */
const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
/** The warnings the process emits while `body` runs, by name. */
async function warned(body) {
  const names = []; const keep = (warning) => names.push(warning.name);
  process.on('warning', keep);
  try { return { result: await body(), names: await new Promise((resolve) => setImmediate(() => resolve(names))) }; }
  finally { process.off('warning', keep); }
}

/** One run of `workflow` whose effect takes `ms` and reports whether its signal was aborted by then. */
async function ran(workflow, ms = 50) {
  const store = memoryStore();
  const driver = await openRecovery(store, workflow, { key: 'long' });
  let dispatched = 0, aborted;
  const runEffect = async ({ signal }) => { dispatched += 1; await new Promise((resolve) => setTimeout(resolve, ms)); aborted = signal.aborted; if (aborted) throw signal.reason; return { ok: true }; };
  const status = await runWorkflow(workflow, {}, withRecovery(driver, { runEffect })).then((result) => result.status, (error) => error.code ?? error.name);
  await driver.close();
  return { status, dispatched, aborted, effects: await effects(store, workflow) };
}

test('an effect deadline with a fraction of a millisecond is waited out: the effect is dispatched and completes', async () => {
  assert.deepEqual(await ran(called(1.0005)), { status: 'complete', dispatched: 1, aborted: false, effects: ['completed'] });
});

test('an effect deadline past the timer limit does not fire at once: the effect completes, and nothing overflows', async () => {
  const before = timers();
  const { result, names } = await warned(() => ran(called(3_000_000)));
  assert.deepEqual(result, { status: 'complete', dispatched: 1, aborted: false, effects: ['completed'] });
  assert.deepEqual(names.filter((name) => name === 'TimeoutOverflowWarning'), []);
  assert.equal(timers(), before, 'the completed effect left its deadline armed');
});

test('a poll wait past the timer limit waits: one check, no second one, until the run is cancelled', async () => {
  const workflow = doc({ node: 'call', label: 'status', via: 'tool', tool: 'jobs.status', args: {}, out: 'Status', as: 'job', deadline_s: 30,
    poll: { until: { predicate: 'in', path: 'status', values: ['COMPLETED'] }, interval_s: 3_000_000, deadline_s: 4_000_000 } });
  const before = timers();
  const { result, names } = await warned(async () => {
    const driver = await openRecovery(memoryStore(), workflow, { key: 'long' });
    let checks = 0;
    const running = runWorkflow(workflow, {}, withRecovery(driver, { runEffect: async () => { checks += 1; return { status: 'PENDING' }; } }))
      .then((result) => result.status, (error) => error.code);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const seen = checks;
    driver.stop({ action: 'cancel', source: 'operator' });
    const status = await running;
    await driver.close();
    return { checks: seen, status };
  });
  assert.deepEqual(result, { checks: 1, status: 'FROZEN_CANCELLED' });
  assert.deepEqual(names.filter((name) => name === 'TimeoutOverflowWarning'), []);
  assert.equal(timers(), before, 'the cancelled wait left its timer armed');
});

test('a poll wait with a fraction of a millisecond waits it out', async () => {
  const workflow = doc({ node: 'call', label: 'status', via: 'tool', tool: 'jobs.status', args: {}, out: 'Status', as: 'job', deadline_s: 30,
    poll: { until: { predicate: 'in', path: 'status', values: ['COMPLETED'] }, interval_s: 0.2005, deadline_s: 30 } });
  const driver = await openRecovery(memoryStore(), workflow, { key: 'long' });
  const at = [];
  const runEffect = async () => { at.push(performance.now()); return { status: at.length < 2 ? 'PENDING' : 'COMPLETED' }; };
  const result = await runWorkflow(workflow, {}, withRecovery(driver, { runEffect }));
  await driver.close();
  assert.equal(result.status, 'complete');
  assert.ok(at[1] - at[0] >= 199, `the second check came ${at[1] - at[0]} ms after the first`);
});

test('control: a whole-millisecond deadline still fires on time from its durable clock, with the TimeoutError a host reads as a deadline', async () => {
  // The first process sets the effect's clock and dies at its admission; the next one resumes 400 ms later, so the
  // driver's deadline (the clock it kept) comes before the interpreter's own, which this process starts afresh.
  const base = memoryStore();
  let killed = true;
  const store = { open: async (bound) => {
    const journal = await base.open(bound);
    return new Proxy(journal, { get(target, key) {
      if (key === 'admit' && killed) return async () => { throw new Error('killed before the admission'); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const workflow = called(1);
  let driver = await openRecovery(store, workflow, { key: 'long' });
  await assert.rejects(runWorkflow(workflow, {}, withRecovery(driver, { runEffect: async () => ({ ok: true }) })), /killed before the admission/);
  await driver.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  killed = false;
  driver = await openRecovery(store, workflow, { key: 'long' });
  let reason, waited;
  const runEffect = async ({ signal }) => {
    const started = performance.now();
    reason = await new Promise((resolve) => { const timer = setTimeout(() => resolve('not aborted'), 10_000); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(signal.reason); }); });
    waited = performance.now() - started;
    throw reason;
  };
  const status = await runWorkflow(workflow, {}, withRecovery(driver, { runEffect })).then((result) => result.status, (error) => error.code ?? error.name);
  await driver.close();
  assert.equal(reason?.name, 'TimeoutError');
  assert.ok(waited < 950, `the deadline fired after ${waited} ms, not from the clock the first process set`);
  assert.notEqual(status, 'complete');
  assert.deepEqual(await effects(base, workflow), ['unknown']);
});

test('a runEffect that ignores its abort and stays pending does not leave the deadline timer holding the process until a far deadline', async () => {
  // The deadline is far out (past the timer limit). The effect never resolves and never heeds its signal. The host
  // cancels; the run ends. The deadline timer must be cleared by the abort, not left armed for ~34 days — otherwise it
  // keeps the process alive long after the run is over. (The dispatch promise never settles, so the `finally` cannot be
  // what clears it.)
  const workflow = called(3_000_000);
  const before = timers();
  const driver = await openRecovery(memoryStore(), workflow, { key: 'long' });
  let dispatched = 0;
  const runEffect = () => { dispatched += 1; return new Promise(() => {}); }; // ignores signal, never resolves
  const running = runWorkflow(workflow, {}, withRecovery(driver, { runEffect })).then((result) => result.status, (error) => error.code);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(dispatched, 1, 'the effect was dispatched');
  driver.stop({ action: 'cancel', source: 'operator' });
  const status = await running;
  await driver.close();
  // An in-flight effect aborted by a cancel stays unknown (its outcome is not known), which is the run's end here.
  assert.equal(status, 'effect_outcome_unknown');
  assert.equal(timers(), before, 'the cancelled effect left its deadline timer armed, holding the process');
});
