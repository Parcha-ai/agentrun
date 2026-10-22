// A run must end, and the pass go on, whatever a tool or a model awaits: a tool call that never settles is abandoned as a
// failed call at the host's per-call deadline, and a run past its wall-clock deadline ends unanswered ('deadline'), is run
// again once as an infrastructure failure, and never ends the stream.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { settleWithin } from './host.mjs';
import { runLoop, scriptedParts } from './runner.mjs';
import { FIXTURES_MCC } from './scripted-mcc.mjs';
import { teacherLabelsOf } from './mcc.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-deadline-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The scripted MCC parts, with fetch_page never settling for `hang` (a URL), as a stalled body read does. */
function partsHanging(hang) {
  const parts = scriptedParts({ set: SETS.mcc });
  const labels = teacherLabelsOf(join(FIXTURES_MCC, 'teacher.json'));
  for (const m of parts.companies) Object.assign(m, labels.get(m.cik) ?? { teacher: null, stratum: null });
  const toolsFor = parts.toolsFor;
  parts.toolsFor = async (job, run) => (await toolsFor(job, run)).map((tool) => (tool.name !== 'fetch_page' ? tool : {
    ...tool,
    run: (args, options) => (args?.url === hang ? new Promise(() => {}) : tool.run(args, options)),
  }));
  return parts;
}

test('settleWithin: a promise that never settles is rejected at the deadline; one that settles passes through', async () => {
  await assert.rejects(settleWithin(new Promise(() => {}), 50, 'never answered'), /never answered/);
  assert.equal(await settleWithin(Promise.resolve(7), 50, 'late'), 7);
  assert.equal(await settleWithin(Promise.resolve(8), Infinity, 'late'), 8);
});

test('a tool call that never settles is abandoned at the per-call deadline, and the run answers and lands', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = partsHanging('https://lumencandle.example/');
  parts.callDeadlineMs = 300;
  const { rows } = await runLoop({ out, parts, split: 'train', list: [{ id: 'm-001' }, { id: 'm-003' }], record: false });
  assert.deepEqual(rows.map((r) => [r.merchantId, r.answer, r.infraFailed]), [['m-001', '5999', false], ['m-003', '5993', false]]);
});

test('a run past its wall-clock deadline ends unanswered, is run again once as an infrastructure failure, and the stream goes on', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = partsHanging('https://lumencandle.example/');
  parts.callDeadlineMs = Infinity;
  parts.runDeadlineMs = 400;
  const { rows } = await runLoop({ out, parts, split: 'train', list: [{ id: 'm-001' }, { id: 'm-003' }], record: false });
  const [first, second] = rows;
  assert.deepEqual([first.merchantId, first.answer, first.infraFailed, first.rerunOf], ['m-001', null, true, 'run-001']);
  const progress = JSON.parse(readFileSync(join(out, 'progress', 'run-001.json'), 'utf8'));
  assert.deepEqual(progress.infraFailed.map((f) => f.reason), ['deadline']);
  assert.equal(second.merchantId, 'm-003');
});
