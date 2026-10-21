// The decision rows as a keyed document family: one document per receipt, written once, so a recording's decisions
// lines grow with the number of questions and not with its square; the same rows read back in the same order; a store
// that holds the old single document keeps that form to the end of its run (one form per recording).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, defineDoc, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DECISION_RECEIPTS_DOC, DECISION_ROW_VERSION, appendDecision, decisionRecovery, durableDecisions, readDecisions, recordingLines } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-decisions-keyed-'));
after(() => rmSync(root, { recursive: true, force: true }));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const fileOf = () => join(mkdtempSync(join(root, 'run-')), 'run.sqlite');
const open = async (file) => Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: {} }, ctx);

// What a receipt weighs on the wire is part of the claim, so a row is the size a real one is (about 0.9 KB).
const row = (i, extra = {}) => ({
  v: DECISION_ROW_VERSION, at: '2026-10-21T00:00:00.000Z', node: 'pick', kind: 'judge', item: i, execution_path: `/root/steps/0/items/${i}/body/steps/1`, request_sha256: null,
  request_bytes: 221, model: null, questions: { label: { type: 'choice', instructions: 'Which one fits best?', criteria: { a: 'The value starts with an even digit.', b: 'The value starts with an odd digit.', c: 'The value is empty.' } } },
  answers: { label: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.1, c: 0.1 }, confidence: 0.8 } }, rule: { kind: 'judge' }, action: { label: 'a' },
  usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0, latency_ms: 3, decision_id: `d${i}`, request: { index: 0, count: 1 }, state_sha256: 'f'.repeat(64), run_key: 'run-1', ...extra,
});
// The old form, as a store that holds it has it: one session document whose receipts list is rewritten at every commit.
const OldDoc = defineDoc({ kind: DECISION_RECEIPTS_DOC, version: 1, scope: 'session', initial: () => ({ receipts: [] }) });
const seedOld = (harness, rows) => harness.commit(async (tx) => { const doc = await tx.doc(OldDoc); for (const stored of rows) doc.receipts.push(JSON.parse(JSON.stringify(stored))); }, ctx);

/** The documents of one kind the file holds: [singleton count, family count]. */
function documentsOf(file, kind) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (family) => db.prepare('SELECT COUNT(*) AS n FROM documents WHERE kind = ? AND family = ? AND retired_at IS NULL').get(JSON.stringify(kind), family).n;
    return { single: count(0), family: count(1) };
  } finally { db.close(); }
}
const decisionBytes = (file) => recordingLines(file).lines.filter((line) => String(line.kind).startsWith('agentrun.decisions')).reduce((sum, line) => sum + JSON.stringify(line).length, 0);

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

test('a row stored keyed is, field for field and byte for byte, the receipt the old list held', async () => {
  const keyed = await fill(3);
  const oldFile = fileOf();
  const harness = await open(oldFile);
  try { await seedOld(harness, [row(0), row(1), row(2)]); } finally { await harness.close(ctx); }
  const read = async (file) => { const h = await open(file); try { return await readDecisions(h, ctx); } finally { await h.close(ctx); } };
  assert.deepEqual((await read(keyed)).map((r) => JSON.stringify(r)), (await read(oldFile)).map((r) => JSON.stringify(r)));
  // In the recording: the keyed line's value is exactly one element of the old line's receipts list.
  const newLines = recordingLines(keyed).lines.filter((line) => line.kind === 'agentrun.decisions');
  const oldLast = recordingLines(oldFile).lines.filter((line) => line.kind === 'agentrun.decisions').at(-1);
  assert.equal(newLines.length, 3);
  newLines.forEach((line, i) => { assert.equal(typeof line.data.key, 'string'); assert.equal(JSON.stringify(line.data.value), JSON.stringify(oldLast.data.value.receipts[i])); });
});

test('an old-shape store keeps its form: new rows go to the old document, no family document is made, no receipt is lost', async () => {
  const file = fileOf();
  const harness = await open(file);
  try {
    await seedOld(harness, [row(0), row(1)]);
    await appendDecision(harness, row(2), ctx);
    await appendDecision(harness, row(3), ctx);
    assert.deepEqual((await readDecisions(harness, ctx)).map((r) => r.decision_id), ['d0', 'd1', 'd2', 'd3']);
  } finally { await harness.close(ctx); }
  assert.deepEqual(documentsOf(file, DECISION_RECEIPTS_DOC), { single: 1, family: 0 });
  assert.deepEqual(documentsOf(file, 'agentrun.decisions.count'), { single: 0, family: 0 });
  // A process that opens the store again still finds the old form, and still writes it.
  const again = await open(file);
  try { await appendDecision(again, row(4), ctx); assert.equal((await readDecisions(again, ctx)).length, 5); } finally { await again.close(ctx); }
  assert.deepEqual(documentsOf(file, DECISION_RECEIPTS_DOC), { single: 1, family: 0 });
});

const receipt = (i) => ({
  v: 1, id: `d${i}`, at: '2026-10-21T00:00:00.000Z', node: 'pick', kind: 'judge', item: i, execution_path: `/root/steps/0/items/${i}/body/steps/1`, request: { index: 0, count: 1 }, status: 'answered',
  state_sha256: 'f'.repeat(64), questions: row(i).questions, answers: row(i).answers, rule: { kind: 'judge' }, action: { label: 'a' }, model: null, usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0,
  request_sha256: null, latency_ms: 3,
});
const exchange = { request: { state: { v: '1' }, questions: row(0).questions } };
const runtimeOf = (harness) => ({ commit: (change, context) => harness.commit(change, context), snapshot: (...args) => harness.snapshot(...args) });

for (const form of ['keyed', 'old']) {
  test(`a resumed run answers a question from its receipt with no new judge call (${form} form), and its own rows only`, async () => {
    const file = fileOf();
    let harness = await open(file);
    try {
      if (form === 'old') await seedOld(harness, [row(0, { run_key: 'run-other', decision_id: 'dx' })]);
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
      assert.deepEqual(documentsOf(file, DECISION_RECEIPTS_DOC), form === 'old' ? { single: 1, family: 0 } : { single: 0, family: 6 });
    } finally { await harness.close(ctx); }
  });
}

test('durableDecisions reads the rows of a store file in commit order in either form, never the empty list of the wrong one', async () => {
  const keyed = await fill(30);
  assert.deepEqual(durableDecisions(keyed).map((r) => r.decision_id), Array.from({ length: 30 }, (_, i) => `d${i}`));
  const oldFile = fileOf();
  const harness = await open(oldFile);
  try { await seedOld(harness, [row(0), row(1)]); await appendDecision(harness, row(2), ctx); } finally { await harness.close(ctx); }
  assert.deepEqual(durableDecisions(oldFile).map((r) => r.decision_id), ['d0', 'd1', 'd2']);
  assert.deepEqual(durableDecisions(join(root, 'no-such-file.sqlite')), []);
});
