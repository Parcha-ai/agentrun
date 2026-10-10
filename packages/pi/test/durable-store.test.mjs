// The document store, held to the store contract by the conformance suite, over a pi-durable Harness on SQLite.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { registerStoreConformance } from '@parcha/agentrun-dsl/recovery/testing';
import { committedRoutes, documentStore, durableDoc, readJournal } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-document-store-'));
after(() => rmSync(root, { recursive: true, force: true }));

const open = async (file) => Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: {} }, ctx);

// Each journal opens as successive processes of one run would: the suite's opens share one Harness, and the file
// tests below reopen the file itself.
registerStoreConformance('document store', async () => documentStore(await open(join(mkdtempSync(join(root, 'run-')), 'run.sqlite')), 'run-1'));

test('document store: a journal survives the Harness that wrote it, and two runs in one Harness do not share one', async () => {
  const file = join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
  const bound = { binding: 'binding-1', inputs: { workflow: 'digest-a' } };
  const first = await open(file);
  const one = await documentStore(first, 'run-1').open(bound);
  await one.admit('e1', 'lookup', 'args-1', { phase: 'admitted' }, 'session-1');
  const other = await documentStore(first, 'run-2').open(bound);
  assert.deepEqual([other.existing, other.effects()], [false, []]);
  await other.close();
  await one.close();
  await first.close(ctx);
  const second = await open(file);
  const again = await documentStore(second, 'run-1').open(bound);
  assert.deepEqual([again.existing, again.generation, again.state, again.effect('e1')?.status, again.effect('e1')?.session], [true, 2, { phase: 'admitted' }, 'unknown', 'session-1']);
  await again.close();
  await second.close(ctx);
});

test('document store: two admissions of one effect asked for together write one admission; two completions, one result', async () => {
  const journal = await documentStore(await open(join(mkdtempSync(join(root, 'run-')), 'run.sqlite')), 'run-1').open({ binding: 'binding-1' });
  const admitted = await Promise.all([journal.admit('e1', 'lookup', 'args-1', { n: 1 }), journal.admit('e1', 'lookup', 'args-1', { n: 2 })]);
  assert.deepEqual([admitted[0], admitted[1].status, journal.revision, journal.effects().length], ['new', 'unknown', 1, 1]);
  const completed = await Promise.allSettled([journal.complete('e1', { value: 'first' }, { n: 3 }), journal.complete('e1', { value: 'second' }, { n: 4 })]);
  assert.deepEqual(completed.map((outcome) => outcome.status), ['fulfilled', 'rejected']);
  await journal.close();
});

test('document store: the readers see a journal from the file, without the Harness, as the last commit left it', async () => {
  const directory = mkdtempSync(join(root, 'run-'));
  mkdirSync(join(directory, 'durable'));
  const bound = { binding: 'binding-1', inputs: { workflow: 'digest-a' } };
  const harness = await open(join(directory, 'durable', 'run.sqlite'));
  assert.equal(readJournal(directory, 'run-1'), undefined);
  const journal = await documentStore(harness, 'run-1').open(bound);
  for (let step = 0; step < 40; step += 1) await journal.save({ step, pin: { routes: { 'root/0': { answer: step } } } }); // past one checkpoint
  await journal.admit('e1', 'lookup', 'args-1', { step: 'admitted' }, 'session-1');
  await journal.complete('e1', { value: 7 }, { step: 'done' });
  await journal.note('handoff', { to: 'agent' });
  await journal.close();
  const view = readJournal(directory, 'run-1');
  assert.deepEqual([view.binding, view.inputs, view.generation, view.revision, view.state], ['binding-1', { workflow: 'digest-a' }, 1, 43, { step: 'done' }]);
  assert.deepEqual(view.effects, [{ id: 'e1', name: 'lookup', argsHash: 'args-1', status: 'completed', session: 'session-1', result: { value: 7 } }]);
  assert.deepEqual(view.notes.map((note) => [note.revision, note.kind, note.detail]), [[43, 'handoff', { to: 'agent' }]]);
  assert.deepEqual(durableDoc(directory, 'agentrun.driver', 'run-1').generation, 1);
  assert.equal(durableDoc(directory, 'agentrun.driver', 'run-2'), undefined);
  assert.equal(readJournal(mkdtempSync(join(root, 'run-')), 'run-1'), undefined);
  assert.deepEqual(committedRoutes({ pin: { routes: { 'root/0': { answer: 1 } } } }), { 'root/0': { answer: 1 } });
  assert.deepEqual(committedRoutes(null), {});
  await harness.close(ctx);
});
