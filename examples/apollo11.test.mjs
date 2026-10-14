// The Apollo 11 example at $0: a data set the test builds (pages with synthetic lines, solid-colour photos, a typed reference in
// the same markup as NASA's), read by the scripted lead and scripted eyes through the whole program, a supervisor, its children and
// a recording. The account's shape, every cite resolving to a receipt, the counters after a kill and the accuracy computed from the
// receipts are checked on what the run filed, never on wording.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { pdfBytes, pngBytes } from '@parcha/pi-vision/testing';
import { receiptAt } from './apollo11/account.ts';
import { fetchItems, loadDataset, placeFiles } from './apollo11/dataset.ts';
import { EYES, LEAD, liveModels } from './apollo11/models.ts';
import { apollo } from './apollo11/run.ts';

const CLASSES = { red: 'A red frame.', green: 'A green frame.', blue: 'A blue frame.' };
const COLOURS = { red: [220, 30, 30], green: [30, 200, 60], blue: [40, 60, 220] };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Three pages of invented air-to-ground lines inside the account's span (04 06 20 00 to 04 06 50 00), the same lines in the typed
 *  reference's markup, and six photos, two of each class, as a data set of `file:` URLs. */
async function syntheticDataset(dir) {
  await mkdir(join(dir, 'files'), { recursive: true });
  const pages = [0, 1, 2].map((page) => Array.from({ length: 4 }, (_, line) => ({ time: `04 06 ${String(30 + page * 5 + line).padStart(2, '0')} ${String(10 + line).padStart(2, '0')}`, speaker: line % 2 ? 'AA' : 'BB', text: `Synthetic call ${page}-${line}.` })));
  const scan = pdfBytes(pages.map((lines) => ({ lines: lines.map((line) => `${line.time}   ${line.speaker}   ${line.text}`) })));
  const typed = pages.flat().map((line) => `${line.time}        <font color="0000FF">${line.speaker}</font><br>\n${line.text}\n<br><br>\n`).join('\n');
  const files = { 'scan.pdf': scan, 'typed.html': Buffer.from(typed) };
  const photos = Object.keys(CLASSES).flatMap((name) => [1, 2].map((n) => ({ id: `photo-${name}-${n}`, name, bytes: pngBytes(64 + n, 48, COLOURS[name]) })));
  for (const photo of photos) files[`${photo.id}.png`] = photo.bytes;
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, 'files', name), bytes);
  const item = (id, kind, name, extra) => ({ id, title: id, kind, role: 'test', url: pathToFileURL(join(dir, 'files', name)).href, license: 'test', bytes: files[name].length, sha256: sha256(files[name]), ...extra });
  const dataset = {
    format: 'apollo11.dataset/1', classes: CLASSES, class_rule: 'test', items: [
      item('transcript-tec', 'transcript', 'scan.pdf', { pages: 3, landing: { from: 1, to: 3 } }),
      item('transcript-tec-typed', 'transcript', 'typed.html', {}),
      ...photos.map((photo) => item(photo.id, 'photo', `${photo.id}.png`, { caption: 'test', class: photo.name })),
    ],
  };
  const file = join(dir, 'dataset.json');
  await writeFile(file, JSON.stringify(dataset, null, 1));
  const scriptedPages = join(dir, 'pages.json');
  await writeFile(scriptedPages, JSON.stringify({ item: 'transcript-tec', page_starts: { 1: pages[0][0].time, 2: pages[1][0].time, 3: pages[2][0].time } }));
  return { file, dataset, sha256: sha256(readFileSync(file)), scriptedPages };
}

const linesOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('a scripted run reads every item once, and its account cites only receipts the run filed for exactly those bytes', { timeout: 240_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  const record = join(tmp, 'recording');
  const result = await apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'run'), cache: join(tmp, 'cache'), mode: 'quick', record });
  assert.equal(result.outcome?.status, 'complete', result.stderr);
  const account = result.account;
  assert.equal(account.format, 'apollo11.account/1');
  assert.equal(account.dataset_sha256, set.sha256);
  assert.ok(account.entries.length >= 3, 'one entry a minute of read lines');
  const items = new Map(set.dataset.items.map((item) => [item.id, item]));
  const filed = new Map(readdirSync(join(tmp, 'run', 'evidence'), { recursive: true }).filter((name) => name.endsWith('.json')).map((name) => {
    const record = JSON.parse(readFileSync(join(tmp, 'run', 'evidence', name), 'utf8'));
    return [record.facts.key, record];
  }));
  for (const entry of account.entries) {
    assert.match(entry.mission_time, /^\d{3}:\d{2}:\d{2}$/);
    assert.ok(entry.cites.length >= 1);
    for (const cite of entry.cites) {
      const look = filed.get(cite.receipt);
      assert.ok(look, `the cite's receipt ${cite.receipt} is a look the run filed`);
      assert.equal(look.status, 'ok');
      assert.equal(look.facts.sha256, items.get(cite.item).sha256, 'the look read exactly the cited item\'s bytes');
      assert.match(cite.fragment, /^#(?:page=\d+|t=[\d.]+,[\d.]+|xywh=percent:[\d.,]+)$/);
    }
  }
  assert.deepEqual(account.dropped, []);
  // Every time the eyes read is one the typed reference holds; the counters fold from the store: each look paid once, at $0.
  assert.equal(account.transcript.times.times, 12);
  assert.equal(account.transcript.times.in_typed, 12);
  assert.deepEqual({ ...account.counters, looks: undefined }, { looks: undefined, paid: 9, kept: 0, repeated: 0, asked_twice: 0, failed: 0, cost_usd: 0, cost_unknown: 0 });
  // The recording validates, names the data set's SHA-256, and its result is the account.
  assert.deepEqual(result.problems, []);
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.equal(manifest.dataset.sha256, set.sha256);
  assert.equal(manifest.providers, 'scripted');
  assert.deepEqual(JSON.parse(readFileSync(join(record, 'blobs', `${manifest.result.blob}.json`), 'utf8')), JSON.parse(JSON.stringify(account)));
  // Each filing carries its item and the images the eyes were shown: blobs of the recording, listed in the line's `blobs`.
  const lines = linesOf(join(record, 'events.jsonl'));
  const blobs = readdirSync(join(record, 'blobs'));
  const filings = lines.filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks' && !line.snapshot);
  const keys = new Set(filings.map((line) => line.data.key));
  assert.equal(keys.size, 9);
  for (const line of filings) for (const look of line.data.value.looks) {
    assert.ok(items.has(look.item), `${look.item} is a data set item`);
    assert.equal(look.miss, null);
    assert.ok(look.images.length >= 1);
    for (const image of look.images) {
      assert.ok(line.blobs.includes(image.blob), 'the line lists the image in its blobs');
      assert.ok(blobs.some((name) => name.startsWith(image.blob)), 'the image is in blobs/');
    }
  }
  assert.equal(lines.filter((line) => line.source === 'vision' && line.kind === 'shown').length, 9, 'one live line per read');
});

test('the photo sort\'s accuracy is computed from the receipts against the captions\' classes, per class and overall', { timeout: 240_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  const result = await apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'run'), cache: join(tmp, 'cache'), mode: 'quick', wrong: ['photo-green-2'] });
  assert.equal(result.outcome?.status, 'complete', result.stderr);
  const { accuracy, photos: sort } = result.account;
  assert.deepEqual(accuracy.overall, { right: 5, total: 6, rate: 0.833 });
  assert.deepEqual(accuracy.by_class.green, { right: 1, total: 2, rate: 0.5 });
  assert.deepEqual(accuracy.by_class.red, { right: 2, total: 2, rate: 1 });
  assert.deepEqual(sort.find((row) => row.item === 'photo-green-2').label, 'red');
  assert.deepEqual(sort.find((row) => row.item === 'photo-green-2').truth, 'green');
  assert.equal(accuracy.confusion.green.red, 1);
  assert.deepEqual(accuracy.unsorted, []);
  const looks = readdirSync(join(tmp, 'run', 'evidence', 'photo')).map((name) => receiptAt(join(tmp, 'run'), `evidence/photo/${name}`));
  for (const row of sort) assert.equal(looks.find((look) => look?.facts.key === row.receipt)?.facts.sha256, set.dataset.items.find((item) => item.id === row.item).sha256, 'each sorted photo rests on a look at its own bytes');
});

test('killed right after a look commits, the run resumes from its store: every look paid once, none repeated', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  const record = join(tmp, 'recording');
  const result = await apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'run'), cache: join(tmp, 'cache'), mode: 'quick', killAfterLook: 3, record });
  assert.equal(result.outcome?.status, 'complete', result.stderr);
  assert.equal(result.kills, 1);
  assert.equal(result.processes, 2);
  const committed = linesOf(join(tmp, 'run', 'looks-committed.jsonl'));
  assert.equal(new Set(committed.map((look) => look.pid)).size, 2, 'both processes committed looks');
  const { counters } = result.account;
  assert.equal(counters.paid, 9, 'each of the nine items\' looks is paid once');
  assert.equal(counters.repeated, 0);
  assert.equal(counters.asked_twice, 0);
  assert.deepEqual(result.problems, []);
  const kill = linesOf(join(record, 'events.jsonl')).find((line) => line.source === 'host' && line.kind === 'kill');
  assert.deepEqual(kill.data.crossing, { point: 'look.committed', n: 3 });
});

test('killed inside the evidence sink, the looks held there come back kept on resume, each paid once, none repeated', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  const record = join(tmp, 'recording');
  const result = await apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'run'), cache: join(tmp, 'cache'), mode: 'quick', sinkKill: { n: 3, hold: 3 }, record });
  assert.equal(result.outcome?.status, 'complete', result.stderr);
  assert.equal(result.kills, 1);
  const { counters } = result.account;
  assert.ok(counters.kept >= 2, `${counters.kept} looks came back kept`);
  assert.equal(counters.paid, 9);
  assert.equal(counters.repeated, 0);
  assert.equal(counters.asked_twice, 0);
  assert.deepEqual(result.problems, []);
  const kill = linesOf(join(record, 'events.jsonl')).find((line) => line.source === 'host' && line.kind === 'kill');
  assert.deepEqual(kill.data.crossing, { point: 'look.filing', n: 3 });
});

test('a look whose request threw has its miss code, and its unknown price makes the cost unknown, never $0', { timeout: 240_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  const record = join(tmp, 'recording');
  const result = await apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'run'), cache: join(tmp, 'cache'), mode: 'quick', fail: ['transcript-tec.pdf#page=2'], record });
  assert.equal(result.outcome?.status, 'complete', result.stderr);
  const { counters, transcript } = result.account;
  assert.ok(counters.failed >= 1);
  assert.equal(counters.cost_usd, null);
  assert.ok(counters.cost_unknown >= 1);
  assert.equal(transcript.times.pages, 2, 'the failed page has no ok look');
  const misses = linesOf(join(record, 'events.jsonl')).filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks).filter((look) => look.record.status === 'failed');
  assert.ok(misses.length >= 1 && misses.every((look) => look.miss?.code === 'look_failed' && look.miss.reason.length > 0 && look.item === 'transcript-tec'));
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.equal(manifest.cost.usd, null);
  assert.equal(manifest.cost.parts.look, null);
  assert.deepEqual(result.problems, []);
});

test('the weak eyes\' run goes in the main account as weak_eyes: its eyes, its run, the times it read with what each stands for, its photo sort', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  const weak = await apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'weak'), cache: join(tmp, 'cache'), mode: 'quick', weakEyes: true, wrong: ['photo-red-1'], name: 'weak-run' });
  assert.equal(weak.outcome?.status, 'complete', weak.stderr);
  const main = await apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'main'), cache: join(tmp, 'cache'), mode: 'quick', weakFrom: join(tmp, 'weak') });
  assert.equal(main.outcome?.status, 'complete', main.stderr);
  assert.deepEqual(main.account.weak_eyes, { model: 'scripted-eyes', source: 'weak-run', times: weak.account.transcript.times, photos: { right: 5, total: 6 } });
});

test('a file whose bytes do not match the data set is removed and refused before anything runs', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  const photo = set.dataset.items.find((item) => item.kind === 'photo');
  await assert.rejects(fetchItems([{ ...photo, sha256: '0'.repeat(64) }], join(tmp, 'cache')), (error) => error.code === 'DATASET_MISMATCH');
  assert.equal(existsSync(join(tmp, 'cache', `${photo.id}.png`)), false);
});

test('a workspace file whose bytes changed is replaced by the checked one, and a run resumes only on the data set it started with', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  const photo = set.dataset.items.find((item) => item.kind === 'photo');
  const paths = await fetchItems([photo], join(tmp, 'cache'));
  await mkdir(join(tmp, 'work'), { recursive: true });
  await writeFile(join(tmp, 'work', `${photo.id}.png`), 'damaged');
  await placeFiles(paths, [photo], join(tmp, 'work'));
  assert.equal(sha256(readFileSync(join(tmp, 'work', `${photo.id}.png`))), photo.sha256);
  await mkdir(join(tmp, 'run'), { recursive: true });
  await writeFile(join(tmp, 'run', 'input.json'), JSON.stringify({ dataset_sha256: '0'.repeat(64) }));
  await assert.rejects(apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'run'), cache: join(tmp, 'cache'), mode: 'quick' }), (error) => error.code === 'DATASET_CHANGED');
});

test('the shipped data set: NASA sources only, every item sized and hashed, every photo captioned in one of the five classes', () => {
  const { dataset, sha256: hash } = loadDataset();
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(dataset.classes).sort(), ['astronaut', 'earth', 'lunar_surface', 'moon_from_space', 'spacecraft']);
  const ids = new Set();
  for (const item of dataset.items) {
    assert.ok(!ids.has(item.id), `${item.id} is listed once`); ids.add(item.id);
    assert.match(new URL(item.url).hostname, /(^|\.)nasa\.gov$/, `${item.id} is a NASA file`);
    assert.equal(item.license, 'NASA public domain');
    assert.ok(Number.isInteger(item.bytes) && item.bytes > 0);
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    if (item.kind === 'photo') { assert.ok(item.class in dataset.classes, item.id); assert.ok(item.caption.length > 0); }
  }
  assert.equal(dataset.items.filter((item) => item.kind === 'photo').length, 60);
  assert.equal(dataset.items.length, 64);
});

test('through a gateway, the lead and the eyes are asked by their public model ids, with the gateway\'s credential', { timeout: 60_000 }, async (t) => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, auth: request.headers.authorization, model: (() => { try { return JSON.parse(body).model; } catch { return undefined; } })() });
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'refused by the test gateway', type: 'invalid_request_error' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { catalog, lead } = liveModels({ APOLLO_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, APOLLO_MODEL_API_KEY: 'gw-key' }, [LEAD, EYES]);
  assert.deepEqual(lead, LEAD);
  for (const model of [LEAD, EYES]) {
    const reply = await catalog.completeSimple(catalog.getModel(model.provider, model.modelId), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() }] }, {});
    assert.equal(reply.stopReason, 'error');
  }
  assert.deepEqual([...new Set(seen.map((row) => JSON.stringify([row.url.split('?')[0], row.model, row.auth])))].map((row) => JSON.parse(row)), [
    ['/v1/responses', 'gpt-6-luna', 'Bearer gw-key'],
    ['/v1/chat/completions', 'gemini-3.7-flash', 'Bearer gw-key'],
  ]);
  assert.throws(() => liveModels({}, [LEAD, EYES]), /OPENAI_API_KEY/);
});

test('a film window is read as frames and cited by #t=, when ffmpeg is on this machine', { timeout: 240_000, skip: (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return false; } catch { return 'ffmpeg is not installed'; } })() }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'apollo11-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const set = await syntheticDataset(tmp);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=12', '-pix_fmt', 'yuv420p', join(tmp, 'files', 'film.mp4')]);
  const bytes = readFileSync(join(tmp, 'files', 'film.mp4'));
  set.dataset.items.push({ id: 'film-descent', title: 'film', kind: 'film', role: 'test', url: pathToFileURL(join(tmp, 'files', 'film.mp4')).href, license: 'test', bytes: bytes.length, sha256: sha256(bytes), duration_s: 12, landing: { from_s: 0, to_s: 12 }, window_s: 6 });
  await writeFile(set.file, JSON.stringify(set.dataset));
  const result = await apollo({ dataset: set.file, scriptedPages: set.scriptedPages, dir: join(tmp, 'run'), cache: join(tmp, 'cache'), mode: 'quick' });
  assert.equal(result.outcome?.status, 'complete', result.stderr);
  assert.deepEqual(result.account.film.map((window) => window.fragment), ['#t=0,6', '#t=6,12']);
  assert.equal(result.account.counters.paid, 11);
});
