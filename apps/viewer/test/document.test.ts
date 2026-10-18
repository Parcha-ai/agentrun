// The document panel: the pages of a PDF a cited result names, drawn with PDF.js, each box a row cites placed over its
// page in percent of the crop box. On the hand recording of vision-hand.ts delivering a made-up certificate check whose
// PDF this file writes by hand (a crop box inside the media box on page 1, so a box placed on the media box would land
// off its mark, and page 3 a scan whose image is CCITT coded, as a scanner writes one), the view is checked as nodes,
// and the page in a real Chrome under a static host's policy (scripts, workers and fetches only from its own origin):
// embedded, opened by URL and followed, each mark's box over the black the PDF draws there, and nothing the policy
// refused.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import type { Json, Line } from '../src/format.ts';
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
  { media: [612, 792], crop: [0, 0, 612, 792], marks: [], scan: g4Scan() }]);
const PDF = createHash('sha256').update(PDF_BYTES).digest('hex');
const at = (box: Box) => `xywh=percent:${box.x},${box.y},${box.w},${box.h}`;

/** A made-up certificate check, as example 3 delivers it: a row a mark, a box where it is present, none where it is not. */
const CHECK = {
  format: 'agentrun.cited/1', title: 'A made-up certificate, checked',
  rows: [
    { label: 'seal', value: 'present', note: 'noul 0.95', cites: [{ blob: PDF, look: K.page1, fragment: `page=1&${at(SEAL)}` }] },
    { label: 'signature', value: 'present', cites: [{ blob: PDF, look: K.page2, fragment: `page=1&${at(SIGNATURE)}` }] },
    { label: 'file number', value: 'absent', cites: [{ blob: PDF, look: K.page3, fragment: 'page=1' }] },
    { label: 'filed stamp', value: 'present', cites: [{ blob: PDF, fragment: `#page=2&${at(STAMP)}` }] },
    { label: 'scanned block', value: 'present', cites: [{ blob: PDF, fragment: `page=3&${at(BLOCK)}` }] },
    { label: 'page 1 as the eyes saw it', value: 'kept', cites: [{ blob: PAGES[0]!, fragment: 'page=1' }] },
    { label: 'summary', value: '3 of 4 marks', cites: [] },
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
  assert.deepEqual(pages.map((page) => [page.blob, page.page, page.marks.map((mark) => [mark.row.label, mark.box ?? null])]), [
    [PDF, 1, [['seal', SEAL], ['signature', SIGNATURE], ['file number', null]]],
    [PDF, 2, [['filed stamp', STAMP]]],
    [PDF, 3, [['scanned block', BLOCK]]],
  ]);
  assert.deepEqual(docPagesOf(visionCitedOf(CHECK as unknown as Json)!).map((page) => [page.blob, page.page]), [[PDF, 1], [PDF, 2], [PDF, 3], [PAGES[0], 1]], 'a file of a type not known yet is taken for a page; the shell says when it is not');
});

test('each page a pdf-page node with its boxes over it, a caption that links the file at the page, and its rows listed, a box or not', () => {
  const node = view(delivered.length);
  const sheets = find(node, (each) => each.tag === 'pdf-page');
  assert.deepEqual(sheets.map((sheet) => 'page' in sheet && [sheet.blob, sheet.page, sheet.alt]), [[PDF, 1, 'page 1'], [PDF, 2, 'page 2'], [PDF, 3, 'page 3']]);
  const boxes = sheets.map((sheet) => find(sheet, cls('doc-box')).map((box) => ['box' in box && box.box, words(box), 'cite' in box ? box.cite : undefined]));
  assert.deepEqual(boxes, [[[SEAL, 'seal', K.page1], [SIGNATURE, 'signature', K.page2]], [[STAMP, 'filed stamp', undefined]], [[BLOCK, 'scanned block', undefined]]]);
  assert.deepEqual(find(node, cls('doc-mark')).map(words), [
    'seal present · box at 40, 70, 20, 15 % · noul 0.95',
    'signature present · box at 65, 87, 25, 8 %',
    'file number absent · no box',
    'filed stamp present · box at 55, 5, 35, 12 %',
    'scanned block present · box at 25, 40, 50, 20 %',
  ]);
  assert.deepEqual(find(node, (each) => each.tag === 'a').map((link) => 'fragment' in link && [link.blob, link.fragment]), [[PDF, 'page=1'], [PDF, 'page=2'], [PDF, 'page=3']]);
  assert.equal(words(find(node, cls('doc-title'))[0]!), CHECK.title);
});

test('a selected citation lights its box and its row; a click on either selects it', () => {
  const node = view(delivered.length, { cite: K.page2 });
  assert.deepEqual(find(node, cls('hot')).map((each) => [each.class, words(each).split(' ')[0]]), [['doc-box hot', 'signature'], ['doc-mark hot', 'signature']]);
  assert.deepEqual(find(node, (each) => 'cite' in each && each.cite !== undefined).map((each) => 'cite' in each && each.cite), [K.page1, K.page2, K.page1, K.page2, K.page3]);
});

test('before the result, while it is read, and for a result that cites no page, the panel says so', () => {
  const before = delivered.findIndex((line) => line.kind === 'result');
  assert.match(words(view(before)), /has not delivered its result yet/);
  assert.match(words(view(delivered.length, { json: () => undefined })), /Reading the result/);
  assert.match(words(view(delivered.length, { json: () => CHAPTERS as unknown as Json })), /cites no page of a file/);
  assert.match(words(view(delivered.length, { json: () => ACCOUNT as unknown as Json })), /cites no page of a file/);
});

test('a recording draws the panel when its result cites a page, never for its lines alone', () => {
  const drawn = (results: Json[]) => panelsFor(delivered, results).some((panel) => panel.id === 'document');
  assert.equal(drawn([]), false, 'a result line alone is every run\'s');
  assert.equal(drawn([CHECK as unknown as Json]), true);
  assert.equal(drawn([CHAPTERS as unknown as Json, ACCOUNT as unknown as Json]), false, 'a film\'s chapters and an account cite no page');
});

test('a scrub to any point equals a fresh reduce to it', () => {
  let state = documentPanel.init();
  for (let p = 0; p <= delivered.length; p += 1) {
    assert.deepEqual(state, reduceTo(documentPanel, delivered, p), `at ${p}`);
    if (p < delivered.length && documentPanel.accepts(delivered[p]!)) state = documentPanel.reduce(state, delivered[p]!);
  }
});

test('PDF.js and its JavaScript image decoders are their release files, unchanged, and the build ships them beside the page as scripts with their licenses', () => {
  const vendor = new URL('../vendor/pdfjs/', import.meta.url);
  const table = [...readFileSync(new URL('README.md', vendor), 'utf8').matchAll(/^\| `([^`]+)` \| `[^`]+` \| `([0-9a-f]{64})` \|$/gm)].map((row) => [row[1], row[2]]);
  assert.deepEqual(table.map(([name]) => name), ['pdf.min.mjs', 'pdf.worker.min.mjs', 'LICENSE.txt', 'wasm/jbig2_nowasm_fallback.js', 'wasm/openjpeg_nowasm_fallback.js',
    'wasm/LICENSE_JBIG2.txt', 'wasm/LICENSE_PDFJS_JBIG2.txt', 'wasm/LICENSE_OPENJPEG.txt', 'wasm/LICENSE_PDFJS_OPENJPEG.txt']);
  for (const [name, sha] of table) assert.equal(createHash('sha256').update(readFileSync(new URL(name!, vendor))).digest('hex'), sha, `${name} is the released file`);
  const out = mkdtempSync(join(tmpdir(), 'viewer-pdfjs-build-'));
  try {
    mkdirSync(join(out, 'none'));
    build(join(out, 'dist'), join(out, 'none'));
    for (const [from, to] of [['pdf.min.mjs', 'pdf.min.js'], ['pdf.worker.min.mjs', 'pdf.worker.min.js'], ...table.slice(2).map(([name]) => [name!, name!])]) assert.ok(readFileSync(join(out, 'dist', 'pdfjs', to!)).equals(readFileSync(new URL(from!, vendor))), `dist/pdfjs/${to}`);
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
  mkdirSync(join(out, 'none'));
  build(join(out, 'dist'), join(out, 'none'));
  // A published site: the recording embedded, the PDF a data: URL the page must read without fetching it.
  build(join(out, 'site'), join(out, 'recordings'));
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
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
  const page = await drivenPage(`${origin}/site/index.html?r=certificate`, join(out, 'profile'), { signal: t.signal });
  pages.push(page);
  for (const [at, opened] of ['site/index.html?r=certificate', 'viewer/index.html?src=/rec/', 'viewer/index.html?follow=/rec/'].entries()) {
    if (at > 0) {
      // The viewer writes where it is into its address as it draws, so the new document is told by a mark the old one has.
      await page.evaluate(`window.before = true; location.assign(${JSON.stringify(`${origin}/${opened}`)})`);
      await page.once(`window.before === undefined && document.readyState === 'complete'`, 'true', 30_000, `${opened} opening`);
    }
    const ready = `[...document.querySelectorAll('.doc-sheet img.pdf-picture')].filter((img) => img.complete && img.naturalWidth > 0).length === 3 || document.body.innerText.includes('could not be drawn')`;
    await page.once(ready, 'true', 30_000, `${opened}: the three cited pages drawn`);
    assert.doesNotMatch(String(await page.evaluate('document.body.innerText')), /could not be drawn|breaks the format/, opened);
    const sheets = await page.evaluate(MEASURE) as { place: number[]; inside: number[]; outside: number; corner: number }[][];
    assert.deepEqual(sheets.map((boxes) => boxes.map((box) => box.place)), [[SEAL, SIGNATURE].map((box) => [box.x, box.y, box.w, box.h]), [[STAMP.x, STAMP.y, STAMP.w, STAMP.h]], [[BLOCK.x, BLOCK.y, BLOCK.w, BLOCK.h]]], `${opened}: each box at its cite's percent of its page`);
    for (const box of sheets.flat()) {
      assert.ok(box.inside.every((shade) => shade < 60), `${opened}: the page is black inside the box at ${box.place} (${box.inside})`);
      assert.ok(box.outside > 200 && box.corner > 200, `${opened}: and white just outside it and at the corner (${box.outside}, ${box.corner})`);
    }
    assert.deepEqual(await page.evaluate('window.refused'), [], `${opened}: the policy refused nothing`);
  }
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
  assert.match(text, /seal present · box at 40, 70, 20, 15 %/);
  assert.equal(await page.evaluate(`[...document.querySelectorAll('.doc-sheet a')].map((a) => a.href.split('#')[1]).join(' ')`), 'page=1 page=2 page=3');
});
