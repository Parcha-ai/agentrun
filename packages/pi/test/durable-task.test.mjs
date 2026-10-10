// The workflow as one pi-durable task, in one process over SQLite: what a run commits, how a later start of its key
// reaches it, what a typed failure becomes, and the two stops. Each reopen of a file stands for a later process.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, recoveryBound, withRecovery, workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension, documentStore } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-durable-task-'));
after(() => rmSync(root, { recursive: true, force: true }));

const WORKFLOW = {
  v: 2, name: 'task',
  schemas: { Quote: { type: 'object', required: ['price'], properties: { price: { type: 'number' } } }, Out: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } },
  output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'quote', via: 'tool', tool: 'prices.quote', args: { sku: '{sku}' }, out: 'Quote', as: 'quote', deadline_s: 20 },
    { node: 'code', label: 'total', code: 's => ({ result: { total: s.quote.price * 2 } })' },
  ] },
};
const request = (key = 'run-1') => ({ key, workflow: WORKFLOW, input: { sku: 'A-1' } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const pending = (promise, ms = 30) => Promise.race([promise.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), ms))]);

/** A host whose effects go to `runEffect`, over a scratch workspace. */
const hostOf = (runEffect) => {
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  return { options: () => ({ files }), run: () => ({ adapters: { runEffect: (params) => runEffect(params) } }) };
};
/** One process: a Harness over `file` with the workflow extension installed. */
async function open(file, flow) {
  const registry = createRegistry();
  registry.install(flow.extension);
  return Harness.open(await openNodeSqliteStorage(file), { registry, models: {} }, ctx);
}
const fileOf = () => join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
/** The journal in an operator's hands, outside any task. */
async function journalOf(harness, key = 'run-1') {
  const journal = await documentStore(harness, key).open(recoveryBound(WORKFLOW));
  try { return { status: journal.state?.status, effects: journal.effects().map((e) => [e.name, e.status, e.result?.value ?? null]) }; }
  finally { await journal.close(); }
}

test('a run is one task: it completes with the workflow output, and a later start of its key returns the same task and outcome with no new effect', async () => {
  let calls = 0;
  const flow = createWorkflowExtension(hostOf(async () => { calls += 1; return { price: 21 }; }));
  const harness = await open(fileOf(), flow);
  const run = await flow.start(harness, request(), ctx);
  const outcome = await run.wait(ctx);
  assert.deepEqual([run.started, outcome.status, outcome.output, outcome.state.quote, calls], ['created', 'complete', { total: 42 }, { price: 21 }, 1]);
  const record = await harness.getTask(run.taskId, ctx);
  assert.deepEqual([record.kind, record.state.status, record.state.outcome.status], ['agentrun.workflow', 'terminal', 'completed']);
  assert.deepEqual(await journalOf(harness), { status: 'running', effects: [['quote', 'completed', { price: 21 }]] });
  const again = await flow.start(harness, request(), ctx);
  assert.deepEqual([again.started, again.taskId, await again.wait(ctx), calls], ['settled', run.taskId, outcome, 1]);
  assert.deepEqual(await flow.read(harness, 'run-1', ctx), { taskId: run.taskId, status: 'terminal', outcome });
  assert.equal(await flow.read(harness, 'run-2', ctx), undefined);
  await harness.close(ctx);
});

test('a typed failure is a committed outcome, never a throw; a later start runs a new task over the same journal, which refuses the unknown effect', async () => {
  let calls = 0;
  const flow = createWorkflowExtension(hostOf(async () => { calls += 1; throw new Error('connection reset'); }));
  const harness = await open(fileOf(), flow);
  const first = await flow.start(harness, request(), ctx);
  const failed = await first.wait(ctx);
  assert.equal(failed.status, 'refused');
  assert.match(failed.message, /connection reset/);
  const record = await harness.getTask(first.taskId, ctx);
  assert.deepEqual([record.state.outcome.status, typeof record.state.outcome.error.detail.code], ['failed', 'string']);
  assert.deepEqual(await journalOf(harness), { status: 'running', effects: [['quote', 'unknown', null]] });
  const second = await flow.start(harness, request(), ctx);
  assert.equal(second.started, 'created');
  assert.notEqual(second.taskId, first.taskId);
  const refused = await second.wait(ctx);
  assert.deepEqual([refused.status, refused.code, calls], ['refused', 'FROZEN_EFFECT_UNKNOWN', 1]);
  assert.match(refused.message, /^Reconcile step:\/root\/steps\/0#call:0 before resuming; it will not be repeated$/);
  const kept = await harness.getTask(second.taskId, ctx);
  assert.deepEqual([kept.state.outcome.status, kept.state.outcome.error.detail.code], ['failed', 'FROZEN_EFFECT_UNKNOWN']);
  await harness.close(ctx);
});

test('a pause lets the effect in flight complete and commit, the task stays pending, and the next process continues it with no second dispatch', async () => {
  const file = fileOf(); let calls = 0; const flight = deferred(), release = deferred();
  const flow = createWorkflowExtension(hostOf(async ({ signal }) => { calls += 1; flight.resolve(); await release.promise; return { price: 21, aborted: signal.aborted }; }));
  let harness = await open(file, flow);
  const run = await flow.start(harness, request(), ctx);
  await flight.promise;
  const stopping = flow.stop(harness, 'run-1', 'pause', ctx, 'operator');
  // The pause waits for the effect in flight.
  assert.equal(await pending(stopping), true);
  release.resolve();
  assert.equal(await stopping, 'paused');
  // A paused task does not end while the Harness stays open: it waits for the host to close it.
  assert.equal(await pending(harness.waitForTask(run.taskId, ctx), 200), true);
  assert.equal((await harness.getTask(run.taskId, ctx)).state.status, 'running');
  await harness.close(ctx);
  harness = await open(file, flow);
  assert.deepEqual(await journalOf(harness), { status: 'paused', effects: [['quote', 'completed', { price: 21, aborted: false }]] });
  assert.equal((await harness.getTask(run.taskId, ctx)).state.status, 'pending');
  assert.equal(await flow.stop(harness, 'run-1', 'pause', ctx), 'not-live');
  harness.resume();
  const settled = await harness.waitForTask(run.taskId, ctx);
  assert.deepEqual([settled.state.outcome.status, settled.state.outcome.result.output, calls], ['completed', { total: 42 }, 1]);
  await harness.close(ctx);
});

test('a cancel returns once pi marked the task, before it is terminal; the effect it cut stays unknown, the journal is cancelled and never resumes', async () => {
  let calls = 0; const flight = deferred();
  const flow = createWorkflowExtension(hostOf(({ signal }) => { calls += 1; flight.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }));
  const harness = await open(fileOf(), flow);
  const run = await flow.start(harness, request(), ctx);
  await flight.promise;
  assert.equal(await flow.stop(harness, 'run-1', 'cancel', ctx, 'owner'), 'marked');
  assert.notEqual((await harness.getTask(run.taskId, ctx)).state.status, 'terminal');
  assert.deepEqual(await run.wait(ctx), { status: 'stopped', stop: 'cancelled', source: 'owner' });
  assert.deepEqual((await harness.getTask(run.taskId, ctx)).state.outcome, { status: 'aborted', reason: 'cancelled by owner' });
  assert.deepEqual(await journalOf(harness), { status: 'cancelled', effects: [['quote', 'unknown', null]] });
  const again = await flow.start(harness, request(), ctx);
  assert.deepEqual([again.started, again.taskId, await again.wait(ctx), calls], ['settled', run.taskId, { status: 'stopped', stop: 'cancelled', source: 'owner' }, 1]);
  assert.equal(await flow.stop(harness, 'run-1', 'cancel', ctx), 'terminal');
  assert.equal(await flow.stop(harness, 'run-9', 'cancel', ctx), 'not-live');
  await harness.close(ctx);
});

test('a start of a live run attaches to its task; a journal an older build started with no task is adopted and answered from its receipts', async () => {
  let calls = 0; const flight = deferred(), release = deferred();
  const flow = createWorkflowExtension(hostOf(async () => { calls += 1; flight.resolve(); await release.promise; return { price: 21 }; }));
  const harness = await open(fileOf(), flow);
  const first = await flow.start(harness, request(), ctx);
  await flight.promise;
  const second = await flow.start(harness, request(), ctx);
  assert.deepEqual([second.started, second.taskId], ['attached', first.taskId]);
  release.resolve();
  assert.deepEqual(await second.wait(ctx), await first.wait(ctx));
  assert.equal(calls, 1);
  // An older build ran the driver with no task and died after the effect completed, before the next commit.
  const driver = await openRecovery(documentStore(harness, 'run-old'), WORKFLOW, { key: 'run-old', files: workspaceFiles(mkdtempSync(join(root, 'cwd-'))) });
  const deps = withRecovery(driver, { runEffect: async () => { calls += 1; return { price: 5 }; } });
  deps.recovery = { ...deps.recovery, commit: (node, ...rest) => node.label === 'total' ? Promise.reject(new Error('the process died')) : driver.recovery.commit(node, ...rest) };
  await assert.rejects(runWorkflow(WORKFLOW, { sku: 'A-1' }, deps), /the process died/);
  await driver.close();
  assert.equal(await flow.read(harness, 'run-old', ctx), undefined);
  const adopted = await flow.start(harness, request('run-old'), ctx);
  const outcome = await adopted.wait(ctx);
  assert.deepEqual([adopted.started, outcome.status, outcome.output, calls], ['created', 'complete', { total: 10 }, 2]);
  await harness.close(ctx);
});

test('a host that composes its own dependencies over the driver gets the open driver, and the task runs them as they are', async () => {
  let calls = 0; const seen = [];
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const flow = createWorkflowExtension({
    options: () => ({ files }),
    run: ({ driver, taskId }) => {
      seen.push([typeof driver.escalate, driver.driverId, Number(taskId) > 0]);
      return { deps: withRecovery(driver, { runEffect: async () => { calls += 1; return { price: 21 }; } }) };
    },
  });
  const harness = await open(fileOf(), flow);
  const outcome = await (await flow.start(harness, request(), ctx)).wait(ctx);
  assert.deepEqual([outcome.status, outcome.output, calls, seen], ['complete', { total: 42 }, 1, [['function', 'run-1', true]]]);
  await harness.close(ctx);
});

test('a failure keeps its own plain fields on the outcome, so the host reads back the failure it raised', async () => {
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const flow = createWorkflowExtension({ options: () => ({ files }), run: () => ({ adapters: { runEffect: async () => {
    throw Object.assign(new Error('the pin is not runnable'), { code: 'pin_invalid', stage: 'pin', cost_usd: 0.25, nested: { node: 'quote' }, hook: () => 1 });
  } } }) });
  const harness = await open(fileOf(), flow);
  const run = await flow.start(harness, request(), ctx);
  const outcome = await run.wait(ctx);
  assert.equal(outcome.status, 'refused');
  const detail = (await harness.getTask(run.taskId, ctx)).state.outcome.error.detail;
  assert.deepEqual([outcome.code, outcome.message, detail], ['pin_invalid', 'the pin is not runnable', { code: 'pin_invalid', stage: 'pin', cost_usd: 0.25, nested: { node: 'quote' } }]);
  await harness.close(ctx);
});

test('a host that runs its documents under its own policy gives its interpreter, and the task runs the run with it', async () => {
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const seen = [];
  const flow = createWorkflowExtension({
    options: () => ({ files }),
    run: ({ driver }) => ({
      deps: withRecovery(driver, { runEffect: async () => ({ price: 21 }) }),
      interpret: async (workflow, input, deps) => { seen.push([workflow.name, input.sku]); return runWorkflow(workflow, input, deps); },
    }),
  });
  const harness = await open(fileOf(), flow);
  const outcome = await (await flow.start(harness, request(), ctx)).wait(ctx);
  assert.deepEqual([outcome.status, outcome.output, seen], ['complete', { total: 42 }, [['task', 'A-1']]]);
  await harness.close(ctx);
});

test('a run whose Session refuses its commits fails its waiters with its own failure instead of waiting forever', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const prepare = DatabaseSync.prototype.prepare;
  // The effect's admission is the write that fails, and the failed commit poisons the Session: no later commit lands.
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (!/^\s*INSERT INTO documents/i.test(String(sql))) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key !== 'run') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return (...args) => { if (args.some((arg) => arg === JSON.stringify('agentrun.effects'))) throw Object.assign(new Error('injected store write failure'), { code: 'ERR_SQLITE_ERROR' }); return target.run(...args); };
    } });
  };
  try {
    const flow = createWorkflowExtension(hostOf(async () => ({ price: 21 })));
    const harness = await open(fileOf(), flow);
    const run = await flow.start(harness, request(), ctx);
    const hung = new Promise((_, reject) => setTimeout(() => reject(new Error('the wait hung')), 20000));
    await assert.rejects(Promise.race([run.wait(ctx), hung]), /injected store write failure|poisoned/);
    await harness.close(ctx).catch(() => undefined);
  } finally { DatabaseSync.prototype.prepare = prepare; }
});

test('a stop given before the run started is taken before any step: a pause is in the journal and the next start runs; a cancel ends the task through pi', async () => {
  let calls = 0;
  const file = fileOf();
  const flow = createWorkflowExtension(hostOf(async () => { calls += 1; return { price: 21 }; }));
  let harness = await open(file, flow);
  const run = await flow.start(harness, request(), ctx, { stop: { action: 'pause', source: 'operator' } });
  // The pause is taken as the run's phase opens its driver: nothing is dispatched, and the task stays pending. A pause
  // handed over once the phase is waiting is answered `paused`, however fast the phase got there.
  let answer = 'not-live';
  for (let i = 0; i < 200 && answer === 'not-live'; i += 1) { answer = await flow.stop(harness, 'run-1', 'pause', ctx); if (answer === 'not-live') await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(answer, 'paused');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await flow.stop(harness, 'run-1', 'pause', ctx), 'paused');
  await harness.close(ctx);
  harness = await open(file, flow);
  assert.deepEqual([await journalOf(harness), calls, (await harness.getTask(run.taskId, ctx)).state.status], [{ status: 'paused', effects: [] }, 0, 'pending']);
  const again = await flow.start(harness, request(), ctx);
  assert.deepEqual([again.started, (await again.wait(ctx)).status, calls], ['attached', 'complete', 1]);
  await harness.close(ctx);
  const cancelled = createWorkflowExtension(hostOf(async () => { calls += 1; return { price: 21 }; }));
  const other = await open(fileOf(), cancelled);
  const stopped = await cancelled.start(other, request(), ctx, { stop: { action: 'cancel', source: 'owner' } });
  assert.deepEqual([await stopped.wait(ctx), calls], [{ status: 'stopped', stop: 'cancelled', source: 'owner' }, 1]);
  assert.deepEqual(await journalOf(other), { status: 'cancelled', effects: [] });
  await other.close(ctx);
});
