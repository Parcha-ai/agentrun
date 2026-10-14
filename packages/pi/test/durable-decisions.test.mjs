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
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DECISION_RECEIPTS_DOC, DECISION_ROW_VERSION, appendDecision, createDecisionWriter, readDecisions } from '@parcha/agentrun-pi/durable';

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

// A Session the writer opens, counting how often it was opened and released.
function sessionOn(harness, { failOn = new Set() } = {}) {
  const seen = { opened: 0, released: 0, commits: 0 };
  let next = 0;
  return {
    seen,
    open: async () => {
      seen.opened += 1;
      return {
        harness: { commit: (change, context) => { next += 1; seen.commits += 1; return failOn.has(next) ? Promise.reject(new Error(`commit ${next} refused`)) : harness.commit(change, context); } },
        release: async () => { seen.released += 1; },
      };
    },
  };
}

test('rows commit in the order they were recorded, and flush waits for every one', async () => {
  const harness = await open(new MemoryStorage());
  try {
    const session = sessionOn(harness);
    const writer = createDecisionWriter({ open: session.open });
    for (const node of ['first', 'after', 'later']) writer.record(row(node));
    await writer.flush();
    assert.deepEqual((await readDecisions(harness, ctx)).map((r) => r.node), ['first', 'after', 'later']);
    assert.deepEqual(session.seen, { opened: 1, released: 1, commits: 3 });
  } finally { await harness.close(ctx); }
});

test('a writer that records no row never opens the Session', async () => {
  const opened = [];
  const writer = createDecisionWriter({ open: async () => { opened.push(1); throw new Error('not opened'); } });
  await writer.settled();
  await writer.flush();
  assert.deepEqual(opened, []);
});

test('settled throws the first failed commit and keeps the Session; flush releases it, then throws', async () => {
  const harness = await open(new MemoryStorage());
  try {
    const session = sessionOn(harness, { failOn: new Set([2]) });
    const writer = createDecisionWriter({ open: session.open });
    for (const node of ['first', 'refused', 'later']) writer.record(row(node));
    await assert.rejects(writer.settled(), /commit 2 refused/);
    assert.equal(session.seen.released, 0, 'settled keeps the Session open');
    await assert.rejects(writer.flush(), /commit 2 refused/);
    assert.equal(session.seen.released, 1, 'flush releases the Session although a commit failed');
    // The row after the failed one is still committed, after the one before it.
    assert.deepEqual((await readDecisions(harness, ctx)).map((r) => r.node), ['first', 'later']);
    await writer.flush();
  } finally { await harness.close(ctx); }
});

test('a Session that cannot be opened fails the rows, and settled and flush both report it', async () => {
  let attempts = 0;
  const writer = createDecisionWriter({ open: async () => { attempts += 1; throw new Error('the run file is held elsewhere'); } });
  writer.record(row('first'));
  writer.record(row('after'));
  await assert.rejects(writer.settled(), /held elsewhere/);
  await assert.rejects(writer.flush(), /held elsewhere/);
  // One open, shared by every row: a failed open is not retried per row.
  assert.equal(attempts, 1);
});

const gate = () => { let open; const shut = new Promise((resolve) => { open = resolve; }); return { shut, open }; };

test('a row recorded while flush waits is committed before the Session is released', async () => {
  const harness = await open(new MemoryStorage());
  try {
    const first = gate(), seen = { opened: 0, released: 0 };
    let n = 0;
    const writer = createDecisionWriter({ open: async () => {
      seen.opened += 1;
      return { harness: { commit: async (change, context) => { n += 1; if (n === 1) await first.shut; return harness.commit(change, context); } }, release: async () => { seen.released += 1; } };
    } });
    writer.record(row('first'));
    const flushing = writer.flush();
    await new Promise((resolve) => setImmediate(resolve));
    writer.record(row('while flushing'));
    first.open();
    await flushing;
    assert.deepEqual((await readDecisions(harness, ctx)).map((r) => r.node), ['first', 'while flushing']);
    assert.deepEqual(seen, { opened: 1, released: 1 });
  } finally { await harness.close(ctx); }
});

test('a row recorded while the Session is being released is committed on a Session flush also releases', async () => {
  const harness = await open(new MemoryStorage());
  try {
    const releasing = gate(), seen = { opened: 0, released: 0 };
    let writer;
    writer = createDecisionWriter({ open: async () => {
      const ordinal = (seen.opened += 1);
      return { harness, release: async () => {
        if (ordinal === 1) { writer.record(row('while releasing')); await releasing.shut; }
        seen.released += 1;
      } };
    } });
    writer.record(row('first'));
    const flushing = writer.flush();
    await new Promise((resolve) => setImmediate(resolve));
    releasing.open();
    await flushing;
    assert.deepEqual((await readDecisions(harness, ctx)).map((r) => r.node), ['first', 'while releasing']);
    assert.deepEqual(seen, { opened: 2, released: 2 }, 'every Session the writer opened is released');
  } finally { await harness.close(ctx); }
});

test('flush reports the first failed commit even when releasing the Session also fails, and a failed release alone', async () => {
  const harness = await open(new MemoryStorage());
  try {
    const failing = (failCommit) => createDecisionWriter({ open: async () => ({
      harness: { commit: (change, context) => failCommit ? Promise.reject(new Error('commit refused')) : harness.commit(change, context) },
      release: async () => { throw new Error('release failed'); },
    }) });
    const both = failing(true);
    both.record(row('first'));
    await assert.rejects(both.flush(), /commit refused/);
    const releaseOnly = failing(false);
    releaseOnly.record(row('first'));
    await assert.rejects(releaseOnly.flush(), /release failed/);
  } finally { await harness.close(ctx); }
});

test('a row is stored as it was when recorded, not as the caller later changed it', async () => {
  const harness = await open(new MemoryStorage());
  try {
    const writer = createDecisionWriter({ open: sessionOn(harness).open });
    const recorded = row('first', { answers: { holds: { p_yes: 0.9 } } });
    writer.record(recorded);
    recorded.answers.holds.p_yes = 0.1;
    recorded.node = 'changed';
    await writer.flush();
    const [stored] = await readDecisions(harness, ctx);
    assert.equal(stored.node, 'first');
    assert.deepEqual(stored.answers, { holds: { p_yes: 0.9 } });
  } finally { await harness.close(ctx); }
});

test("the run's file holds the rows where a reader of today's file finds them: a session document, base plus deltas", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentrun-decisions-'));
  try {
    const file = join(dir, 'run.sqlite');
    const harness = await open(await openNodeSqliteStorage(file));
    const rows = [row('first', { error: 'the request was refused' }), row('after', { driver_spend: true, action: { holds: true } }), row('later')];
    try {
      for (const r of rows) await appendDecision(harness, r, ctx);
    } finally { await harness.close(ctx); }

    const value = storedDecisions(file);
    assert.deepEqual(Object.keys(value), ['receipts']);
    assert.deepEqual(value.receipts, rows);
    for (const stored of value.receipts) assert.deepEqual(Object.keys(stored).filter((k) => k !== 'error' && k !== 'driver_spend'), ROW_FIELDS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('row version 1 with the receipt identity and without it: both are stored and read back as written, and a row without it is stored as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentrun-decisions-'));
  try {
    const file = join(dir, 'run.sqlite');
    const harness = await open(await openNodeSqliteStorage(file));
      // A row as a host wrote it before the identity fields, and one that carries all four.
    const before = row('before');
    const identified = row('identified', { execution_path: '/root', decision_id: 'd'.repeat(64), request: { index: 0, count: 1 }, state_sha256: 'a'.repeat(64), run_key: 'run-1' });
    try {
      await appendDecision(harness, before, ctx);
      await appendDecision(harness, identified, ctx);
      assert.deepEqual(await readDecisions(harness, ctx), [before, identified]);
    } finally { await harness.close(ctx); }
    const stored = storedDecisions(file).receipts;
    assert.deepEqual(stored, [before, identified]);
    assert.deepEqual(Object.keys(stored[0]), ROW_FIELDS);
    assert.deepEqual(Object.keys(stored[1]), [...ROW_FIELDS, 'decision_id', 'request', 'state_sha256', 'run_key']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
