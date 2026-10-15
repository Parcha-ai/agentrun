// Apollo 11 at $0, on the reference entry. The template's three beats run what a run on fakes reads, the committed slice of NASA's
// files, with no network; what the program measures runs on a data set the test builds (pages of invented lines, solid-colour
// photos in the demo's classes, a typed reference in the markup of NASA's), steered by the demo's own `DEMO_*` settings. Both go
// through the demo's run.ts: the entry's supervisor, its children, a recording. Everything is checked on what the run filed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { pdfBytes, pngBytes } from '@parcha/pi-vision/testing';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { foldLooks, lookCounters, receiptAt } from './apollo11/account.ts';
import { DATASET_FILE, loadDataset, loadSlice, SLICE_DIR, sourcesFor } from './apollo11/dataset.ts';
import { sliceInput } from './apollo11/job.ts';
import { chooseModels, EYES, LEAD, liveModels, liveParts } from './apollo11/models.ts';
import { options } from './apollo11/run.ts';
import { demo } from './reference/index.ts';

const { dataset: REAL } = loadDataset();
const COLOURS = { earth: [40, 60, 220], astronaut: [220, 220, 220], lunar_surface: [120, 110, 100] };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FFMPEG = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
/** What a run on fakes reads with no --input, the committed slice: three film windows, three pages, five photos. Without ffmpeg it reads no film window. */
const DEFAULT = FFMPEG ? undefined : { ...sliceInput, film_to_s: sliceInput.film_from_s };
const LOOKS = FFMPEG ? 11 : 8;

/** Three pages of invented air-to-ground lines inside the account's span, the same lines in the typed reference's markup, and six
 *  photos, two in each of three of the demo's classes, written into the run's `work/` (a no-key run reads what is there); the manifest
 *  that names them, the page starts the scripted eyes answer from, and the input that reads them. */
async function synthetic(tmp) {
  const work = join(tmp, 'run', 'work');
  await mkdir(work, { recursive: true });
  const pages = [0, 1, 2].map((page) => Array.from({ length: 4 }, (_, line) => ({ time: `04 06 ${String(30 + page * 5 + line).padStart(2, '0')} ${String(10 + line).padStart(2, '0')}`, speaker: line % 2 ? 'AA' : 'BB', text: `Synthetic call ${page}-${line}.` })));
  const files = {
    'transcript-tec.pdf': pdfBytes(pages.map((lines) => ({ lines: lines.map((line) => `${line.time}   ${line.speaker}   ${line.text}`) }))),
    'transcript-tec-typed.html': Buffer.from(pages.flat().map((line) => `${line.time}        <font color="0000FF">${line.speaker}</font><br>\n${line.text}\n<br><br>\n`).join('\n')),
  };
  const photos = Object.keys(COLOURS).flatMap((name) => [1, 2].map((n) => ({ id: `photo-${name}-${n}`, name, bytes: pngBytes(64 + n, 48, COLOURS[name]) })));
  for (const photo of photos) files[`${photo.id}.png`] = photo.bytes;
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(work, name), bytes);
  const item = (id, kind, name, extra) => ({ id, title: id, kind, role: 'test', url: pathToFileURL(join(work, name)).href, license: 'test', bytes: files[name].length, sha256: sha256(files[name]), ...extra });
  const sources = {
    format: 'apollo11.dataset/1', classes: REAL.classes, class_rule: 'test', items: [
      item('transcript-tec', 'transcript', 'transcript-tec.pdf', { pages: 3 }),
      item('transcript-tec-typed', 'transcript', 'transcript-tec-typed.html', {}),
      ...photos.map((photo) => item(photo.id, 'photo', `${photo.id}.png`, { caption: 'test', class: photo.name })),
    ],
  };
  const file = join(tmp, 'sources.json');
  await writeFile(file, JSON.stringify(sources, null, 1));
  const pageStarts = join(tmp, 'pages.json');
  await writeFile(pageStarts, JSON.stringify({ item: 'transcript-tec', page_starts: { 1: pages[0][0].time, 2: pages[1][0].time, 3: pages[2][0].time } }));
  const input = {
    film_item: 'film-descent', film_file: 'film-descent.mp4', film_from_s: 0, film_to_s: 0, window_s: 6,
    scan_item: 'transcript-tec', scan_file: 'transcript-tec.pdf', pages_from: 1, pages_to: 3,
    photos: photos.map((photo) => photo.id), photo_ext: '.png', typed_item: 'transcript-tec-typed', typed_file: 'transcript-tec-typed.html',
    span_from: '04 06 20 00', span_to: '04 06 50 00',
  };
  return { file, sources, work, sha256: sha256(readFileSync(file)), input, env: { DEMO_APOLLO_SOURCES: file, DEMO_PAGES: pageStarts } };
}

const linesOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const scratch = async (t) => { const tmp = await mkdtemp(join(tmpdir(), 'apollo11-')); t.after(() => rm(tmp, { recursive: true, force: true })); return tmp; };
/** `npm run demo:apollo11 -- <args>` in the run directory `<tmp>/run`, with the demo's `DEMO_*` settings in `env` for its processes. */
async function go(tmp, args = [], env = {}) {
  Object.assign(process.env, env);
  try { return await demo({ ...options, argv: ['--dir', join(tmp, 'run'), ...args] }); } finally { for (const name of Object.keys(env)) delete process.env[name]; }
}
/** The demo as `npm run demo:apollo11` runs it on fakes: the slice, and the spec's own kill. */
const slice = (tmp, args = []) => go(tmp, [...(DEFAULT ? ['--input', JSON.stringify(DEFAULT)] : []), ...args]);
const statusOf = (run) => run.processes.at(-1)?.outcome?.status;
const stderrOf = (run) => run.processes.map((process) => `${process.outcome?.message ?? ''}\n${process.stderr}`).join('\n');
/** The recording's text files that hold this machine's name or the run's own directory. */
const leaks = (record, own) => {
  const walk = (at) => (statSync(at).isDirectory() ? readdirSync(at).flatMap((name) => walk(join(at, name))) : [at]);
  return walk(record).filter((file) => /\.(?:jsonl?|txt|md)$/.test(file) && [hostname(), own].some((value) => readFileSync(file, 'utf8').includes(value)));
};

test('beat 1: on fakes, with no network, the job reads the slice and delivers an agentrun.cited/1 result whose every cite is a look at exactly the cited bytes', { timeout: 240_000 }, async (t) => {
  const tmp = await scratch(t);
  const run = await slice(tmp);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const result = run.record;
  assert.equal(result.format, 'agentrun.cited/1');
  assert.ok(result.rows.length >= 3, 'a row a minute of read lines');
  const items = new Map(REAL.items.map((item) => [item.id, item]));
  const filed = new Map(readdirSync(join(tmp, 'run', 'evidence'), { recursive: true }).filter((name) => name.endsWith('.json')).map((name) => {
    const record = JSON.parse(readFileSync(join(tmp, 'run', 'evidence', name), 'utf8'));
    return [record.facts.key, record];
  }));
  for (const row of result.rows) {
    assert.match(row.label, /^\d{3}:\d{2}:\d{2}$/);
    assert.ok(row.cites.length >= 1);
    for (const cite of row.cites) {
      const look = filed.get(cite.look);
      assert.ok(look, `the cite's look ${cite.look} is one the run filed`);
      assert.equal(look.status, 'ok');
      assert.equal(look.facts.sha256, items.get(cite.note).sha256, 'the look read exactly the cited item\'s bytes');
      assert.match(cite.fragment, /^#(?:page=\d+|t=[\d.]+,[\d.]+|xywh=percent:[\d.,]+)$/);
    }
  }
  assert.equal(result.apollo11.format, 'apollo11.account/1');
  assert.equal(result.apollo11.dataset_sha256, sha256(readFileSync(DATASET_FILE)));
  assert.deepEqual(result.apollo11.dropped, []);
  assert.equal(result.apollo11.transcript.times.pages, 3);
  assert.ok(result.apollo11.transcript.times.times > 0);
  assert.equal(result.apollo11.transcript.times.in_typed, result.apollo11.transcript.times.times, 'the scripted eyes read the typed lines back');
  assert.deepEqual(result.apollo11.accuracy.overall, { right: 5, total: 5, rate: 1 });
});

test('beat 2: killed inside the evidence sink at vision.filing, a fresh process resumes; the fold reads repeated 0, measured, and unknown 0, and the held looks come back kept', { timeout: 300_000 }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const [kill] = options.spec.kills;
  assert.ok(kill.n + kill.hold - 1 <= LOOKS, 'the spec\'s kill lands inside the default run\'s looks');
  const run = await slice(tmp, ['--kill', '--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.deepEqual(run.kills.map((each) => each.point), ['vision.filing']);
  assert.deepEqual(run.unlanded, []);
  assert.equal(run.processes.length, 2);
  const line = linesOf(join(record, 'events.jsonl')).find((row) => row.source === 'host' && row.kind === 'kill');
  assert.equal(line.data.crossing.point, 'vision.filing');
  const folded = fold(readEvents(record));
  assert.equal(folded.repeated, 0);
  assert.equal(folded.repeatedNotMeasured, 0);
  assert.equal(folded.unknown, 0);
  assert.equal(folded.paid.vision, LOOKS, 'each item\'s look is paid once');
  const counted = lookCounters(join(tmp, 'run', 'store', 'run.sqlite'));
  assert.ok(counted.kept >= 1, `${counted.kept} looks came back kept`);
  assert.equal(counted.repeated, 0);
});

test('beat 3: every paid look has its receipt, the recording validates, says scripted, names its sources, and its cost is a number it earned', { timeout: 240_000 }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await slice(tmp, ['--record', record]);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.deepEqual(validateRecording(record), []);
  assert.deepEqual(leaks(record, tmp), []);
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.equal(manifest.providers, 'scripted');
  assert.equal(manifest.sources.sha256, sha256(readFileSync(DATASET_FILE)));
  assert.equal(manifest.slice.sha256, loadSlice().sha256);
  assert.deepEqual(manifest.models, { lead: 'scripted lead (pi-ai faux)', eyes: 'scripted-eyes' });
  assert.equal(manifest.cost.usd, 0, 'the scripted parts are priced at 0, so the run cost 0');
  const blobs = readdirSync(join(record, 'blobs'));
  const filings = linesOf(join(record, 'events.jsonl')).filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks' && !line.snapshot);
  assert.equal(new Set(filings.map((line) => line.data.key)).size, LOOKS);
  for (const line of filings) for (const look of line.data.value.looks) {
    assert.ok(look.receipt && receiptAt(join(tmp, 'run'), look.receipt), 'the look\'s receipt is a file the run filed');
    assert.ok(REAL.items.some((item) => item.id === look.item));
    assert.ok(look.images.length >= 1 && look.images.every((image) => line.blobs.includes(image.blob) && blobs.some((name) => name.startsWith(image.blob))));
  }
  assert.deepEqual(JSON.parse(readFileSync(join(record, 'blobs', `${manifest.result.blob}.json`), 'utf8')), JSON.parse(JSON.stringify(run.record)));
});

test('a look whose request threw has its miss code, and its unknown price makes the cost unknown, never $0', { timeout: 240_000 }, async (t) => {
  const tmp = await scratch(t);
  const set = await synthetic(tmp);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--input', JSON.stringify(set.input), '--record', record], { ...set.env, DEMO_FAIL: 'transcript-tec.pdf#page=2' });
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const counted = lookCounters(join(tmp, 'run', 'store', 'run.sqlite'));
  assert.ok(counted.failed >= 1);
  assert.equal(counted.cost_usd, null);
  assert.equal(run.record.apollo11.transcript.times.pages, 2, 'the failed page has no ok look');
  const misses = linesOf(join(record, 'events.jsonl')).filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks).filter((look) => look.record.status === 'failed');
  assert.ok(misses.length >= 1 && misses.every((look) => look.miss?.code === 'look_failed' && look.miss.reason.length > 0 && look.item === 'transcript-tec'));
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.equal(manifest.cost.usd, null);
  assert.deepEqual(validateRecording(record), []);
});

test('the photo sort\'s accuracy is computed from the receipts against the captions\' classes, by class and overall', { timeout: 240_000 }, async (t) => {
  const tmp = await scratch(t);
  const set = await synthetic(tmp);
  const run = await go(tmp, ['--input', JSON.stringify(set.input)], { ...set.env, DEMO_WRONG: 'photo-astronaut-2' });
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const { accuracy, photos } = run.record.apollo11;
  assert.deepEqual(accuracy.overall, { right: 5, total: 6, rate: 0.833 });
  assert.deepEqual(accuracy.by_class.astronaut, { right: 1, total: 2, rate: 0.5 });
  assert.deepEqual(accuracy.by_class.earth, { right: 2, total: 2, rate: 1 });
  assert.equal(photos.find((row) => row.item === 'photo-astronaut-2').truth, 'astronaut');
  assert.notEqual(photos.find((row) => row.item === 'photo-astronaut-2').label, 'astronaut');
});

test('the weak eyes\' run is linked from the main recording by see_also, never merged into its result', { timeout: 300_000 }, async (t) => {
  const tmp = await scratch(t);
  const set = await synthetic(tmp);
  const weak = join(tmp, 'weak-recording');
  const first = await go(tmp, ['--input', JSON.stringify(set.input), '--record', weak], { ...set.env, DEMO_WRONG: 'photo-earth-1' });
  assert.equal(statusOf(first), 'complete', stderrOf(first));
  const other = await scratch(t);
  const again = await synthetic(other);
  const main = join(other, 'main-recording');
  const run = await go(other, ['--input', JSON.stringify(again.input), '--record', main, '--see-also', weak], again.env);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const manifest = JSON.parse(readFileSync(join(main, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.see_also, [{ recording: 'weak-recording', label: JSON.parse(readFileSync(join(weak, 'manifest.json'), 'utf8')).title }]);
  assert.equal(run.record.apollo11.weak_eyes, undefined);
});

test('the look counters follow the recording format: a kept filing pays only as its key\'s first, and a later payment by another process is repeated', () => {
  const look = (key, { kept = false, status = 'ok', cost = 0.01 } = {}) => ({ tool: 'look', args: { path: 'x', model: 'm', native: false }, status, facts: { sha256: 's', kind: 'image', fragment: '', key, ...(cost === null ? {} : { cost_usd: cost }), ...(kept ? { kept: true } : {}) }, body: '' });
  const filing = (record, incarnation) => ({ receipt: null, record, incarnation });
  assert.deepEqual(foldLooks([{ looks: [filing(look('a', { kept: true }), 'p2'), filing(look('a'), 'p3')] }]),
    { looks: 2, paid: 2, kept: 1, repeated: 1, asked_twice: 0, failed: 0, cost_usd: 0.02, cost_unknown: 0 });
  assert.deepEqual(foldLooks([{ looks: [filing(look('b'), 'p1'), filing(look('b', { kept: true }), 'p2')] }, { looks: [filing(look('c'), 'p1'), filing(look('c'), 'p1')] }]),
    { looks: 4, paid: 3, kept: 1, repeated: 0, asked_twice: 1, failed: 0, cost_usd: 0.03, cost_unknown: 0 });
  assert.deepEqual(foldLooks([{ looks: [filing(look('d', { status: 'failed', cost: null }), 'p1'), filing(look('e'), 'p1')] }]),
    { looks: 2, paid: 1, kept: 0, repeated: 0, asked_twice: 0, failed: 1, cost_usd: null, cost_unknown: 1 });
});

test('the shipped sources: NASA files only, every one sized and hashed, every photo captioned in one of the five classes', () => {
  const { dataset, sha256: hash } = loadDataset(DATASET_FILE);
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

test('the slice: every committed file is the size and SHA-256 slice.json fixes, cut from a checked file or that file unchanged, under 1 MB in all, and the job\'s files', () => {
  const { slice } = loadSlice();
  const sources = new Map(loadDataset(DATASET_FILE).dataset.items.map((item) => [item.id, item]));
  assert.deepEqual(readdirSync(SLICE_DIR).sort(), [...slice.files.map((entry) => entry.file), 'cut.sh', 'slice.json'].sort(), 'the directory holds the listed files and how they were cut');
  for (const entry of slice.files) {
    const bytes = readFileSync(join(SLICE_DIR, entry.file));
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(sha256(bytes), entry.sha256, entry.file);
    const from = sources.get(entry.from);
    assert.ok(from, `${entry.file} names the item of sources.json it comes from`);
    assert.ok(entry.cut.length > 0);
    if (entry.item) assert.equal(entry.item.license, from.license);
    else assert.equal(entry.sha256, from.sha256, `${entry.file} is NASA's file unchanged`);
    assert.deepEqual(new Uint8Array(options.job.files[entry.file]), new Uint8Array(bytes), `${entry.file} is one of the job's files`);
  }
  assert.equal(Object.keys(options.job.files).length, slice.files.length);
  assert.ok(slice.files.reduce((total, entry) => total + entry.bytes, 0) < 1_000_000);
});

test('the entry fetches only the NASA files an input reads; the slice\'s cuts are the job\'s own', () => {
  const held = new Set(Object.keys(options.job.files));
  const onFakes = sourcesFor(sliceInput);
  assert.deepEqual(onFakes.map((item) => item.id).sort(), [...sliceInput.photos].sort(), 'the slice reads only photographs that are NASA\'s files unchanged');
  assert.ok(onFakes.every((item) => held.has(`${item.id}.jpg`)));
  const gallery = JSON.parse(readFileSync(join(import.meta.dirname, 'apollo11', 'inputs', 'gallery.json'), 'utf8'));
  const needed = sourcesFor(gallery);
  assert.deepEqual(needed.map((item) => item.id).sort(), [gallery.film_item, gallery.scan_item, gallery.typed_item, ...gallery.photos].sort());
  assert.ok(needed.every((item) => /^https:\/\/[^/]*nasa\.gov\//.test(item.url) && /^[0-9a-f]{64}$/.test(item.sha256)));
});

test('an input that reads NASA\'s own files is refused with no flag, before anything is downloaded; --fetch-sources or --live asks for them', { timeout: 60_000 }, async (t) => {
  const tmp = await scratch(t);
  const run = await go(tmp, ['--input', join(import.meta.dirname, 'apollo11', 'inputs', 'gallery.json'), '--cache', join(tmp, 'cache')]);
  assert.notEqual(statusOf(run), 'complete');
  assert.match(run.processes.at(-1).outcome.message, /--fetch-sources/);
  assert.equal(existsSync(join(tmp, 'cache')), false, 'nothing was fetched');
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
    ['/v1/chat/completions', 'gemini-3.8-flash', 'Bearer gw-key'],
  ]);
  assert.throws(() => liveModels({}, [LEAD, EYES]), /OPENAI_API_KEY/);
});

test('with no model named, a run takes the default lead and eyes when it can, else each keyed provider\'s own image-taking models; the live parts take the entry\'s model flags', () => {
  const name = ({ lead, eyes }) => [`${lead.provider}/${lead.modelId}`, `${eyes.provider}/${eyes.modelId}`];
  assert.deepEqual(name(chooseModels({ OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k' })), ['openai/gpt-6-luna', 'google/gemini-3.8-flash']);
  assert.deepEqual(name(chooseModels({ APOLLO_MODEL_BASE_URL: 'http://gateway/v1', APOLLO_MODEL_API_KEY: 'k' })), ['openai/gpt-6-luna', 'google/gemini-3.8-flash']);
  assert.deepEqual(name(chooseModels({ OPENAI_API_KEY: 'k' })), ['openai/gpt-6-luna', 'openai/gpt-6-sol']);
  assert.deepEqual(name(chooseModels({ GEMINI_API_KEY: 'k' })), ['google/gemini-3.8-flash', 'google/gemini-3.8-flash']);
  assert.deepEqual(name(chooseModels({ ANTHROPIC_API_KEY: 'k' })), ['anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5']);
  assert.deepEqual(name(chooseModels({ OPENAI_API_KEY: 'k' }, { eyes: 'openai/gpt-6-luna' })), ['openai/gpt-6-luna', 'openai/gpt-6-luna']);
  assert.throws(() => chooseModels({}), /OPENAI_API_KEY/);
  assert.throws(() => chooseModels({ OPENAI_API_KEY: 'k' }, { eyes: 'acme/model' }), /provider\/id/);
  const parts = liveParts({ env: { APOLLO_MODEL_BASE_URL: 'http://gateway/v1', APOLLO_MODEL_API_KEY: 'k' }, models: { provider: 'openai', model: 'gpt-6-luna', eyesModel: 'openai/gpt-6-luna' } });
  assert.deepEqual(parts.host.models.lead, LEAD);
  assert.deepEqual(parts.vision().eyesModel, { provider: 'openai', modelId: 'gpt-6-luna' });
  assert.deepEqual(parts.vision().limits(), { image: { native: false } });
  assert.deepEqual(parts.models, { lead: 'openai/gpt-6-luna', eyes: 'openai/gpt-6-luna' }, 'what the manifest names');
});

test('a film window is read as frames and cited by #t=, when ffmpeg is on this machine', { timeout: 240_000, skip: FFMPEG ? false : 'ffmpeg is not installed' }, async (t) => {
  const tmp = await scratch(t);
  const set = await synthetic(tmp);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=12', '-pix_fmt', 'yuv420p', join(set.work, 'film-descent.mp4')]);
  const bytes = readFileSync(join(set.work, 'film-descent.mp4'));
  set.sources.items.push({ id: 'film-descent', title: 'film', kind: 'film', role: 'test', url: pathToFileURL(join(set.work, 'film-descent.mp4')).href, license: 'test', bytes: bytes.length, sha256: sha256(bytes), duration_s: 12 });
  await writeFile(set.file, JSON.stringify(set.sources));
  const run = await go(tmp, ['--input', JSON.stringify({ ...set.input, film_to_s: 12 })], set.env);
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.deepEqual(run.record.apollo11.film.map((window) => window.fragment), ['#t=0,6', '#t=6,12']);
  assert.equal(lookCounters(join(tmp, 'run', 'store', 'run.sqlite')).paid, 11);
});
