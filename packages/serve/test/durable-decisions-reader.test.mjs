// durableDecisions: the decision rows of a store file in commit order, in either form of `agentrun.decisions` (the single document, or one keyed
// document per row), and the empty list only for a store with none: never the empty list of a reader that does not know the form.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDoc, defineDocFamily, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { durableDecisions } from '../dist/workflow/readers.js';

const root = mkdtempSync(join(tmpdir(), 'agentrun-decisions-reader-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fileOf = () => join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
const open = async (file) => Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: createModels() }, ctx);
const Single = defineDoc({ kind: 'agentrun.decisions', version: 1, scope: 'session', checkpointWhen: () => false, initial: () => ({ receipts: [] }) });
const Keyed = defineDocFamily({ kind: 'agentrun.decisions', version: 1, scope: 'session', family: true, checkpointWhen: () => false, initial: () => ({}) });
const Count = defineDoc({ kind: 'agentrun.decisions.count', version: 1, scope: 'session', checkpointWhen: () => false, initial: () => ({ count: 0 }) });
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

test('unlocked: a read-only, lock-free read (vfs=unix-none) of a store its process holds under an exclusive lock with its WAL in heap; the handle cannot write', async () => {
  const file = fileOf();
  const harness = await open(file);
  try { await harness.commit(async (tx) => { const doc = await tx.doc(Single); for (const id of ['a', 'b']) doc.receipts.push(row(id)); }, ctx); } finally { await harness.close(ctx); }
  // The run's own process, as pi-durable-disk's exclusive profile opens it: it holds the file's lock.
  const { DatabaseSync } = await import('node:sqlite');
  const writer = new DatabaseSync(file);
  try {
    writer.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; BEGIN EXCLUSIVE; COMMIT');
    assert.throws(() => durableDecisions(file), /locked|busy/i, 'a plain read waits on the lock');
    assert.deepEqual(durableDecisions(file, { unlocked: true }).map((r) => r.decision_id), ['a', 'b']);
    const { withDurableFile } = await import('../dist/workflow/readers.js');
    withDurableFile(file, (db) => {
      assert.throws(() => db.exec('CREATE TABLE written (a)'), /readonly/i, 'read-only by construction');
    }, { unlocked: true });
  } finally {
    writer.close();
  }
});
