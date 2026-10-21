// The rolling TRAIN stream (learning redesign, section 5.a): K runs in flight on one agent repository, each prepared at
// main's tip, curate the single writer as runs land, and the lag each row carries; main frozen at checkpoints; a run that
// ends on a model error run again once; DEV refusing a run its home seeded from another commit; the rate limits a row
// counts by the hour.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { limitsOfLines } from './limits.mjs';
import { readRows, runLoop, runSealed, scriptedParts } from './runner.mjs';
import { FIXTURES_V4 } from './scripted.mjs';
import { SETS } from './sets.mjs';
import { streamOf } from './stream.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-classify-rolling-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The v4 fixtures' companies under new CIKs and tickers, split train/dev/test (as eval-harness.test.mjs builds them). */
async function standIn(dir, { train = 6, dev = 0, test: testCount = 0 } = {}) {
  const data = join(dir, 'data');
  await cp(FIXTURES_V4, data, { recursive: true });
  const answers = JSON.parse(readFileSync(join(FIXTURES_V4, 'answers.json'), 'utf8'));
  const base = JSON.parse(readFileSync(join(FIXTURES_V4, 'companies-v4.json'), 'utf8')).filter((c) => !answers[c.name].browserOnly);
  const splits = [...Array(train).fill('train'), ...Array(dev).fill('dev'), ...Array(testCount).fill('test')];
  const companies = splits.map((split, i) => {
    const c = base[i % base.length];
    return { ...c, cik: String(810000 + i).padStart(10, '0'), ticker: `R${String(i).padStart(3, '0')}`, split, order: i + 1 };
  });
  writeFileSync(join(data, 'companies-v4.json'), `${JSON.stringify(companies, null, 2)}\n`);
  return { data, companies };
}

const parts = (data) => scriptedParts({ set: SETS.v4, data });
const git = (bare, ...args) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' }).trim();
const isAncestor = (bare, a, b) => spawnSync('git', ['--git-dir', bare, 'merge-base', '--is-ancestor', a, b]).status === 0;

/** A model whose every answer is a provider error pi-ai does not retry, as a request the upstream keeps refusing. */
function refusingModel() {
  const faux = fauxProvider({ models: [{ id: 'scripted', reasoning: true }] });
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage([fauxText('')], { stopReason: 'error', errorMessage: '400 the upstream refused the request' })));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, agent: { model: { provider: 'faux', modelId: 'scripted' }, thinkingLevel: 'low' } };
}

/** The scripted parts with the model refusing the first `failures.get(cik)` attempts of a company; no workflow is served
 *  by the host, so every attempt asks the model. */
function refusing(base, failures) {
  const tries = new Map();
  return {
    ...base,
    dispatch: false,
    modelFor: (job, run) => {
      const n = (tries.get(job.cik) ?? 0) + 1;
      tries.set(job.cik, n);
      return n <= (failures.get(job.cik) ?? 0) ? refusingModel() : base.modelFor(job, run);
    },
  };
}
const modelErrors = (row) => row.limits.filter((l) => l.source === 'model').reduce((sum, l) => sum + l.n, 0);

test('a rolling stream: K runs in flight, each prepared at main\'s tip as it stood; curate the single writer; each row carries its lag; a stopped stream resumes', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 6 });
  const list = streamOf(companies, { split: 'train', epochs: 1, seed: 4 });
  const out = join(dir, 'train');
  await runLoop({ out, parts: parts(data), list, split: 'train', concurrency: 3, jobs: 3, record: false });
  const result = await runLoop({ out, parts: parts(data), list, split: 'train', concurrency: 3, record: false });
  const rows = [...result.rows].sort((a, b) => a.run - b.run);
  assert.deepEqual(rows.map((r) => r.cik), list.map((e) => e.cik));
  // Three in flight: the first three were all prepared before any run was curated, and so were the three after the stop.
  assert.deepEqual(rows.map((r) => r.curatedBefore), [0, 0, 0, 3, 3, 3]);
  assert.deepEqual(rows.map((r) => r.lag), [0, 1, 2, 0, 1, 2]);
  // One writer: the curates, in the order they ran, made one line of main.
  const bare = join(out, 'agent.git');
  const byCurate = [...rows].sort((a, b) => a.curatedIndex - b.curatedIndex);
  assert.deepEqual(byCurate.map((r) => r.curatedIndex), [1, 2, 3, 4, 5, 6]);
  for (let i = 1; i < byCurate.length; i++) assert.ok(isAncestor(bare, byCurate[i - 1].afterSha, byCurate[i].afterSha), `curate ${i + 1}`);
  assert.equal(git(bare, 'rev-parse', 'main'), byCurate.at(-1).afterSha);
  // Each run started from main as the last curate before it left it.
  const seed = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')).seedSha;
  for (const r of rows) assert.equal(r.seedSha, r.curatedBefore === 0 ? seed : byCurate[r.curatedBefore - 1].afterSha, `run ${r.run}`);
  assert.equal(readRows(join(out, 'runs.jsonl')).length, 6);
}, { timeout: 300_000 });

test('a stream in batches stays as it was: a batch starts from one main, and its jobs are curated in stream order', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 4 });
  const list = streamOf(companies, { split: 'train', epochs: 1, seed: 5 });
  const { rows } = await runLoop({ out: join(dir, 'train'), parts: parts(data), list, split: 'train', concurrency: 2, schedule: 'batch', record: false });
  assert.deepEqual(rows.map((r) => r.cik), list.map((e) => e.cik));
  assert.deepEqual(rows.map((r) => r.curatedIndex), [1, 2, 3, 4]);
  assert.deepEqual(rows.map((r) => r.curatedBefore), [0, 0, 2, 2]);
  assert.equal(rows[2].seedSha, rows[1].afterSha);
}, { timeout: 300_000 });

test('checkpoints: main frozen at the seed, after the Nth curate and at the end of each epoch, by label in checkpoints.json', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 3 });
  const list = streamOf(companies, { split: 'train', epochs: 2, seed: 6 });
  const out = join(dir, 'train');
  const { rows } = await runLoop({ out, parts: parts(data), list, split: 'train', concurrency: 2, checkpoints: [2, 4], record: false });
  const byIndex = new Map(rows.map((r) => [r.curatedIndex, r]));
  const frozen = JSON.parse(readFileSync(join(out, 'checkpoints.json'), 'utf8'));
  assert.deepEqual(Object.keys(frozen).sort(), ['0', '2', '4', 'epoch-1', 'epoch-2']);
  const seed = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')).seedSha;
  assert.deepEqual({ ...frozen['0'], at: undefined }, { sha: seed, streamIndex: 0, epoch: null, at: undefined });
  for (const n of [2, 4]) assert.deepEqual({ ...frozen[n], at: undefined }, { sha: byIndex.get(n).afterSha, streamIndex: n, epoch: byIndex.get(n).epoch, at: undefined });
  for (const epoch of [1, 2]) {
    const last = Math.max(...rows.filter((r) => r.epoch === epoch).map((r) => r.curatedIndex));
    // A later epoch's runs that landed before this epoch's last are in that main too, and the entry says how many.
    const alsoIncludes = rows.filter((r) => r.epoch > epoch && r.curatedIndex < last).length;
    assert.deepEqual({ ...frozen[`epoch-${epoch}`], at: undefined }, { sha: byIndex.get(last).afterSha, streamIndex: last, epoch, alsoIncludes, at: undefined });
  }
  for (const entry of Object.values(frozen)) assert.ok(!Number.isNaN(Date.parse(entry.at)), entry.at);
  assert.equal(frozen['epoch-2'].sha, git(join(out, 'agent.git'), 'rev-parse', 'main'));
  // A label once passed is kept as it was: a resumed or longer pass never moves it.
  const again = await runLoop({ out, parts: parts(data), list, split: 'train', concurrency: 2, checkpoints: [2, 4, 5], record: false });
  assert.equal(again.rows.length, 6);
  const after = JSON.parse(readFileSync(join(out, 'checkpoints.json'), 'utf8'));
  for (const label of Object.keys(frozen)) assert.deepEqual(after[label], frozen[label]);
  assert.equal(after['5'].sha, byIndex.get(5).afterSha);
}, { timeout: 300_000 });

test('a run that ends on a model error is run again once; a second one is the job\'s outcome; every failed call is counted', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 3 });
  const list = streamOf(companies, { split: 'train', epochs: 1, seed: 2 });
  const [once, twice, clean] = list.map((e) => e.cik);
  const out = join(dir, 'train');
  const { rows } = await runLoop({ out, parts: refusing(parts(data), new Map([[once, 1], [twice, 2]])), list, split: 'train', record: false });
  const row = (cik) => rows.find((r) => r.cik === cik);
  assert.deepEqual([once, twice, clean].map((cik) => [row(cik).rerunOf, row(cik).infraFailed]), [['run-001', false], ['run-002', true], [null, false]]);
  assert.deepEqual([once, twice, clean].map((cik) => modelErrors(row(cik))), [1, 2, 0]);
  assert.ok(rows.flatMap((r) => r.limits).every((l) => l.status === 400 && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(l.hour)));
  // The first attempt is abandoned, never proposed; the second is the job's run.
  const progress = JSON.parse(readFileSync(join(out, 'progress', 'run-001.json'), 'utf8'));
  assert.equal(progress.attempt, 2);
  assert.deepEqual(progress.infraFailed.map((f) => [f.runId, f.reason]), [['run-001', 'model_error']]);
  assert.equal(git(join(out, 'agent.git'), 'branch', '--list', 'runs/run-001'), '');
  // Its twice-failed job has no third attempt.
  assert.equal(JSON.parse(readFileSync(join(out, 'progress', 'run-002.json'), 'utf8')).attempt, 2);
}, { timeout: 300_000 });

test('DEV runs a model error again once, as TRAIN does', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 1, dev: 2 });
  const [devOnce, devClean] = companies.filter((c) => c.split === 'dev').map((c) => c.cik);
  const devOut = join(dir, 'dev');
  const dev = await runSealed({ out: devOut, parts: refusing(parts(data), new Map([[devOnce, 1]])), at: 'seed', split: 'dev', concurrency: 2 });
  const row = (cik) => dev.rows.find((r) => r.cik === cik);
  assert.deepEqual([devOnce, devClean].map((cik) => [row(cik).rerunOf, row(cik).infraFailed, modelErrors(row(cik))]), [[`sealed-${devOnce}`, false, 1], [null, false, 0]]);
  assert.equal(existsSync(join(devOut, 'sealed', dev.label, 'home', 'runs', `sealed-${devOnce}-a2`)), true);
}, { timeout: 300_000 });

test('DEV refuses a run its home seeded from another commit than the frozen one: a home reused from a later checkpoint', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 3, dev: 2 });
  const train = join(dir, 'train');
  await runLoop({ out: train, parts: parts(data), list: streamOf(companies, { split: 'train', epochs: 1, seed: 1 }), split: 'train', record: false });
  const bare = join(train, 'agent.git');
  const seed = JSON.parse(readFileSync(join(train, 'meta.json'), 'utf8')).seedSha;
  const later = git(bare, 'rev-parse', 'main');
  assert.notEqual(later, seed);
  const devOut = join(dir, 'dev');
  await runSealed({ out: devOut, parts: parts(data), at: later, from: bare, split: 'dev' });
  // The trap: the later checkpoint's home where the seed's belongs. The home never moves back, so it would run the later agent.
  await cp(join(devOut, 'sealed', later.slice(0, 12), 'home'), join(devOut, 'sealed', seed.slice(0, 12), 'home'), { recursive: true });
  await assert.rejects(runSealed({ out: devOut, parts: parts(data), at: 'seed', split: 'dev' }), new RegExp(`seeded from ${later.slice(0, 12)}, not ${seed.slice(0, 12)}`));
  assert.equal(readRows(join(devOut, `sealed-${seed.slice(0, 12)}.jsonl`)).length, 0);
}, { timeout: 300_000 });

test('what a run cost the disk, on every TRAIN and DEV row: its durable commits and the commit time of its own volume', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 2, dev: 2 });
  const train = await runLoop({ out: join(dir, 'train'), parts: parts(data), list: streamOf(companies, { split: 'train', epochs: 1, seed: 3 }), split: 'train', concurrency: 2, record: false });
  const dev = await runSealed({ out: join(dir, 'dev'), parts: parts(data), at: 'seed', split: 'dev', concurrency: 2 });
  for (const row of [...train.rows, ...dev.rows]) {
    assert.ok(Number.isInteger(row.durableCommits) && row.durableCommits > 0, `${row.cik}: ${row.durableCommits}`);
    assert.ok(typeof row.fsyncProbeMs === 'number' && row.fsyncProbeMs >= 0, `${row.cik}: ${row.fsyncProbeMs}`);
  }
}, { timeout: 300_000 });

test('the limits of a run by the hour: model errors by their leading status, site 429s, web.archive.org apart, a workflow\'s call once', () => {
  const at = (iso) => Date.parse(iso);
  const assistant = (iso, extra) => ({ kind: 'pi.assistant', conv: 1, data: { model: [{ role: 'assistant', content: [], stopReason: 'error', timestamp: at(iso), ...extra }] } });
  const call = (iso, id, args) => ({ kind: 'pi.assistant', conv: 1, data: { model: [{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'x', arguments: args }], stopReason: 'toolUse', timestamp: at(iso) }] } });
  const result = (iso, id, toolName, value, isError = false) => ({ kind: 'pi.tool-result', conv: 1, data: { model: [{ role: 'toolResult', toolCallId: id, toolName, content: [{ type: 'text', text: JSON.stringify(value) }], isError, timestamp: at(iso) }] } });
  const effect = (key, status, value) => ({ kind: 'agentrun.effects', data: { key, value: { status, intent: { tool: 'read_document' }, args: { url: 'https://web.archive.org/web/2024/https://example.com/x.pdf' }, ...(value ? { result: { value } } : {}) } } });
  const lines = [
    assistant('2026-10-22T03:10:00Z', { errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error"}}' }),
    assistant('2026-10-22T03:20:00Z', { errorMessage: '529 {"type":"error","error":{"type":"overloaded_error"}}' }),
    assistant('2026-10-22T04:05:00Z', { errorMessage: 'Connection error.' }),
    { kind: 'pi.assistant', conv: 1, data: { model: [{ role: 'assistant', content: [], stopReason: 'stop', timestamp: at('2026-10-22T04:06:00Z') }] } },
    call('2026-10-22T04:07:00Z', 'c1', { url: 'https://stocktitan.net/x' }),
    result('2026-10-22T04:07:30Z', 'c1', 'fetch_page', { ok: false, url: 'https://stocktitan.net/x', status: 429 }),
    result('2026-10-22T04:08:00Z', 'c2', 'read_document', { error: 'HTTP 429', status: 429, url: 'https://web.archive.org/web/2024/https://example.com/a.pdf' }),
    result('2026-10-22T04:09:00Z', 'c3', 'browse', { ok: true, url: 'https://example.com/', status: 200 }),
    result('2026-10-22T04:10:00Z', 'c4', 'browse', { ok: false, url: 'https://example.com/', status: 429 }, true),
    result('2026-10-22T04:11:00Z', 'c5', 'search_web', { ok: false, status: 429 }),
    effect('k1', 'unknown'),
    effect('k1', 'completed', { ok: false, status: 429 }),
  ];
  assert.deepEqual(limitsOfLines(lines), [
    { hour: '2026-10-22T03', source: 'model', status: 429, n: 1 },
    { hour: '2026-10-22T03', source: 'model', status: 529, n: 1 },
    { hour: '2026-10-22T04', source: 'model', status: 'other', n: 1 },
    { hour: '2026-10-22T04', source: 'site', status: 429, n: 1 },
    { hour: '2026-10-22T04', source: 'wayback', status: 429, n: 2 },
  ]);
  assert.deepEqual(limitsOfLines([effect('k2', 'completed', { status: 429 })]), []);
  assert.deepEqual(limitsOfLines([effect('k2', 'completed', { status: 429 })], { at: at('2026-10-22T05:00:00Z') }), [{ hour: '2026-10-22T05', source: 'wayback', status: 429, n: 1 }]);
});
