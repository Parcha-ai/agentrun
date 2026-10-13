// One process of a workflow task over one SQLite file, for the kill matrix in durable-task-crash.test.mjs. `start`
// starts (or reaches) the run and waits for it; `resume` opens, installs the extension and calls `resume()`, nothing
// else, then waits for the task. With KILL_AT set, the process kills itself at that point. With SETTLE set, the host's
// `options` completes each effect a killed process left unknown with that JSON value before the driver opens, as a host
// that learned what the call did reconciles it. With PAUSE_AT_START set, `start` gives a pause with the start and
// reports once the run is paused (kill point `paused`). Rows go to stdout as JSON.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { recoveryBound, workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension, documentStore } from '@parcha/agentrun-pi/durable';

export const WORKFLOW = {
  v: 2, name: 'task-crash',
  schemas: { Quote: { type: 'object', required: ['price'], properties: { price: { type: 'number' } } }, Out: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } },
  output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'quote', via: 'tool', tool: 'prices.quote', args: { sku: '{sku}' }, out: 'Quote', as: 'quote', deadline_s: 20 },
    { node: 'code', label: 'total', code: 's => ({ result: { total: s.quote.price * 2 } })' },
  ] },
};
const LAST = '/root/steps/1';

const [mode, file] = process.argv.slice(2);
if (mode) {
  const log = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
  const kill = (point) => { if (process.env.KILL_AT === point) { log({ kill: point }); process.kill(process.pid, 'SIGKILL'); } };
  const files = workspaceFiles(mkdtempSync(join(tmpdir(), 'agentrun-task-cwd-')));
  /** Completes each unknown effect with `value` on the run's journal, opened under the task's commit and closed. */
  const settle = async ({ key, runtime, context }, value) => {
    const commit = async (change) => { let result; await runtime.commit(async (tx) => { result = await change(tx); return undefined; }, context); return result; };
    const journal = await documentStore({ commit }, key, { context }).open(recoveryBound(WORKFLOW));
    try {
      for (const effect of journal.effects()) {
        if (effect.status !== 'unknown') continue;
        await journal.complete(effect.id, { value, files: {} });
        log({ settled: effect.id });
      }
    } finally { await journal.close(); }
  };
  const options = async (invocation) => {
    if (process.env.SETTLE) await settle(invocation, JSON.parse(process.env.SETTLE));
    return { files };
  };
  const flow = createWorkflowExtension({ options, run: () => ({
    adapters: { runEffect: async ({ node, input, signal }) => {
      const response = await fetch(`${process.env.COUNT_URL}/effect`, { method: 'POST', body: JSON.stringify({ tool: node.tool, args: input }), signal });
      const result = await response.json();
      kill('after-dispatch');
      return result;
    } },
  }) });
  const registry = createRegistry();
  registry.install(flow.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry, models: {} }, ctx);
  // A kill point that is a commit: the process dies once the commit is durable, before anything after it runs.
  harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type !== 'document' || !change.value) continue;
      if (change.record.kind === 'agentrun.effects' && change.value.status === 'unknown') kill('after-admit');
      if (change.record.kind === 'agentrun.effects' && change.value.status === 'completed') kill('after-complete');
      if (change.record.kind === 'agentrun.driver' && change.value.state?.pin?.done?.includes(LAST)) kill('before-terminal');
    }
  });
  const receipt = (record) => record && { id: record.id, status: record.state.status, outcome: record.state.outcome ?? null };
  if (mode === 'start') {
    const pause = process.env.PAUSE_AT_START === '1';
    const run = await flow.start(harness, { key: 'run-1', workflow: WORKFLOW, input: { sku: 'A-1' } }, ctx, pause ? { stop: { action: 'pause', source: 'operator' } } : {});
    log({ started: run.started, task: run.taskId });
    if (pause) {
      // The pause is taken as the run's phase opens its driver; a pause handed over once the phase waits is answered.
      let answer = 'not-live';
      for (let i = 0; i < 500 && answer === 'not-live'; i += 1) { answer = await flow.stop(harness, 'run-1', 'pause', ctx); if (answer === 'not-live') await new Promise((resolve) => setTimeout(resolve, 10)); }
      log({ paused: answer });
      kill('paused');
    }
    log({ outcome: await run.wait(ctx), record: receipt(await harness.getTask(run.taskId, ctx)) });
  } else {
    // No task is named here: pi finds what is pending, and resume() alone runs it.
    const before = await harness.inspect(ctx);
    log({ live: before.tasks.map((t) => `${t.record.kind}:${t.record.state.status}`) });
    harness.resume();
    const task = (await flow.read(harness, 'run-1', ctx)).taskId;
    const settled = await harness.waitForTask(task, ctx);
    log({ resumed: receipt(settled) });
  }
  await harness.close(ctx);
}
