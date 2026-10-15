// The hero job on fakes: nine grids read from their charts by scripted eyes, then snapshot.html citing nine screenshots. A page that is not the
// dashboard is filed failed and never cited. Killed inside a paid call (the operator's published figure, after the host kept the answer), the
// resumed process settles the call from the kept answer, and the recording's own fold reads repeated 0 and the counters equal the ledger.
// Expected values are fixed by hand from the scripted charts (examples/hero/job.ts), not read back from the run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { cost } from './reference/index.ts';
import { heroRun } from './hero/run.ts';

const sources = JSON.parse(readFileSync(new URL('./hero/sources.json', import.meta.url), 'utf8'));
const NINE = ['caiso', 'ercot', 'nyiso', 'isone', 'ieso', 'eirgrid', 'bpa', 'transpower', 'ree'];

const scratch = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'hero-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('sources.json lists nine operators, each with a dashboard and a published figure, and none of the excluded', () => {
  assert.deepEqual(sources.sources.map((source) => source.id), NINE);
  for (const source of sources.sources) {
    assert.match(source.dashboardUrl, /^https?:\/\//, source.id);
    assert.ok(source.publishedDataUrl && source.chart && source.numbers, source.id);
    assert.ok(source.checked?.date && source.robots, `${source.id} says how and when it was checked`);
  }
  const names = sources.sources.map((source) => source.operator);
  for (const excluded of sources.excluded) assert.ok(!names.includes(excluded.operator), `${excluded.operator} is excluded and listed`);
  assert.equal(sources.rules.length, 4);
});

test('the job runs to the snapshot on fakes: nine grids read from their charts, nine screenshots cited, the published figure beside each', { timeout: 120_000 }, async (t) => {
  const run = await heroRun();
  t.after(() => run.cleanup());
  assert.deepEqual(run.processes.map((process) => process.outcome?.status), ['complete']);
  const { record } = run;
  assert.deepEqual([record.grids, record.read, record.failed], [9, 9, 0]);
  assert.deepEqual(record.rows.map((row) => row.id), NINE);
  // Hand-fixed: the scripted charts show these shares and the eyes read them within these distances (0.2 -0.4 0 0.3 -0.1 0.5 0 -0.2 0.4), so the mean gap is 2.1 / 9, 0.2 to one place.
  assert.deepEqual(record.rows.map((row) => row.published), [63.4, 27.9, 18.2, 11.6, 94.1, 72.8, 88.5, 94.0, 52.3]);
  assert.deepEqual(record.rows.map((row) => row.share), [63.6, 27.5, 18.2, 11.9, 94.0, 73.3, 88.5, 93.8, 52.7]);
  assert.deepEqual([record.meanGap, record.closeWithinOnePoint], [0.2, 9]);
  const html = readFileSync(join(run.dir, 'out', 'snapshot.html'), 'utf8');
  assert.match(html, /Nine grids, read from the chart/);
  assert.match(html, /Vision came within one point of the published figure on 9 of 9 grids/);
  const links = [...html.matchAll(/href="(screenshots\/[^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(links).size, 9, 'nine different screenshots are cited');
  for (const row of record.rows) {
    const file = join(run.dir, 'out', `screenshots/${row.id}.jpg`);
    assert.ok(existsSync(file) && readFileSync(file).length > 0, `${row.id}'s screenshot is beside the snapshot`);
    assert.ok(html.includes(`href="screenshots/${row.id}.jpg"`), `${row.id}'s reading links to its screenshot`);
    // The screenshot is the one the run filed: its bytes are the receipt's body.
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), createHash('sha256').update(Buffer.from(JSON.parse(readFileSync(join(run.dir, row.screenshot), 'utf8')).body, 'base64')).digest('hex'));
  }
  // Every number came from the chart: one paid look per grid, and no browser read of a page's text.
  assert.equal(run.eyesRequests, 9);
  assert.equal(run.ledger.filter((row) => row.kind === 'tool' && row.name === 'published').length, 9);
});

test('a page that is not the dashboard is filed failed and never cited', { timeout: 120_000 }, async (t) => {
  const run = await heroRun({ broken: 'isone' });
  t.after(() => run.cleanup());
  const { record } = run;
  assert.deepEqual([record.grids, record.read, record.failed], [9, 8, 1]);
  const row = record.rows.find((entry) => entry.id === 'isone');
  assert.deepEqual([row.status, row.screenshot, row.share], ['failed', '', 0]);
  const html = readFileSync(join(run.dir, 'out', 'snapshot.html'), 'utf8');
  assert.ok(!html.includes('screenshots/isone'), 'the failed grid cites no screenshot');
  assert.match(html, /ISO New England[^<]*<\/td><td colspan="4">not read/);
  assert.match(html, /on 8 of 8 grids read/);
});

test('killed inside a paid call, the resumed process settles it from the kept answer: nothing is paid twice, and the recording says so', { timeout: 240_000 }, async (t) => {
  const tmp = await scratch(t);
  const uncut = await heroRun();
  t.after(() => uncut.cleanup());
  const recording = join(tmp, 'recording');
  const run = await heroRun({ kill1: 3, record: recording });
  t.after(() => run.cleanup());
  assert.deepEqual(run.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']]);
  // A receipt's name is the hash of its body, which holds the time it was taken: the readings are compared, and each run cites its own receipts.
  const readings = (rows) => rows.map(({ screenshot, ...rest }) => ({ ...rest, cited: screenshot !== '' }));
  assert.deepEqual(readings(run.record.rows), readings(uncut.record.rows), 'the resumed run reads what the uncut run read');
  // Paid calls: the published figure is fetched once per grid in all, never again after the kill; the eyes were asked once per grid.
  assert.equal(run.ledger.filter((row) => row.kind === 'tool' && row.name === 'published').length, 9);
  assert.equal(run.eyesRequests, 9);
  const byProcess = run.ledger.filter((row) => row.kind === 'tool' && row.name === 'published').reduce((counts, row) => ({ ...counts, [row.incarnation]: (counts[row.incarnation] ?? 0) + 1 }), {});
  const [before, after] = Object.values(byProcess);
  assert.ok(Object.keys(byProcess).length === 2 && before >= 3 && before + after === 9, `the killed process fetched at least the three it kept, the resumed one the rest: ${JSON.stringify(byProcess)}`);
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  const counted = fold(lines);
  assert.deepEqual([counted.processes, counted.kills, counted.paid.workflow, counted.repeated, counted.repeatedNotMeasured, counted.unknown], [2, 1, 9, 0, 0, 0]);
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.providers, manifest.kills, manifest.generations], ['scripted', 1, 2]);
  assert.deepEqual(manifest.cost, cost(lines), 'the manifest cost is the example\'s own fold of the lines');
  assert.equal(manifest.cost.usd, 0);
});

test('the recording counts the guard\'s looks: paid.vision is nine and the cost holds the eyes\' price, so the strip cannot understate it', { timeout: 240_000 }, async (t) => {
  const tmp = await scratch(t);
  const recording = join(tmp, 'recording');
  const run = await heroRun({ kill1: 3, record: recording, eyesPrice: 1 });
  t.after(() => run.cleanup());
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  // What the eyes charged, from the package's own look reports (one live LookEvent per look), not from the fold under test.
  const charged = lines.filter((line) => line.source === 'vision' && line.kind === 'LookEvent').map((line) => line.data.costUsd);
  assert.equal(charged.length, 9);
  assert.ok(charged.every((usd) => usd > 0), 'a priced look costs something');
  const total = charged.reduce((sum, usd) => sum + usd, 0);
  const counted = fold(lines);
  assert.equal(counted.paid.vision, 9);
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.ok(Math.abs(manifest.cost.parts.look - total) < 1e-9, `the manifest's look cost ${manifest.cost.parts.look} is what the eyes charged ${total}`);
  assert.ok(manifest.cost.usd >= total);
  assert.deepEqual(manifest.cost, cost(lines));
  assert.deepEqual([counted.repeated, counted.unknown], [0, 0]);
});

test('the recording holds each screenshot as an image blob and a cited result that names, per number, the blob and the look that read it', { timeout: 240_000 }, async (t) => {
  const tmp = await scratch(t);
  const recording = join(tmp, 'recording');
  const run = await heroRun({ kill1: 3, record: recording });
  t.after(() => run.cleanup());
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  // The result the manifest points at is the cited shape.
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  const cited = JSON.parse(readFileSync(join(recording, 'blobs', manifest.result.blob + '.json'), 'utf8'));
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
    const bytes = readFileSync(join(recording, 'blobs', `${entry.images[0].blob}.jpg`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.images[0].blob, 'the blob is named by the image\'s own hash');
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], 'and it is a JPEG');
  }
  for (const row of cited.rows) {
    assert.equal(row.cites.length, 1, row.label);
    const [cite] = row.cites;
    assert.ok(filed.has(cite.look), `${row.label} names a look the run filed`);
    assert.equal(cite.blob, filed.get(cite.look).images[0].blob, `${row.label}: the cite's blob is the image that look was shown`);
    assert.ok(existsSync(join(recording, 'blobs', `${cite.blob}.jpg`)));
  }
  // Nine different charts.
  assert.equal(new Set(cited.rows.map((row) => row.cites[0].blob)).size, 9);
});

test('a grid that was not read is a row in the cited result with no cite', { timeout: 240_000 }, async (t) => {
  const tmp = await scratch(t);
  const recording = join(tmp, 'recording');
  const run = await heroRun({ broken: 'isone', record: recording });
  t.after(() => run.cleanup());
  assert.deepEqual(validateRecording(recording), []);
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  const cited = JSON.parse(readFileSync(join(recording, 'blobs', manifest.result.blob + '.json'), 'utf8'));
  assert.equal(cited.rows.length, 17);
  const row = cited.rows.find((entry) => entry.label.startsWith('ISO New England'));
  assert.deepEqual([row.cites, row.value.startsWith('not read')], [[], true]);
});
