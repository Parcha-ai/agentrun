// One process of a workflow task with the durable recorder inside it, for durable-recording.test.mjs. After the Harness
// opens and before anything runs, the process writes snapshotLines at the store's head and subscribes recordCommits from
// that snapshot, then starts the run (`start`) or resumes what a killed process left (`resume`). Lines are
// appended to LINES as JSON, one commit at a time. With KILL_AT set, the process kills itself inside the commit that
// point names; stdout gets a JSON row naming that commit.
import { appendFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowExtension, recordCommits, snapshotLines } from '@parcha/agentrun-pi/durable';

export const WORKFLOW = {
  v: 2, name: 'recording-crash',
  schemas: { Quote: { type: 'object', required: ['price'], properties: { price: { type: 'number' } } }, Out: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } },
  output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'quote', via: 'tool', tool: 'prices.quote', args: { sku: '{sku}' }, out: 'Quote', as: 'quote', deadline_s: 20 },
    { node: 'code', label: 'total', code: 's => ({ result: { total: s.quote.price * 2 } })' },
  ] },
};

const [mode, file] = process.argv.slice(2);
if (mode) {
  const log = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
  const write = (lines) => appendFileSync(process.env.LINES, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  const files = workspaceFiles(mkdtempSync(join(tmpdir(), 'agentrun-recording-cwd-')));
  // The effect completes with the price it is given; a resumed run answers it from its receipt, or settles it in options.
  const flow = createWorkflowExtension({ options: () => ({ files }), run: () => ({ adapters: { runEffect: async () => ({ price: 21 }) } }) });
  const registry = createRegistry();
  registry.install(flow.extension);
  const storage = await openNodeSqliteStorage(file);
  const harness = await Harness.open(storage, { registry, models: {} }, ctx);
  // The head, as a disk run reads it with storeHead; this test's store admits a second connection.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const reader = new DatabaseSync(file, { readOnly: true });
  const head = reader.prepare('SELECT next_seq FROM durable_metadata').get().next_seq - 1;
  reader.close();
  const snapshot = await snapshotLines(storage, { at: head, context: ctx });
  write(snapshot);
  log({ snapshot: head });
  const stop = recordCommits(harness, { from: snapshot, write });
  harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type !== 'document' || !change.value) continue;
      const point = change.record.kind === 'agentrun.effects' ? (change.value.status === 'unknown' ? 'after-admit' : 'after-complete') : null;
      if (point && process.env.KILL_AT === point) { log({ kill: point, commit: Number(publication.seq) }); process.kill(process.pid, 'SIGKILL'); }
    }
  });
  if (mode === 'start') {
    const run = await flow.start(harness, { key: 'run-1', workflow: WORKFLOW, input: { sku: 'A-1' } }, ctx);
    log({ outcome: (await run.wait(ctx)).status });
  } else {
    harness.resume();
    const task = (await flow.read(harness, 'run-1', ctx)).taskId;
    log({ settled: (await harness.waitForTask(task, ctx)).state.status });
  }
  await stop();
  await harness.close(ctx);
}
