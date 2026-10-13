// A node an older build opened, resumed by this runner. `legacy` opens the node as that build did: an anchor task in
// a plan conversation owns the node's conversation and submits its request; the conversation selects a per-node
// extension (its own `task` section and `submit`) by name; the index entry keeps that extension's name and the system
// text beside the conversation. It kills itself at KILL_AT (`after-conversation`, `mid-model`). `resume` installs
// the runner's extension and, for the older build's node, the runner's stand-in under that build's extension name
// (LEGACY=none leaves it out), lets pi resume, and reaches the node later. A scripted model counts its requests in a
// file the test reads.
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { configure, createRegistry, defineExtension, defineTask, Harness, section } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { hostScope, NodeIndex } from '../../dist/durable/node.js';
import { nodeRunner } from '../../dist/durable/node-runner.js';
import { RecordDoc, recordTool } from '../../dist/durable/record-tool.js';

const [mode, file, counter] = process.argv.slice(2);
const MODEL = { provider: 'faux', modelId: 'faux-1' };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const SESSION = 'run-1:step:/root/steps/0:a0';
const OLD = { extension: 'node-session:7f3a', system: 'Decide buy or pass.\n\nThe stance the older build wrote.' };
const say = (row) => console.log(JSON.stringify(row));
const dieAt = (point) => { if (process.env.KILL_AT === point) { process.kill(process.pid, 'SIGKILL'); for (;;); } };

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 8 }, () => (context) => {
  appendFileSync(counter, 'request\n');
  const system = context.messages.filter((message) => message.role === 'system');
  say({ event: 'request', sections: system.at(-1)?.sections ?? null, submit: context.messages.flatMap((message) => message.toolsAdded ?? []).filter((tool) => tool.name === 'submit').at(-1)?.description });
  dieAt('mid-model');
  return fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' });
}));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
let harness;

if (mode === 'legacy') {
  const Anchor = defineTask({
    name: 'older.node-anchor', version: 1, initial: () => ({ phase: 'run' }),
    phases: { run: async (task, runtime, context) => {
      let child;
      await runtime.commit(async (tx) => { child = (await tx.scanConversations({ ownerTaskId: runtime.taskId }, 1)).items[0]?.id; return undefined; }, context);
      const submission = await (await runtime.conversation(child, context)).submit({ type: 'input', content: task.input.user, requestId: `node:${task.input.session}` }, context);
      await submission.wait(context);
      await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'completed', result: {} } }), context);
    } },
    abort: async (_task, runtime, context) => { await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'aborted' } }), context); },
  });
  const own = defineExtension({ name: OLD.extension, tools: [recordTool({ record: { schema: SCHEMA, label: 'the Verdict record' }, contract: () => ({ schema: SCHEMA }) })], sections: [section('task', () => OLD.system, { tag: false })] });
  registry.install(defineExtension({ name: 'older-run', tasks: [Anchor] }));
  registry.install(own);
  harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
  const opened = await harness.commit(async (tx) => {
    const plan = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    const anchor = await tx.createTask(Anchor, { session: SESSION, user: '{"claim":"x"}' }, { ownership: { kind: 'conversation' }, conversationId: plan.id });
    const conversation = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
    await configure(tx, conversation.id, { model: MODEL, extensions: [own] });
    Object.assign(await tx.doc(NodeIndex, SESSION, null), { anchor: Number(anchor), conversation: Number(conversation.id), digest: 'binding-1', startedMs: Date.now(),
      extension: OLD.extension, tools: ['submit'], safe: ['submit'], system: OLD.system, done: false, closed: false });
    return { anchor, conversation: conversation.id };
  }, ctx);
  say({ event: 'legacy-open', conversation: Number(opened.conversation) });
  dieAt('after-conversation');
  await harness.waitForTask(opened.anchor, ctx);
  say({ event: 'legacy-end' });
} else {
  let conversation;
  const nodes = nodeRunner({
    agent: () => ({ model: MODEL }), digest: () => 'binding-1',
    onNodeOpen: (node) => { conversation = node.conversationId; say({ event: 'open', conversation: Number(node.conversationId), resumed: node.resumed }); },
  });
  registry.install(nodes.extension);
  harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
  // Before pi resumes: each node the older build left unfinished gets its extension back under that build's name.
  if (process.env.LEGACY !== 'none') {
    const entry = await harness.snapshot(NodeIndex, SESSION, ctx);
    registry.install(nodes.legacy({ extension: entry.extension, system: entry.system }));
  }
  harness.resume();
  await sleep(400);
  say({ event: 'reached' });
  const record = await nodes.on(hostScope(harness), ctx).runNode({
    kind: 'decide', label: 'Verdict', executionPath: '/root/steps/0', system: ['Decide buy or pass.'], user: '{"claim":"x"}', schema: SCHEMA,
    step: { sessionId: SESSION, attempt: 0, earlierSessionIds: [] },
  });
  say({ event: 'end', record, stored: (await harness.snapshot(RecordDoc, conversation, ctx)) ?? null });
}
await harness.close(ctx);
