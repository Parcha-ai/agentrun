// The decision rows a durable host stores: the session document `agentrun.decisions`, written in the order rows are
// recorded, read back in commit order, and stored the way a reader of the run's file finds them today.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { apply } from '@earendil-works/chord/delta';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDoc, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DECISION_RECEIPTS_DOC, DECISION_ROW_VERSION, appendDecision, readDecisions } from '../dist/workflow/decisions.js';

// Every field a stored row carries; `error` and `driver_spend` only when they apply.
const ROW_FIELDS = ['v', 'at', 'node', 'kind', 'item', 'execution_path', 'request_sha256', 'request_bytes', 'model', 'questions', 'answers', 'rule', 'action', 'usage', 'cost_usd', 'latency_ms'];
const row = (node, extra = {}) => ({
  v: DECISION_ROW_VERSION, at: '2026-10-12T00:00:00.000Z', node, kind: 'ask', item: null, execution_path: null, request_sha256: null,
  request_bytes: 0, model: null, questions: { holds: { type: 'noul', instructions: '?' } }, answers: {}, rule: { kind: 'ask', gte: 0.5 },
  action: null, usage: null, cost_usd: null, latency_ms: 0, ...extra,
});
const open = (storage) => Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);

/** The `agentrun.decisions` document as the reader the stored format is frozen for finds it in `file`: the latest base of
 *  the singleton session document of that kind, with every later delta applied; every revision is document version 1. */
function storedDecisions(file) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const doc = db.prepare("SELECT id FROM documents WHERE kind = ? AND scope_kind = 'session' AND owner_id = 0 AND family = 0 AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(JSON.stringify(DECISION_RECEIPTS_DOC), JSON.stringify(''));
    assert.ok(doc, 'one session document named agentrun.decisions');
    const versions = db.prepare('SELECT DISTINCT version FROM document_revisions WHERE document_id = ?').all(doc.id).map((r) => r.version);
    assert.deepEqual(versions, [1], 'every revision is of document version 1');
    const base = db.prepare("SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(doc.id);
    let value = JSON.parse(base.content);
    for (const delta of db.prepare('SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq').all(doc.id, base.seq)) value = apply(value, JSON.parse(delta.content));
    return value;
  } finally { db.close(); }
}

/** The keyed form as the file holds it: each `agentrun.decisions` family document's latest value, in key order. */
function storedFamily(file) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const docs = db.prepare("SELECT id, key_value FROM documents WHERE kind = ? AND scope_kind = 'session' AND owner_id = 0 AND family = 1 AND retired_at IS NULL").all(JSON.stringify(DECISION_RECEIPTS_DOC));
    return docs.map((doc) => ({ key: JSON.parse(doc.key_value), doc })).sort((a, b) => (a.key < b.key ? -1 : 1)).map(({ key, doc }) => {
      const base = db.prepare("SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(doc.id);
      let value = JSON.parse(base.content);
      for (const delta of db.prepare('SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq').all(doc.id, base.seq)) value = apply(value, JSON.parse(delta.content));
      return { key, value };
    });
  } finally { db.close(); }
}
test('a fresh store holds the rows as the keyed family: one document per row, each exactly the row, keys in commit order, and the count beside them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentrun-decisions-'));
  try {
    const file = join(dir, 'run.sqlite');
    const harness = await open(await openNodeSqliteStorage(file));
    const before = row('before');
    const identified = row('identified', { execution_path: '/root', decision_id: 'd'.repeat(64), request: { index: 0, count: 1 }, state_sha256: 'a'.repeat(64), run_key: 'run-1' });
    const refused = row('first', { error: 'the request was refused' });
    try {
      for (const r of [before, identified, refused]) await appendDecision(harness, r, ctx);
      assert.deepEqual(await readDecisions(harness, ctx), [before, identified, refused]);
    } finally { await harness.close(ctx); }
    const stored = storedFamily(file);
    assert.deepEqual(stored.map((entry) => entry.key), ['00000000', '00000001', '00000002']);
    assert.deepEqual(stored.map((entry) => entry.value), [before, identified, refused]);
    assert.deepEqual(Object.keys(stored[0].value), ROW_FIELDS);
    assert.deepEqual(Object.keys(stored[1].value), [...ROW_FIELDS, 'decision_id', 'request', 'state_sha256', 'run_key']);
    assert.throws(() => storedDecisions(file), /one session document named agentrun.decisions/, 'no single document');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
