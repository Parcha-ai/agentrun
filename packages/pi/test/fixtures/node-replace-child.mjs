// One process of a workflow task whose agent node runs on the node runner, for node-replace.test.mjs. The workflow
// calls a tool, asks an agent for a verdict, then totals. `start` starts (or replaces) the run and waits for its
// outcome; with KILL_AT=mid-model it kills itself inside the agent's model request, so the node is in flight. `refuse`
// opens the file and lets pi resume what was in flight while the run's open fails (its host's options throw, as an
// older build refuses a newer run, or a host fails to give its options): the task ends failed and pi aborts the
// node's request, which the model never answers here. Each model request and each tool call is a line in a file.
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension, nodeRunner, taskScope } from '@parcha/agentrun-pi/durable';

export const WORKFLOW = {
  v: 2, name: 'node-replace',
  schemas: {
    Quote: { type: 'object', required: ['price'], properties: { price: { type: 'number' } } },
    Verdict: { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } },
    Out: { type: 'object', required: ['total', 'verdict'], properties: { total: { type: 'number' }, verdict: { type: 'string' } } },
  },
  output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'quote', via: 'tool', tool: 'prices.quote', args: { sku: '{sku}' }, out: 'Quote', as: 'quote', deadline_s: 20 },
    { node: 'agent', label: 'verdict', instructions: 'Decide buy or pass for the quote.', out: 'Verdict', as: 'verdict' },
    { node: 'code', label: 'total', code: 's => ({ result: { total: s.quote.price * 2, verdict: s.verdict.verdict } })' },
  ] },
};

const [mode, file] = process.argv.slice(2);
if (mode) {
  const log = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 8 }, () => (context, options) => {
    appendFileSync(process.env.REQUESTS, `${process.pid}\n`);
    if (process.env.KILL_AT === 'mid-model') { process.kill(process.pid, 'SIGKILL'); for (;;); }
    // A model that does not answer while the run's open fails: its request ends only when pi aborts it.
    if (mode === 'refuse') return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return fauxAssistantMessage([fauxToolCall('submit', { verdict: 'buy' })], { stopReason: 'toolUse' });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const nodes = nodeRunner({ agent: () => ({ model: { provider: 'faux', modelId: 'faux-1' } }) });
  const files = workspaceFiles(mkdtempSync(join(tmpdir(), 'agentrun-node-replace-cwd-')));
  const flow = createWorkflowExtension({
    options: () => {
      if (mode === 'refuse') throw Object.assign(new Error(process.env.REFUSE_MESSAGE ?? 'the run is refused at its open'), { code: process.env.REFUSE_CODE ?? 'FROZEN_CHECKPOINT_INVALID' });
      return { files };
    },
    run: ({ runtime, context }) => ({
      adapters: { runEffect: async () => { appendFileSync(process.env.CALLS, `${process.pid}\n`); return { price: 21 }; }, runNode: nodes.on(taskScope(runtime), context).runNode },
      durableNodes: true,
    }),
  });
  const registry = createRegistry();
  registry.install(nodes.extension);
  registry.install(flow.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry, models }, ctx);
  const request = { key: 'run-1', workflow: WORKFLOW, input: { sku: 'A-1' } };
  if (mode === 'start') {
    const run = await flow.start(harness, request, ctx);
    const outcome = await run.wait(ctx);
    log({ outcome: outcome.status, ...(outcome.status === 'complete' ? { output: outcome.output } : { code: outcome.code ?? null, message: String(outcome.message ?? '').slice(0, 300) }) });
  } else {
    harness.resume();
    const task = (await flow.read(harness, 'run-1', ctx)).taskId;
    const settled = await harness.waitForTask(task, ctx);
    log({ settled: settled.state.status, outcome: settled.state.outcome?.status ?? null });
  }
  await harness.close(ctx);
}
