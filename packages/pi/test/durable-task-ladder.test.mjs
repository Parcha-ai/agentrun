// The host's ladder inside the workflow task: a run that did not complete continues in the task's invocation, so the
// continuation is a conversation the task owns and the run's stops reach it; a run reopened after its escalation commit
// goes back to the ladder with the same row; a refusal never ladders.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { recoveryBound, workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension, documentStore } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-durable-ladder-'));
after(() => rmSync(root, { recursive: true, force: true }));

const WORKFLOW = {
  v: 2, name: 'ladder',
  schemas: { Quote: { type: 'object', required: ['price'], properties: { price: { type: 'number' } } }, Out: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } },
  output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'quote', via: 'tool', tool: 'prices.quote', args: { sku: '{sku}' }, out: 'Quote', as: 'quote', deadline_s: 20 },
    { node: 'code', label: 'total', code: 's => { throw new Error("the total cannot be computed") }' },
  ] },
};
const request = { key: 'run-1', workflow: WORKFLOW, input: { sku: 'A-1' } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const fileOf = () => join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
const aborted = (signal) => new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
/** The row a host commits: the escalation's own fields and the host's. */
const rowOf = (ending) => ({ kind: ending.row?.kind ?? 'failure', stage: 'total', summary: String(ending.error?.message ?? ending.row?.summary ?? 'escalated'), state: ending.state,
  workflow_sha_used: 'sha-w', pin_sha256: 'sha-w', step_label: 'total', step_exec_id: null, cost_usd: 0, turns: 0, effect_calls: 1, evidence_dir: 'evidence' });

/** A host whose ladder is `tail`; effects are counted. */
function hostOf(tail, counts = { effects: 0, endings: [] }) {
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  return { counts, host: {
    run: () => ({ adapters: { runEffect: async () => { counts.effects += 1; return { price: 21 }; } }, options: { files } }),
    escalated: async (ending, invocation) => {
      counts.endings.push(Object.keys(ending).filter((key) => key !== 'state').sort().join(','));
      const row = await invocation.driver.escalate(rowOf(ending));
      // The continuation's conversation is owned by the workflow task.
      let conversation;
      await invocation.runtime.commit(async (tx) => { conversation = (await tx.createConversation({ ownership: { kind: 'task', taskId: invocation.taskId } })).id; return undefined; }, invocation.context);
      return tail({ row, conversation, invocation });
    },
  } };
}
async function open(file, flow) {
  const registry = createRegistry();
  registry.install(flow.extension);
  return Harness.open(await openNodeSqliteStorage(file), { registry, models: {} }, ctx);
}
const owned = (harness, taskId) => harness.commit(async (tx) => (await tx.scanConversations({ ownerTaskId: taskId }, 10)).items.map((c) => Number(c.id)), ctx);
async function journalOf(harness) {
  const journal = await documentStore(harness, 'run-1').open(recoveryBound(WORKFLOW));
  try { return { status: journal.state?.status, escalation: journal.state?.escalation?.tail ?? null, notes: journal.notes().map((n) => n.kind) }; }
  finally { await journal.close(); }
}

test('a failure that is not a refusal continues on the host\'s ladder inside the task: the row is committed, the continuation is the task\'s, and a later start returns it', async () => {
  const { host, counts } = hostOf(async ({ row, conversation }) => ({ tail: row.tail, conversation: Number(conversation) }));
  const flow = createWorkflowExtension(host);
  const harness = await open(fileOf(), flow);
  const run = await flow.start(harness, request, ctx);
  const outcome = await run.wait(ctx);
  assert.equal(outcome.status, 'escalated');
  assert.deepEqual([outcome.escalation.kind, outcome.escalation.tail.startsWith('run-1:escalated:'), outcome.escalation.revision > 0], ['failure', true, true]);
  assert.match(outcome.escalation.summary, /the total cannot be computed/);
  assert.deepEqual([outcome.continuation.tail, outcome.state.quote, counts.effects, counts.endings], [outcome.escalation.tail, { price: 21 }, 1, ['error']]);
  assert.deepEqual(await owned(harness, run.taskId), [outcome.continuation.conversation]);
  assert.deepEqual(await journalOf(harness), { status: 'running', escalation: outcome.escalation.tail, notes: ['escalation'] });
  const again = await flow.start(harness, request, ctx);
  assert.deepEqual([again.started, await again.wait(ctx), counts.endings.length], ['settled', outcome, 1]);
  await harness.close(ctx);
});

test('a cancel during the continuation ends it through the task: its signal fires, the task ends cancelled, the escalation row stays', async () => {
  const entered = deferred(); let cut = false;
  const { host } = hostOf(async ({ invocation }) => { entered.resolve(); await aborted(invocation.signal); cut = true; throw invocation.signal.reason; });
  const flow = createWorkflowExtension(host);
  const harness = await open(fileOf(), flow);
  const run = await flow.start(harness, request, ctx);
  await entered.promise;
  assert.equal(await flow.stop(harness, 'run-1', 'cancel', ctx, 'owner'), 'marked');
  assert.deepEqual(await run.wait(ctx), { status: 'stopped', stop: 'cancelled', source: 'owner' });
  assert.equal(cut, true);
  const journal = await journalOf(harness);
  assert.deepEqual([journal.status, journal.notes], ['cancelled', ['escalation']]);
  await harness.close(ctx);
});

test('a run reopened after its escalation commit goes back to the ladder with the same row, and the interpreter does not run again', async () => {
  const file = fileOf(); const entered = deferred(); let committed;
  const first = hostOf(async ({ row, invocation }) => { committed = row.tail; entered.resolve(); await aborted(invocation.signal); throw invocation.signal.reason; });
  let flow = createWorkflowExtension(first.host);
  let harness = await open(file, flow);
  const run = await flow.start(harness, request, ctx);
  await entered.promise;
  // The process ends while the continuation runs, after the escalation commit.
  await harness.close(ctx);
  const second = hostOf(async ({ row }) => ({ continued: row.tail }), first.counts);
  flow = createWorkflowExtension(second.host);
  harness = await open(file, flow);
  harness.resume();
  const settled = await harness.waitForTask(run.taskId, ctx);
  const outcome = settled.state.outcome.result;
  assert.deepEqual([settled.state.outcome.status, outcome.status, outcome.continuation, first.counts.effects, first.counts.endings],
    ['completed', 'escalated', { continued: committed }, 1, ['error', 'row']]);
  assert.deepEqual((await journalOf(harness)).notes, ['escalation']);
  await harness.close(ctx);
});

test('a pause during the continuation leaves the task pending; the next process goes back to the ladder with the row', async () => {
  const file = fileOf(); const entered = deferred(); let committed;
  const first = hostOf(async ({ row, invocation }) => { committed = row.tail; entered.resolve(); await aborted(invocation.signal); throw invocation.signal.reason; });
  let flow = createWorkflowExtension(first.host);
  let harness = await open(file, flow);
  const run = await flow.start(harness, request, ctx);
  await entered.promise;
  assert.equal(await flow.stop(harness, 'run-1', 'pause', ctx, 'operator'), 'paused');
  assert.equal((await harness.getTask(run.taskId, ctx)).state.status, 'running');
  await harness.close(ctx);
  const second = hostOf(async ({ row }) => ({ continued: row.tail }), first.counts);
  flow = createWorkflowExtension(second.host);
  harness = await open(file, flow);
  assert.deepEqual([(await harness.getTask(run.taskId, ctx)).state.status, (await journalOf(harness)).status], ['pending', 'paused']);
  harness.resume();
  const settled = await harness.waitForTask(run.taskId, ctx);
  assert.deepEqual([settled.state.outcome.result.continuation, first.counts.endings], [{ continued: committed }, ['error', 'row']]);
  await harness.close(ctx);
});

test('a refusal never ladders: a run whose effect is unknown fails with its code and the host\'s ladder is not called', async () => {
  const counts = { effects: 0, endings: [] };
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const flow = createWorkflowExtension({
    run: () => ({ adapters: { runEffect: async () => { counts.effects += 1; throw new Error('connection reset'); } }, options: { files } }),
    escalated: async (ending) => { counts.endings.push(Object.keys(ending).sort().join(',')); throw new Error('not reached'); },
  });
  const harness = await open(fileOf(), flow);
  // The first run's failure is the adapter's, not a refusal: it ladders, and this host's ladder throws, so it fails.
  const first = await (await flow.start(harness, request, ctx)).wait(ctx);
  assert.deepEqual([first.status, first.message], ['refused', 'not reached']);
  // The next run finds the effect unknown: a refusal, which never reaches the ladder.
  const second = await (await flow.start(harness, request, ctx)).wait(ctx);
  assert.deepEqual([second.status, second.code, counts.effects, counts.endings], ['refused', 'FROZEN_EFFECT_UNKNOWN', 1, ['error,state']]);
  await harness.close(ctx);
});

test('a refusal that leaves the driver able to commit (a moved input) does not ladder either', async () => {
  const file = fileOf(); const endings = [];
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const run = () => ({ adapters: { runEffect: async () => ({ price: 21 }) }, options: { files } });
  // The first process has no ladder: its failure at `total` is the run's, and the journal holds the run's input.
  let flow = createWorkflowExtension({ run });
  let harness = await open(file, flow);
  assert.equal((await (await flow.start(harness, request, ctx)).wait(ctx)).status, 'refused');
  await harness.close(ctx);
  // The next start brings another input under the same key: the driver refuses it, and the ladder is not asked.
  flow = createWorkflowExtension({ run, escalated: async (ending) => { endings.push(Object.keys(ending).sort().join(',')); return null; } });
  harness = await open(file, flow);
  const moved = await (await flow.start(harness, { ...request, input: { sku: 'B-2' } }, ctx)).wait(ctx);
  assert.deepEqual([moved.status, moved.code, endings], ['refused', 'FROZEN_INPUT_CHANGED', []]);
  await harness.close(ctx);
});
