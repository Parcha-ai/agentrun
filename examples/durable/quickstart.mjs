// A workflow with one external action, run twice over the same SQLite file. The second run is a new Harness, as a
// restarted process would open it: the committed step is answered from the journal and the action is not taken again.
import { mkdirSync } from 'node:fs';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery } from '@parcha/agentrun-dsl/recovery';
import { documentStore } from '@parcha/agentrun-pi/durable';

const workflow = {
  v: 2, name: 'send-receipt',
  schemas: { Sent: { type: 'object', required: ['content'], properties: { content: { type: 'array' } } } },
  output: { schemaId: 'Sent', path: 'sent' },
  root: { node: 'call', label: 'send', via: 'tool', tool: 'mailer.send', args: { to: '{to}' }, out: 'Sent', as: 'sent', deadline_s: 10 },
};
const input = { to: 'ada@example.com' };
const file = process.argv[2] ?? '.durable/run.sqlite';
mkdirSync(file.slice(0, file.lastIndexOf('/')) || '.', { recursive: true });

let sends = 0;
const adapters = {
  // The one place the action happens. A completed call is answered from its receipt on every later run.
  runEffect: async () => { sends += 1; return { content: [{ type: 'text', text: 'sent' }] }; },
};

async function run() {
  const harness = await Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: {} }, context);
  const driver = await openRecovery(documentStore(harness, 'run-1'), workflow, { key: 'run-1', bind: { input } });
  try {
    const result = await runWorkflow(workflow, input, withRecovery(driver, adapters));
    return result.status;
  } finally {
    await driver.close();
    await harness.close(context);
  }
}

console.log(await run(), `sends so far: ${sends}`);
console.log(await run(), `sends so far: ${sends}`);
