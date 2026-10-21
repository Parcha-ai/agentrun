// durableDecisions: the decision rows of a store file in commit order, in either form of `agentrun.decisions` (the single document, or one keyed
// document per row), and the empty list only for a store with none: never the empty list of a reader that does not know the form.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, defineDoc, defineDocFamily, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { durableDecisions } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-decisions-reader-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fileOf = () => join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
const open = async (file) => Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: {} }, ctx);
const Single = defineDoc({ kind: 'agentrun.decisions', version: 1, scope: 'session', initial: () => ({ receipts: [] }) });
const Keyed = defineDocFamily({ kind: 'agentrun.decisions', version: 1, scope: 'session', family: true, initial: () => ({}) });
const Count = defineDoc({ kind: 'agentrun.decisions.count', version: 1, scope: 'session', initial: () => ({ count: 0 }) });
const row = (id) => ({ v: 1, node: 'pick', kind: 'judge', decision_id: id, run_key: 'r', rule: { kind: 'judge' }, cost_usd: 0 });

test('the single document: its list, in order', async () => {
  const file = fileOf();
  const harness = await open(file);
  try { await harness.commit(async (tx) => { const doc = await tx.doc(Single); for (const id of ['a', 'b', 'c']) doc.receipts.push(row(id)); }, ctx); } finally { await harness.close(ctx); }
  assert.deepEqual(durableDecisions(file).map((r) => r.decision_id), ['a', 'b', 'c']);
});

test('the keyed documents: one row each, in the order of their places, past ten of them', async () => {
  const file = fileOf();
  const harness = await open(file);
  try {
    for (let place = 0; place < 12; place += 1) {
      await harness.commit(async (tx) => { const count = await tx.doc(Count); count.count = place + 1; Object.assign(await tx.doc(Keyed, String(place).padStart(8, '0'), null), row(`d${place}`)); }, ctx);
    }
  } finally { await harness.close(ctx); }
  assert.deepEqual(durableDecisions(file).map((r) => r.decision_id), Array.from({ length: 12 }, (_, i) => `d${i}`));
});

test('a store with no decision, and a file that is not there, hold none', async () => {
  const file = fileOf();
  const harness = await open(file);
  await harness.close(ctx);
  assert.deepEqual(durableDecisions(file), []);
  assert.deepEqual(durableDecisions(join(root, 'no-such-file.sqlite')), []);
});
