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
import { createWorkflowExtension, documentStore, durableDoc, readJournal } from '@parcha/agentrun-pi/durable';

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
/** `promise`, or a rejection when it has not settled in `ms`: a wait that hangs fails its test instead of the file. */
const within = (promise, ms = 5000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]).finally(() => clearTimeout(timer)); };
/** Runs `body` with the document writes `when({ kind, content })` picks failing in SQLite: each is a revision of a
 *  document of that kind, with its content as stored. A failed commit poisons the Session: no later commit lands. */
async function refusingWrites(when, body) {
  const { DatabaseSync } = await import('node:sqlite');
  const prepare = DatabaseSync.prototype.prepare;
  const kinds = new Map();
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    const table = /^\s*INSERT INTO (documents|document_revisions)\b/i.exec(String(sql))?.[1];
    if (!table) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key !== 'run') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return (...args) => {
        if (table === 'documents') kinds.set(args[0], JSON.parse(args[1]));
        else if (when({ kind: kinds.get(args[0]), content: String(args[4]) })) throw Object.assign(new Error('injected store write failure'), { code: 'ERR_SQLITE_ERROR' });
        return target.run(...args);
      };
    } });
  };
  try { return await body(); } finally { DatabaseSync.prototype.prepare = prepare; }
}

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

test('a run stored in a schema newer than this build knows stays pending with its store intact: its waiters get the refusal, and a build that knows the schema completes it', async () => {
  const file = fileOf(); let calls = 0; const flight = deferred(), release = deferred();
  const flow = createWorkflowExtension(hostOf(async () => { calls += 1; flight.resolve(); await release.promise; return { price: 21 }; }));
  let harness = await open(file, flow);
  const run = await flow.start(harness, request(), ctx);
  await flight.promise;
  const stopping = flow.stop(harness, 'run-1', 'pause', ctx);
  release.resolve();
  assert.equal(await stopping, 'paused');
  await harness.close(ctx);
  /** The journal's state, restamped as a build with another schema would have written it. */
  const stamp = async (schema) => {
    const operator = await open(file, flow);
    const journal = await documentStore(operator, 'run-1').open(recoveryBound(WORKFLOW));
    const state = journal.state;
    await journal.save({ ...state, schema });
    await journal.close();
    await operator.close(ctx);
    return state.schema;
  };
  const known = await stamp('agentrun.frozen_run.v99');
  harness = await open(file, flow);
  const attached = await flow.start(harness, request(), ctx);
  assert.equal(attached.started, 'attached');
  await assert.rejects(within(attached.wait(ctx)), (error) => error.code === 'RECOVERY_SCHEMA_NEWER' && error.found === 'agentrun.frozen_run.v99');
  assert.equal(await pending(harness.waitForTask(run.taskId, ctx), 200), true, 'the task does not end while this build holds it');
  await harness.close(ctx);
  harness = await open(file, flow);
  assert.equal((await harness.getTask(run.taskId, ctx)).state.status, 'pending');
  const journal = await documentStore(harness, 'run-1').open(recoveryBound(WORKFLOW));
  assert.deepEqual([journal.state.schema, journal.effects().map((e) => [e.name, e.status])], ['agentrun.frozen_run.v99', [['quote', 'completed']]]);
  await journal.close();
  await harness.close(ctx);
  await stamp(known);
  harness = await open(file, flow);
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

test('a stop given with the start is recorded in the commit that creates the task; a cancel recorded before pi marked the task is taken by the next process before any step', async () => {
  let calls = 0;
  const file = fileOf();
  const host = () => hostOf(async () => { calls += 1; return { price: 21 }; });
  let flow = createWorkflowExtension(host());
  let harness = await open(file, flow);
  const entries = [];
  harness.subscribeCommits((publication) => { for (const change of publication.changes) if (change.type === 'document' && change.record.kind === 'agentrun.task' && change.value) entries.push([change.value.task !== null, change.value.stop]); });
  // The process dies once the start has committed, before pi marks the task.
  harness.abortTask = async () => { throw new Error('killed before the mark'); };
  await assert.rejects(flow.start(harness, request(), ctx, { stop: { action: 'cancel', source: 'owner' } }), /killed before the mark/);
  assert.deepEqual(entries, [[true, { action: 'cancel', source: 'owner' }]]);
  await harness.close(ctx);
  flow = createWorkflowExtension(host());
  harness = await open(file, flow);
  try {
    const { taskId } = await flow.read(harness, 'run-1', ctx);
    harness.resume();
    const settled = await within(harness.waitForTask(taskId, ctx));
    assert.deepEqual([settled.state.outcome, calls], [{ status: 'aborted', reason: 'cancelled by owner' }, 0]);
    assert.deepEqual((await flow.read(harness, 'run-1', ctx)).outcome, { status: 'stopped', stop: 'cancelled', source: 'owner' });
    assert.deepEqual(await journalOf(harness), { status: 'cancelled', effects: [] });
    // The cancelled run is returned as it is, and never runs.
    const again = await flow.start(harness, request(), ctx);
    assert.deepEqual([again.started, await again.wait(ctx), calls], ['settled', { status: 'stopped', stop: 'cancelled', source: 'owner' }, 0]);
  } finally { await harness.close(ctx); }
});

test('a waiter that began before another start attached still gets the run\'s failure when the Session refuses its commits', async () => {
  const flight = deferred(), release = deferred(); let armed = false;
  // The effect's completion is the write that fails, after the second start attached.
  await refusingWrites(({ kind }) => armed && kind === 'agentrun.effects', async () => {
    const flow = createWorkflowExtension(hostOf(async () => { flight.resolve(); await release.promise; return { price: 21 }; }));
    const harness = await open(fileOf(), flow);
    try {
      const first = await flow.start(harness, request(), ctx);
      const waiting = first.wait(ctx);
      waiting.catch(() => undefined);
      await flight.promise;
      const second = await flow.start(harness, request(), ctx);
      assert.deepEqual([second.started, second.taskId], ['attached', first.taskId]);
      armed = true;
      release.resolve();
      await assert.rejects(within(waiting), /injected store write failure|poisoned/);
      await assert.rejects(within(second.wait(ctx)), /injected store write failure|poisoned/);
      // A wait that begins after the failure fails too, instead of waiting for a task nothing will end.
      await assert.rejects(within(first.wait(ctx)), /injected store write failure|poisoned/);
    } finally { await harness.close(ctx).catch(() => undefined); }
  });
});

test('a host with its own dependencies and its own signal: a pause still reaches a step that is running', async () => {
  const NODES = { ...WORKFLOW, name: 'task-node', root: { node: 'chain', steps: [
    { node: 'agent', label: 'quote', instructions: 'Quote the price.', out: 'Quote', as: 'quote' }, WORKFLOW.root.steps[1],
  ] } };
  const entered = deferred(); let cut = false;
  const own = new AbortController();
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const runNode = ({ signal }) => { entered.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => { cut = true; reject(signal.reason); }, { once: true })); };
  const flow = createWorkflowExtension({ options: () => ({ files }), run: ({ driver }) => ({ deps: { ...withRecovery(driver, { runNode }), signal: own.signal } }) });
  const harness = await open(fileOf(), flow);
  try {
    await flow.start(harness, { key: 'run-1', workflow: NODES, input: { sku: 'A-1' } }, ctx);
    await within(entered.promise);
    assert.equal(await within(flow.stop(harness, 'run-1', 'pause', ctx, 'operator')), 'paused');
    assert.equal(cut, true);
  } finally { await harness.close(ctx); }
});

test('a pause that cannot be let go of as the run opens is the run\'s failure: its waiter gets it, and the journal is let go', async () => {
  // The start records the pause; the write that lets go of it, once the journal holds the pause, is the one that fails.
  let recorded = false;
  const lettingGo = ({ kind, content }) => {
    if (kind !== 'agentrun.task') return false;
    const pause = content.includes('"action":"pause"');
    if (pause) recorded = true;
    return recorded && !pause;
  };
  await refusingWrites(lettingGo, async () => {
    let calls = 0;
    const flow = createWorkflowExtension(hostOf(async () => { calls += 1; return { price: 21 }; }));
    const harness = await open(fileOf(), flow);
    try {
      const run = await flow.start(harness, request(), ctx, { stop: { action: 'pause', source: 'operator' } });
      await assert.rejects(within(run.wait(ctx)), /injected store write failure/);
      assert.deepEqual([recorded, calls, await flow.stop(harness, 'run-1', 'pause', ctx)], [true, 0, 'not-live']);
    } finally { await harness.close(ctx).catch(() => undefined); }
  });
});

test('the first cancel names the run\'s source: a later cancel, of the live run or the finished one, does not change it', async () => {
  const flight = deferred();
  const flow = createWorkflowExtension(hostOf(({ signal }) => { flight.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }));
  const harness = await open(fileOf(), flow);
  try {
    const run = await flow.start(harness, request(), ctx);
    await flight.promise;
    assert.equal(await flow.stop(harness, 'run-1', 'cancel', ctx, 'owner'), 'marked');
    await flow.stop(harness, 'run-1', 'cancel', ctx, 'someone-else');
    assert.deepEqual(await run.wait(ctx), { status: 'stopped', stop: 'cancelled', source: 'owner' });
    assert.equal(await flow.stop(harness, 'run-1', 'cancel', ctx), 'terminal');
    assert.equal(await flow.stop(harness, 'run-1', 'cancel', ctx, 'someone-else'), 'terminal');
    assert.deepEqual((await flow.read(harness, 'run-1', ctx)).outcome, { status: 'stopped', stop: 'cancelled', source: 'owner' });
    assert.deepEqual(await run.wait(ctx), { status: 'stopped', stop: 'cancelled', source: 'owner' });
    assert.deepEqual((await harness.getTask(run.taskId, ctx)).state.outcome, { status: 'aborted', reason: 'cancelled by owner' });
  } finally { await harness.close(ctx); }
  // A run pi aborted with no cancel recorded has no source, and a cancel of the finished run does not give it one.
  const held = deferred();
  const other = createWorkflowExtension(hostOf(({ signal }) => { held.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }));
  const second = await open(fileOf(), other);
  try {
    const run = await other.start(second, request(), ctx);
    await held.promise;
    await second.abortTask(run.taskId, ctx);
    assert.deepEqual(await run.wait(ctx), { status: 'stopped', stop: 'cancelled' });
    assert.equal(await other.stop(second, 'run-1', 'cancel', ctx, 'late'), 'terminal');
    assert.deepEqual((await other.read(second, 'run-1', ctx)).outcome, { status: 'stopped', stop: 'cancelled' });
  } finally { await second.close(ctx); }
});

test('a pause given with a start that attaches to a run running here is recorded, not taken now; a recorded pause never gives a cancel its source', async () => {
  let calls = 0; const flight = deferred(), release = deferred();
  const flow = createWorkflowExtension(hostOf(async () => { calls += 1; flight.resolve(); await release.promise; return { price: 21 }; }));
  const harness = await open(fileOf(), flow);
  try {
    const run = await flow.start(harness, request(), ctx);
    await flight.promise;
    const attached = await flow.start(harness, request(), ctx, { stop: { action: 'pause', source: 'operator' } });
    assert.deepEqual([attached.started, attached.taskId], ['attached', run.taskId]);
    // The run is not paused: its effect completes and the run ends complete. `stop` is what pauses a run running here.
    release.resolve();
    assert.deepEqual([(await within(run.wait(ctx))).status, calls], ['complete', 1]);
  } finally { await harness.close(ctx); }
  // pi aborts a run whose entry records a pause: the run ends cancelled with no source, since no cancel named one.
  const held = deferred();
  const other = createWorkflowExtension(hostOf(({ signal }) => { held.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }));
  const second = await open(fileOf(), other);
  try {
    const run = await other.start(second, request(), ctx);
    await held.promise;
    await other.start(second, request(), ctx, { stop: { action: 'pause', source: 'operator' } });
    await second.abortTask(run.taskId, ctx);
    assert.deepEqual(await within(run.wait(ctx)), { status: 'stopped', stop: 'cancelled' });
    assert.deepEqual((await second.getTask(run.taskId, ctx)).state.outcome, { status: 'aborted', reason: 'cancelled' });
  } finally { await second.close(ctx); }
});

/** A run bound beside its workflow, and the three requests for another run under its key: its workflow moved, what the
 *  host binds moved, or its input moved, each with the names the refusal gives for what moved. */
const BOUND = { key: 'run-1', workflow: WORKFLOW, input: { sku: 'A-1', qty: 2 }, bind: { tenant: 'acme', sop: 'v1' } };
const MOVED_WORKFLOW = { ...WORKFLOW, root: { ...WORKFLOW.root, steps: [{ ...WORKFLOW.root.steps[0], deadline_s: 30 }, WORKFLOW.root.steps[1]] } };
const MOVES = [
  ['the workflow', { ...BOUND, workflow: MOVED_WORKFLOW }, ['workflow.root']],
  ['what the host binds', { ...BOUND, bind: { tenant: 'acme', sop: 'v2' } }, ['sop']],
  ['the input', { ...BOUND, input: { sku: 'B-2', qty: 2 } }, ['input.sku']],
];
/** The same request as `BOUND`, with the keys of every object in another order. */
const REORDERED = { bind: { sop: 'v1', tenant: 'acme' }, input: { qty: 2, sku: 'A-1' }, workflow: Object.fromEntries(Object.entries(WORKFLOW).reverse()), key: 'run-1' };
/** Each request for another run is refused with the driver's binding mismatch naming what moved, alone, with a pause and
 *  with a cancel, and the start commits nothing: no commit at all, and the run reads as it did. */
async function refusesEveryMove(flow, harness) {
  const before = await flow.read(harness, 'run-1', ctx);
  for (const [what, moved, names] of MOVES) {
    const commits = [];
    const unsubscribe = harness.subscribeCommits((publication) => { commits.push(publication.changes.map((change) => change.type)); });
    try {
      for (const stop of [undefined, { action: 'pause', source: 'operator' }, { action: 'cancel', source: 'owner' }]) {
        await assert.rejects(flow.start(harness, moved, ctx, stop ? { stop } : {}), (error) => {
          assert.deepEqual([error.name, error.code, error.moved], ['RecoveryError', 'RUN_STORE_BINDING_MISMATCH', names], `${what}, ${stop?.action ?? 'no stop'}`);
          return true;
        });
      }
    } finally { unsubscribe(); }
    assert.deepEqual(commits, [], what);
    assert.deepEqual(await flow.read(harness, 'run-1', ctx), before, what);
  }
}

test('a start that attaches asks for the run its task holds: a moved workflow, binding or input is refused with nothing committed, and the run goes on', async () => {
  let calls = 0; const flight = deferred(), release = deferred();
  const flow = createWorkflowExtension(hostOf(async () => { calls += 1; flight.resolve(); await release.promise; return { price: 21 }; }));
  const harness = await open(fileOf(), flow);
  try {
    const run = await flow.start(harness, BOUND, ctx);
    await flight.promise;
    await refusesEveryMove(flow, harness);
    // The same request with its keys in another order attaches, as it did before.
    const again = await flow.start(harness, REORDERED, ctx);
    assert.deepEqual([again.started, again.taskId], ['attached', run.taskId]);
    // No refused cancel reached the run: its effect completes and the run ends complete.
    release.resolve();
    const outcome = await within(run.wait(ctx));
    assert.deepEqual([outcome.status, outcome.output, calls], ['complete', { total: 42 }, 1]);
  } finally { await harness.close(ctx); }
});

test('a start that reaches a finished run asks for the run its task holds: a moved request is refused as a hand-run open of the journal refuses it, with nothing committed', async () => {
  let calls = 0;
  const flow = createWorkflowExtension(hostOf(async () => { calls += 1; return { price: 21 }; }));
  const harness = await open(fileOf(), flow);
  try {
    const run = await flow.start(harness, BOUND, ctx);
    const outcome = await run.wait(ctx);
    assert.equal(outcome.status, 'complete');
    await refusesEveryMove(flow, harness);
    // The same code and the same names as the driver's own refusal, for what its binding covers.
    for (const [what, moved, names] of MOVES.slice(0, 2)) {
      await assert.rejects(documentStore(harness, 'run-1').open(recoveryBound(moved.workflow, moved.bind)), (error) => {
        assert.deepEqual([error.code, error.moved], ['RUN_STORE_BINDING_MISMATCH', names], what);
        return true;
      });
    }
    const again = await flow.start(harness, REORDERED, ctx);
    assert.deepEqual([again.started, again.taskId, await again.wait(ctx), calls], ['settled', run.taskId, outcome, 1]);
  } finally { await harness.close(ctx); }
});

test('a start that replaces a failed run asks for the run its task holds: a moved input never runs under the failed run\'s journal, and the same request is replaced as before', async () => {
  let calls = 0; let ready = false;
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  // The host cannot give its adapters on the first invocation: the run fails after its journal is bound, before any step.
  const flow = createWorkflowExtension({ options: () => ({ files }), run: () => {
    if (!ready) throw Object.assign(new Error('the host is not ready'), { code: 'HOST_NOT_READY' });
    return { adapters: { runEffect: async ({ input }) => { calls += 1; return { price: input.sku === 'A-1' ? 21 : 50 }; } } };
  } });
  const harness = await open(fileOf(), flow);
  try {
    const first = await flow.start(harness, BOUND, ctx);
    assert.deepEqual([(await first.wait(ctx)).code, (await harness.getTask(first.taskId, ctx)).state.outcome.status], ['HOST_NOT_READY', 'failed']);
    ready = true;
    await refusesEveryMove(flow, harness);
    // The same request with its keys in another order gets a new task over the same journal, which runs it.
    const again = await flow.start(harness, REORDERED, ctx);
    assert.equal(again.started, 'created');
    assert.notEqual(again.taskId, first.taskId);
    const outcome = await within(again.wait(ctx));
    assert.deepEqual([outcome.status, outcome.output, calls], ['complete', { total: 42 }, 1]);
  } finally { await harness.close(ctx); }
});

test('what moved is named per part: a bound key named like the input never hides a field of either', async () => {
  const flow = createWorkflowExtension(hostOf(async () => ({ price: 21 })));
  const harness = await open(fileOf(), flow);
  const bound = { ...BOUND, bind: { tenant: 'acme', input: { sku: 'A-1' } } };
  try {
    assert.equal((await (await flow.start(harness, bound, ctx)).wait(ctx)).status, 'complete');
    const refusal = async (moved) => {
      let refused;
      await assert.rejects(flow.start(harness, moved, ctx), (error) => { refused = error; return error.code === 'RUN_STORE_BINDING_MISMATCH'; });
      return [refused.moved, refused.message];
    };
    // Only the bound `input.sku` moved: it is named, and the message is the driver's own for its binding.
    assert.deepEqual(await refusal({ ...bound, bind: { tenant: 'acme', input: { sku: 'B-2' } } }),
      [['input.sku'], 'Run store binding mismatch: input.sku changed since the run was bound']);
    // The bound `input.sku` and the input's `qty` moved: each part names its own.
    const [moved, message] = await refusal({ ...bound, bind: { tenant: 'acme', input: { sku: 'B-2' } }, input: { sku: 'A-1', qty: 3 } });
    assert.deepEqual(moved, ['input.sku', 'input.qty']);
    assert.match(message, /input\.sku changed since the run was bound.*input\.qty changed since the run was bound/);
  } finally { await harness.close(ctx); }
});

test('a task host settles a killed run\'s unknown effect through reconcile: the run holds one generation per process, and the effect is not dispatched again', async () => {
  let calls = 0; const kept = new Map(); let settle = true;
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const flow = createWorkflowExtension({
    options: () => ({ files, reconcile: async (unknown, complete) => {
      if (!settle) throw new Error('the door is down');
      for (const effect of unknown) await complete(effect.id, kept.get(effect.id), { calls: [{ outcome: 'applied', tool: 'prices.quote' }] });
    } }),
    run: () => ({ adapters: { runEffect: async ({ effect }) => { calls += 1; kept.set(effect.id, { price: 21 }); throw new Error('the process died'); } } }),
  });
  const file = fileOf();
  const harness = await open(file, flow);
  assert.equal((await (await flow.start(harness, request(), ctx)).wait(ctx)).status, 'refused');
  assert.equal(readJournal(file, 'run-1').generation, 1);
  settle = false;
  const failed = await (await flow.start(harness, request(), ctx)).wait(ctx);
  assert.deepEqual([failed.status, failed.code, calls, readJournal(file, 'run-1').generation], ['refused', 'RECOVERY_RECONCILE_FAILED', 1, 2]);
  settle = true;
  const done = await (await flow.start(harness, request(), ctx)).wait(ctx);
  assert.deepEqual([done.status, done.output, calls, readJournal(file, 'run-1').generation], ['complete', { total: 42 }, 1, 3]);
  // The re-send was made by the settling process: the effect keeps the call record it reported, written by that generation.
  assert.deepEqual(durableDoc(file, 'agentrun.effects', 'run-1\u0000step:/root/steps/0#call:0').calls, [{ outcome: 'applied', tool: 'prices.quote' }]);
  await harness.close(ctx);
});

test('options is told its phase: the abort handler opens the driver too, and a host can skip reconcile there', async () => {
  const flight = deferred(); const phases = []; const asked = [];
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const flow = createWorkflowExtension({
    options: ({ phase }) => { phases.push(phase); return { files, reconcile: async (unknown) => { asked.push([phase, unknown.length]); } }; },
    run: () => ({ adapters: { runEffect: ({ signal }) => { flight.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } } }),
  });
  const harness = await open(fileOf(), flow);
  const run = await flow.start(harness, request(), ctx);
  await flight.promise;
  await flow.stop(harness, 'run-1', 'cancel', ctx, 'owner');
  await run.wait(ctx);
  assert.deepEqual(phases, ['run', 'abort']);
  // The effect the cancel cut is unknown when the abort handler opens the driver, so reconcile is asked there, and only there.
  assert.deepEqual(asked, [['abort', 1]]);
  await harness.close(ctx);
});
