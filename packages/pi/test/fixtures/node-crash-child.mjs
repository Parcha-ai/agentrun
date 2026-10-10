// One process over one SQLite file: a task that runs one node attempt in a conversation it owns, with a scripted model
// that counts its requests in a file the test reads. `start` creates the task; `resume` only opens, installs and
// resumes. The process kills itself at KILL_AT: `after-conversation` once the conversation is committed and nothing is
// submitted, `mid-model` inside the model request, `in-submit-tool` inside the tool before any write, and
// `after-submission` once the record is committed and the task has not ended.
import { appendFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTask, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { runNodeAttempt, taskScope } from '../../dist/durable/node.js';
import { RecordDoc, recordTool } from '../../dist/durable/record-tool.js';

const [mode, file, counter] = process.argv.slice(2);
const MODEL = { provider: 'faux', modelId: 'faux-1' };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const say = (row) => console.log(JSON.stringify(row));
const dieAt = (point) => { if (process.env.KILL_AT === point) { process.kill(process.pid, 'SIGKILL'); for (;;); } };

const Owner = defineTask({
  name: 'node-crash.owner', version: 1, initial: () => ({ phase: 'run' }),
  phases: { run: async (_task, runtime, context) => {
    const outcome = await runNodeAttempt(taskScope(runtime), {
      session: 'run-1:verdict:/root/steps/2:a0', digest: 'binding-1', agent: { model: MODEL }, user: 'Decide buy or pass.',
      onOpen: ({ conversationId, resumed }) => { say({ conversation: Number(conversationId), resumed }); if (!resumed) dieAt('after-conversation'); },
    }, context);
    dieAt('after-submission');
    await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'completed', result: { conversation: Number(outcome.conversationId), record: outcome.delivered?.record ?? null, requested: outcome.settled !== undefined } } }), context);
  } },
  abort: async (_task, runtime, context) => { await runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'aborted' } }), context); },
});

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 8 }, () => () => {
  appendFileSync(counter, 'request\n');
  dieAt('mid-model');
  return fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' });
}));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: 'node-crash', tasks: [Owner], tools: [recordTool({
  schema: SCHEMA, label: 'the verdict record', contract: () => { dieAt('in-submit-tool'); return { schema: SCHEMA }; },
})] }));

const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
let task;
if (mode === 'start') {
  const root = await harness.root(ctx, { agent: { model: MODEL } });
  task = await root.commit((tx) => tx.createTask(Owner, {}, { ownership: { kind: 'conversation' } }), ctx);
  say({ task: Number(task) });
} else {
  task = Number(process.env.TASK_ID);
  harness.resume();
}
const settled = await harness.waitForTask(task, ctx);
const result = settled.state.outcome.result ?? null;
say({ outcome: settled.state.outcome.status, result, record: result ? (await harness.snapshot(RecordDoc, result.conversation, ctx)) ?? null : null });
await harness.close(ctx);
