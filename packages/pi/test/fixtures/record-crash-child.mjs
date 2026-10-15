// One process over one SQLite file: a conversation with the `submit` tool, driven by a scripted model that counts its
// requests in a file the test reads. `start` submits the node's input; `resume` only opens, installs and resumes.
// The process kills itself at KILL_AT: `before-commit` inside the tool before any write, `after-commit` once the
// decision is committed and before the model is answered. With REFUSE_NEWER set, the process refuses a store a newer
// pi-durable left with a tool call in flight right after it opens, and prints the refusal.
import { appendFileSync, readFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { GateDoc, RecordDoc, recordTool, refuseNewerTasks } from '@parcha/agentrun-pi/durable';

const [mode, file, counter] = process.argv.slice(2);
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const OBJECTION = { id: 'verify', kind: 'verify', verdict: 'fails', reasons: ['names no reason'] };
const say = (row) => console.log(JSON.stringify(row));
const dieAt = (point) => { if (process.env.KILL_AT === point) { process.kill(process.pid, 'SIGKILL'); for (;;); } };

const faux = fauxProvider();
faux.setResponses(Array.from({ length: 8 }, () => () => {
  // FIRST=invalid: the run's first request, counted across processes, submits a record the schema refuses.
  const first = readFileSync(counter, 'utf8') === '';
  appendFileSync(counter, 'request\n');
  return fauxAssistantMessage([fauxToolCall('submit', first && process.env.FIRST === 'invalid' ? { nope: 1 } : { verdict: 'buy' })], { stopReason: 'toolUse' });
}));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: 'record-crash', tools: [recordTool({
  record: { schema: SCHEMA, label: 'the verdict record' },
  contract: () => { dieAt('before-commit'); return { schema: SCHEMA, ...(process.env.REVIEW === 'objects' ? { reviewers: [() => [OBJECTION]] } : {}) }; },
  onDelivery: (delivery) => { say({ delivery: delivery.status }); dieAt('after-commit'); },
})] }));

const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, ctx);
if (process.env.REFUSE_NEWER) {
  try { await refuseNewerTasks(harness, ctx); } catch (error) {
    say({ refused: { name: error.name, code: error.code, kind: error.kind, version: error.version, message: error.message } });
    await harness.close(ctx);
    process.exit(3);
  }
}
const conversation = await harness.root(ctx, mode === 'start' ? { agent: { model: { provider: 'faux', modelId: 'faux-1' } } } : undefined);
if (mode === 'resume') harness.resume();
// The same request id finds the same submission: a resumed process waits on the one the first process made.
const settled = await (await conversation.submit({ type: 'input', content: 'Decide.', requestId: 'node:crash' }, ctx)).wait(ctx);
say({ settled: settled.status, record: (await harness.snapshot(RecordDoc, conversation.id, ctx)) ?? null, gate: (await harness.snapshot(GateDoc, conversation.id, ctx)) ?? null });
await harness.close(ctx);
