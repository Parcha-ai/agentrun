// A run on a durable disk that is fenced while a step's attempt is out. `fenced` is not final, so the recovery driver
// admits the step's next attempt in this stale process. Its flush before the attempt commits through the run's Harness
// over the claim's observed storage, so it is refused with the fence; the driver's seam after it would stop the attempt
// too. The node runner must not be called again once a store commit failed as an I/O error and fenced the run.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry } from '@earendil-works/pi-durable';
import { FencedError, openClaimDir, openDurableRun } from '@parcha/pi-durable-disk';
import { createWorkflowExtension } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-fenced-flush-'));
after(() => rmSync(root, { recursive: true, force: true }));

const WORKFLOW = {
  v: 2, name: 'fenced-flush',
  schemas: { Verdict: { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string', enum: ['buy', 'pass'] } } } },
  output: { schemaId: 'Verdict', path: 'decision' },
  root: { node: 'decide', label: 'verdict', instructions: 'Decide buy or pass.', out: 'Verdict', as: 'decision' },
};

const within = (promise, ms, what) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
const until = async (check, ms, what) => {
  for (const end = Date.now() + ms; !check();) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const fencedBy = (error) => {
  for (let at = error; at; at = at.cause) if (at instanceof FencedError) return true;
  return false;
};

// A claim over a local directory that records the fence and nothing else, as the disk package's own tests take one.
const claimOf = (directory) => (ref) => {
  let fence;
  return {
    ref, disk: ref.disk, root: directory, work: join(directory, 'work'), store: join(directory, 'store'),
   
    get fenced() { return fence !== undefined; },
    markFenced(cause) { fence ??= { cause }; },
    async barrier() { if (fence) throw new Error('fenced', { cause: fence.cause }); return { ms: 0 }; },
    async release() { return { via: 'none' }; },
  };
};

/** An error shaped like node:sqlite's for a commit whose fsync failed (SQLITE_IOERR_FSYNC). */
const fsyncFailed = () => Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 1034, errstr: 'disk I/O error' });

/**
 * One run whose single step fails its first attempt after `fence(state)` armed a failing store: every commit from then on
 * runs and then fails before COMMIT, as one whose fsync failed. Returns what the flushes, the runner and the wait saw.
 */
async function runFenced({ fence }) {
  const directory = mkdtempSync(join(root, 'run-'));
  const state = { failing: false, fenced: [] };
  const decorateStore = (database) => new Proxy(database, {
    get(target, key) {
      if (key === 'transaction') return (callback) => (state.failing ? target.transaction(async (tx) => { await callback(tx); throw fsyncFailed(); }) : target.transaction(callback));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const flushes = [];
  let runs = 0;
  const runNode = async () => {
    runs += 1;
    if (runs > 1) return { verdict: 'buy' };
    await fence(state);
    throw new Error('the first attempt failed');
  };
  const flow = createWorkflowExtension({
    run: ({ driver }) => {
      // Each flush before an attempt, as it settled: the step's record must be durable before the attempt runs.
      const flush = driver.flush.bind(driver);
      driver.flush = async () => {
        try { await flush(); flushes.push('ok'); } catch (error) { flushes.push(error); throw error; }
      };
      return { adapters: { runNode }, durableNodes: true };
    },
  });
  const registry = createRegistry();
  registry.install(flow.extension);
  const run = await openDurableRun({ disk: 'dsk-local', region: 'local', id: 'run-1' }, {
    acquire: async ({ ref }) => claimOf(directory)(ref), claimDir: (at) => openClaimDir(at),
    harness: { registry, models: createModels() }, decorateStore,
    onFenced: (error) => { state.fenced.push(error); },
  });
  let settled;
  try {
    const task = await flow.start(run.harness, { key: 'run-1', workflow: WORKFLOW, input: {} }, ctx);
    settled = await within(task.wait(ctx).then((outcome) => ({ outcome }), (error) => ({ error })), 20000, 'the run\'s wait');
  } finally {
    await within(run.release().catch(() => undefined), 20000, 'the release');
    await within(run.harness.close(ctx).catch(() => undefined), 20000, 'the close');
  }
  return { runs, flushes, settled, fenced: state.fenced };
}

// The fence carries its cause: the store's commit failing as an I/O error.
const failedStoreCommit = (e) => {
  for (let at = e; at; at = at.cause) if (at.errcode === 1034) return e instanceof FencedError;
  return false;
};
const carries = (error, fence) => {
  for (let at = error; at; at = at.cause) if (at === fence) return true;
  return false;
};
const described = (e) => (e ? `${e.name} ${e.code ?? ''}${e.by ? ` by ${e.by}` : ''}: ${e.message}` : String(e));

function refusedByTheFence(label, { runs, flushes, settled, fenced }, cause) {
  assert.equal(fenced.length, 1, `${label}: the run was fenced once`);
  assert.ok(cause.test(fenced[0]), `${label}: the run was fenced by ${cause.name}, got ${described(fenced[0])}`);
  assert.equal(flushes[0], 'ok', `${label}: the flush before the first attempt committed`);
  assert.equal(flushes.length, 2, `${label}: the driver flushed before the second attempt, saw ${flushes.length} flushes`);
  assert.ok(fencedBy(flushes[1]), `${label}: the flush before the second attempt is refused with the fence, got ${flushes[1] === 'ok' ? 'a commit' : `${flushes[1]?.name}: ${flushes[1]?.message}`}`);
  assert.ok(carries(flushes[1], fenced[0]), `${label}: the flush is refused with the fence the run recorded, got ${described(flushes[1])}`);
  assert.equal(runs, 1, `${label}: the node runner is not called for the second attempt`);
  assert.notEqual(settled.outcome?.status, 'complete', `${label}: the stale process does not complete the run`);
}

test('a step\'s next attempt after a store commit failed and fenced the run: the flush before it is refused with the fence, and the runner is not called', { timeout: 60000 }, async () => {
  const seen = await runFenced({
    fence: async (state) => {
      state.failing = true;
    },
  });
  refusedByTheFence('store', seen, { name: 'a failed store commit', test: failedStoreCommit });
});
