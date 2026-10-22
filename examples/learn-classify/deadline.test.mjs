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
import { FIXTURES_V4, readJson } from './scripted.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-deadline-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The scripted v4 parts, with every tool that reads the web never settling for the company `hang` (a CIK), as a stalled
 *  body read does. */
const READERS = new Set(['fetch_page', 'search_web', 'browse', 'read_document']);
function partsHanging(hang) {
  const parts = scriptedParts({ set: SETS.v4 });
  const toolsFor = parts.toolsFor;
  parts.toolsFor = async (job, run) => (await toolsFor(job, run)).map((tool) => (job.cik !== hang || !READERS.has(tool.name) ? tool : {
    ...tool,
    run: () => new Promise(() => {}),
  }));
  return parts;
}
const truth = readJson(join(FIXTURES_V4, 'answers.json'));
const HARBOR = '0000900101';
const SUMMIT = '0000900103';

test('settleWithin: a promise that never settles is rejected at the deadline; one that settles passes through', async () => {
  await assert.rejects(settleWithin(new Promise(() => {}), 50, 'never answered'), /never answered/);
  assert.equal(await settleWithin(Promise.resolve(7), 50, 'late'), 7);
  assert.equal(await settleWithin(Promise.resolve(8), Infinity, 'late'), 8);
});

test('a tool call that never settles is abandoned at the per-call deadline, and the run answers and lands', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = partsHanging(HARBOR);
  parts.callDeadlineMs = 300;
  const { rows } = await runLoop({ out, parts, split: 'run', list: [{ cik: HARBOR }, { cik: SUMMIT }], record: false });
  const sic4 = (cik) => truth[parts.companies.find((c) => c.cik === cik).name].sic4;
  assert.deepEqual(rows.map((r) => [r.cik, r.answer, r.infraFailed]), [[HARBOR, sic4(HARBOR), false], [SUMMIT, sic4(SUMMIT), false]]);
});

test('a run past its wall-clock deadline ends unanswered, is run again once as an infrastructure failure, and the stream goes on', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = partsHanging(HARBOR);
  parts.callDeadlineMs = Infinity;
  parts.runDeadlineMs = 400;
  const { rows } = await runLoop({ out, parts, split: 'run', list: [{ cik: HARBOR }, { cik: SUMMIT }], record: false });
  const [first, second] = rows;
  assert.deepEqual([first.cik, first.answer, first.infraFailed, first.rerunOf], [HARBOR, null, true, 'run-001']);
  const progress = JSON.parse(readFileSync(join(out, 'progress', 'run-001.json'), 'utf8'));
  assert.deepEqual(progress.infraFailed.map((f) => f.reason), ['deadline']);
  assert.equal(second.cik, SUMMIT);
});
