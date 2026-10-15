// The vision panel reading the generic cited result (`agentrun.cited/1`) any run may deliver, on the hand recording of
// vision-hand.ts made to deliver it: a row a line, a look's chip opens its receipt and moves its lane, a file's chip
// opens the file, and a row that cites nothing was not read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error: the build script is plain JavaScript
import { build } from '../build.mjs';
import type { Json } from '../src/format.ts';
import type { Node, ViewContext } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { visionAccountOf, visionCitedOf, visionPanel } from '../src/vision.ts';
import { CITED, deliverInstead, FILM, K, lines, PAGES, PHOTOS, RESULT, writeRecording } from './vision-hand.ts';

const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => {
  if (typeof node === 'string') return;
  visit(node);
  if ('children' in node) for (const child of node.children ?? []) walk(child, visit);
};
const find = (node: Node, test: (node: Exclude<Node, string>) => boolean) => { const out: Exclude<Node, string>[] = []; walk(node, (each) => { if (test(each)) out.push(each); }); return out; };
const words = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(words).join(' ') : '');
const text = (node: Node) => words(node).replace(/\s+/g, ' ');
const cls = (name: string) => (each: Exclude<Node, string>) => 'class' in each && new RegExp(`(^| )${name}( |$)`).test(each.class ?? '');
const json = (sha: string): Json | undefined => (sha === RESULT ? CITED as unknown as Json : undefined);
const view = (context: Partial<ViewContext> = {}) => visionPanel.view(reduceTo(visionPanel, lines, lines.length), { t: 0, json, ...context });

test('the generic cited result reads as rows of a label, a value, a note and cites; a cite names a blob or a look', () => {
  const cited = visionCitedOf(CITED as unknown as Json)!;
  assert.equal(cited.title, 'Three pages and three photographs, read');
  assert.deepEqual(cited.rows.map((row) => [row.label, row.value, row.cites.length]), [['The alarm', 'number 9', 1], ['The first photograph', 'ground', 2], ['A share read from a picture', '41', 1], ['A page that was not the dashboard', 'failed', 0]]);
  const loose = visionCitedOf({ format: 'agentrun.cited/1', rows: [{ label: 'kept', value: 1, cites: [{ fragment: '#page=1' }, { look: 'k' }] }, { value: 'no label', cites: [] }] })!;
  assert.deepEqual(loose.rows, [{ label: 'kept', value: '1', cites: [{ look: 'k', fragment: '' }] }], 'a cite with neither a blob nor a look is left out, and a row with no label');
  assert.equal(visionCitedOf({ format: 'report/1', rows: [] }), undefined);
  assert.equal(visionCitedOf(CITED as unknown as Json) !== undefined && typeof visionAccountOf(CITED as unknown as Json), 'string', 'it is not an account');
});

test('the panel draws a row a line: a look\'s chip selects its look, a file\'s chip links the file, and a row with no cite is not read', () => {
  const shown = view();
  const rows = find(shown, cls('vz-entry'));
  assert.equal(rows.length, 4);
  assert.match(text(rows[0]!), /The alarm number 9 · read off page 2 p\.2 · box/);
  assert.match(text(rows[3]!), /A page that was not the dashboard failed not read/);
  assert.ok(find(shown, (each) => each.tag === 'h5').some((each) => text(each) === 'Three pages and three photographs, read'), 'the title heads the rows');
  const lookChips = find(shown, cls('vz-cite')).filter((each) => 'cite' in each);
  assert.deepEqual(lookChips.map((chip) => ('cite' in chip ? chip.cite : undefined)), [K.page2, K.photo1]);
  const fileChips = find(shown, (each) => each.tag === 'a' && 'blob' in each);
  assert.deepEqual(fileChips.map((chip) => ('text' in chip && 'blob' in chip ? [chip.blob, chip.text] : [])), [[PHOTOS[0], 'file'], [FILM[0], 'file']], 'a file beside a look reads "file", and so does a file alone with no fragment');
});

test('a look chip opens the receipt, moves the pages lane to the page and draws the row\'s box over it', () => {
  const shown = view({ cite: K.page2 });
  assert.match(text(find(shown, cls('vz-receipt'))[0]!), /Receipt · scan-pages #page=2/);
  assert.equal(find(shown, (each) => each.tag === 'img' && 'blob' in each && each.blob === PAGES[1]).length, 1);
  assert.deepEqual(find(shown, cls('vz-box')).map((each) => ('box' in each ? each.box : undefined)), [{ x: 6, y: 8, w: 80, h: 6 }]);
  assert.equal(find(shown, cls('hot')).length, 1, 'its chip is lit');
  assert.equal(find(shown, cls('cited')).filter(cls('vz-entry')).length, 1, 'and its row marked');
});

const chrome = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
test('the page from file:// reads a cited result from the result blob', { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}` }, (t) => {
  const out = mkdtempSync(join(tmpdir(), 'viewer-cited-'));
  t.after(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  writeRecording(join(out, 'recordings', 'vision-cited'));
  deliverInstead(join(out, 'recordings', 'vision-cited'), CITED as unknown as Json);
  build(join(out, 'dist'), join(out, 'recordings'));
  const ran = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(out, 'profile')}`,
    '--virtual-time-budget=4000', '--dump-dom', `${pathToFileURL(join(out, 'dist', 'index.html')).href}?r=vision-cited`], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(ran.status, 0, ran.stderr);
  const page = ran.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const shown of ['Three pages and three photographs, read', 'The alarm number 9', 'A page that was not the dashboard failed not read']) assert.ok(page.includes(shown), `the page shows ${shown}`);
  assert.doesNotMatch(page, /breaks the format/);
  assert.ok((ran.stdout.match(/<span[^>]*class="vz-cite[^"]*"[^>]*>/g) ?? []).every((chip) => /role="button"/.test(chip)), 'a look chip is a button');
  assert.match(ran.stdout, /<a [^>]*class="vz-cite"[^>]*>file<\/a>/, 'a file chip is a link to the blob');
});
