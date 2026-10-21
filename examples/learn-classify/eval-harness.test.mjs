// The eval harness at scale (learning redesign, section 5): a TRAIN stream with epochs over a split, DEV at a frozen
// commit of the stream's repository with nothing learned, N jobs at once, and the test split closed unless opened.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentHomeFor, prepareRun } from './host.mjs';
import { listQueue, liveParts, openOut, readRows, runLoop, runSealed, scriptedParts } from './runner.mjs';
import { FIXTURES_V4 } from './scripted.mjs';
import { ARCHIVED_SEC_NOTE } from './tools.mjs';
import { SETS } from './sets.mjs';
import { streamOf } from './stream.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-classify-eval-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in for the 1,000 set: the v4 fixtures' companies under new CIKs and tickers, split train/dev/test. The scripted
 *  agent and tools know a company by its name and site, so a copy behaves as its original. */
async function standIn(dir, { train = 6, dev = 4, test: testCount = 2 } = {}) {
  const data = join(dir, 'data');
  await cp(FIXTURES_V4, data, { recursive: true });
  const base = JSON.parse(readFileSync(join(FIXTURES_V4, 'companies-v4.json'), 'utf8'))
    .filter((c) => !JSON.parse(readFileSync(join(FIXTURES_V4, 'answers.json'), 'utf8'))[c.name].browserOnly);
  const splits = [...Array(train).fill('train'), ...Array(dev).fill('dev'), ...Array(testCount).fill('test')];
  const companies = splits.map((split, i) => {
    const c = base[i % base.length];
    return { ...c, cik: String(800000 + i).padStart(10, '0'), ticker: `Z${String(i).padStart(3, '0')}`, split, order: i + 1 };
  });
  writeFileSync(join(data, 'companies-v4.json'), `${JSON.stringify(companies, null, 2)}\n`);
  return { data, companies };
}

const parts = (data) => scriptedParts({ set: SETS.v4, data });
const git = (bare, ...args) => execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' }).trim();

test('the stream: each epoch is every company of the split once, in an order the seed fixes; another seed or epoch reorders it', () => {
  const companies = Array.from({ length: 12 }, (_, i) => ({ cik: String(i).padStart(10, '0'), ticker: `T${i}`, split: i < 10 ? 'train' : 'dev' }));
  const stream = streamOf(companies, { split: 'train', epochs: 3, seed: 7 });
  assert.equal(stream.length, 30);
  for (const epoch of [1, 2, 3]) {
    const ciks = stream.filter((e) => e.epoch === epoch).map((e) => e.cik);
    assert.deepEqual([...ciks].sort(), companies.slice(0, 10).map((c) => c.cik));
  }
  assert.deepEqual(streamOf(companies, { split: 'train', epochs: 3, seed: 7 }), stream);
  assert.notDeepEqual(stream.filter((e) => e.epoch === 1).map((e) => e.cik), stream.filter((e) => e.epoch === 2).map((e) => e.cik));
  assert.notDeepEqual(streamOf(companies, { split: 'train', epochs: 1, seed: 8 }).map((e) => e.cik), stream.filter((e) => e.epoch === 1).map((e) => e.cik));
  const same = streamOf(companies, { split: 'train', epochs: 2, seed: 7, reshuffle: false });
  assert.deepEqual(same.filter((e) => e.epoch === 2).map((e) => e.cik), same.filter((e) => e.epoch === 1).map((e) => e.cik));
  const first = streamOf(companies, { split: 'train', epochs: 2, seed: 7, first: 4 });
  assert.equal(first.length, 8);
  assert.deepEqual(new Set(first.filter((e) => e.epoch === 2).map((e) => e.cik)), new Set(first.filter((e) => e.epoch === 1).map((e) => e.cik)));
  assert.throws(() => streamOf(companies, { split: 'test', epochs: 1, seed: 1 }), /the test split/);
});

test('a list names a split; a company may come back in a later epoch, never twice in one; the test split stays closed unless opened', async (t) => {
  const { companies } = await standIn(await scratch(t));
  const train = companies.filter((c) => c.split === 'train');
  const dev = companies.find((c) => c.split === 'dev');
  const testCo = companies.find((c) => c.split === 'test');
  const e = (c, epoch) => ({ cik: c.cik, ticker: c.ticker, epoch });
  const queue = listQueue(companies, [e(train[0], 1), e(train[1], 1), e(train[0], 2)], 'train');
  assert.deepEqual(queue.map((c) => [c.order, c.cik, c.epoch]), [[1, train[0].cik, 1], [2, train[1].cik, 1], [3, train[0].cik, 2]]);
  assert.throws(() => listQueue(companies, [e(train[0], 1), e(train[0], 1)], 'train'), new RegExp(`${train[0].cik} is listed twice in epoch 1`));
  assert.throws(() => listQueue(companies, [e(dev, 1)], 'train'), new RegExp(`${dev.cik} \\(${dev.ticker}\\) is dev: a pass on a list takes the train split only`));
  assert.throws(() => listQueue(companies, [{ cik: train[0].cik, epoch: 0 }], 'train'), /epoch is a whole number from 1/);
  assert.throws(() => listQueue(companies, [e(testCo, 1)], 'test'), /the test split is opened once per finalist/);
  assert.equal(listQueue(companies, [e(testCo, 1)], 'test', { openTest: true }).length, 1);
});

test('a TRAIN stream with two epochs: rows numbered by stream index with their epoch, the repository learning across both; a stopped stream resumes at its next index', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 3, dev: 1, test: 0 });
  const list = streamOf(companies, { split: 'train', epochs: 2, seed: 3 });
  const out = join(dir, 'train');
  const first = await runLoop({ out, parts: parts(data), list, split: 'train', jobs: 4, record: false });
  assert.deepEqual(first.rows.map((r) => r.run), [1, 2, 3, 4]);
  const all = await runLoop({ out, parts: parts(data), list, split: 'train', record: false });
  assert.deepEqual(all.rows.map((r) => [r.run, r.cik, r.epoch]), list.map((entry, i) => [i + 1, entry.cik, entry.epoch]));
  assert.ok(all.rows.every((r) => r.split === 'train'));
  // One repository across the stream: each run starts where the one before it left main.
  for (let i = 1; i < all.rows.length; i++) assert.equal(all.rows[i].seedSha, all.rows[i - 1].afterSha);
}, { timeout: 300_000 });

test('DEV at a frozen commit of the stream\'s repository: every job seeded from that sha, nothing proposed or curated, the stream\'s repository untouched', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 3, dev: 3, test: 1 });
  const train = join(dir, 'train');
  await runLoop({ out: train, parts: parts(data), list: streamOf(companies, { split: 'train', epochs: 1, seed: 1 }), split: 'train', record: false });
  const trainBare = join(train, 'agent.git');
  const frozen = git(trainBare, 'rev-parse', 'main');
  const refsBefore = git(trainBare, 'for-each-ref');
  const devOut = join(dir, 'dev');
  const dev = await runSealed({ out: devOut, parts: parts(data), at: frozen, from: trainBare, split: 'dev', concurrency: 2 });
  assert.equal(dev.rows.length, 3);
  assert.deepEqual(dev.rows.map((r) => r.cik).sort(), companies.filter((c) => c.split === 'dev').map((c) => c.cik).sort());
  for (const row of dev.rows) {
    assert.equal(row.seedSha, frozen);
    assert.equal(row.afterSha, frozen);
    assert.equal(row.phase, 'after');
    assert.deepEqual([row.curate.admitted, row.curate.promoted, row.curate.demoted], [[], [], []]);
  }
  assert.equal(git(trainBare, 'for-each-ref'), refsBefore);
  assert.equal(git(join(devOut, 'agent.git'), 'rev-parse', 'main'), frozen);
  assert.equal(JSON.parse(readFileSync(join(devOut, 'meta.json'), 'utf8')).seedSha, JSON.parse(readFileSync(join(train, 'meta.json'), 'utf8')).seedSha);
  // The by-hand baseline: the same DEV companies at the stream's seed, with no workflow served.
  const baseline = await runSealed({ out: join(dir, 'by-hand'), parts: { ...parts(data), dispatch: false }, at: 'seed', from: trainBare, split: 'dev' });
  assert.ok(baseline.rows.every((r) => r.phase === 'before' && !r.dispatched));
  // A resumed DEV pass runs nothing twice.
  const again = await runSealed({ out: devOut, parts: parts(data), at: frozen, from: trainBare, split: 'dev', concurrency: 2 });
  assert.equal(again.rows.length, 3);
  assert.equal(readRows(join(devOut, `sealed-${frozen.slice(0, 12)}.jsonl`)).length, 3);
}, { timeout: 300_000 });

test('DEV shards: --shard i/N takes every N-th company of the split, the shards together the whole split once, rows numbered by place in the split', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 1, dev: 5, test: 0 });
  const shards = [];
  for (const index of [1, 2]) shards.push(await runSealed({ out: join(dir, `dev-${index}`), parts: parts(data), at: 'seed', split: 'dev', shard: { index, count: 2 } }));
  const rows = shards.flatMap((s) => s.rows);
  assert.deepEqual(rows.map((r) => r.cik).sort(), companies.filter((c) => c.split === 'dev').map((c) => c.cik).sort());
  assert.deepEqual(rows.map((r) => r.run).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.deepEqual(shards[0].rows.map((r) => r.run), [1, 3, 5]);
}, { timeout: 300_000 });

test('a TRAIN stream in batches: the batch starts from one main, then each job is proposed and curated in stream order', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 4, dev: 0, test: 0 });
  const list = streamOf(companies, { split: 'train', epochs: 1, seed: 5 });
  const result = await runLoop({ out: join(dir, 'train'), parts: parts(data), list, split: 'train', concurrency: 2, record: false });
  const rows = result.rows;
  assert.deepEqual(rows.map((r) => r.cik), list.map((e) => e.cik));
  assert.equal(rows[0].seedSha, rows[1].seedSha);
  assert.equal(rows[2].seedSha, rows[3].seedSha);
  assert.equal(rows[2].seedSha, rows[1].afterSha);
}, { timeout: 300_000 });

test('a stop between a run\'s start and its progress file: the run that exists is abandoned and the job starts again as the next attempt', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 2, dev: 0, test: 0 });
  const list = streamOf(companies, { split: 'train', epochs: 1, seed: 2 });
  const out = join(dir, 'train');
  await runLoop({ out, parts: parts(data), list, split: 'train', jobs: 1, record: false });
  // What a kill inside prepareRun leaves: run-002 started in the home, its progress file still "new".
  const { repo } = await openOut(out, { mode: 'scripted', set: SETS.v4 });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  await prepareRun({ home, repo, host: 'learn-classify', runId: 'run-002', input: { name: companies[0].name } });
  const resumed = await runLoop({ out, parts: parts(data), list, split: 'train', record: false });
  assert.deepEqual(resumed.rows.map((r) => r.run), [1, 2]);
  const progress = JSON.parse(readFileSync(join(out, 'progress', 'run-002.json'), 'utf8'));
  assert.equal(progress.attempt, 2);
  assert.deepEqual(progress.abandoned.map((a) => a.runId), ['run-002']);
}, { timeout: 300_000 });

test('dropEvidence: once a job\'s row is written its run keeps its store and loses its evidence and browser profile, in TRAIN and in DEV', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 2, dev: 2, test: 0 });
  const kept = (base) => {
    const p = parts(data);
    const toolsFor = p.toolsFor;
    return { ...p, ...base, toolsFor: async (job, run) => {
      mkdirSync(join(run.dir, 'evidence', 'documents'), { recursive: true });
      writeFileSync(join(run.dir, 'evidence', 'documents', 'report.pdf'), 'x'.repeat(1024));
      mkdirSync(join(run.dir, 'chrome'), { recursive: true });
      return toolsFor(job, run);
    } };
  };
  const out = join(dir, 'train');
  const train = await runLoop({ out, parts: kept(), list: streamOf(companies, { split: 'train', epochs: 1, seed: 1 }), split: 'train', record: false, dropEvidence: true });
  for (const run of ['run-001', 'run-002']) {
    assert.equal(existsSync(join(out, 'home', 'runs', run, 'evidence')), false, run);
    assert.equal(existsSync(join(out, 'home', 'runs', run, 'chrome')), false, run);
    assert.equal(existsSync(join(out, 'home', 'runs', run, 'store')), true, run);
  }
  assert.equal(train.rows.length, 2);
  const dev = await runSealed({ out: join(dir, 'dev'), parts: kept(), at: 'seed', split: 'dev', concurrency: 2, dropEvidence: true });
  const label = dev.sha.slice(0, 12);
  for (const row of dev.rows) assert.equal(existsSync(join(dir, 'dev', 'sealed', label, 'home', 'runs', row.runId ?? `sealed-${row.cik}`, 'evidence')), false);
  const keep = await runLoop({ out: join(dir, 'keep'), parts: kept(), list: streamOf(companies, { split: 'train', epochs: 1, seed: 1 }), split: 'train', jobs: 1, record: false });
  assert.equal(keep.rows.length, 1);
  assert.equal(existsSync(join(dir, 'keep', 'home', 'runs', 'run-001', 'evidence', 'documents', 'report.pdf')), true);
}, { timeout: 300_000 });

test('agentDir seeds the repository from another agent home; a pass resumed with a different one is refused', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await standIn(dir, { train: 1, dev: 0, test: 0 });
  const home = join(dir, 'agent-marked');
  await cp(SETS.v4.agentDir, home, { recursive: true });
  writeFileSync(join(home, 'AGENTS.md'), `${readFileSync(join(home, 'AGENTS.md'), 'utf8')}\nA marker only this home has.\n`);
  const out = join(dir, 'train');
  const result = await runLoop({ out, parts: { ...parts(data), agentDir: home }, list: streamOf(companies, { split: 'train', epochs: 1, seed: 1 }), split: 'train', record: false });
  assert.match(git(join(out, 'agent.git'), 'show', `${result.seedSha}:AGENTS.md`), /A marker only this home has/);
  await assert.rejects(runLoop({ out, parts: { ...parts(data), agentDir: SETS.v4.agentDir }, split: 'train', record: false }), /seeded from another agent home/);
}, { timeout: 300_000 });

test('edgarArchive: every tool of a live pass, and its browser check, opens the Wayback copy of an SEC page', async (t) => {
  const env = { LEARN_CLASSIFY_GATEWAY: 'http://127.0.0.1:9/' };
  const dir = await scratch(t);
  const job = { name: 'X', website: 'https://www.example.com' };
  const off = await liveParts({ set: SETS.v4, data: FIXTURES_V4, env });
  const on = await liveParts({ set: SETS.v4, data: FIXTURES_V4, env, archivedSec: true });
  const descriptions = async (p) => Object.fromEntries((await p.toolsFor(job, { dir })).map((tool) => [tool.name, tool.description]));
  const [plain, archived] = [await descriptions(off), await descriptions(on)];
  for (const name of ['fetch_page', 'search_web', 'browse', 'read_document']) {
    assert.ok(archived[name]?.includes(ARCHIVED_SEC_NOTE), `${name} with the archive`);
    assert.ok(!plain[name]?.includes(ARCHIVED_SEC_NOTE), `${name} without`);
  }
  assert.equal(on.archivedSec, true);
  assert.equal(off.archivedSec, false);
});

test('the CLI: --split, --from, --concurrency and --shard are checked; the test split needs --open-test', async (t) => {
  const dir = await scratch(t);
  const { data } = await standIn(dir, { train: 1, dev: 1, test: 1 });
  const runner = join(import.meta.dirname, 'runner.mjs');
  const run = (...args) => spawnSync(process.execPath, [runner, '--set', 'v4', '--scripted', '--data', data, '--no-record', ...args], { encoding: 'utf8' });
  const closed = run('--sealed', '--at', 'seed', '--split', 'test', '--out', join(dir, 'test'));
  assert.equal(closed.status, 2, closed.stderr);
  assert.match(closed.stderr, /the test split is opened once per finalist/);
  for (const [args, message] of [
    [['--concurrency', '0'], /--concurrency is a whole number from 1/],
    [['--sealed', '--at', 'seed', '--shard', '3/2'], /--shard is i\/N with 1 <= i <= N/],
    [['--shard', '1/2'], /--shard takes a sealed pass/],
    [['--from', join(dir, 'x.git')], /--from takes a sealed pass/],
  ]) {
    const bad = run(...args, '--out', join(dir, `bad-${args.join('')}`.replace(/\W/g, '')));
    assert.equal(bad.status, 2, `${args}: ${bad.stderr}`);
    assert.match(bad.stderr, message);
  }
  const ok = run('--split', 'train', '--jobs', '1', '--out', join(dir, 'ok'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readRows(join(dir, 'ok', 'runs.jsonl'))[0].split, 'train');
}, { timeout: 300_000 });
