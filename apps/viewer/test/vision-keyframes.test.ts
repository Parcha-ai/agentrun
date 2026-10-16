// Pictures a cited result names: a cite whose file is a picture in the recording is drawn small in its row (a strip when
// a row cites several), and a window of film the eyes saw as video, with no picture of its own, shows the keyframes a
// row pairs with it, each labelled as that chapter's keyframe, never as what the eyes saw. On the hand recording of
// vision-hand.ts delivering chapters, and on the film recording FILM_RECORDING names, when there is one.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { typeOfName } from '../src/blobs.ts';
import { parseLines, validate, type Json, type Line } from '../src/format.ts';
import type { Node, ViewContext } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { visionCitedOf, visionPanel } from '../src/vision.ts';
import { blobs, CHAPTERS, CITED, deliverInstead, FILM, K, lines, PHOTOS, RESULT, SCANS, withoutFilmFrames, writeRecording } from './vision-hand.ts';

const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => {
  if (typeof node === 'string') return;
  visit(node);
  if ('children' in node) for (const child of node.children ?? []) walk(child, visit);
};
const find = (node: Node, test: (node: Exclude<Node, string>) => boolean) => { const out: Exclude<Node, string>[] = []; walk(node, (each) => { if (test(each)) out.push(each); }); return out; };
const words = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(words).join(' ') : '');
const text = (node: Node) => words(node).replace(/\s+/g, ' ');
const cls = (name: string) => (each: Exclude<Node, string>) => 'class' in each && new RegExp(`(^| )${name}( |$)`).test(each.class ?? '');
const blobOf = (each: Exclude<Node, string>) => ('blob' in each ? each.blob : undefined);
const blobType = (sha: string) => { const ext = blobs.get(sha)?.ext; return ext ? typeOfName(`${sha}.${ext}`) : undefined; };
const view = (result: Json, run: Line[], context: Partial<ViewContext> = {}) =>
  visionPanel.view(reduceTo(visionPanel, run, run.length), { t: 0, json: (sha) => (sha === RESULT ? result : undefined), blobType, ...context });
const frameless = withoutFilmFrames(lines);

test('a picture a row cites is drawn small in its row, several make a strip, and any other file is a link', () => {
  const rows = find(view(CITED as unknown as Json, lines), cls('vz-entry'));
  const pictures = (row: Node) => find(row, cls('vz-keyframe')).map(blobOf);
  assert.deepEqual(rows.map(pictures), [[], [PHOTOS[0]], [FILM[0]], [], [], [], []], 'the photo beside its look and the picture a share was read from');
  assert.deepEqual(find(rows[1]!, cls('vz-keyframe')).map((each) => ('alt' in each ? each.alt : undefined)), ['The first photograph'], 'named by its row');
  assert.deepEqual(find(rows[6]!, (each) => each.tag === 'a').map((each) => [blobOf(each), 'fragment' in each ? each.fragment : undefined]), [[SCANS, '#page=2']], 'the scans are a file');
  const chapters = find(view(CHAPTERS as unknown as Json, frameless), cls('vz-entry'));
  assert.deepEqual(chapters.map(pictures), [[], [FILM[0], FILM[1]], [FILM[2]]], 'a chapter row shows its keyframes, in the order it cites them');
  assert.match(text(chapters[0]!), /Summary ground, then a shadow cites nothing/);
  const unknown = find(view(CITED as unknown as Json, lines, { blobType: () => undefined }), cls('vz-entry'));
  assert.deepEqual(unknown.map(pictures).flat(), [], 'a file whose type the shell has not found is a link, as before');
});

test('a window of film with no picture of its own shows the keyframes a row pairs with it, labelled as the chapters\' keyframes', () => {
  const chosen = view(CHAPTERS as unknown as Json, frameless, { cite: K.film });
  const strip = find(chosen, cls('vz-strip'))[0]!;
  assert.deepEqual(find(strip, cls('vz-frame')).map(blobOf), [FILM[0], FILM[1], FILM[2]], 'every keyframe a row cites beside the window, once each');
  assert.deepEqual(find(strip, (each) => each.tag === 'figcaption').map(text), ['keyframe: The ground slides past', 'keyframe: The ground slides past', 'keyframe: A shadow crosses']);
  assert.match(text(chosen), /The chapter's keyframe, not what the eyes saw: they looked at the window itself\./);
  assert.match(text(find(chosen, cls('vz-receipt'))[0]!), /Receipt · film-window #t=0,30/, 'the receipt is still the look\'s');
  const own = view(CHAPTERS as unknown as Json, lines, { cite: K.film });
  assert.deepEqual(find(find(own, cls('vz-strip'))[0]!, cls('vz-frame')).map(blobOf), FILM, 'the frames the read showed win over any keyframe');
  assert.doesNotMatch(text(own), /keyframe/);
  const untyped = view(CHAPTERS as unknown as Json, frameless, { cite: K.film, blobType: () => undefined });
  assert.match(text(find(untyped, cls('vz-strip'))[0]!), /no picture in this recording/, 'with no file known to be a picture, the window has none');
  const paired = { format: 'agentrun.cited/1', rows: [{ label: 'a page', value: 'x', cites: [{ look: K.page2 }, { blob: PHOTOS[1]! }] }] } as unknown as Json;
  const state = reduceTo(visionPanel, frameless, frameless.length);
  const bare = { ...state, looks: state.looks.map((look) => (look.key === K.page2 ? { ...look, images: [] } : look)) };
  const scan = visionPanel.view(bare, { t: 0, json: (sha) => (sha === RESULT ? paired : undefined), blobType, cite: K.page2 });
  const lane = find(scan, cls('vz-page'))[0]!;
  assert.ok(find(lane, (each) => each.tag === 'img').length === 0 && /no picture in this recording/.test(text(lane)), 'a page with no scan of its own is drawn without one: a picture beside it is no keyframe');
  assert.doesNotMatch(text(scan), /keyframe/);
});

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const page = (out: string, query: string) => {
  build(join(out, 'dist'), join(out, 'recordings'));
  const ran = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
    '--virtual-time-budget=4000', '--dump-dom', `${pathToFileURL(join(out, 'dist', 'index.html')).href}?${query}`], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.doesNotMatch(ran.stdout, /breaks the format/);
  return ran.stdout;
};
const imgs = (dom: string, className: string) => (dom.match(new RegExp(`<img [^>]*class="${className}"[^>]*>`, 'g')) ?? []).filter((img) => /src="data:image\/(png|jpeg)/.test(img));

test('the page draws the chapters\' keyframes in their rows and on the film, from the recording\'s own blobs', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-keyframes-'));
  t.after(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  writeRecording(join(out, 'recordings', 'vision-chapters'), frameless);
  deliverInstead(join(out, 'recordings', 'vision-chapters'), CHAPTERS as unknown as Json);
  // At the end (`t` past the last line): a row pairs a keyframe with a window only once the result is delivered.
  const dom = page(out, `r=vision-chapters&cite=${K.film}&t=999999`);
  assert.equal(imgs(dom, 'vz-keyframe').length, 3, 'three keyframes in two chapter rows');
  assert.equal(imgs(dom, 'vz-frame').length, 3, 'and on the film, beside the window');
  assert.ok(dom.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').includes('keyframe: A shadow crosses'));
});

/** A static host's policy: pictures may be data: or blob: URLs, but the page fetches only from its own origin. */
const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; object-src 'none'";

test('over HTTP, with a host policy that fetches only from its own origin, the chapters draw with their keyframes: embedded, opened by URL, or followed', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-keyframes-http-'));
  t.after(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  writeRecording(join(out, 'recordings', 'vision-chapters'), frameless);
  deliverInstead(join(out, 'recordings', 'vision-chapters'), CHAPTERS as unknown as Json);
  mkdirSync(join(out, 'none'));
  build(join(out, 'dist'), join(out, 'none'));
  // A published site: the recording embedded, each blob a data: URL the page must read without fetching it.
  build(join(out, 'site'), join(out, 'recordings'));
  const asked: string[] = [];
  // The recording's files by their paths, a 200 for the whole file (no ranges), and no listing of blobs/.
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    asked.push(`${request.method} ${path}`);
    const file = path.startsWith('/viewer/') ? join(out, 'dist', path.slice(8)) : path.startsWith('/site/') ? join(out, 'site', path.slice(6))
      : path.startsWith('/rec/') ? join(out, 'recordings', 'vision-chapters', path.slice(5)) : '';
    if (!file || !existsSync(file) || statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': typeOfName(file) ?? (file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/plain'), 'content-security-policy': POLICY })
      .end(request.method === 'HEAD' ? undefined : readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const dump = (page: string) => new Promise<string>((resolve) => {
    const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, `profile-${asked.length}`)}`,
      '--virtual-time-budget=8000', '--dump-dom', `http://127.0.0.1:${(server.address() as AddressInfo).port}/${page}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    browser.stdout.on('data', (chunk: Buffer) => { text += chunk; });
    browser.on('close', () => resolve(text));
  });
  const drawn = (dom: string, className: string) => (dom.match(new RegExp(`<img [^>]*class="${className}"[^>]*>`, 'g')) ?? []).filter((img) => /src="[^"]+"/.test(img));
  // At the end, with no citation: the film lane shows the window it read last, and its keyframes.
  for (const opened of ['site/index.html?r=vision-chapters', 'viewer/index.html?src=/rec/', 'viewer/index.html?follow=/rec/']) {
    const dom = await dump(`${opened}&t=999999`);
    assert.match(dom, /film\.mp4, in 2 chapters/, `${opened}: the result is read`);
    assert.doesNotMatch(dom, /breaks the format/);
    assert.equal(drawn(dom, 'vz-keyframe').length, 3, `${opened}: the three keyframes in their rows`);
    assert.equal(drawn(dom, 'vz-frame').length, 3, `${opened}: and on the film`);
    assert.doesNotMatch(dom, /not in this recording/, `${opened}: none is missing`);
  }
  assert.ok([FILM[0], FILM[1], FILM[2]].every((sha) => asked.some((request) => request.endsWith(`/rec/blobs/${sha}.png`))), 'each keyframe asked for by its name');
});

const film = process.env.FILM_RECORDING;
test('the film recording: each chapter row draws its keyframe, and each window a chapter cites shows it, labelled', { skip: film && existsSync(film) ? false : 'FILM_RECORDING names no recording' }, (t) => {
  const run = parseLines(readFileSync(join(film!, 'events.jsonl'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(film!, 'manifest.json'), 'utf8'));
  const names = readdirSync(join(film!, 'blobs'));
  assert.deepEqual(validate(manifest, run, new Set(names.map((name) => name.split('.')[0]!))), []);
  const typeOf = (sha: string) => { const name = names.find((each) => each.startsWith(`${sha}.`)); return name ? typeOfName(name) : undefined; };
  const result = JSON.parse(readFileSync(join(film!, 'blobs', names.find((name) => name.startsWith(manifest.result.blob))!), 'utf8')) as Json;
  const cited = visionCitedOf(result)!;
  const keyframed = cited.rows.filter((row) => row.cites.some((each) => each.blob && typeOf(each.blob)?.startsWith('image/')));
  assert.ok(keyframed.length > 0, 'the chapters cite keyframes');
  const context = { t: 0, json: (sha: string) => (sha === manifest.result.blob ? result : undefined), blobType: typeOf };
  const state = reduceTo(visionPanel, run, run.length);
  const rows = find(visionPanel.view(state, context), cls('vz-entry'));
  for (const [at, row] of cited.rows.entries()) {
    const pictures = row.cites.flatMap((each) => (each.blob && typeOf(each.blob)?.startsWith('image/') ? [each.blob] : []));
    assert.deepEqual(find(rows[at]!, cls('vz-keyframe')).map(blobOf), pictures, `row ${at} (${row.label}) draws its pictures`);
  }
  const window = keyframed[0]!.cites.find((each) => each.look)!.look!;
  const chosen = visionPanel.view(state, { ...context, cite: window });
  const captions = find(find(chosen, cls('vz-strip'))[0]!, (each) => each.tag === 'figcaption').map(text);
  assert.ok(captions.length > 0 && captions.every((caption) => caption.startsWith('keyframe: ')), `the window shows keyframes: ${captions.join(' | ')}`);
  assert.ok(captions.includes(`keyframe: ${keyframed[0]!.label}`), 'the first chapter that cites it among them');
  if (!existsSync(chrome)) return;
  const out = mkdtempSync(join(tmpdir(), 'viewer-film-'));
  t.after(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  cpSync(film!, join(out, 'recordings', basename(film!)), { recursive: true });
  const dom = page(out, `r=${basename(film!)}&cite=${window}&t=999999`);
  const keyframes = cited.rows.flatMap((row) => row.cites).filter((each) => each.blob && typeOf(each.blob)?.startsWith('image/')).length;
  assert.equal(imgs(dom, 'vz-keyframe').length, keyframes, 'every keyframe a row cites is drawn on the page');
  assert.equal(imgs(dom, 'vz-frame').length, captions.length, 'and the chosen window\'s');
});
