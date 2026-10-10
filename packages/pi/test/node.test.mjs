// The node runner's kernel on the in-memory storage: one attempt is one conversation, found again by its session id.
// A scripted model counts its requests, so "found again" means no request the second time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { hostScope, NodeBindingMismatch, NodeIndex, runNodeAttempt, taskScope } from '../dist/durable/node.js';
import { RecordDoc, recordTool } from '../dist/durable/record-tool.js';

const MODEL = { provider: 'faux', modelId: 'faux-1' };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const submit = (args) => fauxAssistantMessage([fauxToolCall('submit', args)], { stopReason: 'toolUse' });
const NoteDoc = defineDoc({ kind: 'node-test.note', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ label: '' }) });

/** A Harness with the `submit` tool installed and a scripted model; `tasks` are installed beside it. */
async function open(turns, { tasks = [], maxAttempts } = {}) {
  const requests = [];
  const faux = fauxProvider();
  faux.setResponses(turns.map((turn) => (context) => { requests.push(context); return turn; }));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'node-test', tasks, tools: [recordTool({ schema: SCHEMA, label: 'the verdict record', contract: () => ({ schema: SCHEMA, ...(maxAttempts ? { maxAttempts } : {}) }) })] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  return { harness, requests };
}
const attempt = (extra = {}) => ({ session: 'run-1:verdict:/root/steps/2:a0', digest: 'binding-1', agent: { model: MODEL }, user: 'Decide buy or pass.', ...extra });

test('an attempt creates its conversation once, runs it, and returns the record its submit committed', async () => {
  const { harness, requests } = await open([submit({ verdict: 'buy' })]);
  const opened = [];
  const outcome = await runNodeAttempt(hostScope(harness), attempt({
    init: async (tx, conversationId) => { (await tx.doc(NoteDoc, conversationId)).label = 'verdict'; },
    onOpen: (at) => { opened.push(at.resumed); },
  }), ctx);
  assert.deepEqual(outcome.delivered, { record: { verdict: 'buy' }, disagreements: [] });
  assert.deepEqual(outcome.settled, { status: 'done' });
  assert.equal(outcome.resumed, false);
  assert.deepEqual(opened, [false], 'the host is told before the request');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].messages.filter((m) => m.role === 'user').map((m) => m.content), ['Decide buy or pass.']);
  const entry = await harness.snapshot(NodeIndex, attempt().session, ctx);
  assert.equal(entry.conversation, Number(outcome.conversationId));
  assert.equal(entry.digest, 'binding-1');
  assert.equal(typeof entry.startedMs, 'number');
  assert.deepEqual(await harness.snapshot(NoteDoc, outcome.conversationId, ctx), { label: 'verdict' }, 'what init writes is in the commit that creates the conversation');
  assert.equal((await harness.commit((tx) => tx.conversation(outcome.conversationId), ctx)).owner, undefined, 'driven by the host, owned by no task');
  await harness.close(ctx);
});

test('the same session id finds the same conversation: a delivered record is returned with no request', async () => {
  const { harness, requests } = await open([submit({ verdict: 'buy' }), submit({ verdict: 'never asked' })]);
  const first = await runNodeAttempt(hostScope(harness), attempt(), ctx);
  const opened = [];
  const again = await runNodeAttempt(hostScope(harness), attempt({ onOpen: (at) => { opened.push(at.resumed); }, init: () => { throw new Error('init runs only with the creation'); } }), ctx);
  assert.equal(again.conversationId, first.conversationId);
  assert.equal(again.resumed, true);
  assert.deepEqual(opened, [true]);
  assert.deepEqual(again.delivered, { record: { verdict: 'buy' }, disagreements: [] });
  assert.equal(again.settled, undefined, 'no submission was waited on');
  assert.equal(requests.length, 1);
  await harness.close(ctx);
});

test('another session id is another conversation', async () => {
  const { harness, requests } = await open([submit({ verdict: 'buy' }), submit({ verdict: 'pass' })]);
  const first = await runNodeAttempt(hostScope(harness), attempt(), ctx);
  const second = await runNodeAttempt(hostScope(harness), attempt({ session: 'run-1:verdict:/root/steps/2:a1' }), ctx);
  assert.notEqual(second.conversationId, first.conversationId);
  assert.deepEqual([first.delivered.record, second.delivered.record], [{ verdict: 'buy' }, { verdict: 'pass' }]);
  assert.equal(requests.length, 2);
  await harness.close(ctx);
});

test('an attempt found under another binding is refused and makes no request', async () => {
  const { harness, requests } = await open([submit({ verdict: 'buy' }), submit({ verdict: 'never asked' })]);
  await runNodeAttempt(hostScope(harness), attempt(), ctx);
  await assert.rejects(runNodeAttempt(hostScope(harness), attempt({ digest: 'binding-2' }), ctx),
    (error) => error instanceof NodeBindingMismatch && error.code === 'NODE_BINDING_MISMATCH' && error.stored === 'binding-1' && error.asked === 'binding-2');
  assert.equal(requests.length, 1);
  assert.equal((await harness.snapshot(NodeIndex, attempt().session, ctx)).digest, 'binding-1', 'the entry stays as its own binding left it');
  await harness.close(ctx);
});

test('an attempt that ends without a record says how it ended and delivers nothing', async () => {
  const { harness } = await open([submit({ nope: 1 }), submit({ nope: 2 }), submit({ verdict: 'never asked' })], { maxAttempts: 2 });
  const outcome = await runNodeAttempt(hostScope(harness), attempt(), ctx);
  assert.equal(outcome.delivered, undefined);
  assert.deepEqual(outcome.settled, { status: 'done' });
  assert.deepEqual(await harness.snapshot(RecordDoc, outcome.conversationId, ctx), { record: null, attempts: 2 });
  await harness.close(ctx);
});

test('under a task, the task owns the node\'s conversation', async () => {
  const Owner = defineTask({
    name: 'node-test.owner', version: 1, initial: () => ({ phase: 'run' }),
    phases: { run: async (_task, runtime, context) => {
      const outcome = await runNodeAttempt(taskScope(runtime), attempt(), context);
      await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'completed', result: { conversation: Number(outcome.conversationId), record: outcome.delivered?.record ?? null } } }), context);
    } },
    abort: async (_task, runtime, context) => { await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'aborted' } }), context); },
  });
  const { harness, requests } = await open([submit({ verdict: 'buy' })], { tasks: [Owner] });
  const root = await harness.root(ctx, { agent: { model: MODEL } });
  const task = await root.commit((tx) => tx.createTask(Owner, {}, { ownership: { kind: 'conversation' } }), ctx);
  const settled = await harness.waitForTask(task, ctx);
  assert.deepEqual(settled.state.outcome.status, 'completed');
  const { conversation, record } = settled.state.outcome.result;
  assert.deepEqual(record, { verdict: 'buy' });
  assert.equal((await harness.commit((tx) => tx.conversation(conversation), ctx)).owner.taskId, task, 'the node\'s conversation names the task as its owner');
  assert.equal(requests.length, 1);
  await harness.close(ctx);
});
