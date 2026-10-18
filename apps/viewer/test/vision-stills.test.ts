// Looks made on stills cut from a film: the code cuts a frame at a second and has the eyes (or Jev) look at it, naming
// it `film.mp4#t=S` (the record's `args.path`; its kind is `image`, its own fragment empty). Such a look is the film's
// at that second, never a photograph: it is drawn in the film lane at its second, and a cite of it with a box
// (`#t=S&xywh=percent:x,y,w,h`) draws the box over that frame.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { typeOfName } from '../src/blobs.ts';
import { parseLines, validate, type Json, type Line } from '../src/format.ts';
import type { Node, ViewContext } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { visionPanel } from '../src/vision.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const STILL = sha256('the frame at 1024 s');
const FRAME = sha256('the frame at 1024 s, as the result shows it');
const RESULT = sha256('the result');
const K = { judged: sha256('jev on the still at 1024'), seen: sha256('the eyes on two stills'), photo: sha256('a photograph') };
let t = 0;
let commit = 0;
const filed = (key: string, record: Json): Line => ({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen: 1, t: (t += 10), commit: (commit += 1), order: 0, conv: 1,
  data: { doc: 'vision.looks', key, value: { looks: [{ receipt: `evidence/read/${key.slice(0, 8)}.json`, record }] } } });
const lines: Line[] = [
  { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } },
  filed(K.photo, { tool: 'look', args: { path: 'crew.png', ask: 'Who is in it?', model: 'faux/eyes', native: false }, status: 'ok', body: 'Three people.', facts: { sha256: sha256('crew'), kind: 'image', fragment: '', key: K.photo, cost_usd: 0.001 } } as unknown as Json),
  filed(K.seen, { tool: 'look', args: { path: 'film.mp4#t=10, film.mp4#t=20', ask: 'Is the flag up?', model: 'faux/eyes', native: false }, status: 'ok', body: 'Not yet.', facts: { sha256: sha256('two stills'), kind: 'image', fragment: '', key: K.seen, cost_usd: 0.002 } } as unknown as Json),
  filed(K.judged, { tool: 'look', args: { path: 'film.mp4#t=1024', ask: '{"here":"Is the flag standing planted?"}', model: 'jev', native: false, via: 'jev' }, status: 'ok', body: '{"here":{"answer":true,"p":0.88}}', facts: { sha256: STILL, kind: 'image', fragment: '', key: K.judged, cost_usd: 0.0001 } } as unknown as Json),
  { channel: 'live', source: 'host', kind: 'result', t: 1000, seq: 2, data: { gen: 1, blob: RESULT, title: 'Seen' } },
];
const CITED = { format: 'agentrun.cited/1', rows: [{ label: 'the flag, first seen planted', value: '1024 s', cites: [
  { look: K.judged, fragment: '#t=1024&xywh=percent:31,6,49,52' }, { blob: FRAME, fragment: '#t=1024&xywh=percent:31,6,49,52', note: 'the frame, with the box' },
] }] } as unknown as Json;

const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => { if (typeof node === 'string') return; visit(node); if ('children' in node) for (const child of node.children ?? []) walk(child, visit); };
const find = (node: Node, test: (node: Exclude<Node, string>) => boolean) => { const out: Exclude<Node, string>[] = []; walk(node, (each) => { if (test(each)) out.push(each); }); return out; };
const words = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(words).join(' ') : '');
const text = (node: Node) => words(node).replace(/\s+/g, ' ').trim();
const cls = (name: string) => (each: Exclude<Node, string>) => 'class' in each && new RegExp(`(^| )${name}( |$)`).test(each.class ?? '');
const view = (context: Partial<ViewContext> = {}) => visionPanel.view(reduceTo(visionPanel, lines, lines.length),
  { t: 0, json: (sha) => (sha === RESULT ? CITED : undefined), blobType: (sha) => (sha === FRAME ? 'image/png' : undefined), ...context });
const lane = (node: Node, title: RegExp) => find(node, cls('vz-lane')).find((each) => title.test(text(find(each, (one) => one.tag === 'h5')[0]!)));

test('a look on a still cut from the film is the film\'s, at its second: never a photograph', () => {
  const drawn = view();
  const photos = lane(drawn, /^Photographs/)!;
  assert.match(text(find(photos, (each) => each.tag === 'h5')[0]!), /^Photographs · 1 looked at/, 'only the photograph itself');
  assert.equal(find(photos, cls('vz-tile')).length, 1);
  const film = lane(drawn, /^Film/)!;
  assert.match(text(find(film, (each) => each.tag === 'h5')[0]!), /^Film · film\.mp4 · 3 stills looked at$/);
  const cells = find(film, cls('vz-cell'));
  const read = cells.map((cell, at) => (cls('read')(cell) ? at : -1)).filter((at) => at >= 0);
  assert.ok(read.includes(cells.length - 1), 'the still at 1024 s marks the end of the film read so far');
  assert.ok(read.includes(0), 'the stills at 10 and 20 s mark its start');
  assert.ok(read.length <= 3, `each still marks its own second, not the span between them: ${read.join(', ')}`);
});

test('a cite of the still with a box draws the box over that frame', () => {
  const chosen = view({ cite: K.judged });
  const film = lane(chosen, /^Film/)!;
  const frame = find(film, cls('vz-still'))[0]!;
  assert.ok(frame, 'the frame is drawn');
  assert.deepEqual(find(frame, (each) => each.tag === 'img').map((each) => ('blob' in each ? each.blob : undefined)), [FRAME], 'the frame the row cites at that second');
  const boxes = find(frame, cls('vz-box'));
  assert.deepEqual(boxes.map((box) => ('box' in box ? box.box : undefined)), [{ x: 31, y: 6, w: 49, h: 52 }]);
  assert.doesNotMatch(text(film), /keyframe/, 'the frame at the still\'s own second is no chapter\'s keyframe');
  assert.match(text(find(chosen, cls('vz-receipt'))[0]!), /^Receipt · film\.mp4 #t=1024/);
});

test('the hear-and-find recording: Jev\'s looks on stills cut from the film are the film\'s, and the cited frame carries its box', () => {
  // test/fixtures/hear-and-find: pi-vision's hear-and-find example on its scripted path (a public-domain NASA clip), whose
  // Jev looks name their stills `eagle-heard-and-seen.webm#t=S`; its result cites the frame at 28 s with the box Jev drew.
  const dir = new URL('./fixtures/hear-and-find/', import.meta.url);
  const recorded = parseLines(readFileSync(new URL('events.jsonl', dir), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as Json;
  const names = new Map(readdirSync(new URL('blobs/', dir)).map((name) => [name.split('.')[0]!, name]));
  assert.deepEqual(validate(manifest, recorded, new Set(names.keys())), [], 'it obeys the format');
  const json = (sha: string) => (names.get(sha)?.endsWith('.json') ? JSON.parse(readFileSync(new URL(`blobs/${names.get(sha)}`, dir), 'utf8')) as Json : undefined);
  const blobType = (sha: string) => (names.has(sha) ? typeOfName(names.get(sha)!) : undefined);
  const state = reduceTo(visionPanel, recorded, recorded.length);
  const drawn = visionPanel.view(state, { t: 0, json, blobType });
  assert.match(text(lane(drawn, /^Photographs/)!), /No photograph looked at yet/, 'no still is a grey photograph tile');
  assert.match(text(find(lane(drawn, /^Film/)!, (each) => each.tag === 'h5')[0]!), /^Film · eagle-heard-and-seen\.webm · 1 window read · 7 stills looked at$/);
  const result = json(String((manifest as { result: { blob: string } }).result.blob)) as { rows: { cites: { look?: string; blob?: string; fragment: string }[] }[] };
  const cite = result.rows.flatMap((row) => row.cites).find((each) => each.look && /xywh=/.test(each.fragment))!;
  const frame = find(lane(visionPanel.view(state, { t: 0, json, blobType, cite: cite.look }), /^Film/)!, cls('vz-still'))[0]!;
  assert.deepEqual(find(frame, (each) => each.tag === 'img').map((each) => ('blob' in each ? each.blob : undefined)), [result.rows.flatMap((row) => row.cites).find((each) => each.blob)!.blob]);
  assert.deepEqual(find(frame, cls('vz-box')).map((box) => ('box' in box ? box.box : undefined)), [{ x: 30.3, y: 5.6, w: 50.3, h: 54.4 }]);
});

test('a transcription of a piece cut from a film reads its rows at the film\'s seconds', () => {
  // The transcribe skill cuts a long film into pieces and names each by its place in the film (`film.mp4#t=600,660` in
  // the record's path); the words' seconds count from the start of the piece. Shown and cited, a row is at the film's
  // second: the piece's start plus its own.
  const KEY = sha256('a piece from 600 s');
  const piece: Line[] = [lines[0]!, filed(KEY, { tool: 'transcribe', args: { path: 'film.mp4#t=600,660', model: 'faux/ears', native: false, via: 'faux' }, status: 'ok',
    body: '0.00\t4.00\tHouston, Tranquility Base here\n5.00\t9.50\tThe Eagle has landed', facts: { sha256: sha256('piece'), kind: 'audio', key: KEY, cost_usd: 0.001 } } as unknown as Json), lines.at(-1)!];
  const at = (fragment: string) => visionPanel.view(reduceTo(visionPanel, piece, piece.length), { t: 0, cite: KEY,
    json: (sha) => (sha === RESULT ? { format: 'agentrun.cited/1', rows: [{ label: 'landed', value: 'x', cites: [{ look: KEY, fragment }] }] } as unknown as Json : undefined) });
  const speech = lane(at('#t=606'), /^Speech/)!;
  assert.deepEqual(find(speech, cls('vz-line')).map(text), ['10:00–10:04 Houston, Tranquility Base here', '10:05–10:09 The Eagle has landed']);
  assert.deepEqual(find(speech, cls('vz-line')).map((row) => cls('cited')(row)), [false, true], 'the film\'s second 606 is the piece\'s 6');
  assert.match(text(lane(at('#t=6'), /^Speech/)!), /#t=6 is in no row of this transcript/, 'a second of the piece alone is not the film\'s');
  assert.match(text(find(at('#t=606'), cls('vz-receipt'))[0]!), /answer 2 rows, 600 to 609\.5 s/);
});
