// One process over one SQLite file: the node runner runs one attempt of one node, with a scripted model that counts its
// requests in a file the test reads. `start` runs the node; `resume` opens the file, lets pi resume what was in
// flight, and reaches the node only after a pause, as a workflow that resumes reaches its nodes after pi does. The
// process kills itself at KILL_AT: `after-conversation` once the conversation is committed and nothing is submitted,
// `mid-model` inside the model request, `in-review` inside `submit` in the node's verify clause, before any write, and
// `after-record` once the record is committed and the node has not returned.
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { hostScope } from '../../dist/durable/node.js';
import { nodeRunner } from '../../dist/durable/node-runner.js';
import { RecordDoc } from '../../dist/durable/record-tool.js';

const [mode, file, counter] = process.argv.slice(2);
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const say = (row) => console.log(JSON.stringify(row));
const dieAt = (point) => { if (process.env.KILL_AT === point) { process.kill(process.pid, 'SIGKILL'); for (;;); } };

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 8 }, () => (context) => {
  appendFileSync(counter, 'request\n');
  say({ event: 'request', submit: context.messages.flatMap((message) => message.toolsAdded ?? []).find((tool) => tool.name === 'submit')?.description });
  dieAt('mid-model');
  return fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' });
}));
const models = createModels();
models.setProvider(faux.provider);
let conversation;
const nodes = nodeRunner({
  agent: () => ({ model: { provider: 'faux', modelId: 'faux-1' } }),
  onNodeOpen: (node) => { conversation = node.conversationId; say({ event: 'open', conversation: Number(node.conversationId), resumed: node.resumed }); if (!node.resumed) dieAt('after-conversation'); },
  submit: { onDelivery: (delivery) => { say({ event: 'delivery', status: delivery.status }); dieAt('after-record'); } },
});
const registry = createRegistry();
registry.install(nodes.extension);

const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
if (mode === 'resume') { harness.resume(); await sleep(400); say({ event: 'reached' }); }
const record = await nodes.on(hostScope(harness), ctx).runNode({
  kind: 'decide', label: 'Verdict', executionPath: '/root/steps/0', system: ['Decide buy or pass.'], user: '{"claim":"x"}', schema: SCHEMA,
  step: { sessionId: 'run-1:step:/root/steps/0:a0', attempt: 0, earlierSessionIds: [] },
  review: async () => { say({ event: 'review' }); dieAt('in-review'); return { accepted: true }; },
});
say({ event: 'end', record, stored: (await harness.snapshot(RecordDoc, conversation, ctx)) ?? null });
await harness.close(ctx);
