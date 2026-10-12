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

test('document store: a key or an effect id with a NUL is refused, so two journals never name one effect document', async () => {
  const harness = await open(join(mkdtempSync(join(root, 'run-')), 'run.sqlite'));
  await assert.rejects(documentStore(harness, 'a\u0000b').open({ binding: 'binding-1' }), /NUL/);
  const journal = await documentStore(harness, 'a').open({ binding: 'binding-1' });
  await assert.rejects(journal.admit('b\u0000c', 'lookup', 'args-1', {}), /NUL/);
  assert.deepEqual([journal.revision, journal.effects()], [0, []]);
  await journal.close();
  const next = await documentStore(harness, 'a\u0000b').open({ binding: 'binding-1' }).catch((error) => error);
  assert.match(next.message, /NUL/);
  await harness.close(ctx);
});

test('document store: a read of the journal is one read transaction, so it is one commit whatever a writer commits meanwhile', async () => {
  const directory = mkdtempSync(join(root, 'run-'));
  mkdirSync(join(directory, 'durable'));
  const harness = await open(join(directory, 'durable', 'run.sqlite'));
  const journal = await documentStore(harness, 'run-1').open({ binding: 'binding-1' });
  await journal.admit('e1', 'lookup', 'args-1', {});
  await journal.complete('e1', { value: 1 }, {});
  await journal.close();
  await harness.close(ctx);
  const { DatabaseSync } = (await import('node:module')).createRequire(import.meta.url)('node:sqlite');
  const original = DatabaseSync.prototype.prepare;
  const inTransaction = [];
  DatabaseSync.prototype.prepare = function (sql) { inTransaction.push(this.isTransaction); return original.call(this, sql); };
  try { assert.equal(readJournal(directory, 'run-1').effects.length, 1); } finally { DatabaseSync.prototype.prepare = original; }
  assert.ok(inTransaction.length >= 4 && inTransaction.every(Boolean), `the reader's queries ran in a transaction: ${inTransaction}`);
});

test('document store: an effect admitted with an intent carries it at every later open and after it completes; one admitted without carries none', async () => {
  const directory = mkdtempSync(join(root, 'run-'));
  mkdirSync(join(directory, 'durable'));
  const harness = await open(join(directory, 'durable', 'run.sqlite'));
  const bound = { binding: 'binding-1' };
  const intent = { tool: 'paid', argsHash: 'args-digest' };
  const first = await documentStore(harness, 'run-1').open(bound);
  await first.admit('e1', 'lookup', 'args-1', {}, null, intent);
  await first.admit('e2', 'lookup', 'args-2', {});
  assert.deepEqual(first.effects().map((effect) => [effect.id, Object.keys(effect).includes('intent'), effect.intent]), [['e1', true, intent], ['e2', false, undefined]]);
  await first.close();
  const second = await documentStore(harness, 'run-1').open(bound);
  assert.deepEqual(second.effect('e1'), { id: 'e1', name: 'lookup', argsHash: 'args-1', status: 'unknown', session: null, result: null, intent });
  assert.deepEqual(second.effect('e2'), { id: 'e2', name: 'lookup', argsHash: 'args-2', status: 'unknown', session: null, result: null });
  await second.complete('e1', { value: 1 }, {});
  assert.deepEqual(second.effect('e1').intent, intent);
  assert.deepEqual(await second.admit('e1', 'other', 'args-9', {}, null, { tool: 'other', argsHash: 'x' }), second.effect('e1'));
  await second.close();
  const third = await documentStore(harness, 'run-1').open(bound);
  assert.deepEqual([third.effect('e1').status, third.effect('e1').intent, Object.keys(third.effect('e2')).includes('intent')], ['completed', intent, false]);
  await third.close();
  await harness.close(ctx);
  assert.deepEqual(readJournal(directory, 'run-1').effects.map((effect) => [effect.id, effect.intent]), [['e1', intent], ['e2', undefined]]);
});

test('document store: two invocations of one owner are one owner: the later takes over, the earlier is fenced, another owner is refused', async () => {
  const harness = await open(join(mkdtempSync(join(root, 'run-')), 'run.sqlite'));
  const bound = { binding: 'binding-1' };
  const seen = [];
  // Each invocation writes through a commit of its own and a context of its own, as a running task's runtime provides.
  const invocation = (owner, context = ctx) => documentStore({ commit: (change, given) => { seen.push(given); return harness.commit(change, given); } }, 'run-1', { owner, context });
  const first = await invocation('task-1').open(bound);
  await first.admit('e1', 'lookup', 'args-1', { phase: 'admitted' });
  // The first invocation never closed (it was aborted): the same owner's next one takes over.
  const second = await invocation('task-1').open(bound);
  assert.deepEqual([second.generation, second.state, second.effect('e1')?.status], [2, { phase: 'admitted' }, 'unknown']);
  await assert.rejects(first.save({ stale: true }), /generation is not acquired/);
  await first.close();
  await second.save({ phase: 'resumed' });
  // Another owner is refused while the journal is open, and the first invocation's close did not release the hold.
  await assert.rejects(invocation('task-2').open(bound), /live owner/);
  await second.close();
  const replacement = await invocation('task-2').open(bound);
  assert.deepEqual([replacement.generation, replacement.state], [3, { phase: 'resumed' }]);
  await replacement.close();
  // A refused binding leaves the earlier hold in place.
  const held = await invocation('task-2').open(bound);
  await assert.rejects(invocation('task-2').open({ binding: 'binding-2' }), /binding mismatch/);
  await assert.rejects(invocation('task-3').open(bound), /live owner/);
  await held.close();
  // The commits run under the context the invocation was given.
  const own = {};
  const scoped = await documentStore({ commit: (change, given) => { seen.push(given); return harness.commit(change, ctx); } }, 'run-2', { owner: 'task-9', context: own }).open(bound);
  await scoped.save({});
  await scoped.close();
  assert.ok(seen.includes(own));
  await harness.close(ctx);
});
