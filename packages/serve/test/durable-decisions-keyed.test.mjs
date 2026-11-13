// The decision rows as a keyed document family: one document per receipt, written once, so a recording's decisions
// lines grow with the number of questions and not with its square; the same rows read back in the same order.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { apply } from '@earendil-works/chord/delta';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DECISION_RECEIPTS_DOC, DECISION_ROW_VERSION, appendDecision, readDecisions } from '../dist/workflow/decisions.js';
import { decisionRecovery } from '../dist/workflow/decision-recovery.js';

const root = mkdtempSync(join(tmpdir(), 'agentrun-decisions-keyed-'));
after(() => rmSync(root, { recursive: true, force: true }));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const fileOf = () => join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
const open = async (file) => Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: createModels() }, ctx);

// What a receipt weighs on the wire is part of the claim, so a row is the size a real one is (about 0.9 KB).
const row = (i, extra = {}) => ({
  v: DECISION_ROW_VERSION, at: '2026-10-21T00:00:00.000Z', node: 'pick', kind: 'judge', item: i, execution_path: `/root/steps/0/items/${i}/body/steps/1`, request_sha256: null,
  request_bytes: 221, model: null, questions: { label: { type: 'choice', instructions: 'Which one fits best?', criteria: { a: 'The value starts with an even digit.', b: 'The value starts with an odd digit.', c: 'The value is empty.' } } },
  answers: { label: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.1, c: 0.1 }, confidence: 0.8 } }, rule: { kind: 'judge' }, action: { label: 'a' },
  usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0, latency_ms: 3, decision_id: `d${i}`, request: { index: 0, count: 1 }, state_sha256: 'f'.repeat(64), run_key: 'run-1', ...extra,
});
/** The documents of one kind the file holds: [singleton count, family count]. */
function documentsOf(file, kind) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (family) => db.prepare('SELECT COUNT(*) AS n FROM documents WHERE kind = ? AND family = ? AND retired_at IS NULL').get(JSON.stringify(kind), family).n;
    return { single: count(0), family: count(1) };
  } finally { db.close(); }
}
/** Every revision of the file's decision documents, in commit order, as a recording line carries one: its kind, and its
 *  document's kind, key (a family member's), whole value and version. */
function decisionLines(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const revisions = db.prepare("SELECT d.id, d.kind AS doc, d.family, d.key_value, r.seq, r.kind, r.version, r.content FROM documents d JOIN document_revisions r ON r.document_id = d.id WHERE d.kind LIKE '\"agentrun.decisions%' ORDER BY r.seq").all();
    const values = new Map();
    return revisions.map((rev) => {
      const value = rev.kind === 'base' ? JSON.parse(rev.content) : apply(structuredClone(values.get(rev.id)), JSON.parse(rev.content));
      values.set(rev.id, value);
      const kind = JSON.parse(rev.doc);
      return { kind, data: { doc: kind, ...(rev.family === 1 ? { key: JSON.parse(rev.key_value) } : {}), value, version: rev.version } };
    });
  } finally { db.close(); }
}
const decisionBytes = (file) => decisionLines(file).filter((line) => String(line.kind).startsWith('agentrun.decisions')).reduce((sum, line) => sum + JSON.stringify(line).length, 0);

async function fill(n) {
  const file = fileOf();
  const harness = await open(file);
  try { for (let i = 0; i < n; i += 1) await appendDecision(harness, row(i), ctx); } finally { await harness.close(ctx); }
  return file;
}

test('red first, size: the decisions lines of a recording grow linearly with the questions, not with their square', async () => {
  const per = {};
  for (const n of [25, 100, 200]) per[n] = decisionBytes(await fill(n)) / n;
  // Today one row costs 0.43 KB x N on average (a whole list per commit): 4.3 KB at 25 ... 85 KB at 200. Linear: the same at every N.
  assert.ok(per[200] <= per[25] * 1.2, `bytes per question: ${JSON.stringify(per)}`);
  assert.ok(per[200] < 3000, `one question costs ${Math.round(per[200])} bytes in the recording`);
});

test('a fresh store writes the keyed family only: one document per row, no single document, rows read back in the order they were recorded', async () => {
  const file = await fill(12);
  assert.deepEqual(documentsOf(file, DECISION_RECEIPTS_DOC), { single: 0, family: 12 });
  const harness = await open(file);
  try { assert.deepEqual((await readDecisions(harness, ctx)).map((r) => r.decision_id), Array.from({ length: 12 }, (_, i) => `d${i}`)); } finally { await harness.close(ctx); }
});

const receipt = (i) => ({
  v: 1, id: `d${i}`, at: '2026-10-21T00:00:00.000Z', node: 'pick', kind: 'judge', item: i, execution_path: `/root/steps/0/items/${i}/body/steps/1`, request: { index: 0, count: 1 }, status: 'answered',
  state_sha256: 'f'.repeat(64), questions: row(i).questions, answers: row(i).answers, rule: { kind: 'judge' }, action: { label: 'a' }, model: null, usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0,
  request_sha256: null, latency_ms: 3,
});
const exchange = { request: { state: { v: '1' }, questions: row(0).questions } };
const runtimeOf = (harness) => ({ commit: (change, context) => harness.commit(change, context), snapshot: (...args) => harness.snapshot(...args) });

{
  test('a resumed run answers a question from its receipt with no new judge call, and its own rows only', async () => {
    const file = fileOf();
    let harness = await open(file);
    try {
      const first = decisionRecovery({ key: 'run-1', runtime: runtimeOf(harness), context: ctx });
      for (let i = 0; i < 5; i += 1) await first.recordDecision(receipt(i), exchange);
    } finally { await harness.close(ctx); }
    harness = await open(file);
    try {
      const resumed = decisionRecovery({ key: 'run-1', runtime: runtimeOf(harness), context: ctx });
      for (let i = 0; i < 5; i += 1) assert.deepEqual(await resumed.decision(`d${i}`), receipt(i), `d${i} answered from its row`);
      assert.equal(await resumed.decision('dx'), undefined, "another run's row never answers");
      // A row recorded after the first read is found too.
      await resumed.recordDecision(receipt(5), exchange);
      assert.deepEqual(await resumed.decision('d5'), receipt(5));
      assert.deepEqual(documentsOf(file, DECISION_RECEIPTS_DOC), { single: 0, family: 6 });
    } finally { await harness.close(ctx); }
  });
}
