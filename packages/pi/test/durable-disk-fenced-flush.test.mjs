// A run on a durable disk whose lease is fenced while a step's attempt is out. `fenced` is not final, so the recovery
// driver admits the step's next attempt in this stale process. Its flush before the attempt commits through the run's
// Harness over the lease's observed storage, so it is refused with the fence; the driver's seam after it would stop the
// attempt too. The node runner must not be called again: whether the lease was fenced by a failed heartbeat write, or
// lapsed while the process was stuck.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
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
    reused: false, forced: false, timings: { mountMs: 0, verifyMs: 0 },
    get fenced() { return fence !== undefined; },
    markFenced(cause) { fence ??= { cause }; },
    async barrier() { if (fence) throw new Error('fenced', { cause: fence.cause }); return { ms: 0 }; },
    async release() { return { via: 'archil' }; },
  };
};

/**
 * One run whose single step fails its first attempt after `fence(state)` fenced the lease, or made it lapse. `lease`
 * goes to the disk package. Returns what the flushes, the runner and the wait saw.
 */
async function runFenced({ lease, fence }) {
  const directory = mkdtempSync(join(root, 'run-'));
  const state = { failing: false, fenced: [] };
  // run.json as the disk package writes it, and an I/O error once `failing` is set: a failed heartbeat write is a fence.
  const persist = async (at, text, signal) => {
    if (state.failing) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    await writeFile(join(at, 'run.json.tmp'), text);
    signal?.throwIfAborted();
    await rename(join(at, 'run.json.tmp'), join(at, 'run.json'));
  };
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
    mountToken: 'unused', acquire: async ({ ref }) => claimOf(directory)(ref), claimDir: (at) => openClaimDir(at, { fstype: null }),
    harness: { registry, models: {} }, persist, lease,
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

function refusedByTheFence(label, { runs, flushes, settled, fenced }) {
  assert.equal(fenced.length, 1, `${label}: the lease was fenced once`);
  assert.equal(flushes[0], 'ok', `${label}: the flush before the first attempt committed`);
  assert.equal(flushes.length, 2, `${label}: the driver flushed before the second attempt, saw ${flushes.length} flushes`);
  assert.ok(fencedBy(flushes[1]), `${label}: the flush before the second attempt is refused with the fence, got ${flushes[1] === 'ok' ? 'a commit' : `${flushes[1]?.name}: ${flushes[1]?.message}`}`);
  assert.equal(runs, 1, `${label}: the node runner is not called for the second attempt`);
  assert.notEqual(settled.outcome?.status, 'complete', `${label}: the stale process does not complete the run`);
}

test('a step\'s next attempt after its lease was fenced by a failed heartbeat write: the flush before it is refused with the fence, and the runner is not called', { timeout: 60000 }, async () => {
  const seen = await runFenced({
    lease: { heartbeatMs: 20, expiryMs: 60_000, marginMs: 1_000, checkMs: 10 },
    fence: async (state) => {
      state.failing = true;
      await until(() => state.fenced.length === 1, 10000, 'the heartbeat fence');
    },
  });
  refusedByTheFence('heartbeat', seen);
  assert.match(seen.fenced[0].message, /run\.json/);
});

test('a step\'s next attempt after its lease lapsed while the process was stuck: the flush before it is refused with the fence, and the runner is not called', { timeout: 60000 }, async () => {
  // The first attempt holds this thread past the lease, as a FUSE request that never answers does: no heartbeat and no
  // self-fence timer runs meanwhile, and the watchdog thread records the lapse. The lease finds it at its next check or
  // at the flush's commit, whichever runs first: either fences, and the flush is refused.
  const seen = await runFenced({
    lease: { heartbeatMs: 100, expiryMs: 3_000, marginMs: 1_000, checkMs: 50 },
    fence: async () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4_500); },
  });
  refusedByTheFence('watchdog', seen);
});
