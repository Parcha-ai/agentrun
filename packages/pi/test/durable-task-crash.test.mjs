// The workflow task killed at each point that matters and resumed by a process that only opens the file, installs the
// extension and calls resume(); then a start of the same key again. A counting server is the paid effect.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const child = fileURLToPath(new URL('./fixtures/durable-task-child.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'agentrun-durable-task-crash-'));
let server, url, paid = 0;
before(async () => {
  server = http.createServer((req, res) => { if (req.url === '/effect') paid += 1; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ price: 21 })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

const run = (mode, file, killAt = '', env = {}) => new Promise((resolve) => {
  const proc = spawn(process.execPath, [child, mode, file], { env: { ...process.env, COUNT_URL: url, KILL_AT: killAt, ...env } });
  let out = '', err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('close', (code, signal) => resolve({ exit: signal ?? code, err, rows: out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }));
});
const pick = (result, key) => result.rows.find((row) => row[key] !== undefined)?.[key];

const COMPLETE = { status: 'complete', total: 42 };
const UNKNOWN = { status: 'refused', code: 'FROZEN_EFFECT_UNKNOWN' };
const brief = (outcome) => outcome?.status === 'completed' ? { status: 'complete', total: outcome.result.output.total }
  : outcome?.status === 'failed' ? { status: 'refused', code: outcome.error.detail.code } : outcome;
const rows = [
  // [kill point, paid by the first process, outcome after resume() alone, paid in all, a later start reaches the same task]
  ['none', 1, COMPLETE, 1, true],
  ['after-admit', 0, UNKNOWN, 0, false],
  ['after-dispatch', 1, UNKNOWN, 1, false],
  ['after-complete', 1, COMPLETE, 1, true],
  ['before-terminal', 1, COMPLETE, 1, true],
];

for (const [point, firstPaid, resumed, totalPaid, sameTask] of rows) {
  test(`killed at ${point}: resume() alone ends it ${resumed.status}, and a later start of the key pays nothing more`, async () => {
    paid = 0;
    const file = join(mkdtempSync(join(root, `${point}-`)), 'run.sqlite');
    const first = await run('start', file, point === 'none' ? '' : point);
    assert.equal(first.exit, point === 'none' ? 0 : 'SIGKILL', first.err);
    const task = pick(first, 'task');
    assert.equal(paid, firstPaid);
    const second = await run('resume', file);
    assert.equal(second.exit, 0, second.err);
    assert.deepEqual(pick(second, 'live'), point === 'none' ? [] : ['agentrun.workflow:pending']);
    const settled = pick(second, 'resumed');
    assert.deepEqual([settled.id, settled.status, brief(settled.outcome)], [task, 'terminal', resumed]);
    assert.equal(paid, totalPaid);
    // A terminal complete is returned as it is; a terminal refusal gets a new task over the same journal, which
    // refuses again until the host reconciles it. Neither pays again.
    const again = await run('start', file);
    assert.equal(again.exit, 0, again.err);
    assert.deepEqual([pick(again, 'started'), pick(again, 'task') === task], [sameTask ? 'settled' : 'created', sameTask]);
    assert.deepEqual(brief(pick(again, 'record').outcome), resumed);
    assert.equal(paid, totalPaid);
  });
}

test('killed after dispatch: a host that completes the unknown effect in options resumes the run to its end, and nothing is dispatched again', async () => {
  paid = 0;
  const file = join(mkdtempSync(join(root, 'settled-')), 'run.sqlite');
  const first = await run('start', file, 'after-dispatch');
  assert.equal(first.exit, 'SIGKILL', first.err);
  const task = pick(first, 'task');
  assert.equal(paid, 1);
  // The host learned what the call did; the price is one the server never answers, so the total shows the run took it.
  const second = await run('resume', file, '', { SETTLE: JSON.stringify({ price: 50 }) });
  assert.equal(second.exit, 0, second.err);
  assert.equal(second.rows.filter((row) => row.settled !== undefined).length, 1);
  const settled = pick(second, 'resumed');
  assert.deepEqual([settled.id, settled.status, brief(settled.outcome)], [task, 'terminal', { status: 'complete', total: 100 }]);
  assert.equal(paid, 1);
});
