// The dependency audit with no key: a captured project's facts, a scripted lead and judge. What matters is not the flags but that
// every claim in the report cites a receipt that exists, and that the pure helpers read the public sources' shapes right.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateWorkflow } from '@parcha/agentrun-dsl';
import { audit, loadFixture } from './dependency-audit/run.ts';
import { checkReceipts, recordOf } from './dependency-audit/check.ts';
import { repositoryUrl, resolveRange } from './dependency-audit/sources.ts';
import { workflow } from './dependency-audit/workflow.ts';

test('the workflow is a valid document: a map of six at a time over a call, an agent, an extraction and a typed flag', () => {
  assert.deepEqual(validateWorkflow(workflow), { ok: true });
  const map = workflow.root.steps[0];
  assert.equal(map.node, 'map');
  assert.equal(map.maxConcurrency, 6);
  assert.deepEqual(map.body.steps.map((step) => `${step.node}:${step.label}`), ['call:registry', 'call:advisories', 'call:install in a box', 'agent:repository', 'extract:finding', 'judge:verdict', 'code:row']);
});

test('a repository field reads as one https URL, whatever form the registry holds it in', () => {
  for (const form of ['git+https://github.com/o/r.git', 'git://github.com/o/r.git', 'https://github.com/o/r', 'github:o/r', 'o/r', { type: 'git', url: 'git+ssh://git@github.com/o/r.git' }]) {
    assert.equal(repositoryUrl(form), 'https://github.com/o/r', JSON.stringify(form));
  }
  assert.equal(repositoryUrl(undefined), '');
  assert.equal(repositoryUrl('not a repository'), '');
});

test('a range resolves to the highest version it allows, and an exact pin to itself', () => {
  const versions = ['0.9.0', '1.0.0', '1.2.3', '1.9.9', '2.0.0', '2.0.1-beta.1', '2.1.0'];
  assert.equal(resolveRange('1.2.3', versions), '1.2.3');
  assert.equal(resolveRange('^1.0.0', versions), '1.9.9');
  assert.equal(resolveRange('~1.2.3', versions), '1.2.3');
  assert.equal(resolveRange('>=1.2.3', versions), '2.1.0');
  assert.equal(resolveRange('1.x', versions), '1.9.9');
  assert.equal(resolveRange('^0.9.0', versions), '0.9.0');
  assert.equal(resolveRange('9.9.9', versions), null);
  assert.equal(resolveRange('git+https://x', versions), null);
});

test('the scripted audit completes, and every claim in the report cites a receipt that exists', { timeout: 180_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'dependency-audit-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const fixture = loadFixture('gsap');
  const result = await audit({ fixture: 'gsap', limit: 6, dir: join(tmp, 'run') });
  assert.equal(result.outcome?.status, 'complete', JSON.stringify(result));
  const output = JSON.parse(readFileSync(join(tmp, 'run', 'out', 'record.json'), 'utf8'));
  const record = output.record ?? output;
  assert.equal(record.project, fixture.project);
  assert.equal(record.rows.length, 6);
  // Flags sort act, notice, clear; every fact names a receipt, and the receipt is a file this run wrote.
  const order = { act: 0, notice: 1, clear: 2 };
  assert.deepEqual(record.rows.map((row) => row.flag), record.rows.map((row) => row.flag).sort((a, b) => order[a] - order[b]));
  for (const row of record.rows) {
    assert.equal(row.dropped, 0, `${row.name}: a claim with no receipt was dropped`);
    for (const fact of row.facts) assert.equal(existsSync(join(tmp, 'run', fact.receipt)), true, `${row.name}: ${fact.receipt}`);
  }
  assert.match(record.report_markdown, /^# Dependency audit: /);
  // The replay says so: no install receipt claims a box ran.
  for (const row of record.rows) assert.equal(JSON.parse(readFileSync(join(tmp, 'run', `receipts/install/${row.name.replace('/', '__')}@${row.version}.json`), 'utf8')).ran, false);
});

test('every fact of a scripted audit cites a filed receipt of its kind, and a badge fact cites a look of the badge image', { timeout: 180_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'dependency-audit-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'run');
  const result = await audit({ fixture: 'gsap', dir });
  assert.equal(result.outcome?.status, 'complete');
  assert.deepEqual(result.receiptProblems, []);
  const record = recordOf(dir);
  const badges = record.rows.flatMap((row) => row.facts.filter((fact) => fact.source === 'badge'));
  assert.ok(badges.length >= 5, `the vision lane ran: ${badges.length} badge facts`);
  for (const fact of badges) {
    const look = JSON.parse(readFileSync(join(dir, fact.receipt), 'utf8'));
    assert.equal(look.tool, 'look');
    assert.match(look.facts.sha256, /^[0-9a-f]{64}$/);
    assert.ok(fact.claim.includes(look.body), `${fact.claim} says what the eyes said: ${look.body}`);
  }
  // A finding that cites a badge with no look receipt fails the check: a path that was never filed, a receipt of another kind.
  const first = record.rows.find((row) => row.facts.some((fact) => fact.source === 'badge'));
  const badge = first.facts.find((fact) => fact.source === 'badge');
  const wrong = (receipt, source = 'badge') => checkReceipts(dir, { rows: [{ name: first.name, version: first.version, facts: [{ claim: 'x', source, receipt }] }] });
  assert.deepEqual(wrong(badge.receipt), []);
  assert.match(wrong('evidence/repository/look-never-filed.json')[0], /does not exist/);
  const read = record.rows.flatMap((row) => row.facts).find((fact) => fact.source === 'repository');
  assert.match(wrong(read.receipt)[0], /not an ok look of an image/, 'a browser read is not a look');
  assert.match(wrong('../outside.json')[0], /outside the run|not under/);
  assert.match(wrong(badge.receipt, 'repository')[0], /not an ok browser_read/);
});
