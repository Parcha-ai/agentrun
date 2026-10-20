// The hill-climb's company list (runner --list): an ordered list of run-split companies, run in that order, each
// numbered by its place in the list.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listQueue, readRows, runLoop, scriptedParts } from './runner.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-classify-list-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const companies = scriptedParts({ set: SETS.v4 }).companies;
const entry = (name, cause = 'a test') => { const c = companies.find((x) => x.name === name); return { cik: c.cik, ticker: c.ticker, cause }; };
const LIST = [entry('Summit Ridge Software Corp.'), entry('Harbor Valve Works Inc.'), entry('Golden Prairie Foods Inc.')];

test('a pass on a list runs the listed companies in its order, each numbered by its place; --jobs caps it, and a resume goes on down the list', async (t) => {
  const out = join(await scratch(t), 'out');
  const first = await runLoop({ out, parts: scriptedParts({ set: SETS.v4 }), list: LIST, jobs: 2, record: false });
  assert.deepEqual(first.rows.map((r) => [r.run, r.company]), [[1, 'Summit Ridge Software Corp.'], [2, 'Harbor Valve Works Inc.']]);
  const all = await runLoop({ out, parts: scriptedParts({ set: SETS.v4 }), list: LIST, record: false });
  assert.deepEqual(all.rows.map((r) => [r.run, r.company]), [[1, 'Summit Ridge Software Corp.'], [2, 'Harbor Valve Works Inc.'], [3, 'Golden Prairie Foods Inc.']]);
  assert.deepEqual(readRows(join(out, 'runs.jsonl')).map((r) => r.cik), LIST.map((e) => e.cik));
}, { timeout: 180_000 });

test('a list is refused: a company not in the run split, a sealed one, a duplicate, a ticker that is not the company\'s', () => {
  const sealed = companies.find((c) => c.split === 'sealed');
  assert.throws(() => listQueue(companies, [...LIST, { cik: '0000000000', ticker: 'NONE' }]), /0000000000 is not in the run split/);
  assert.throws(() => listQueue(companies, [{ cik: sealed.cik, ticker: sealed.ticker }]), new RegExp(`${sealed.cik} \\(${sealed.ticker}\\) is sealed`));
  assert.throws(() => listQueue(companies, [LIST[0], LIST[1], LIST[0]]), new RegExp(`${LIST[0].cik} is listed twice`));
  assert.throws(() => listQueue(companies, [{ ...LIST[0], ticker: 'HVW' }]), new RegExp(`${LIST[0].cik} is ${LIST[0].ticker}, not HVW`));
  assert.throws(() => listQueue(companies, []), /an empty list/);
  assert.deepEqual(listQueue(companies, LIST).map((c) => [c.order, c.name]), [[1, 'Summit Ridge Software Corp.'], [2, 'Harbor Valve Works Inc.'], [3, 'Golden Prairie Foods Inc.']]);
});

test('the CLI: --list reads the file and runs it in order; --list with --sealed is refused', async (t) => {
  const dir = await scratch(t);
  const file = join(dir, 'list.json');
  writeFileSync(file, JSON.stringify(LIST));
  const runner = join(import.meta.dirname, 'runner.mjs');
  const sealed = spawnSync(process.execPath, [runner, '--set', 'v4', '--scripted', '--sealed', '--at', 'seed', '--list', file, '--out', join(dir, 'sealed')], { encoding: 'utf8' });
  assert.equal(sealed.status, 2, sealed.stderr);
  assert.match(sealed.stderr, /--list runs a learning pass: a sealed pass takes the sealed split/);
  const pass = spawnSync(process.execPath, [runner, '--set', 'v4', '--scripted', '--list', file, '--jobs', '1', '--no-record', '--out', join(dir, 'out')], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(readRows(join(dir, 'out', 'runs.jsonl')).map((r) => [r.run, r.cik]), [[1, LIST[0].cik]]);
  const bad = spawnSync(process.execPath, [runner, '--set', 'v4', '--scripted', '--list', join(dir, 'missing.json'), '--out', join(dir, 'bad')], { encoding: 'utf8' });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /--list .*missing\.json/);
  assert.ok(readFileSync(file, 'utf8'));
}, { timeout: 180_000 });
