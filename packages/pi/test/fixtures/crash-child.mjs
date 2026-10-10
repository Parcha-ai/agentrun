// The reference child of the crash sweep on the document store: a workflow with two effects, run under the recovery
// driver over a pi-durable Harness on SQLite. `start` begins the run and `resume` opens the one a process left. Each prints its outcome and exits 0.
// PLANT=bypass-journal skips the driver's effect wrapper, as a host that dispatches without consulting the journal.
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, RecoveryError } from '@parcha/agentrun-dsl/recovery';
import { crossing } from '@parcha/agentrun-dsl/recovery/testing';
import { documentStore } from '@parcha/agentrun-pi/durable';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { join } from 'node:path';

const [, , mode, directory] = process.argv;
const tool = (label) => ({ node: 'call', label, via: 'tool', tool: 'paid', args: {}, out: 'Any', as: label, deadline_s: 5 });
const workflow = {
  v: 2, name: 'crash-reference',
  schemas: { Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, Any: { type: 'object' } },
  output: { schemaId: 'Out', path: 'final' },
  root: { node: 'chain', steps: [tool('first'), tool('second'), { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' }] },
};
const say = (row) => console.log(JSON.stringify(row));

// The store the driver writes through: an admission is a crossing before it is made.
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'run.sqlite')), { registry: createRegistry(), models: {} }, ctx);
const base = documentStore(harness, 'run-1');
const store = { open: async (bound) => {
  const journal = await base.open(bound);
  return new Proxy(journal, { get: (target, name) => name === 'admit' ? async (...args) => { await crossing('admit'); return target.admit(...args); } : Reflect.get(target, name) });
} };

const call = async ({ executionPath }) => {
  await crossing('dispatch');
  const response = await fetch(`${process.env.COUNT_URL}/effect${executionPath}`, { method: 'POST', headers: { 'x-agentrun-count-token': process.env.COUNT_TOKEN } });
  const value = await response.json();
  await crossing('settle');
  return value;
};

const driver = await openRecovery(store, workflow, { key: 'run-1' });
const deps = withRecovery(driver, { runEffect: call });
if (process.env.PLANT === 'bypass-journal') deps.runEffect = call;
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
