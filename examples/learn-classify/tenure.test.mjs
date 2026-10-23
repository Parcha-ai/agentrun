// D (--trial-tenure): pi-agent-learn's workflowAdmitter({ tenure }) wired into the lane runner. The host says where each
// run started (the main commit it was prepared from and its place in the start order) and which runs are in flight: every
// run whose curation has not committed, a run that ends without reaching curate (an infrastructure failure, a deadline,
// an abandoned attempt) leaving at its end. Without the flag every curate is as before.
import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLoop, scriptedParts } from './runner.mjs';
import { teacherLabelsOf } from './mcc.mjs';
import { FIXTURES_MCC } from './scripted-mcc.mjs';
import { SETS } from './sets.mjs';
import { tenureTracker } from './tenure.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-tenure-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the tracker: each run started gets its main commit and the next place in the start order; it leaves inFlight() when it ends', () => {
  const tracker = tenureTracker();
  tracker.start('run-001', 'a'.repeat(40));
  tracker.start('run-002', 'b'.repeat(40));
  assert.deepEqual([tracker.started('run-001'), tracker.started('run-002')], [{ sha: 'a'.repeat(40), order: 0 }, { sha: 'b'.repeat(40), order: 1 }]);
  assert.deepEqual(tracker.inFlight(), ['run-001', 'run-002']);
  tracker.end('run-001', 'curated');
  assert.deepEqual(tracker.inFlight(), ['run-002']);
  assert.equal(tracker.started('run-003'), undefined, 'a run the host did not start');
  assert.deepEqual(tracker.events.map((e) => [e.event, e.run, e.why ?? null]), [['start', 'run-001', null], ['start', 'run-002', null], ['end', 'run-001', 'curated']]);
});

/** The scripted MCC parts with teacher labels joined; `hang` (a URL) makes fetch_page never settle there. */
function partsOf(data, { hang } = {}) {
  const parts = scriptedParts({ set: SETS.mcc, ...(data ? { data } : {}) });
  const labels = teacherLabelsOf(join(data ?? FIXTURES_MCC, 'teacher.json'));
  for (const m of parts.companies) Object.assign(m, labels.get(m.cik) ?? { teacher: null, stratum: null });
  if (hang) {
    const toolsFor = parts.toolsFor;
    parts.toolsFor = async (job, run) => (await toolsFor(job, run)).map((tool) => (tool.name !== 'fetch_page' ? tool : { ...tool, run: (args, options) => (args?.url === hang ? new Promise(() => {}) : tool.run(args, options)) }));
  }
  return parts;
}

test('a run that ends without reaching curate (past its deadline) leaves inFlight() at its end, before its attempt again starts', async (t) => {
  const out = join(await scratch(t), 'out');
  const parts = partsOf(undefined, { hang: 'https://lumencandle.example/' });
  Object.assign(parts, { callDeadlineMs: Infinity, runDeadlineMs: 400, trialTenure: true });
  const tracker = tenureTracker();
  await runLoop({ out, parts, split: 'train', list: [{ id: 'm-001' }, { id: 'm-003' }], record: false, tenure: tracker });
  const events = tracker.events.map((e) => `${e.event} ${e.run}${e.why ? ` (${e.why})` : ''}`);
  const ended = events.indexOf('end run-001 (ended without curate)');
  assert.ok(ended >= 0 && ended < events.indexOf('start run-001-a2'), events.join('\n'));
  assert.deepEqual(tracker.inFlight(), [], 'every run left at its end');
});

/** A stream in which every run the agent finishes saves a new revision (saveEvery), `n` merchants, `concurrency` in flight. */
async function churnStream(t, { tenure, concurrency = 12 }) {
  const root = await scratch(t);
  const data = join(root, 'data');
  await cp(FIXTURES_MCC, data, { recursive: true });
  const answers = JSON.parse(await readFile(join(data, 'answers.json'), 'utf8'));
  for (const name of Object.keys(answers)) answers[name].saveEvery = true;
  await writeFile(join(data, 'answers.json'), JSON.stringify(answers, null, 2));
  const parts = partsOf(data);
  Object.assign(parts, { thresholds: { promoteAfter: 2 }, ...(tenure ? { trialTenure: true } : {}) });
  const list = ['m-001', 'm-003', 'm-005', 'm-006', 'm-007', 'm-008', 'm-010', 'm-002', 'm-004', 'm-009', 'm-001', 'm-003'].map((id, i, all) => ({ id, epoch: all.slice(0, i).filter((x) => x === id).length + 1 }));
  const tracker = tenureTracker();
  const { rows } = await runLoop({ out: join(root, 'out'), parts, split: 'train', list, record: false, concurrency, ...(tenure ? { tenure: tracker } : {}) });
  const held = rows.flatMap((r) => (r.curate?.held ?? []).filter((h) => h.workflow).map((h) => ({ run: r.run, reason: h.reason })));
  return { rows, held, tracker };
}

test('12 in flight, every finished run saving: with the flag, saves from runs that started before the live trial, or behind earlier runs still in flight, are held; without it, none', async (t) => {
  const on = await churnStream(t, { tenure: true });
  const off = await churnStream(t, { tenure: false });
  assert.equal(on.rows.length, 12);
  const tenureHolds = on.held.filter((h) => /started before the live trial|keeps its tenure/.test(h.reason));
  assert.ok(tenureHolds.length >= 1, JSON.stringify(on.held));
  // The C-a2 churn case: a save from a run that started before the trial now live never replaces it.
  assert.ok(on.held.some((h) => /started before the live trial/.test(h.reason)), JSON.stringify(on.held));
  assert.equal(off.held.filter((h) => /started before the live trial|keeps its tenure/.test(h.reason)).length, 0, 'without the flag, no tenure');
  assert.deepEqual(on.tracker.inFlight(), [], 'every run left inFlight() when its curation committed');
  assert.equal(on.tracker.events.filter((e) => e.event === 'start').length, 12);
});
