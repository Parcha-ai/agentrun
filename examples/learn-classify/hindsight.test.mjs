// Hindsight lessons at $0: a scripted v4 pass whose first run answers the code wrong, a scripted reflection that checks the
// Wayback copy of the filing's index and writes two hypotheses, and what reaches curate; never on a right field, a DEV
// or sealed pass, or twice for one field.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HINDSIGHT_SPLITS, MAX_REFLECTION_USD, reflect, reflectOnRun, wrongFields } from './hindsight.mjs';
import { readRows, runLoop, runSealed, scriptedParts } from './runner.mjs';
import { FIXTURES_V4, readJson, scriptedModel } from './scripted.mjs';
import { SETS } from './sets.mjs';
import { ANY_HOST, fetchPageTool } from './tools.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-hindsight-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const HARBOR = 'Harbor Valve Works Inc.';
const INDEX = 'https://web.archive.org/web/2026id_/https://www.sec.gov/Archives/edgar/data/900101/000090010126000001/0000900101-26-000001-index.htm';
const LESSON = 'The SEC files a registrant\'s SIC code in its EDGAR filing index; read it from the Wayback Machine\'s copy of that page before choosing a code by revenue.';
const HYPOTHESES = [
  { lesson: LESSON, why: `${HARBOR} answered 3562 from its product line, but the SEC files it under 3561.`, whereReadable: 'the EDGAR filing index of its 10-K, archived', scope: 'every SEC registrant', mechanism: 'workflow-node', test: 'replay the code step on past runs with the index read first' },
  { lesson: 'Pump makers are filed under 3561.', why: 'the code was chosen by product', whereReadable: 'the filing index', scope: 'pump makers', mechanism: 'lesson', test: 'replay on pump makers' },
];

/** The v4 fixtures with the first company's answer on the wrong code. */
function wrongCodeData(dir) {
  const data = join(dir, 'fixtures-v4');
  cpSync(FIXTURES_V4, data, { recursive: true });
  const answers = readJson(join(data, 'answers.json'));
  answers[HARBOR] = { ...answers[HARBOR], sic4: '3562' };
  writeFileSync(join(data, 'answers.json'), JSON.stringify(answers));
  return data;
}

/** A reflection that reads the archived filing index, then answers; `asked` counts the reflections made. */
function hindsightParts(asked, { fields = ['sic4'], hypotheses = HYPOTHESES } = {}) {
  const archive = async (href) => {
    assert.equal(href, INDEX);
    return new Response('<title>EDGAR Filing Documents</title><p>HARBOR VALVE WORKS INC (Filer) SIC: 3561 PUMPS &amp; PUMPING EQUIPMENT</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  return {
    fields,
    model: () => {
      asked.push('reflection');
      return scriptedModel({ root: [{ call: 'fetch_page', args: { url: INDEX } }, { call: 'answer', args: { hypotheses } }] });
    },
    tools: async () => [fetchPageTool({ allowDomain: ANY_HOST, archivedSec: true, fetch: archive, lookup: async () => [{ address: '93.184.216.34', family: 4 }] })],
  };
}

test('a TRAIN run with the code wrong gets one reflection; its hypotheses reach curate as lessons, and one naming the true code is refused', async (t) => {
  const dir = await scratch(t);
  const out = join(dir, 'out');
  const parts = scriptedParts({ set: SETS.v4, data: wrongCodeData(dir) });
  const asked = [];
  parts.hindsight = hindsightParts(asked);
  const { rows } = await runLoop({ out, parts, jobs: 1, record: false });
  assert.equal(rows[0].sic4Answer ?? rows[0].answer, '3562');
  assert.deepEqual(asked, ['reflection']);
  const [reflection] = rows[0].hindsight.reflections;
  assert.deepEqual([reflection.field, reflection.hypotheses, reflection.archivedSecRead, reflection.truthOnArchivedPage], ['sic4', 2, true, true]);
  assert.deepEqual(rows[0].hindsight.proposals.map((p) => [p.runId, p.status, p.reasons]), [[`run-001-h1`, 'proposed', undefined], [`run-001-h2`, 'refused', ['case_data']]]);
  // The lesson went through curate like a run's own: its branch was read, and its text is on main or in curate's report.
  const git = (...args) => execFileSync('git', ['--git-dir', join(out, 'agent.git'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.match(git('branch', '--list', 'runs/*'), new RegExp(`runs/run-001-h1`));
  assert.doesNotMatch(git('branch', '--list', 'runs/*'), new RegExp(`runs/run-001-h2`));
  const progress = JSON.parse(readFileSync(join(out, 'progress', 'run-001.json'), 'utf8'));
  assert.match(JSON.stringify(progress.curated.report), new RegExp(`run-001-h1`));
  // The evidence kept with it names neither the company nor the true code.
  const inbox = git('show', `runs/run-001-h1:inbox/run-001-h1.md`);
  assert.match(inbox, /read it from the Wayback Machine's copy of that page/);
  assert.doesNotMatch(inbox, /Harbor Valve|3561/i);
  // The reflection's cost is in the row's.
  assert.equal(typeof rows[0].hindsight.costUsd, 'number');
  // A resumed pass does not ask again.
  await runLoop({ out, parts, jobs: 1, record: false });
  assert.deepEqual(asked, ['reflection']);
  assert.deepEqual(readRows(join(out, 'runs.jsonl')).length, 1);
});

test('no reflection on a right field, a field not asked for, or a pass that is not TRAIN\'s', async (t) => {
  const dir = await scratch(t);
  // Every field right: nothing to reflect on.
  const right = scriptedParts({ set: SETS.v4 });
  const asked = [];
  right.hindsight = hindsightParts(asked);
  const { rows } = await runLoop({ out: join(dir, 'right'), parts: right, jobs: 1, record: false });
  assert.deepEqual([asked, rows[0].hindsight], [[], undefined]);
  // The code wrong, but only the headquarters asked for.
  const hqOnly = scriptedParts({ set: SETS.v4, data: wrongCodeData(dir) });
  hqOnly.hindsight = hindsightParts(asked, { fields: ['hq'] });
  await runLoop({ out: join(dir, 'hq'), parts: hqOnly, jobs: 1, record: false });
  assert.deepEqual(asked, []);
  // A sealed (DEV) pass never reflects, whatever is wrong.
  const sealed = scriptedParts({ set: SETS.v4, data: wrongCodeData(dir) });
  sealed.hindsight = hindsightParts(asked);
  const pass = await runSealed({ out: join(dir, 'hq'), parts: sealed, at: 'seed' });
  assert.ok(pass.rows.every((r) => r.hindsight === undefined));
  assert.deepEqual(asked, []);
  // TRAIN and the older sets' run split only.
  assert.deepEqual(HINDSIGHT_SPLITS, ['train', 'run']);
  const never = () => { throw new Error('no reflection here'); };
  for (const split of ['dev', 'test', 'sealed']) {
    const none = await reflectOnRun({ job: { split, name: 'x' }, run: {}, score: { sicCorrect4: false, sic4Answer: '1', sic4Truth: '2' }, answer: {}, model: never, effects: [] });
    assert.deepEqual(none, { wrong: [], reflections: [] }, split);
  }
  // What counts as wrong: the code, the headquarters judged wrong, segments below F1 0.8, a list given none of.
  const score = { sicCorrect4: false, sic4Answer: '3562', sic4Truth: '3561', hqCorrect: false, hqAnswer: { city: 'A' }, hqTruth: { city: 'B' }, segmentsF1: 0.8, subsidiariesRecall: 0, subsidiariesTruthCount: 3 };
  assert.deepEqual(wrongFields(score).map((w) => w.field), ['sic4', 'hq', 'subsidiaries']);
  assert.deepEqual(wrongFields({ ...score, segmentsF1: 0.5, subsidiariesTruthCount: null }).map((w) => w.field), ['sic4', 'hq', 'segments']);
  assert.deepEqual(wrongFields(score, ['sic4'], { codes: { 3561: 'PUMPS & PUMPING EQUIPMENT' } }), [{ field: 'sic4', answer: '3562', truth: '3561', truthTitle: 'PUMPS & PUMPING EQUIPMENT' }]);
});

test('a reflection stops at its spend limit ($1 by default) and its tools at 6 calls', async (t) => {
  const dir = await scratch(t);
  const asked = [];
  const parts = hindsightParts(asked);
  const prompt = 'review';
  assert.equal(MAX_REFLECTION_USD, 1);
  const full = await reflect({ model: parts.model(), effects: await parts.tools(), storePath: join(dir, 'a.sqlite'), prompt });
  assert.deepEqual([full.hypotheses.length, full.stopped], [2, null]);
  // A limit already passed stops it at its first step: no answer, and it says why.
  const capped = await reflect({ model: parts.model(), effects: await parts.tools(), storePath: join(dir, 'b.sqlite'), prompt, limitUsd: -1 });
  assert.deepEqual(capped.hypotheses, []);
  assert.match(capped.stopped, /passed its limit of \$-1/);
  // A seventh tool call is refused.
  const many = scriptedModel({ root: [...Array.from({ length: 7 }, () => ({ call: 'fetch_page', args: { url: INDEX } })), { call: 'answer', args: { hypotheses: HYPOTHESES } }] });
  const busy = await reflect({ model: many, effects: await parts.tools(), storePath: join(dir, 'c.sqlite'), prompt });
  const results = many.requests.at(-1).messages.filter((m) => m.role === 'toolResult' && m.toolName === 'fetch_page').map((m) => JSON.parse(m.content[0].text));
  assert.deepEqual(results.map((r) => Boolean(r.refused)), [false, false, false, false, false, false, true]);
  assert.equal(busy.hypotheses.length, 2);
});
