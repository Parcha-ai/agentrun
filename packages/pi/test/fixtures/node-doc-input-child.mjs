// One process over one SQLite file: the node runner runs one attempt of one node, with a scripted model that counts its
// requests in a file the test reads. `older` plays a build from before the node's configuration document carried its
// input: its host takes `input` off the document in the commit that writes it, so the stored document holds what that
// build wrote, and the process kills itself inside the model request. `resume` opens the file with this build, lets
// pi resume the request, and reaches the node after a pause, as a workflow that resumes reaches its nodes after pi.
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { hostScope, NodeDoc, nodeRunner, RecordDoc } from '@parcha/agentrun-pi/durable';

const [mode, file, counter] = process.argv.slice(2);
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const say = (row) => console.log(JSON.stringify(row));

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 4 }, () => () => {
  appendFileSync(counter, 'request\n');
  say({ event: 'request' });
  if (mode === 'older') { process.kill(process.pid, 'SIGKILL'); for (;;); }
  return fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' });
}));
const models = createModels();
models.setProvider(faux.provider);
let conversation;
const nodes = nodeRunner({
  agent: () => ({ model: { provider: 'faux', modelId: 'faux-1' } }),
  init: mode === 'older' ? async (_node, tx, id) => { delete (await tx.doc(NodeDoc, id)).input; } : undefined,
  onNodeOpen: async (node) => {
    conversation = node.conversationId;
    say({ event: 'open', conversation: Number(node.conversationId), resumed: node.resumed, doc: (await harness.snapshot(NodeDoc, node.conversationId, ctx)) ?? null });
  },
});
const registry = createRegistry();
registry.install(nodes.extension);

const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
if (mode === 'resume') { harness.resume(); await sleep(400); say({ event: 'reached' }); }
const record = await nodes.on(hostScope(harness), ctx).runNode({
  kind: 'decide', label: 'Verdict', executionPath: '/root/steps/0', system: ['Decide buy or pass.'], user: '{"claim":"x"}', schema: SCHEMA,
  step: { sessionId: 'run-1:step:/root/steps/0:a0', attempt: 0, earlierSessionIds: [] },
});
say({ event: 'end', record, doc: (await harness.snapshot(NodeDoc, conversation, ctx)) ?? null, stored: (await harness.snapshot(RecordDoc, conversation, ctx)) ?? null });
await harness.close(ctx);
