// The document panel: the pages of a PDF a cited result names, drawn with PDF.js, each box a row cites placed over its
// page in percent of the crop box. On the hand recording of vision-hand.ts delivering a made-up certificate check whose
// PDF this file writes by hand (a crop box inside the media box on page 1, so a box placed on the media box would land
// off its mark, and page 3 a scan whose image is CCITT coded, as a scanner writes one), the view is checked as nodes,
// and the page in a real Chrome under a static host's policy (scripts, workers and fetches only from its own origin):
// embedded, opened by URL and followed, each mark's box over the black the PDF draws there, and nothing the policy
// refused.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import { typeOfName } from '../src/blobs.ts';
import { docPagesOf, documentPanel } from '../src/document.ts';
import { parseLines, validate, type Json, type Line } from '../src/format.ts';
import { panelsFor, type Box, type Node, type ViewContext } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { visionCitedOf } from '../src/vision.ts';
import { closeAll, closeLeftBrowsers, chrome, drivenPage } from './driven-page.ts';
import { ACCOUNT, CHAPTERS, deliverInstead, K, lines, PAGES, RESULT, writeRecording } from './vision-hand.ts';

/** A scan of 400 by 500 pixels, white with a black block over columns 100 to 300 and rows 200 to 300, coded as CCITT
 *  Group 4 (T.6), each line against the one above it: a white line under a white one is one vertical code (1); the
 *  block's first line a horizontal code (001, white 100 as 11011 00010101, black 200 as 000011001001 000101) and a
 *  vertical one; each line under it three vertical codes; the first white line after it a pass code (0001) and a
 *  vertical one; then the end of the block. */
function g4Scan(): Buffer {
  const line = (row: number) => (row === 200 ? '001' + '11011' + '00010101' + '000011001001' + '000101' + '1' : row > 200 && row < 300 ? '111' : row === 300 ? '00011' : '1');
  const coded = `${Array.from({ length: 500 }, (_, row) => line(row)).join('')}000000000001000000000001`;
  const bits = coded.padEnd(Math.ceil(coded.length / 8) * 8, '0');
  return Buffer.from(Array.from({ length: bits.length / 8 }, (_, at) => parseInt(bits.slice(at * 8, at * 8 + 8), 2)));
}

/** A PDF of `pages`, each `media` points wide and high with its crop box, a black rectangle at each mark (percent of the
 *  crop box, from its top left), and a scan over the whole crop box when it has one, with the byte offsets its
 *  cross-reference table names. */
function pdfOf(pages: { media: [number, number]; crop: [number, number, number, number]; marks: Box[]; scan?: Buffer }[]): Buffer {
  const bytes = (text: string) => Buffer.byteLength(text, 'latin1');
  const bodies: string[] = ['', ''];
  const kids: number[] = [];
  for (const page of pages) {
    const [x0, y0, x1, y1] = page.crop;
    const [w, h] = [x1 - x0, y1 - y0];
    let image = '';
    if (page.scan) {
      bodies.push(`<< /Type /XObject /Subtype /Image /Width 400 /Height 500 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 400 /Rows 500 >> /Length ${page.scan.length} >>\nstream\n${page.scan.toString('latin1')}\nendstream`);
      image = ` /Resources << /XObject << /Scan ${bodies.length} 0 R >> >>`;
    }
    const stream = `${page.scan ? `q ${w} 0 0 ${h} ${x0} ${y0} cm /Scan Do Q\n` : ''}0 0 0 rg\n${page.marks.map((m) => `${x0 + (m.x / 100) * w} ${y1 - ((m.y + m.h) / 100) * h} ${(m.w / 100) * w} ${(m.h / 100) * h} re f`).join('\n')}\n`;
    bodies.push(`<< /Length ${bytes(stream)} >>\nstream\n${stream}endstream`);
    bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.media.join(' ')}] /CropBox [${page.crop.join(' ')}]${image} /Contents ${bodies.length} 0 R >>`);
    kids.push(bodies.length);
  }
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = bodies.map((body, at) => { const offset = bytes(out); out += `${at + 1} 0 obj\n${body}\nendobj\n`; return offset; });
  const xref = bytes(out);
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${out}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

const SEAL = { x: 40, y: 70, w: 20, h: 15 };
const SIGNATURE = { x: 65, y: 87, w: 25, h: 8 };
const STAMP = { x: 55, y: 5, w: 35, h: 12 };
/** Where the scan's black block is on its page: columns 100 to 300 and rows 200 to 300 of 400 by 500. */
const BLOCK = { x: 25, y: 40, w: 50, h: 20 };
const PDF_BYTES = pdfOf([{ media: [612, 792], crop: [36, 36, 576, 756], marks: [SEAL, SIGNATURE] }, { media: [612, 792], crop: [0, 0, 612, 792], marks: [STAMP] },
  { media: [612, 792], crop: [0, 0, 612, 792], marks: [], scan: g4Scan() },
  // A page ten times as tall as it is wide: drawn smaller, so that it holds no more pixels than a page may.
  { media: [612, 6120], crop: [0, 0, 612, 6120], marks: [] }]);
const PDF = createHash('sha256').update(PDF_BYTES).digest('hex');
const at = (box: Box) => `xywh=percent:${box.x},${box.y},${box.w},${box.h}`;

/** A made-up certificate check, as example 3 delivers it: a row a mark (its key and its words), a box where it is there,
 *  none where it is not. */
const CHECK = {
  format: 'agentrun.cited/1', title: 'A made-up certificate, checked',
  rows: [
    { id: 'seal', label: 'seal', value: 'yes', note: 'noul 0.95', cites: [{ blob: PDF, look: K.page1, fragment: `page=1&${at(SEAL)}` }] },
    { id: 'signature', label: 'signature', value: 'yes', cites: [{ blob: PDF, look: K.page2, fragment: `page=1&${at(SIGNATURE)}` }] },
    { id: 'file_number', label: 'file number', value: 'no', cites: [{ blob: PDF, look: K.page3, fragment: 'page=1' }] },
    // A leading '#' is taken as well.
    { id: 'filed_stamp', label: 'filed stamp', value: 'yes', cites: [{ blob: PDF, fragment: `#page=2&${at(STAMP)}` }] },
    { id: 'scan', label: 'scanned block', value: 'yes', cites: [{ blob: PDF, fragment: `page=3&${at(BLOCK)}` }] },
    { id: 'eyes', label: 'page 1 as the eyes saw it', value: 'kept', cites: [{ blob: PAGES[0]!, fragment: 'page=1' }] },
    { id: 'tall', label: 'a tall page', value: 'yes', cites: [{ blob: PDF, fragment: 'page=4' }] },
    { id: 'summary', label: 'summary', value: '4 of 5 marks', cites: [] },
  ],
};
const CHECK_SHA = createHash('sha256').update(JSON.stringify(CHECK)).digest('hex');
const types: Record<string, string> = { [PDF]: 'application/pdf', [PAGES[0]!]: 'image/png' };

const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => {
  if (typeof node === 'string') return;
  visit(node);
  if ('children' in node) for (const child of node.children ?? []) walk(child, visit);
};
const find = (node: Node, test: (node: Exclude<Node, string>) => boolean) => { const out: Exclude<Node, string>[] = []; walk(node, (each) => { if (test(each)) out.push(each); }); return out; };
const words = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(words).join('') : '');
const cls = (name: string) => (node: Exclude<Node, string>) => 'class' in node && typeof node.class === 'string' && node.class.split(' ').includes(name);

/** The hand recording delivering the check: its result line names the check's JSON. */
const delivered: Line[] = lines.map((line) => (line.kind === 'result' ? { ...line, data: { ...(line.data as Record<string, Json>), blob: CHECK_SHA }, blobs: [CHECK_SHA] } : line));
const view = (p: number, context: Partial<ViewContext> = {}) => documentPanel.view(reduceTo(documentPanel, delivered, p), { t: 0, json: (sha) => (sha === CHECK_SHA ? CHECK as unknown as Json : undefined), blobType: (sha) => types[sha], ...context });

test('the cited pages, in the order first cited, each with its rows: a box where the fragment names a region, none where it does not, and no picture', () => {
  const pages = docPagesOf(visionCitedOf(CHECK as unknown as Json)!, (sha) => types[sha]);
  assert.deepEqual(pages.map((page) => [page.blob, page.page, page.rows.map((shown) => [shown.row.label, shown.boxes])]), [
    [PDF, 1, [['seal', [SEAL]], ['signature', [SIGNATURE]], ['file number', []]]],
    [PDF, 2, [['filed stamp', [STAMP]]]],
    [PDF, 3, [['scanned block', [BLOCK]]]],
    [PDF, 4, [['a tall page', []]]],
  ]);
  assert.deepEqual(docPagesOf(visionCitedOf(CHECK as unknown as Json)!).map((page) => [page.blob, page.page]), [[PDF, 1], [PDF, 2], [PDF, 3], [PAGES[0], 1], [PDF, 4]], 'a file of a type not known yet is taken for a page; the shell says when it is not');
});

test('each page a pdf-page node with its boxes over it, a caption that links the file at the page, and its rows listed, a box or not', () => {
  const node = view(delivered.length);
  const sheets = find(node, (each) => each.tag === 'pdf-page');
  assert.deepEqual(sheets.map((sheet) => 'page' in sheet && [sheet.blob, sheet.page, sheet.alt]), [[PDF, 1, 'page 1'], [PDF, 2, 'page 2'], [PDF, 3, 'page 3'], [PDF, 4, 'page 4']]);
  const boxes = sheets.map((sheet) => find(sheet, cls('doc-box')).map((box) => ['box' in box && box.box, words(box), 'cite' in box ? box.cite : undefined]));
  assert.deepEqual(boxes, [[[SEAL, '1 seal', K.page1], [SIGNATURE, '2 signature', K.page2]], [[STAMP, '1 filed stamp', undefined]], [[BLOCK, '1 scanned block', undefined]], []], 'each box carries its row\'s number on its page and its words');
  assert.deepEqual(find(node, cls('doc-mark')).map(words), [
    'seal yes · box at 40, 70, 20, 15 % · noul 0.95',
    'signature yes · box at 65, 87, 25, 8 %',
    'file number no · no box',
    'filed stamp yes · box at 55, 5, 35, 12 %',
    'scanned block yes · box at 25, 40, 50, 20 %',
    'a tall page yes · no box',
  ]);
  assert.deepEqual(find(node, (each) => each.tag === 'a').map((link) => 'fragment' in link && [link.blob, link.fragment]), [[PDF, 'page=1'], [PDF, 'page=2'], [PDF, 'page=3'], [PDF, 'page=4']]);
  assert.equal(words(find(node, cls('doc-title'))[0]!), CHECK.title);
});

test('a selected citation lights its box and its row; a click on either selects it', () => {
  const node = view(delivered.length, { cite: K.page2 });
  assert.deepEqual(find(node, cls('hot')).map((each) => [each.class, words(each)]), [['doc-box hot', '2 signature'], ['doc-mark hot', 'signature yes · box at 65, 87, 25, 8 %']]);
  assert.deepEqual(find(node, (each) => 'cite' in each && each.cite !== undefined).map((each) => 'cite' in each && each.cite), [K.page1, K.page2, K.page1, K.page2, K.page3]);
});

test('a row that cites two regions of a page is one numbered row there, and both its boxes carry its number', () => {
  const twice = { ...CHECK, rows: [CHECK.rows[0]!, { ...CHECK.rows[1]!, cites: [...CHECK.rows[1]!.cites, { blob: PDF, look: K.page2, fragment: `page=1&${at(STAMP)}` }] }] };
  const node = view(delivered.length, { json: () => twice as unknown as Json });
  const sheet = find(node, (each) => each.tag === 'pdf-page')[0]!;
  assert.deepEqual(find(sheet, cls('doc-box')).map((box) => ['box' in box && box.box, words(box)]), [[SEAL, '1 seal'], [SIGNATURE, '2 signature'], [STAMP, '2 signature']]);
  assert.deepEqual(find(node, cls('doc-mark')).map(words), ['seal yes · box at 40, 70, 20, 15 % · noul 0.95', 'signature yes · boxes at 65, 87, 25, 8 %; 55, 5, 35, 12 %']);
});

test('rows that cite the same region share one box, with both numbers and both rows\' words', () => {
  const agree = { id: 'numbers_match', label: 'the numbers agree', value: 'yes', cites: [{ blob: PDF, look: K.page3, fragment: `page=1&${at(SEAL)}` }] };
  const both = { ...CHECK, rows: [...CHECK.rows.slice(0, 3), agree] };
  const node = view(delivered.length, { json: () => both as unknown as Json, cite: K.page3 });
  const boxes = find(find(node, (each) => each.tag === 'pdf-page')[0]!, cls('doc-box'));
  assert.deepEqual(boxes.map((box) => ['box' in box && box.box, words(box), 'cite' in box && box.cite, box.class]), [[SEAL, '1, 4 seal · the numbers agree', K.page1, 'doc-box hot'], [SIGNATURE, '2 signature', K.page2, 'doc-box']]);
  assert.deepEqual(find(node, cls('doc-mark')).map((mark) => words(mark).split(' · ')[0]), ['seal yes', 'signature yes', 'file number no', 'the numbers agree yes']);
});

test('before the result, while it is read, and for a result that cites no page, the panel says so', () => {
  const before = delivered.findIndex((line) => line.kind === 'result');
  assert.match(words(view(before)), /has not delivered its result yet/);
  assert.match(words(view(delivered.length, { json: () => undefined })), /Reading the result/);
  assert.match(words(view(delivered.length, { json: () => CHAPTERS as unknown as Json })), /cites no page of a file/);
  assert.match(words(view(delivered.length, { json: () => ACCOUNT as unknown as Json })), /cites no page of a file/);
});

test('a recording draws the panel when its result cites a page, never for its lines alone, nor for a result that cites only pictures', () => {
  const drawn = (results: Json[]) => panelsFor(delivered, results, (sha) => types[sha]).some((panel) => panel.id === 'document');
  assert.equal(drawn([]), false, 'a result line alone is every run\'s');
  assert.equal(drawn([CHECK as unknown as Json]), true);
  assert.equal(drawn([CHAPTERS as unknown as Json, ACCOUNT as unknown as Json]), false, 'a film\'s chapters and an account cite no page');
  const pictures = { ...CHECK, rows: CHECK.rows.filter((row) => row.cites.every((each) => each.blob === PAGES[0])) };
  assert.equal(pictures.rows.length, 2);
  assert.equal(drawn([pictures as unknown as Json]), false, 'a result whose pages are pictures in the recording');
});

test('a scrub to any point equals a fresh reduce to it', () => {
  let state = documentPanel.init();
  for (let p = 0; p <= delivered.length; p += 1) {
    assert.deepEqual(state, reduceTo(documentPanel, delivered, p), `at ${p}`);
    if (p < delivered.length && documentPanel.accepts(delivered[p]!)) state = documentPanel.reduce(state, delivered[p]!);
  }
});

test('PDF.js and its JavaScript image decoders are their release files, unchanged, listed with their licenses, run no eval, and ship beside the page', () => {
  const vendor = new URL('../vendor/pdfjs/', import.meta.url);
  const listed = JSON.parse(readFileSync(new URL('vendored.json', vendor), 'utf8')) as { version: string; source: string; files: { path: string; from: string; license: string; bytes: number; sha256: string }[] };
  const walk = (dir: string): string[] => readdirSync(new URL(dir, vendor), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(`${dir}${entry.name}/`) : [`${dir}${entry.name}`]));
  assert.deepEqual(walk('').filter((name) => name !== 'vendored.json' && name !== 'README.md').sort(), listed.files.map((file) => file.path).sort(), 'every file here is listed, and every one listed is here');
  for (const file of listed.files) {
    const bytes = readFileSync(new URL(file.path, vendor));
    assert.deepEqual([bytes.length, createHash('sha256').update(bytes).digest('hex')], [file.bytes, file.sha256], `${file.path} is the released file`);
  }
  // The viewer README's list is this one: a release moved in one place and not the other fails here.
  const readme = [...readFileSync(new URL('../README.md', import.meta.url), 'utf8').matchAll(/^\| `([^`]+)` \| `([^`]+)` \| ([^|]+) \| ([\d,]+) \| `([0-9a-f]{64})` \|$/gm)];
  assert.deepEqual(readme.map((row) => ({ path: row[1], from: row[2], license: row[3], bytes: Number(row[4]!.replaceAll(',', '')), sha256: row[5] })), listed.files);
  assert.ok(readFileSync(new URL('../README.md', import.meta.url), 'utf8').includes(listed.source), 'the README names where the files came from');
  // Untrusted PDFs: the scripts build no code from strings.
  for (const file of listed.files.filter((each) => /\.m?js$/.test(each.path))) assert.doesNotMatch(readFileSync(new URL(file.path, vendor), 'utf8'), /\beval\(|new Function\(/, `${file.path} runs no eval`);
  const out = mkdtempSync(join(tmpdir(), 'viewer-pdfjs-build-'));
  try {
    mkdirSync(join(out, 'none'));
    build(join(out, 'dist'), join(out, 'none'));
    const shipped = (path: string) => path.replace(/^(pdf(?:\.worker)?\.min)\.mjs$/, '$1.js');
    for (const file of listed.files) assert.ok(readFileSync(join(out, 'dist', 'pdfjs', shipped(file.path))).equals(readFileSync(new URL(file.path, vendor))), `dist/pdfjs/${shipped(file.path)}`);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

// A browser a test left open would hold this file's process: each is ended here, and the file fails.
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

/** A strict static host's policy: scripts, workers and fetches from its own origin only, and no eval. */
const POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
/** Kept in the page before anything else runs: each request the policy refused. */
const LISTEN = "<script>window.refused=[];document.addEventListener('securitypolicyviolation',(e)=>refused.push(e.violatedDirective+' '+e.blockedURI));</script>";

/** In the page: for each drawn sheet, each box's place in percent of its page, and the picture's shade inside each box,
 *  just outside its left edge, and at the page's top left corner (0 black, 255 white). */
const MEASURE = `(() => [...document.querySelectorAll('.doc-sheet')].map((sheet) => {
  const img = sheet.querySelector('img.pdf-picture');
  const s = sheet.getBoundingClientRect();
  const canvas = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const shade = (px, py) => ctx.getImageData(Math.round(px / 100 * (img.naturalWidth - 1)), Math.round(py / 100 * (img.naturalHeight - 1)), 1, 1).data[0];
  return [...sheet.querySelectorAll('.doc-box')].map((box) => {
    const b = box.getBoundingClientRect();
    const place = [(b.left - s.left) / s.width * 100, (b.top - s.top) / s.height * 100, b.width / s.width * 100, b.height / s.height * 100].map((v) => Math.round(v * 10) / 10);
    return { place, inside: [shade(place[0] + 1, place[1] + 1), shade(place[0] + place[2] / 2, place[1] + place[3] / 2), shade(place[0] + place[2] - 1, place[1] + place[3] - 1)], outside: shade(place[0] - 1.5, place[1] + place[3] / 2), corner: shade(2, 2) };
  });
}))()`;

test('in Chrome under a strict static host\'s policy, each cited page is drawn with its boxes over its marks: embedded, opened by URL, and followed', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-document-'));
  const dir = join(out, 'recordings', 'certificate');
  writeRecording(dir);
  writeFileSync(join(dir, 'blobs', `${PDF}.pdf`), PDF_BYTES);
  assert.equal(deliverInstead(dir, CHECK as unknown as Json), CHECK_SHA);
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes(RESULT));
  // The same run delivering an account, which cites no page: it draws no document and loads no PDF.js.
  writeRecording(join(out, 'recordings', 'account'));
  mkdirSync(join(out, 'none'));
  build(join(out, 'dist'), join(out, 'none'));
  // A published site: the recordings embedded, the PDF a data: URL the page must read without fetching it.
  build(join(out, 'site'), join(out, 'recordings'));
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    asked.push(path);
    const file = path.startsWith('/viewer/') ? join(out, 'dist', path.slice(8)) : path.startsWith('/site/') ? join(out, 'site', path.slice(6)) : path.startsWith('/rec/') ? join(dir, path.slice(5)) : '';
    if (!file || !existsSync(file) || statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    const type = typeOfName(file) ?? (file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    const body = file.endsWith('index.html') ? Buffer.from(readFileSync(file, 'utf8').replace('<head>', `<head>${LISTEN}`)) : readFileSync(file);
    response.writeHead(200, { 'content-type': type, 'content-security-policy': POLICY, 'x-content-type-options': 'nosniff' }).end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => { server.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }));
  // One browser, each way opened in turn in its page: a new document each time, the policy's listener first in it.
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await drivenPage(`${origin}/site/index.html?r=account`, join(out, 'profile'), { signal: t.signal });
  pages.push(page);
  await page.once(`document.querySelector('.vz') !== null`, 'true', 30_000, 'the account drawn');
  await page.sleep(1000);
  assert.equal(await page.evaluate(`document.querySelector('.doc-panel') === null`), true, 'a result that cites no page draws no document panel');
  assert.deepEqual(asked.filter((path) => path.includes('/pdfjs/')), [], 'and PDF.js is not loaded');
  for (const opened of ['site/index.html?r=certificate', 'viewer/index.html?src=/rec/', 'viewer/index.html?follow=/rec/']) {
    // The viewer writes where it is into its address as it draws, so the new document is told by a mark the old one has.
    await page.evaluate(`window.before = true; location.assign(${JSON.stringify(`${origin}/${opened}`)})`);
    await page.once(`window.before === undefined && document.readyState === 'complete'`, 'true', 30_000, `${opened} opening`);
    const ready = `[...document.querySelectorAll('.doc-sheet img.pdf-picture')].filter((img) => img.complete && img.naturalWidth > 0).length === 4 || document.body.innerText.includes('could not be drawn')`;
    await page.once(ready, 'true', 30_000, `${opened}: the four cited pages drawn`);
    assert.doesNotMatch(String(await page.evaluate('document.body.innerText')), /could not be drawn|breaks the format/, opened);
    const sheets = await page.evaluate(MEASURE) as { place: number[]; inside: number[]; outside: number; corner: number }[][];
    assert.deepEqual(sheets.map((boxes) => boxes.map((box) => box.place)), [[SEAL, SIGNATURE].map((box) => [box.x, box.y, box.w, box.h]), [[STAMP.x, STAMP.y, STAMP.w, STAMP.h]], [[BLOCK.x, BLOCK.y, BLOCK.w, BLOCK.h]], []], `${opened}: each box at its cite's percent of its page`);
    const drawnSizes = await page.evaluate(`[...document.querySelectorAll('.doc-sheet img.pdf-picture')].map((img) => [img.naturalWidth, img.naturalHeight])`) as number[][];
    assert.deepEqual(drawnSizes.slice(0, 3).map(([w]) => w), [1600, 1600, 1600], `${opened}: a page is drawn 1600 pixels wide`);
    assert.ok(drawnSizes[3]![0]! < 1600 && drawnSizes[3]![0]! * drawnSizes[3]![1]! <= 4_000_000, `${opened}: the tall page is drawn smaller, within its pixels (${drawnSizes[3]})`);
    for (const box of sheets.flat()) {
      assert.ok(box.inside.every((shade) => shade < 60), `${opened}: the page is black inside the box at ${box.place} (${box.inside})`);
      assert.ok(box.outside > 200 && box.corner > 200, `${opened}: and white just outside it and at the corner (${box.outside}, ${box.corner})`);
    }
    assert.deepEqual(await page.evaluate('window.refused'), [], `${opened}: the policy refused nothing`);
  }
  // PDF.js asked its own origin for its worker and the CCITT decoder the scan needs, and for nothing else: no font, no
  // character map, no WebAssembly.
  assert.deepEqual([...new Set(asked.filter((path) => path.includes('/pdfjs/')).map((path) => path.replace(/^\/(site|viewer)\//, '')))].sort(),
    ['pdfjs/pdf.min.js', 'pdfjs/pdf.worker.min.js', 'pdfjs/wasm/jbig2_nowasm_fallback.js']);
});

test('from a file, where PDF.js cannot load, the page says so and links the file at the page; the rows stay', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-document-file-'));
  const dir = join(out, 'recordings', 'certificate');
  writeRecording(dir);
  writeFileSync(join(dir, 'blobs', `${PDF}.pdf`), PDF_BYTES);
  deliverInstead(dir, CHECK as unknown as Json);
  build(join(out, 'site'), join(out, 'recordings'));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => { rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }));
  const page = await drivenPage(`${pathToFileURL(join(out, 'site', 'index.html')).href}?r=certificate`, join(out, 'profile'), { signal: t.signal });
  pages.push(page);
  await page.once(`document.body.innerText.includes('could not be drawn')`, 'true', 30_000, 'the page saying it cannot draw');
  const text = String(await page.evaluate('document.body.innerText'));
  assert.match(text, /page 1 could not be drawn: PDF\.js cannot load in a page opened from a file/);
  assert.match(text, /seal yes · box at 40, 70, 20, 15 %/);
  assert.equal(await page.evaluate(`[...document.querySelectorAll('.doc-sheet a')].map((a) => a.href.split('#')[1]).join(' ')`), 'page=1 page=2 page=3 page=4');
});

const recorded = process.env.DOCUMENT_RECORDING;
test('a document recording (DOCUMENT_RECORDING): the format holds, every page and box its result cites is drawn, and in Chrome each box lands at its percent under the strict policy', { skip: recorded && existsSync(recorded) ? false : 'DOCUMENT_RECORDING names no recording' }, async (t) => {
  const run = parseLines(readFileSync(join(recorded!, 'events.jsonl'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(recorded!, 'manifest.json'), 'utf8'));
  const names = readdirSync(join(recorded!, 'blobs'));
  assert.deepEqual(validate(manifest, run, new Set(names.map((name) => name.split('.')[0]!))), []);
  const typeOf = (sha: string) => { const name = names.find((each) => each.startsWith(`${sha}.`)); return name ? typeOfName(name) : undefined; };
  const result = JSON.parse(readFileSync(join(recorded!, 'blobs', names.find((name) => name.startsWith(manifest.result.blob))!), 'utf8')) as Json;
  assert.equal(documentPanel.showsResult!(result, { blobType: typeOf }), true);
  const cited = docPagesOf(visionCitedOf(result)!, typeOf);
  assert.ok(cited.length > 0 && cited.every((page) => typeOf(page.blob) === 'application/pdf'), 'each cited page is a page of a PDF in the recording');
  const node = documentPanel.view(reduceTo(documentPanel, run, run.length), { t: 0, json: (sha) => (sha === manifest.result.blob ? result : undefined), blobType: typeOf });
  assert.deepEqual(find(node, (each) => each.tag === 'pdf-page').map((sheet) => 'page' in sheet && sheet.page), cited.map((page) => page.page));
  // Rows that cite one region share its box.
  const regions = (rows: typeof cited[number]['rows']) => [...new Map(rows.flatMap((shown) => shown.boxes.map((box) => [JSON.stringify(box), box] as const))).values()];
  assert.deepEqual(find(node, cls('doc-box')).map((box) => 'box' in box && box.box), cited.flatMap((page) => regions(page.rows)));
  if (!existsSync(chrome)) return;
  const out = mkdtempSync(join(tmpdir(), 'viewer-document-recorded-'));
  cpSync(recorded!, join(out, 'recordings', 'recorded'), { recursive: true });
  build(join(out, 'site'), join(out, 'recordings'));
  const server = createServer((request, response) => {
    const file = join(out, 'site', new URL(request.url!, 'http://localhost').pathname.slice(1));
    if (!existsSync(file) || statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    const body = file.endsWith('index.html') ? Buffer.from(readFileSync(file, 'utf8').replace('<head>', `<head>${LISTEN}`)) : readFileSync(file);
    response.writeHead(200, { 'content-type': typeOfName(file) ?? (file.endsWith('.html') ? 'text/html' : 'text/javascript'), 'content-security-policy': POLICY, 'x-content-type-options': 'nosniff' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pages: Awaited<ReturnType<typeof drivenPage>>[] = [];
  t.after(() => closeAll(pages, () => { server.close(); rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }));
  const page = await drivenPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/index.html?r=recorded`, join(out, 'profile'), { signal: t.signal });
  pages.push(page);
  await page.once(`[...document.querySelectorAll('.doc-sheet img.pdf-picture')].filter((img) => img.complete && img.naturalWidth > 0).length === ${cited.length} || document.body.innerText.includes('could not be drawn')`, 'true', 60_000, 'every cited page drawn');
  assert.doesNotMatch(String(await page.evaluate('document.body.innerText')), /could not be drawn|breaks the format/);
  const placed = await page.evaluate(MEASURE) as { place: number[] }[][];
  const near = (a: number[], b: Box) => [b.x, b.y, b.w, b.h].every((value, at) => Math.abs(value - a[at]!) <= 0.15);
  cited.forEach((each, at) => assert.ok(placed[at]!.length === regions(each.rows).length && regions(each.rows).every((box, n) => near(placed[at]![n]!.place, box)), `page ${each.page}: each box at its percent (${JSON.stringify(placed[at])})`));
  assert.deepEqual(await page.evaluate('window.refused'), [], 'the policy refused nothing');
});
