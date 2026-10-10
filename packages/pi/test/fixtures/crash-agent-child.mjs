// The reference child of the crash sweep with an agent step: a workflow with one effect and one LLM step, run under the
// recovery driver over a pi-durable Harness on SQLite. The step is a conversation the Harness keeps, answered by a
// scripted model that takes its submission through a tool. `start` begins the run and `resume` opens the one a process
// left. Each prints its outcome and exits 0.
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, configure, createRegistry, defineDoc, defineDocFamily, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, RecoveryError } from '@parcha/agentrun-dsl/recovery';
import { crossing } from '@parcha/agentrun-dsl/recovery/testing';
import { documentStore } from '@parcha/agentrun-pi/durable';

const [, , , directory] = process.argv;
const MODEL = { provider: 'faux', modelId: 'faux-1' };
const headers = { 'x-agentrun-count-token': process.env.COUNT_TOKEN };
const say = (row) => console.log(JSON.stringify(row));

const workflow = {
  v: 2, name: 'crash-agent-reference',
  schemas: {
    Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, Any: { type: 'object' },
    Verdict: { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string', enum: ['buy', 'pass'] } } },
  },
  output: { schemaId: 'Out', path: 'final' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'lookup', via: 'tool', tool: 'paid', args: {}, out: 'Any', as: 'lookup', deadline_s: 5 },
    { node: 'decide', label: 'verdict', instructions: 'Decide buy or pass.', out: 'Verdict', as: 'decision' },
    { node: 'code', label: 'finish', code: "s => ({ final: { ok: s.decision.verdict === 'buy' } })" },
  ] },
};

// What the step keeps: the conversation it runs in, by the session the driver admitted; and the record its tool took.
const Nodes = defineDocFamily({ kind: 'crash.nodes', version: 1, scope: 'session', family: true, initial: () => ({ conversation: null }) });
const Record = defineDoc({ kind: 'crash.record', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ record: null }) });
const submit = defineTool({
  name: 'submit', description: "Submit the step's record.", parameters: Type.Object({ verdict: Type.String() }), replay: 'safe',
  execute: async (args, api, context) => {
    await crossing('submit');
    await api.commit(async (tx) => { (await tx.doc(Record, api.conversationId)).record = args; }, context);
    return { content: [{ type: 'text', text: 'accepted' }], control: { terminate: true } };
  },
});

const faux = fauxProvider();
faux.setResponses(Array(8).fill(async () => {
  await crossing('request');
  await fetch(`${process.env.COUNT_URL}/model`, { method: 'POST', headers });
  return fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' });
}));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: 'crash', tools: [submit] }));
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'run.sqlite')), { registry, models }, ctx);

const base = documentStore(harness, 'run-1');
const store = { open: async (bound) => {
  const journal = await base.open(bound);
  return new Proxy(journal, { get: (target, name) => name === 'admit' ? async (...args) => { await crossing('admit'); return target.admit(...args); } : Reflect.get(target, name) });
} };

const call = async ({ executionPath }) => {
  await crossing('dispatch');
  const value = await (await fetch(`${process.env.COUNT_URL}/effect${executionPath}`, { method: 'POST', headers })).json();
  await crossing('settle');
  return value;
};

// The step: its conversation is created once per session, and the request carries the session as its id, so a resumed
// process joins the submission the killed one placed instead of placing another.
const runNode = async (params) => {
  const session = params.step.sessionId;
  await crossing('session');
  let conversation;
  await harness.commit(async (tx) => {
    const node = await tx.doc(Nodes, session, null);
    if (node.conversation === null) {
      node.conversation = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id;
      await configure(tx, node.conversation, { model: MODEL, tools: [submit], instructions: params.system.join('\n\n') });
    }
    conversation = node.conversation;
  }, ctx);
  const submission = await (await harness.conversation(conversation, ctx)).submit({ type: 'input', content: params.user, requestId: `node:${session}` }, ctx);
  const settled = await submission.wait(ctx);
  if (settled.status !== 'done') throw new Error(`step ${params.label} unanswered: ${settled.reason}`);
  return JSON.parse(JSON.stringify((await harness.snapshot(Record, conversation, ctx)).record));
};

const driver = await openRecovery(store, workflow, { key: 'run-1' });
const deps = withRecovery(driver, { runEffect: call, runNode }, { durableNodes: true });
const commit = deps.recovery.commit;
deps.recovery = { ...deps.recovery, commit: async (...args) => { await crossing('commit'); return commit(...args); } };
try {
  const run = await runWorkflow(workflow, {}, deps);
  say({ outcome: { status: run.status, output: run.status === 'complete' ? run.output : undefined } });
} catch (error) {
  if (!(error instanceof RecoveryError)) throw error;
  say({ outcome: { status: 'stopped', code: error.code } });
} finally {
  await driver.close();
  await harness.close(ctx);
}
