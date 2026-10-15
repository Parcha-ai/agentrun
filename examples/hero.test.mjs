// The hero on the template: the three beats on fakes. (1) The job: nine grids read from their charts by scripted eyes, then snapshot.html citing nine
// screenshots; a page that is not the dashboard is filed failed and never cited. (2) A kill and resume: killed inside a paid call (the operator's
// published figure, after the host kept the answer), the resumed process settles it from the kept answer, and the recording's own fold reads repeated 0.
// (3) Receipts with cost: the recording validates, its cost is a number from the eyes' own reports, and it says scripted.
// Expected values are fixed by hand from the scripted charts (examples/hero/fakes.ts), not read back from the run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { cost, demo } from './reference/index.ts';
import { options } from './hero/run.ts';

const sources = JSON.parse(readFileSync(new URL('./hero/sources.json', import.meta.url), 'utf8'));
const NINE = ['caiso', 'ercot', 'nyiso', 'isone', 'ieso', 'eirgrid', 'bpa', 'transpower', 'ree'];

const scratch = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'hero-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('sources.json lists nine operators, each with a dashboard and a published figure, and none of the excluded', () => {
  assert.deepEqual(sources.pages.map((source) => source.id), NINE);
  for (const source of sources.pages) {
    assert.match(source.dashboardUrl, /^https?:\/\//, source.id);
    assert.ok(source.publishedDataUrl && source.chart && source.numbers, source.id);
    assert.ok(source.checked?.date && source.robots, `${source.id} says how and when it was checked`);
  }
  const names = sources.pages.map((source) => source.operator);
  for (const excluded of sources.excluded) assert.ok(!names.includes(excluded.operator), `${excluded.operator} is excluded and listed`);
  assert.equal(sources.rules.length, 4);
});

/** One run of the demo as a command line would make it: the supervisor is this process, each process of the run is `run.ts --child`. */
async function hero(t, argv = [], env = {}) {
  const tmp = await scratch(t);
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--record', recording, '--dir', join(tmp, 'run'), ...argv] });
  const rows = (file) => { try { return readFileSync(join(result.dir, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  const cited = JSON.parse(readFileSync(join(recording, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  return { ...result, recording, manifest, cited, ledger: rows('ledger.jsonl'), eyesRequests: rows('eyes.jsonl').length, snapshot: () => readFileSync(join(result.dir, 'out', 'snapshot.html'), 'utf8') };
}

test('beat 1, the job: nine grids read from their charts, nine screenshots cited, the published figure beside each', { timeout: 240_000 }, async (t) => {
  const run = await hero(t);
  assert.deepEqual(run.processes.map((process) => process.outcome?.status), ['complete']);
  const { record } = run;
  assert.deepEqual([record.grids, record.read, record.failed], [9, 9, 0]);
  assert.deepEqual(record.rows.map((row) => row.id), NINE);
  // Hand-fixed: the scripted charts show these shares and the eyes read them within these distances (0.2 -0.4 0 0.3 -0.1 0.5 0 -0.2 0.4), so the mean gap is 2.1 / 9, 0.2 to one place.
  assert.deepEqual(record.rows.map((row) => row.published), [63.4, 27.9, 18.2, 11.6, 94.1, 72.8, 88.5, 94.0, 52.3]);
  assert.deepEqual(record.rows.map((row) => row.share), [63.6, 27.5, 18.2, 11.9, 94.0, 73.3, 88.5, 93.8, 52.7]);
  assert.deepEqual([record.meanGap, record.closeWithinOnePoint], [0.2, 9]);
  const html = run.snapshot();
  assert.match(html, /Nine grids, read from the chart/);
  assert.match(html, /Vision came within one point of the published figure on 9 of 9 grids/);
  const links = [...html.matchAll(/href="(screenshots\/[^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(links).size, 9, 'nine different screenshots are cited');
  for (const row of record.rows) {
    const file = join(run.dir, 'out', `screenshots/${row.id}.jpg`);
    assert.ok(existsSync(file) && readFileSync(file).length > 0, `${row.id}'s screenshot is beside the snapshot`);
    assert.ok(html.includes(`href="screenshots/${row.id}.jpg"`), `${row.id}'s reading links to its screenshot`);
  }
  // Every number came from the chart: one paid look per grid, one published figure per grid.
  assert.equal(run.eyesRequests, 9);
  assert.equal(run.ledger.filter((row) => row.kind === 'tool' && row.name === 'published').length, 9);
  // The input is a form: a subset of operators runs the same job on those.
  const two = await hero(t, ['--input', '{"at":"2026-10-15T12:00:00Z","operators":["bpa","ree"]}']);
  assert.deepEqual(two.record.rows.map((row) => row.id), ['bpa', 'ree']);
});

test('a page that is not the dashboard is filed failed and never cited, and is a row with no cite', { timeout: 240_000 }, async (t) => {
  const run = await hero(t, [], { DEMO_HERO_BROKEN: 'isone' });
  const { record } = run;
  assert.deepEqual([record.grids, record.read, record.failed], [9, 8, 1]);
  const row = record.rows.find((entry) => entry.id === 'isone');
  assert.deepEqual([row.status, row.screenshot, row.share], ['failed', '', 0]);
  assert.ok(!run.snapshot().includes('screenshots/isone'), 'the failed grid cites no screenshot');
  assert.match(run.snapshot(), /ISO New England[^<]*<\/td><td colspan="4">not read/);
  assert.match(run.snapshot(), /on 8 of 8 grids read/);
  assert.equal(run.cited.rows.length, 17);
  const cell = run.cited.rows.find((entry) => entry.label.startsWith('ISO New England'));
  assert.deepEqual([cell.cites, cell.value.startsWith('not read')], [[], true]);
});

test('beat 2, a kill and resume: killed inside a paid call, the resumed process settles it from the kept answer; nothing is paid twice, and the recording says so', { timeout: 300_000 }, async (t) => {
  const uncut = await hero(t);
  const run = await hero(t, ['--kill']);
  assert.deepEqual(run.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']]);
  assert.equal(run.kills[0].point, 'effect.kept published');
  // A receipt's name is the hash of its body, which holds the time it was taken: the readings are compared, and each run cites its own receipts.
  const readings = (rows) => rows.map(({ screenshot, ...rest }) => ({ ...rest, cited: screenshot !== '' }));
  assert.deepEqual(readings(run.record.rows), readings(uncut.record.rows), 'the resumed run reads what the uncut run read');
  // Paid calls: the published figure is fetched once per grid in all, never again after the kill; the eyes were asked once per grid.
  const published = run.ledger.filter((row) => row.kind === 'tool' && row.name === 'published');
  assert.equal(published.length, 9);
  assert.equal(run.eyesRequests, 9);
  const byProcess = published.reduce((counts, row) => ({ ...counts, [row.incarnation]: (counts[row.incarnation] ?? 0) + 1 }), {});
  const [before, after] = Object.values(byProcess);
  assert.ok(Object.keys(byProcess).length === 2 && before >= 3 && before + after === 9, `the killed process fetched at least the three it kept, the resumed one the rest: ${JSON.stringify(byProcess)}`);
  assert.deepEqual(validateRecording(run.recording), []);
  const counted = fold(readEvents(run.recording));
  assert.deepEqual([counted.processes, counted.kills, counted.paid.workflow, counted.repeated, counted.repeatedNotMeasured, counted.unknown], [2, 1, 9, 0, 0, 0]);
  assert.deepEqual([run.manifest.providers, run.manifest.kills, run.manifest.generations], ['scripted', 1, 2]);
});

test('beat 3, receipts with cost: the strip counts the guard\'s looks (paid.vision is nine) and the cost is the eyes\' own price, never an unearned 0', { timeout: 300_000 }, async (t) => {
  // Unpriced eyes at $0 on fakes: the manifest says scripted, and its cost is the fold's number.
  const free = await hero(t);
  assert.equal(free.manifest.providers, 'scripted');
  assert.equal(free.manifest.cost.usd, 0);
  const run = await hero(t, ['--kill'], { DEMO_HERO_EYES_PRICE: '1' });
  assert.deepEqual(validateRecording(run.recording), []);
  const lines = readEvents(run.recording);
  // What the eyes charged, from the package's own look reports (one live LookEvent per look), not from the fold under test.
  const charged = lines.filter((line) => line.source === 'vision' && line.kind === 'LookEvent').map((line) => line.data.costUsd);
  assert.equal(charged.length, 9);
  assert.ok(charged.every((usd) => usd > 0), 'a priced look costs something');
  const total = charged.reduce((sum, usd) => sum + usd, 0);
  const counted = fold(lines);
  assert.equal(counted.paid.vision, 9);
  assert.ok(Math.abs(run.manifest.cost.parts.look - total) < 1e-9, `the manifest's look cost ${run.manifest.cost.parts.look} is what the eyes charged ${total}`);
  assert.ok(run.manifest.cost.usd >= total);
  assert.deepEqual(run.manifest.cost, cost(lines));
  assert.deepEqual([counted.repeated, counted.unknown], [0, 0]);
});

test('the recording holds each screenshot as an image blob and a cited result that names, per number, the blob and the look that read it', { timeout: 300_000 }, async (t) => {
  const run = await hero(t, ['--kill']);
  const lines = readEvents(run.recording);
  const { cited } = run;
  assert.equal(cited.format, 'agentrun.cited/1');
  assert.equal(cited.rows.length, 18, 'two numbers for each of nine grids');
  // Every look the run filed, by key: its screenshot's evidence path as receipt, and the image the eyes saw as a blob in blobs/.
  const filed = new Map();
  for (const line of lines) {
    const value = line.channel === 'durable' && line.data?.doc === 'vision.looks' ? line.data.value : undefined;
    for (const entry of value?.looks ?? []) filed.set(entry.record.facts.key, entry);
  }
  assert.equal(filed.size, 9, 'nine looks, one per screenshot');
  for (const entry of filed.values()) {
    assert.match(entry.receipt, /^evidence\/chart\/screenshot-\w+\.json$/, 'the look is filed with the screenshot\'s evidence path');
    assert.equal(entry.images.length, 1);
    const bytes = readFileSync(join(run.recording, 'blobs', `${entry.images[0].blob}.jpg`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.images[0].blob, 'the blob is named by the image\'s own hash');
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], 'and it is a JPEG');
  }
  for (const row of cited.rows) {
    assert.equal(row.cites.length, 1, row.label);
    const [cite] = row.cites;
    assert.ok(filed.has(cite.look), `${row.label} names a look the run filed`);
    assert.equal(cite.blob, filed.get(cite.look).images[0].blob, `${row.label}: the cite's blob is the image that look was shown`);
  }
  assert.equal(new Set(cited.rows.map((row) => row.cites[0].blob)).size, 9, 'nine different charts');
});

test('the template: demo.json names what the demo is, and job.ts is data', async () => {
  const { default: spec } = await import('./hero/demo.json', { with: { type: 'json' } });
  const { default: job, workflow } = await import('./hero/job.ts');
  assert.deepEqual([spec.name, spec.title, spec.targets], ['hero', 'Nine Grids Read', ['local']]);
  assert.deepEqual(spec.panels, ['workflow-map', 'vision']);
  assert.deepEqual(spec.tools, [{ name: 'published', local: 'fakes', hosted: null }]);
  assert.ok(spec.claim && spec.kills.length === 1 && spec.expectedCost > 0);
  // job.ts survives a JSON round trip unchanged, carries no model, and every input property says what it is.
  assert.deepEqual(JSON.parse(JSON.stringify(job)), job);
  assert.equal(job.workflow, workflow);
  assert.ok(!/"(model|provider)"/.test(JSON.stringify(job)));
  for (const [name, property] of Object.entries(workflow.schemas.Input.properties)) assert.ok(property.description, `input ${name} has a description`);
  assert.deepEqual(job.input.operators, NINE);
});
