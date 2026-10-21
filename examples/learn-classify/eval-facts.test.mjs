// The facts pass (learning redesign, section 3's replay arms): one read of each company's latest annual report, written
// once to facts/<passId>/<cik>.json with its meta and a manifest, with nothing learned and no code anywhere.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFacts } from './eval-facts.mjs';
import { answerFacts, FACTS_RULES } from './facts-job.mjs';
import { scriptedParts } from './runner.mjs';
import { FIXTURES_V4, scriptedModel } from './scripted.mjs';
import { SETS } from './sets.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-classify-facts-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function devSet(dir, n = 3) {
  const data = join(dir, 'data');
  await cp(FIXTURES_V4, data, { recursive: true });
  const base = JSON.parse(readFileSync(join(FIXTURES_V4, 'companies-v4.json'), 'utf8'));
  const companies = base.slice(0, n + 1).map((c, i) => ({ ...c, cik: String(700000 + i).padStart(10, '0'), ticker: `F${i}`, split: i === 0 ? 'train' : 'dev', order: i + 1 }));
  writeFileSync(join(data, 'companies-v4.json'), `${JSON.stringify(companies, null, 2)}\n`);
  return { data, companies };
}

const where = (url) => ({ url, locator: 'pdf p. 1', quote: 'Annual Report 2025' });
const factsOf = (job) => {
  const url = `https://${job.ticker.toLowerCase()}.example/ar-2025.pdf`;
  return {
    report: { form: '10-K', fiscalYear: 2025, periodEnd: '2025-12-31', ...where(url) },
    cover: { name: job.name, city: 'Pittsburgh', state: 'PA', country: 'US', ...where(url) },
    item1: { text: `${job.name} makes what it makes.`, url, locator: 'Item 1' },
    segments: { list: [{ name: 'One', revenue: 600, share: 0.6 }, { name: 'Two', revenue: 400, share: 0.4 }], total: 1000, ...where(url) },
    largestLine: { name: 'One', revenue: 600, share: 0.6, basis: 'segment', ...where(url) },
    revenueLines: { none: true },
  };
};
const scriptedFacts = (data) => ({ ...scriptedParts({ set: SETS.facts, data }), modelFor: (job) => scriptedModel({ root: [{ call: 'answer', args: factsOf(job) }, { say: 'Recorded.' }] }) });
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('the facts set: its agent home is the facts rules alone, its answer has no place for a code, and it offers no code tools', () => {
  const files = SETS.facts.agentFiles();
  assert.equal(files['AGENTS.md'], FACTS_RULES);
  assert.ok(files['agent.json']);
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith('.agents/skills/')), []);
  assert.deepEqual(SETS.facts.answer().parameters, answerFacts().parameters);
  assert.deepEqual(SETS.facts.labelTools({}), []);
  assert.doesNotMatch(JSON.stringify(SETS.facts.answer().parameters), /sic/i);
});

test('a facts pass writes each dev company once, with its meta and a manifest line, learns nothing, and resumes', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await devSet(dir);
  const out = join(dir, 'facts-out');
  const first = await runFacts({ out, parts: scriptedFacts(data), passId: 'F1', split: 'dev', concurrency: 2, jobs: 2 });
  assert.equal(first.written.length, 2);
  const all = await runFacts({ out, parts: scriptedFacts(data), passId: 'F1', split: 'dev', concurrency: 2 });
  assert.equal(all.written.length, 1);
  const dev = companies.filter((c) => c.split === 'dev');
  const manifest = readFileSync(join(out, 'facts', 'F1', 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(manifest.map((m) => m.cik).sort(), dev.map((c) => c.cik).sort());
  for (const job of dev) {
    const file = JSON.parse(readFileSync(join(out, 'facts', 'F1', `${job.cik}.json`), 'utf8'));
    assert.deepEqual(file.facts, factsOf(job));
    assert.equal(file.meta.passId, 'F1');
    assert.equal(file.meta.cik, job.cik);
    for (const field of Object.keys(factsOf(job))) assert.equal(file.meta.sha256[field], sha(factsOf(job)[field]), field);
    assert.ok(file.meta.start <= file.meta.end);
    assert.ok('costUsd' in file.meta && 'model' in file.meta);
  }
  const bare = join(out, 'agent.git');
  assert.equal(execFileSync('git', ['--git-dir', bare, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim(), '1');
  assert.equal(execFileSync('git', ['--git-dir', bare, 'show', 'main:AGENTS.md'], { encoding: 'utf8' }), FACTS_RULES);
}, { timeout: 300_000 });

test('a facts run with no answer writes nothing for its company and says so in the manifest', async (t) => {
  const dir = await scratch(t);
  const { data, companies } = await devSet(dir, 1);
  const parts = { ...scriptedParts({ set: SETS.facts, data }), modelFor: () => scriptedModel({ root: [{ say: 'I could not find the report.' }] }) };
  const out = join(dir, 'facts-out');
  const result = await runFacts({ out, parts, passId: 'F2', split: 'dev' });
  const job = companies.find((c) => c.split === 'dev');
  assert.deepEqual(result.written, []);
  assert.equal(existsSync(join(out, 'facts', 'F2', `${job.cik}.json`)), false);
  const manifest = readFileSync(join(out, 'facts', 'F2', 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(manifest.map((m) => [m.cik, m.ok]), [[job.cik, false]]);
}, { timeout: 300_000 });

test('the runner refuses the facts set: it has its own pass', () => {
  const runner = join(import.meta.dirname, 'runner.mjs');
  const run = spawnSync(process.execPath, [runner, '--set', 'facts', '--scripted', '--jobs', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /the facts set runs with eval-facts\.mjs/);
});
