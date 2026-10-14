// The audit's badge read through a real pi-durable Harness: `badge_image` draws a pinned public badge that shows
// "failing" as a PNG, vision's `read` asks eyes that read the PNG's pixels, and one receipt is filed and kept in
// `vision.looks`. The same badge read as an SVG path reaches the model as its text, which is why the model is given
// only the PNG.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { createVisionExtension } from '@parcha/pi-vision/durable';
import { fakeEyes } from '@parcha/pi-vision/testing';
import sharp from 'sharp';
import { BADGE_ASK, VisionLooks, badgeImageTool, publicFetch, visionOptions } from './dependency-audit/badges.ts';

/** shields.io's static badge, as it answered on 2026-10-14: a public badge that always shows "build" and "failing", with
 *  both words in its title, its aria-label and its text elements. */
const BADGE_URL = 'https://img.shields.io/badge/build-failing-red';
const BADGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20" role="img" aria-label="build: failing"><title>build: failing</title><filter id="blur"><feGaussianBlur stdDeviation="16"/></filter><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="80" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="37" height="20" fill="#555"/><rect x="37" width="43" height="20" fill="#dd4343"/><rect width="80" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110"><g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="195" y="150" fill-opacity=".8" filter="url(#blur)" textLength="270">build</text><text x="195" y="150" fill-opacity=".3" textLength="270">build</text></g><text x="195" y="140" textLength="270">build</text></g><g transform="scale(.1)"><g aria-hidden="true" fill="#010101"><text x="575" y="150" fill-opacity=".8" filter="url(#blur)" textLength="330">failing</text><text x="575" y="150" fill-opacity=".3" textLength="330">failing</text></g><text x="575" y="140" textLength="330">failing</text></g></g></svg>';
const BADGE_SHA256 = 'fa13f7c3cac1295784ccd11d9e3bb2fdd2cd01bd7b3d48003b4aa78cc50c8782';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const textOf = (message) => message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'audit-badges-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A shields badge's value as its colour shows it, from the middle of its right edge: red is failing, green passing. */
async function valueOf(png) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (Math.floor(info.height / 2) * info.width + info.width - 4) * info.channels;
  const [r, g, b] = data.subarray(at, at + 3);
  return r > 150 && g < 110 && b < 110 ? 'failing' : g > 150 && r < 110 && b < 110 ? 'passing' : 'unreadable';
}

/** Eyes that answer from the image they are shown and nothing else, with every request they got. */
function pixelEyes() {
  const requests = [];
  let answer = '';
  const base = fakeEyes({ model: 'pixel-eyes', answers: [() => answer] });
  const eyes = { ...base, async see(request, signal) {
    requests.push(request);
    const images = request.parts.filter((part) => part.type === 'image');
    answer = images.length === 1 ? `build: ${await valueOf(Buffer.from(images[0].data, 'base64'))}` : 'no single image';
    return base.see(request, signal);
  } };
  return { eyes, requests };
}

/** One conversation on a real Harness over SQLite: a lead that takes images and makes `rounds` of tool calls, pi's
 *  coding tools in `cwd`, the badge tool and vision with the repository node's options. What each tool returned to the
 *  lead, what the sink filed, what the eyes saw, the images saved and the conversation's `vision.looks`. */
async function converse(t, { cwd, rounds, fetch = async () => Buffer.from(BADGE_SVG) }) {
  const faux = fauxProvider({ models: [{ id: 'lead-1', input: ['text', 'image'] }] });
  const requests = [];
  faux.setResponses(Array.from({ length: 16 }, () => (context) => {
    requests.push(context.messages);
    const round = rounds[context.messages.filter((message) => message.role === 'assistant').length];
    return round ? fauxAssistantMessage(round.map(([tool, args]) => fauxToolCall(tool, args)), { stopReason: 'toolUse' }) : fauxAssistantMessage([fauxText('done')], { stopReason: 'stop' });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const filed = [], images = [], fetched = [];
  const { eyes, requests: looked } = pixelEyes();
  const host = { evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/look-${filed.length}.json` }; } } };
  let harness;
  const vision = createVisionExtension({ evidence: host.evidence, scope: () => ({ label: 'repository', deriveDir: '.derived' }), ...visionOptions(host, { harness: () => harness, eyes }) });
  const badges = badgeImageTool({ fetch: async (url, signal) => { fetched.push(url.href); return fetch(url, signal); }, onImage: (image) => images.push(image) });
  const registry = createRegistry();
  for (const extension of [CodingTools, badges, vision.extension]) registry.install(extension);
  harness = await Harness.open(await openNodeSqliteStorage(join(cwd, '..', 'run.sqlite')), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'lead-1' } } });
  await (await root.submit({ type: 'input', content: 'go', requestId: 'go-1' }, ctx)).wait(ctx);
  const results = requests.at(-1).filter((message) => message.role === 'toolResult');
  const looks = async (key) => (await harness.snapshot(VisionLooks, root.id, key, ctx))?.looks;
  return { results, filed, looked, images, fetched, looks };
}

test('a badge read through read files one receipt whose words the eyes read from the PNG, kept in vision.looks', { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const cwd = join(dir, 'work');
  await mkdir(cwd);
  assert.equal(sha256(BADGE_SVG), BADGE_SHA256);
  const saved = 'badges/example-build.png';
  const run = await converse(t, { cwd, rounds: [[['badge_image', { url: BADGE_URL, dependency: 'example', label: 'build' }]], [['read', { path: saved, ask: BADGE_ASK }]]] });
  const [drawn, read] = run.results;

  assert.deepEqual(run.fetched, [BADGE_URL]);
  assert.deepEqual(JSON.parse(textOf(drawn)), { path: saved, width: 320, height: 80 }, 'the badge at four times its 80x20 px');
  for (const word of ['failing', '<svg', 'title']) assert.ok(!JSON.stringify(drawn).includes(word), `badge_image returned no "${word}"`);
  const png = await readFile(join(cwd, saved));
  assert.equal(await valueOf(png), 'failing', 'the PNG shows the red of a failing badge');
  assert.deepEqual(run.images.map((image) => [image.path, image.sha256, image.width, image.height]), [[saved, sha256(png), 320, 80]]);

  assert.equal(run.looked.length, 1, 'the eyes were asked once');
  const [request] = run.looked;
  assert.equal(request.ask, BADGE_ASK);
  assert.deepEqual(request.parts.filter((part) => part.type === 'image').map((part) => [part.mimeType, part.width, part.height]), [['image/png', 320, 80]], 'the eyes were shown the PNG');
  assert.ok(!JSON.stringify(request.parts.filter((part) => part.type === 'text')).includes('failing'), 'no text the eyes were given says failing');

  assert.equal(run.filed.length, 1, 'one receipt');
  const [record] = run.filed;
  assert.deepEqual([record.status, record.args.path, record.args.native, record.args.model, record.body], ['ok', saved, false, 'pixel-eyes', 'build: failing']);
  assert.equal(record.facts.sha256, sha256(png), 'the receipt names the PNG the eyes read');
  assert.ok(textOf(read).includes('build: failing') && textOf(read).includes('evidence/repository/look-1.json'), 'the lead read the eyes\' words and the receipt to cite');
  assert.ok(!read.content.some((block) => block.type === 'image'), 'the lead, which takes images, was shown none');
  assert.ok(!textOf(read).includes('<title>'));

  assert.deepEqual(await run.looks(record.facts.key), [{ receipt: 'evidence/repository/look-1.json', record: JSON.parse(JSON.stringify(record)) }]);
});

test('the same badge read as an SVG path reaches the model as its text: the title says failing, with no eyes and no receipt', { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const cwd = join(dir, 'work');
  await mkdir(cwd);
  await writeFile(join(cwd, 'badge.svg'), BADGE_SVG);
  const run = await converse(t, { cwd, rounds: [[['read', { path: 'badge.svg', ask: BADGE_ASK }]]] });
  const [read] = run.results;
  assert.ok(textOf(read).includes('<title>build: failing</title>'), 'the model would have read the title');
  assert.deepEqual([run.looked.length, run.filed.length], [0, 0]);
});

test('badge_image fetches only public https URLs, refusing the rest before any request', { timeout: 60_000 }, async (t) => {
  const refusals = [
    'http://img.shields.io/badge/build-failing-red',
    Object.assign(new URL(BADGE_URL), { username: 'a', password: 'b' }).href,
    'https://img.shields.io:8443/badge/build-failing-red',
    'https://127.0.0.1/badge.svg', 'https://0x7f.1/badge.svg', 'https://10.1.2.3/badge.svg', 'https://169.254.169.254/latest/meta-data',
    'https://192.168.0.10/badge.svg', 'https://[::1]/badge.svg', 'https://[::ffff:10.0.0.1]/badge.svg', 'https://[fd00::1]/badge.svg',
    'https://localhost/badge.svg',
  ];
  for (const url of refusals) await assert.rejects(publicFetch(new URL(url), AbortSignal.timeout(10_000)), { code: 'BADGE_URL_REFUSED' }, url);

  const dir = await scratch(t);
  const cwd = join(dir, 'work');
  await mkdir(cwd);
  const broken = async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>build: failing</title><text>failing');
  const run = await converse(t, { cwd, fetch: broken, rounds: [[['badge_image', { url: 'https://10.0.0.1/badge.svg', dependency: 'example', label: 'build' }], ['badge_image', { url: BADGE_URL, dependency: 'example', label: 'build' }]]] });
  const [privateUrl, brokenSvg] = run.results;
  assert.deepEqual(run.fetched, [BADGE_URL], 'the private URL was never fetched');
  assert.deepEqual([privateUrl.isError, brokenSvg.isError], [true, true]);
  assert.ok(!textOf(brokenSvg).includes('failing'), 'a badge that cannot be drawn says why without its text');
  assert.deepEqual(run.images, []);
});
