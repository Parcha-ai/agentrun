// A storage failure at any point of a workflow run, on the pi-durable these tests run on: at each commit (before the
// write lands, and after it landed with the call still failing) and at each read. The run's waiters settle within a
// bound: with the run's outcome, a refusal that names the storage failure, or the storage failure itself, never with
// `SessionFailed`. A later process on a healthy storage ends the run, and the run's effect is dispatched at most once
// across both.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-storage-failure-'));
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
const request = { key: 'run-1', workflow: WORKFLOW, input: { sku: 'A-1' } };
const INJECTED = 'injected storage failure';
/** `promise`, or a rejection when it has not settled in `ms`: a wait that hangs fails its case instead of the file. */
const within = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle in ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer)); };

/** The Storage's writing and non-reading methods; every other method is a read. */
const NOT_READS = new Set(['commit', 'mintId', 'close']);
/** `storage` with the failure `plan` names, armed by `arm()`: the `at`th commit (thrown before the write, or after it
 *  landed when `landed`), or the `at`th read, throws. Counts every call once armed. */
function failing(storage, plan) {
  const seen = { commits: 0, reads: 0 };
  let armed = false;
  const injected = () => Object.assign(new Error(INJECTED), { code: 'ERR_INJECTED' });
  const proxy = new Proxy(storage, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (key === 'commit') return async (...args) => {
        if (!armed) return value.apply(target, args);
        seen.commits += 1;
        if (plan?.kind !== 'commit' || plan.at !== seen.commits) return value.apply(target, args);
        if (plan.landed) await value.apply(target, args);
        throw injected();
      };
      if (NOT_READS.has(key)) return value.bind(target);
      return async (...args) => {
        if (!armed) return value.apply(target, args);
        seen.reads += 1;
        if (plan?.kind === 'read' && plan.at === seen.reads) throw injected();
        return value.apply(target, args);
      };
    },
  });
  return { storage: proxy, seen, arm: () => { armed = true; } };
}

/** The storage's failure, or an error that names it as its cause (pi 1.1 refuses later commits on a poisoned Session). */
const isStorageFailure = (error) => {
  for (let at = error, depth = 0; at && depth < 8; at = at.cause, depth += 1) if (at.message === INJECTED) return true;
  return false;
};

async function open(storage, flow) {
  const registry = createRegistry();
  registry.install(flow.extension);
  return Harness.open(storage, { registry, models: {} }, ctx);
}

/** One run in a process whose storage fails as `plan` says, then the same run in a later process on a healthy storage. */
async function runCase(plan) {
  const file = join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
  let calls = 0;
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const flow = createWorkflowExtension({ options: () => ({ files }), run: () => ({ adapters: { runEffect: async () => { calls += 1; return { price: 21 }; } } }) });
  const failed = failing(await openNodeSqliteStorage(file), plan);
  const harness = await open(failed.storage, flow);
  failed.arm();
  let first;
  try { first = { outcome: await within((await flow.start(harness, request, ctx)).wait(ctx), 10000, 'the first wait') }; }
  catch (error) { first = { error }; }
  await within(harness.close(ctx).catch(() => undefined), 10000, 'the first close');
  const later = await open(await openNodeSqliteStorage(file), flow);
  try {
    const outcome = await within((await flow.start(later, request, ctx)).wait(ctx), 10000, 'the later wait');
    return { first, outcome, calls, seen: failed.seen };
  } finally { await later.close(ctx); }
}

/** What every case holds, whatever the failure hit. */
function holds(label, { first, outcome, calls }) {
  if (first.error) {
    assert.notEqual(first.error.name, 'SessionFailed', `${label}: a waiter never gets SessionFailed itself`);
    assert.ok(isStorageFailure(first.error), `${label}: the first process fails with the storage's failure, got ${first.error.name}: ${first.error.message}`);
  } else if (first.outcome.status === 'refused') {
    // A failure that left the Session usable (a read on pi 1.1) is the run's own: its outcome is committed and names it.
    assert.deepEqual([first.outcome.code, first.outcome.message], ['ERR_INJECTED', INJECTED], `${label}: a refused run names the storage failure`);
  } else {
    assert.deepEqual([first.outcome.status, first.outcome.output], ['complete', { total: 42 }], `${label}: a run the failure did not stop completes`);
  }
  assert.ok(calls <= 1, `${label}: the effect is dispatched at most once, was ${calls}`);
  if (outcome.status === 'complete') {
    assert.deepEqual([outcome.output, calls], [{ total: 42 }, 1], `${label}: a completed run has its output and one dispatch`);
  } else {
    assert.deepEqual([outcome.status, outcome.code], ['refused', 'FROZEN_EFFECT_UNKNOWN'], `${label}: a run that does not complete refuses an effect whose outcome is unknown, got ${JSON.stringify(outcome)}`);
  }
}

test('a storage failure at any commit of a run, before or after its write lands, ends the run with the storage failure or its outcome, and never dispatches twice', { timeout: 300000 }, async () => {
  const healthy = await runCase(undefined);
  holds('no failure', healthy);
  assert.equal(healthy.outcome.status, 'complete');
  const commits = healthy.seen.commits;
  assert.ok(commits >= 3, `a run commits its start, its effect and its end, counted ${commits}`);
  for (let at = 1; at <= commits; at += 1) {
    for (const landed of [false, true]) holds(`commit ${at} of ${commits}${landed ? ', after it landed' : ''}`, await runCase({ kind: 'commit', at, landed }));
  }
});

test('a storage failure at any read of a run ends the run with the storage failure or its outcome, and never dispatches twice', { timeout: 300000 }, async () => {
  const reads = (await runCase(undefined)).seen.reads;
  assert.ok(reads >= 3, `a run reads its entry, its journal and its task, counted ${reads}`);
  for (let at = 1; at <= reads; at += 1) holds(`read ${at} of ${reads}`, await runCase({ kind: 'read', at }));
});
