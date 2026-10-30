// A decision row names the admission its request was sent under, and the row is that admission's settlement: stored with
// the row in one commit, read back with it, so a reader that sees the row sees the admission settled. A row without one
// is unchanged.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DECISION_ROW_VERSION, appendDecision, readDecisions } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-decisions-admission-'));
after(() => rmSync(root, { recursive: true, force: true }));
const open = async (file) => Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: {} }, ctx);
const row = (extra = {}) => ({
  v: DECISION_ROW_VERSION, at: '2026-10-28T00:00:00.000Z', node: 'page guard', kind: 'judge', item: null, execution_path: null, request_sha256: 'a'.repeat(64),
  request_bytes: 4000, model: 'jev-1.14.0', questions: {}, answers: {}, rule: null, action: null, usage: { input_tokens: 1000, output_tokens: 0 }, cost_usd: 0.000042, latency_ms: 5, ...extra,
});

test('a row names the admission its request was sent under, and is read back naming it; a row without one is unchanged', async () => {
  const file = join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
  const harness = await open(file);
  try {
    await appendDecision(harness, row({ admission: 'question:page guard:1:ab12cd34' }), ctx);
    await appendDecision(harness, row(), ctx);
    const rows = await readDecisions(harness, ctx);
    assert.deepEqual(rows.map((stored) => stored.admission), ['question:page guard:1:ab12cd34', undefined]);
  } finally { await harness.close(ctx); }
  // Read again from the file in a fresh process's Harness: the admission is the row's, durable with it.
  const again = await open(file);
  try { assert.equal((await readDecisions(again, ctx))[0].admission, 'question:page guard:1:ab12cd34'); } finally { await again.close(ctx); }
});
