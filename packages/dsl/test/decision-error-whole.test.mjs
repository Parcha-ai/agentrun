// A decision receipt keeps its request's error whole, up to 64 KB: a host redacts it before it cuts it for a person, and
// a cut made here first could split a secret the error quoted. A longer one is cut at 64 KB and says so
// (error_truncated), so the host holds its tail back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorkflow } from '../dist/index.js';

const SCHEMAS = {
  Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
  Check: { type: 'object', required: ['legit'], properties: { legit: { type: 'boolean', description: 'Is this filing a legitimate certificate of incorporation?' } } },
};
const doc = { v: 2, name: 'decision-error-whole', schemas: SCHEMAS, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [{ node: 'judge', label: 'check', state: { text: '{text}' }, out: 'Check', as: 'check' }, { node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' }] } };

async function receiptOf(message) {
  const receipts = [];
  await runWorkflow(doc, { text: 'a filing' }, { runJudge: async () => { throw new Error(message); }, recordDecision: async (receipt) => { receipts.push(receipt); } }).catch(() => {});
  assert.equal(receipts.length, 1, JSON.stringify(receipts.map((r) => r.status)));
  return receipts[0];
}

test("a decision's error of 5 KB is kept whole, not cut at 2000", async () => {
  const message = `refused ${'x'.repeat(5000)} end`;
  const receipt = await receiptOf(message);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error, message);
  assert.equal(receipt.error_truncated, undefined);
});

test("a decision's error past 64 KB is kept to 64 KB and marked error_truncated", async () => {
  const receipt = await receiptOf(`refused ${'x'.repeat(70_000)}`);
  assert.equal(receipt.error.length, 65_536);
  assert.equal(receipt.error_truncated, true);
});
