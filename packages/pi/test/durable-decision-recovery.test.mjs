// decisionRecovery: a workflow task's decision receipts as rows committed through the task's own commit, and a resumed
// run answered from them. The task is killed once a decision's row is durable and before its answer reaches the run's
// state; a counting server is the paid judge, and it answers differently when asked again.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DECISION_ROW_VERSION, appendDecision, decisionRecovery, readDecisions } from '@parcha/agentrun-pi/durable';

const child = fileURLToPath(new URL('./fixtures/durable-decision-child.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'agentrun-decision-recovery-'));
let server, url, judged = 0;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/judge') judged += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers: { urgent: { type: 'noul', noul: judged === 1 ? 0.9 : 0.1 } }, model: 'counting-judge', usage: null, cost_usd: 0.01 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

const run = (mode, file, env = {}) => new Promise((resolve) => {
  const proc = spawn(process.execPath, [child, mode, file], { env: { ...process.env, COUNT_URL: url, KILL_AT: '', ...env } });
  let out = '', err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('close', (code, signal) => resolve({ exit: signal ?? code, err, rows: out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }));
});
const pick = (result, key) => result.rows.find((row) => row[key] !== undefined)?.[key];
const all = (result, key) => result.rows.filter((row) => row[key] !== undefined).map((row) => row[key]);
const output = (ended) => (ended?.outcome?.status === 'completed' ? ended.outcome.result.output : ended?.outcome);

test('killed between a decision\'s commit and its use: the resumed run decides what it decided, the judge is asked once, and no second row is written', async () => {
  judged = 0;
  const file = join(mkdtempSync(join(root, 'replay-')), 'run.sqlite');
  const first = await run('start', file, { KILL_AT: 'after-decision' });
  assert.equal(first.exit, 'SIGKILL', first.err);
  const receipt = pick(first, 'receipt');
  assert.deepEqual([judged, receipt.status, receipt.action], [1, 'answered', { urgent: true }]);
  const second = await run('resume', file);
  assert.equal(second.exit, 0, second.err);
  const task = pick(first, 'task');
  const ended = pick(second, 'ended');
  assert.deepEqual([ended.id, ended.status, output(ended)], [task, 'terminal', { urgent: true }]);
  assert.equal(judged, 1);
  // The replayed decision is not recorded again, and its row is the whole receipt.
  assert.deepEqual(all(second, 'receipt'), []);
  const rows = pick(second, 'rows');
  assert.deepEqual(rows.map((row) => [row.v, row.decision_id, row.node, row.kind]), [[DECISION_ROW_VERSION, receipt.id, 'triage', 'judge']]);
  assert.deepEqual(pick(second, 'rebuilt'), [receipt]);
});

test('killed at the same point, a host that does not answer from its rows asks the judge again and decides otherwise', async () => {
  judged = 0;
  const file = join(mkdtempSync(join(root, 'asked-')), 'run.sqlite');
  const first = await run('start', file, { KILL_AT: 'after-decision', REPLAY: '0' });
  assert.equal(first.exit, 'SIGKILL', first.err);
  const second = await run('resume', file, { REPLAY: '0' });
  assert.equal(second.exit, 0, second.err);
  assert.deepEqual([judged, output(pick(second, 'ended'))], [2, { urgent: false }]);
  // The same request asked again carries the same id.
  assert.deepEqual(pick(second, 'rows').map((row) => row.decision_id), [pick(first, 'receipt').id, pick(first, 'receipt').id]);
});

const receiptOf = (id, extra = {}) => ({
  v: 1, id, at: '2026-10-13T00:00:00.000Z', node: 'triage', kind: 'judge', item: null, execution_path: '/root/steps/0', request: { index: 0, count: 1 },
  status: 'answered', state_sha256: 'a'.repeat(64), questions: { urgent: { type: 'noul', instructions: 'Is the request urgent?' } },
  answers: { urgent: { type: 'noul', noul: 0.9 } }, rule: { kind: 'judge' }, action: { urgent: true }, model: 'm', usage: { input_tokens: 5, output_tokens: 1 },
  cost_usd: 0.01, request_sha256: null, latency_ms: 3, ...extra,
});
const exchange = { request: { state: { request: 'The server room is flooding.' }, questions: { urgent: { type: 'noul', instructions: 'Is the request urgent?' } } } };

test('decisionRecovery: rows commit in the order they are recorded; only an answered row recorded with its id answers, and the last one wins', async () => {
  const harness = await Harness.open(await openNodeSqliteStorage(join(mkdtempSync(join(root, 'rows-')), 'run.sqlite')), { registry: createRegistry(), models: {} }, ctx);
  // The first commit is the slowest, and the rows still land in the order they were recorded.
  let commits = 0;
  const runtime = {
    commit: async (change, context) => { commits += 1; if (commits === 1) await new Promise((resolve) => setTimeout(resolve, 50)); return harness.commit(change, context); },
    snapshot: (...args) => harness.snapshot(...args),
  };
  const decisions = decisionRecovery(runtime, ctx);
  const failed = receiptOf('b', { status: 'failed', answers: {}, rule: null, action: null, error: 'the judge refused' });
  const later = receiptOf('d', { answers: { urgent: { type: 'noul', noul: 0.2 } }, action: { urgent: false }, latency_ms: 9 });
  await Promise.all([decisions.recordDecision(receiptOf('a'), exchange), decisions.recordDecision(failed, exchange), decisions.recordDecision(receiptOf('d'), exchange)]);
  // A row with the receipt's id and without its place and state digest is not the whole receipt: stored, never answering.
  const { id: _, status: _s, request: _r, state_sha256: _d, ...bare } = receiptOf('c');
  await appendDecision(harness, { ...bare, v: DECISION_ROW_VERSION, request_bytes: 0, decision_id: 'c' }, ctx);
  await decisions.recordDecision(later, exchange);
  const rows = await readDecisions(harness, ctx);
  assert.deepEqual(rows.map((row) => row.decision_id ?? null), ['a', 'b', 'd', 'c', 'd']);
  assert.equal(rows[0].request_bytes, Buffer.byteLength(JSON.stringify({ state: exchange.request.state, questions: exchange.request.questions })));
  assert.deepEqual(await decisions.decision('a'), receiptOf('a'));
  assert.equal(await decisions.decision('b'), undefined);
  assert.equal(await decisions.decision('c'), undefined);
  assert.deepEqual(await decisions.decision('d'), later);
  assert.equal(await decisions.decision('e'), undefined);
  await harness.close(ctx);
});
