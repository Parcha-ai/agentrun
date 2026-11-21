import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scratchConnection, runRow, T0 } from './store-support.mjs';
import { readUsageMetadata } from '../dist/store/sqlite/run-launch.js';
import { postgresOnly } from './store-target.mjs';

test('usage metadata crosses the database boundary without replay, policy, answers or sealed bytes', async t => {
  const db = await scratchConnection(t);
  await runRow(db, 'captured');
  const cli = { runtime: 'codex-cli', session_id: 'native-session-😀', turn_id: 'turn', native_grading: true };
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 3, cache_write_tokens: 0 };
  await db.run('INSERT INTO run_launch (run_id, body, sealed, created_at) VALUES (?, ?, ?, ?)', 'captured',
    JSON.stringify({ input: { content: 'private-input-'.repeat(20_000) }, cli_learning: { ...cli, native_grading: { profile: 'private-profile-'.repeat(20_000) }, instructions: 'private-policy-'.repeat(8_000) } }), new Uint8Array(4096).fill(7), T0);
  await db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', 'sdk-run:captured',
    JSON.stringify({ batches: [{ events: [{ text: 'private-replay-'.repeat(240_000) }] }], completion: { answer: 'private-answer-'.repeat(8_000), usage: { ...usage, legacy_detail: 'private-detail-'.repeat(8_000) } } }), T0);
  const rows = [], queries = [];
  const executor = { dialect: db.connection.dialect, get: async (...args) => {
    queries.push(args[0]); const row = await db.get(...args); rows.push(row); return row;
  } };
  assert.deepEqual(await readUsageMetadata(executor, 'captured', { completion: true }), { cli, completionUsage: usage });
  assert.ok(Buffer.byteLength(JSON.stringify(rows[0])) < 512, 'the database returns accounting fields, not a multi-megabyte row later trimmed in JS');
  assert.ok(!JSON.stringify(rows).includes('private-'));
  assert.deepEqual(await readUsageMetadata(executor, 'captured', { completion: false }), { cli });
  assert.ok(!queries.at(-1).includes('settings'), 'out-of-range historical identity does not even read the inbox');
  assert.equal(await readUsageMetadata(executor, 'absent', { completion: true }), undefined);
});

test('both store dialects preserve absent, null and malformed scalar JSON without interpreting strings as usage', async t => {
  const db = await scratchConnection(t);
  await runRow(db, 'run');
  const absentUsage = { input_tokens: undefined, output_tokens: undefined, cache_read_tokens: undefined, cache_write_tokens: undefined };
  assert.deepEqual(await readUsageMetadata(db.connection, 'run', { completion: true }), {
    cli: { runtime: undefined, session_id: undefined, turn_id: undefined, native_grading: false }, completionUsage: absentUsage,
  });
  for (const value of [null, false, 0, '', '123', '{"input_tokens":100}', ['unexpected'], { input_tokens: null, output_tokens: 0 }]) {
    await db.run('INSERT INTO run_launch (run_id, body, created_at) VALUES (?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET body = excluded.body',
      'run', JSON.stringify({ cli_learning: { runtime: value, session_id: value, turn_id: value, native_grading: value } }), T0);
    await db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      'sdk-run:run', JSON.stringify({ completion: { usage: value } }), T0);
    assert.deepEqual(await readUsageMetadata(db.connection, 'run', { completion: true }), {
      cli: { runtime: value, session_id: value, turn_id: value, native_grading: Boolean(value) }, completionUsage: { ...absentUsage,
        ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) },
    });
  }
  await db.run('UPDATE settings SET value = ? WHERE key = ?', JSON.stringify({ completion: { usage: {
    input_tokens: '100', output_tokens: 0, cache_read_tokens: null, cache_write_tokens: false,
  } } }), 'sdk-run:run');
  assert.deepEqual((await readUsageMetadata(db.connection, 'run', { completion: true })).completionUsage,
    { input_tokens: '100', output_tokens: 0, cache_read_tokens: null, cache_write_tokens: false });
});

test('Postgres Unicode projection refusals preserve exact accounting from legacy JSON text', postgresOnly('Postgres rejects escaped NUL and lone surrogates during JSON extraction'), async t => {
  const db = await scratchConnection(t);
  await runRow(db, 'legacy');
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: null };
  for (const escaped of ['\u0000', '\ud800', '\udc00', '\ud800\ud800']) for (const where of ['launch', 'inbox']) {
    const cli = { runtime: 'codex-cli', session_id: where === 'launch' ? `native-${escaped}` : 'native-clean', turn_id: 'turn', native_grading: false };
    await db.run('INSERT INTO run_launch (run_id, body, created_at) VALUES (?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET body = excluded.body',
      'legacy', JSON.stringify({ cli_learning: { ...cli, instructions: where === 'launch' ? `policy-${escaped}` : 'Task.' } }), T0);
    await db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      'sdk-run:legacy', JSON.stringify({ batches: [{ text: where === 'inbox' ? `replay-${escaped}` : 'Replay.' }], completion: { answer: where === 'inbox' ? `answer-${escaped}` : 'Answer.', usage } }), T0);
    assert.deepEqual(await readUsageMetadata(db.connection, 'legacy', { completion: true }), { cli, completionUsage: usage },
      'a narrow compatibility fallback must preserve the original session bytes and typed counters, not sanitize them');
    assert.deepEqual(await readUsageMetadata(db.connection, 'legacy', { completion: false }), { cli });
  }
});

test('Postgres ordinary invalid JSON retains its check failure without Unicode provenance or fallback', postgresOnly('Postgres error typing'), async t => {
  const db = await scratchConnection(t);
  let reads = 0;
  const executor = { dialect: db.connection.dialect, get: async () => { reads++; return db.get("SELECT '{'::json"); } };
  await assert.rejects(readUsageMetadata(executor, 'run', { completion: true }), error => {
    assert.equal(error.name, 'StoreConstraint');
    assert.equal(error.rule, 'check');
    assert.equal(error.message, 'invalid input syntax for type json');
    assert.equal(error.cause, undefined, 'ordinary invalid JSON carries no surrogate recovery marker');
    return true;
  });
  assert.equal(reads, 1);
});

test('usage projection never falls back to full content for an unrelated database error', async () => {
  const error = new Error('database unavailable', { cause: { code: '08006' } });
  const { postgresDialect } = await import('../dist/store/postgres/dialect.js');
  let reads = 0;
  const executor = { dialect: postgresDialect('test'), get: async () => { reads++; throw error; } };
  await assert.rejects(readUsageMetadata(executor, 'run', { completion: true }), caught => caught === error);
  assert.equal(reads, 1, 'an ordinary failure is propagated without rereading full private content');
});
