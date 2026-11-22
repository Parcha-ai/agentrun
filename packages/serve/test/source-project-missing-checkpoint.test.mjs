import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scratchConnection, runRow, T0 } from './store-support.mjs';
import { readProjectCheckpoints } from '../dist/store/sqlite/project-checkpoints.js';

const pin = { version: 1, sourceId: 'a'.repeat(64), baselineRevision: 'rev-1', digest: 'b'.repeat(64), receipt: 'c'.repeat(64) };
const filter = { agentId: 'agent-1' };
const row = (runId, entryId, checkpoint = {}, attemptEpoch = 1) => ({ runId, revisionId: 'rev-1', entryId, ...(entryId === null || attemptEpoch === null ? {} : { attemptEpoch }), checkpoint });
async function placed(db, id, { state = 'failed', attempt = 1, journalFrom = 1, input = 'private-input', source = pin } = {}) {
  await runRow(db, id, 40); // A release may move the run epoch; it is not an actual attempt identity.
  await db.run('UPDATE runs SET state = ? WHERE id = ?', state, id);
  await db.run('INSERT INTO run_launch (run_id, body, sealed, created_at) VALUES (?, ?, ?, ?)', id,
    JSON.stringify({ input: { content: input }, ...(source === undefined ? {} : { source_project: source }) }), new Uint8Array(1024).fill(7), T0);
  if (attempt !== null) await db.run('INSERT INTO run_attempts (run_id, epoch, turn, attempt, runner, from_state, journal_from, claimed_at) VALUES (?, ?, 1, 1, ?, ?, ?, ?)', id, attempt, 'fixture', 'queued', journalFrom, T0);
}
async function end(db, id, entryId, { checkpoint, text = 'private-answer', state = 'failed', conversation = 1 } = {}) {
  await db.run('INSERT INTO pi_entries (run_id, id, conversation_id, commit_seq, record) VALUES (?, ?, ?, 1, ?)', id, entryId, conversation,
    JSON.stringify({ kind: 'agentrun.end', data: { state, output: text, ...(checkpoint === undefined ? {} : { projectCheckpoint: checkpoint }) } }));
}

test('a placed terminal end without a checkpoint remains visible using its real entry ID, without returning private payloads', async t => {
  const db = await scratchConnection(t);
  await placed(db, 'placed', { input: 'private-input'.repeat(100_000) });
  await end(db, 'placed', 12, { text: 'private-answer'.repeat(100_000) });
  await placed(db, 'ordinary', { source: null }); await end(db, 'ordinary', 9);
  const returned = [];
  const executor = { dialect: db.connection.dialect, all: async (...args) => { const rows = await db.all(...args); returned.push(...rows); return rows; } };
  assert.deepEqual(await readProjectCheckpoints(executor, filter), [row('placed', 12)]);
  assert.ok(Buffer.byteLength(JSON.stringify(returned)) < 2048, 'SQL returns only bounded recovery metadata');
  assert.ok(!JSON.stringify(returned).includes('private-'));
  assert.deepEqual(await readProjectCheckpoints(db.connection, { ...filter, runId: 'absent' }), []);
  assert.deepEqual(await readProjectCheckpoints(db.connection, { agentId: 'another', runId: 'placed' }), []);
});

test('a terminal placed attempt with no end uses its actual attempt epoch, after any older checkpoint', async t => {
  const db = await scratchConnection(t);
  await placed(db, 'reopened', { attempt: 7, journalFrom: 20 });
  const checkpoint = { version: 1, status: 'candidate', sourceId: pin.sourceId, runId: 'reopened', epoch: 1, digest: 'd'.repeat(64) };
  await end(db, 'reopened', 12, { checkpoint });
  await db.run('INSERT INTO run_attempts (run_id, epoch, turn, attempt, runner, from_state, journal_from, claimed_at) VALUES (?, 1, 1, 1, ?, ?, 1, ?)', 'reopened', 'earlier', 'queued', T0);
  assert.deepEqual(await readProjectCheckpoints(db.connection, filter), [row('reopened', 12, checkpoint), { ...row('reopened', null), attemptEpoch: 7 }]);
  assert.equal((await db.get('SELECT count(*) AS n FROM pi_entries WHERE run_id = ?', 'reopened')).n, 1, 'recovery discovery must not fabricate a journal entry');
});

test('a current attempt real terminal entry takes precedence over a synthetic missing-end issue, even with malformed checkpoint data', async t => {
  const db = await scratchConnection(t);
  await placed(db, 'missing', { attempt: 7, journalFrom: 20 }); await end(db, 'missing', 22);
  await placed(db, 'malformed', { attempt: 7, journalFrom: 20 }); await end(db, 'malformed', 22, { checkpoint: { status: 'unknown' } });
  await placed(db, 'valid', { attempt: 7, journalFrom: 20 }); await end(db, 'valid', 22, { checkpoint: { version: 1, status: 'discarded', epoch: 7 } });
  assert.deepEqual(await readProjectCheckpoints(db.connection, filter), [row('malformed', 22, { status: 'unknown' }, 7), row('missing', 22, {}, 7), row('valid', 22, { version: 1, status: 'discarded', epoch: 7 }, 7)]);
});

test('missing-end fallback excludes active, parked, never-claimed, unbound and purged runs and ignores nested end lookalikes', async t => {
  const db = await scratchConnection(t);
  for (const state of ['queued', 'running', 'parked']) await placed(db, state, { state });
  await placed(db, 'unclaimed', { attempt: null });
  await placed(db, 'unbound', { source: { ...pin, baselineRevision: 'another-revision' } });
  await placed(db, 'purged'); await db.run('UPDATE runs SET purged_at = ? WHERE id = ?', T0, 'purged');
  await placed(db, 'nested', { state: 'stopped', attempt: 3, journalFrom: 8 }); await end(db, 'nested', 10, { conversation: 2 });
  assert.deepEqual(await readProjectCheckpoints(db.connection, filter), [{ ...row('nested', null), attemptEpoch: 3 }]);
});

test('NUL and lone-surrogate compatibility preserves missing-end and real-end recovery on both store dialects', async t => {
  const db = await scratchConnection(t);
  for (const [index, text] of ['\u0000', '\ud800', '\udfff', '😀'].entries()) {
    await placed(db, `missing-${index}`, { input: text, attempt: 5 });
    await placed(db, `end-${index}`, { input: text, attempt: 5 }); await end(db, `end-${index}`, 9, { text });
    assert.deepEqual(await readProjectCheckpoints(db.connection, { ...filter, runId: `missing-${index}` }), [{ ...row(`missing-${index}`, null), attemptEpoch: 5 }]);
    assert.deepEqual(await readProjectCheckpoints(db.connection, { ...filter, runId: `end-${index}` }), [row(`end-${index}`, 9, {}, 5)]);
  }
});

test('each terminal entry carries its actual owning attempt, never a copied candidate or discard epoch', async t => {
  const db = await scratchConnection(t);
  await placed(db, 'reopened', { attempt: 7, journalFrom: 20 });
  await db.run('INSERT INTO run_attempts (run_id, epoch, turn, attempt, runner, from_state, journal_from, claimed_at) VALUES (?, 1, 1, 1, ?, ?, 1, ?)', 'reopened', 'earlier', 'queued', T0);
  const first = { version: 1, status: 'candidate', epoch: 1 };
  await end(db, 'reopened', 12, { checkpoint: first });
  await end(db, 'reopened', 22, { checkpoint: first });
  await end(db, 'reopened', 23, { checkpoint: { version: 1, status: 'discarded', epoch: 1 } });
  await placed(db, 'legacy', { attempt: null }); await end(db, 'legacy', 5, { checkpoint: first });
  assert.deepEqual(await readProjectCheckpoints(db.connection, filter), [row('legacy', 5, first, null), row('reopened', 12, first), row('reopened', 22, first, 7), row('reopened', 23, { version: 1, status: 'discarded', epoch: 1 }, 7)]);
});

test('missing-checkpoint projection propagates unrelated database errors without a full-content fallback', async () => {
  const { postgresDialect } = await import('../dist/store/postgres/dialect.js');
  const error = new Error('database unavailable', { cause: { code: '08006' } }); let reads = 0;
  const executor = { dialect: postgresDialect('test'), all: async () => { reads++; throw error; } };
  await assert.rejects(readProjectCheckpoints(executor, filter), caught => caught === error);
  assert.equal(reads, 1);
});
