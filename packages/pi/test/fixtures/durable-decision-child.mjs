// One process of a workflow task whose typed question is recorded through `decisionRecovery`, for
// durable-decision-recovery.test.mjs. `start` starts the run and waits for it; `resume` opens, installs the extension
// and calls `resume()`, then waits for the task and logs the run's decision rows and the receipt each one rebuilds. With
// KILL_AT=after-decision the process kills itself once the decision's row is durable, before the answer reaches the
// run's state. With REPLAY=0 the host records rows and does not answer from them. Rows go to stdout as JSON.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { withRecovery } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension, decisionRecovery, readDecisions } from '@parcha/agentrun-pi/durable';

export const WORKFLOW = {
  v: 2, name: 'decision-crash',
  schemas: {
    Flags: { type: 'object', required: ['urgent'], properties: { urgent: { type: 'boolean', description: 'Is the request urgent?' } } },
    Out: { type: 'object', required: ['urgent'], properties: { urgent: { type: 'boolean' } } },
  },
  output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'judge', label: 'triage', state: { request: '{request}' }, out: 'Flags', as: 'flags' },
    { node: 'code', label: 'out', code: 's => ({ result: { urgent: s.flags.urgent } })' },
  ] },
};

const [mode, file] = process.argv.slice(2);
if (mode) {
  const log = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
  const kill = (point) => { if (process.env.KILL_AT === point) { log({ kill: point }); process.kill(process.pid, 'SIGKILL'); } };
  // The judge is a counting server: what it answers is its business, and each ask is paid.
  const runJudge = async ({ signal }) => (await fetch(`${process.env.COUNT_URL}/judge`, { method: 'POST', signal })).json();
  const flow = createWorkflowExtension({
    run: ({ runtime, context, driver }) => {
      const decisions = decisionRecovery(runtime, context);
      const deps = withRecovery(driver, {
        runJudge,
        recordDecision: async (receipt, exchange) => { log({ receipt }); await decisions.recordDecision(receipt, exchange); },
      });
      return { deps: process.env.REPLAY === '0' ? deps : { ...deps, recovery: { ...deps.recovery, decision: decisions.decision } } };
    },
  });
  const registry = createRegistry();
  registry.install(flow.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry, models: {} }, ctx);
  harness.subscribeCommits((publication) => {
    for (const change of publication.changes) if (change.type === 'document' && change.value && change.record.kind === 'agentrun.decisions') kill('after-decision');
  });
  const ended = (record) => record && { id: record.id, status: record.state.status, outcome: record.state.outcome ?? null };
  if (mode === 'start') {
    const run = await flow.start(harness, { key: 'run-1', workflow: WORKFLOW, input: { request: 'The server room is flooding.' } }, ctx);
    log({ task: run.taskId });
    await run.wait(ctx);
    log({ ended: ended(await harness.getTask(run.taskId, ctx)) });
  } else {
    harness.resume();
    const task = (await flow.read(harness, 'run-1', ctx)).taskId;
    log({ ended: ended(await harness.waitForTask(task, ctx)) });
  }
  const rows = await readDecisions(harness, ctx);
  log({ rows });
  const read = decisionRecovery(harness, ctx);
  log({ rebuilt: await Promise.all(rows.map((row) => read.decision(row.decision_id))) });
  await harness.close(ctx);
}
