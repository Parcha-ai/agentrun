// A transcription the host files beside the looks (RECORDING.md draft 38): a `vision.transcribe` record of the look's
// shape, tool `transcribe`, kind `audio` or `video`, its body the transcript as rows `start<TAB>end<TAB>words` in seconds.
// The panel draws it as its rows, never as a picture or a window of film, marks the row a `#t=` cite of the file falls
// in (by the look's key, or by the file itself), says when a cited second is in no row, and counts it as a look.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { counterFold, countersOf } from '../src/counters.ts';
import type { Json, Line } from '../src/format.ts';
import type { Node, ViewContext } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';
import { visionMeters, visionPanel, visionTranscript } from '../src/vision.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const AUDIO = sha256('the landing call, as audio');
const VIDEO = sha256('the walk, as video');
const PHOTO = sha256('a photograph');
const RESULT = sha256('the result');
const K = { audio: sha256('transcribe audio'), video: sha256('transcribe video'), photo: sha256('look photo'), long: sha256('transcribe long') };
const SPEECH = '0.00\t4.20\tHouston, Tranquility Base here\n5.10\t9.80\tThe Eagle has landed\n12.00\t15.50\tRoger, Tranquility, we copy you on the ground\n16.40\t20.00\tYou got a bunch of guys about to turn blue';

type Filed = { key: string; path: string; sha: string; kind: string; body: string; tool?: string; cost?: number | null; status?: 'ok' | 'failed'; miss?: Json };
const record = (look: Filed): Json => (look.tool === 'look'
  ? { tool: 'look', args: { path: look.path, ask: 'What is in it?', model: 'faux/eyes', native: false }, status: 'ok', body: look.body, facts: { sha256: look.sha, kind: look.kind, fragment: '', key: look.key, cost_usd: 0.001 } }
  : { tool: 'transcribe', args: { path: look.path, model: 'faux/ears', native: false, via: 'faux' }, status: look.status ?? 'ok', body: look.body,
    facts: { sha256: look.sha, kind: look.kind, key: look.key, provider: 'faux', ...(look.cost === undefined ? { cost_usd: 0.006 } : { cost_usd: look.cost }) } }) as Json;
let t = 0;
let commit = 0;
const filed = (look: Filed): Line => ({ channel: 'durable', source: 'vision', kind: 'vision.looks', gen: 1, t: (t += 10), commit: (commit += 1), order: 0, conv: 1,
  data: { doc: 'vision.looks', key: look.key, value: { looks: [{ receipt: `evidence/read/${look.key.slice(0, 8)}.json`, record: record(look), ...(look.miss ? { miss: look.miss } : {}) }] } } });
const started: Line = { channel: 'live', source: 'host', kind: 'process.started', t: 0, seq: 1, data: { gen: 1 } };
const result: Line = { channel: 'live', source: 'host', kind: 'result', t: 1000, seq: 2, data: { gen: 1, blob: RESULT, title: 'What was said' } };
const lines: Line[] = [
  started,
  filed({ key: K.photo, path: 'photo.png', sha: PHOTO, kind: 'image', body: 'A footprint in grey dust.', tool: 'look' }),
  filed({ key: K.audio, path: 'landing.mp3', sha: AUDIO, kind: 'audio', body: SPEECH }),
  filed({ key: K.video, path: 'walk.mp4', sha: VIDEO, kind: 'video', body: '3.00\t6.50\tThat\'s one small step for man', cost: null }),
  result,
];
const CITED = { format: 'agentrun.cited/1', title: 'What was said', rows: [
  { label: 'the landing', value: 'The Eagle has landed', cites: [{ look: K.audio, fragment: '#t=13' }] },
  { label: 'a pause', value: 'between two calls', cites: [{ blob: AUDIO, fragment: '#t=10.5' }] },
] } as unknown as Json;

const walk = (node: Node, visit: (node: Exclude<Node, string>) => void) => {
  if (typeof node === 'string') return;
  visit(node);
  if ('children' in node) for (const child of node.children ?? []) walk(child, visit);
};
const find = (node: Node, test: (node: Exclude<Node, string>) => boolean) => { const out: Exclude<Node, string>[] = []; walk(node, (each) => { if (test(each)) out.push(each); }); return out; };
const words = (node: Node): string => (typeof node === 'string' ? node : 'text' in node ? node.text : 'children' in node ? (node.children ?? []).map(words).join(' ') : '');
const text = (node: Node) => words(node).replace(/\s+/g, ' ').trim();
const cls = (name: string) => (each: Exclude<Node, string>) => 'class' in each && new RegExp(`(^| )${name}( |$)`).test(each.class ?? '');
const view = (run: Line[], context: Partial<ViewContext> = {}) =>
  visionPanel.view(reduceTo(visionPanel, run, run.length), { t: 0, json: (sha) => (sha === RESULT ? CITED : undefined), ...context });
const lane = (node: Node, title: RegExp) => find(node, cls('vz-lane')).find((each) => title.test(text(find(each, (one) => one.tag === 'h5')[0]!)));

test('a transcript body reads as its rows; any other body is not one', () => {
  assert.deepEqual(visionTranscript('0.00\t4.20\tHouston, Tranquility Base here\n\n5.10\t9.80\tThe Eagle\thas landed\n'),
    [{ start: 0, end: 4.2, words: 'Houston, Tranquility Base here' }, { start: 5.1, end: 9.8, words: 'The Eagle\thas landed' }]);
  for (const body of ['', 'A footprint in grey dust.', '0.00\t4.20', 'one\ttwo\tthree', '5\t4\tends before it starts']) assert.equal(visionTranscript(body), undefined, JSON.stringify(body));
});

test('a transcription is drawn as its rows, with no picture, and the row a cited second falls in is marked', () => {
  const cited = view(lines, { cite: K.audio });
  const speech = lane(cited, /^Speech/)!;
  assert.ok(speech, 'a lane of its own');
  assert.match(text(find(speech, (each) => each.tag === 'h5')[0]!), /^Speech · landing\.mp3 · 2 files transcribed$/);
  const rows = find(speech, cls('vz-line'));
  assert.deepEqual(rows.map(text), ['0:00–0:04 Houston, Tranquility Base here', '0:05–0:09 The Eagle has landed', '0:12–0:15 Roger, Tranquility, we copy you on the ground', '0:16–0:20 You got a bunch of guys about to turn blue']);
  assert.deepEqual(rows.map((row) => cls('cited')(row)), [false, false, true, false], '#t=13 is in the third row');
  assert.equal(rows[2]!.tag === 'div' && 'title' in rows[2]! ? rows[2]!.title : undefined, '12.00 to 15.50 s');
  assert.equal(find(speech, (each) => each.tag === 'img').length + find(speech, cls('vz-nopic')).length, 0, 'no picture, and no cell saying there is none');
  // The file itself is cited at a second between two rows: the transcript says nothing was said there.
  assert.match(text(speech), /#t=10\.5 is in no row of this transcript/);
  assert.doesNotMatch(text(speech), /#t=13 is in no row/);
  assert.match(text(find(cited, cls('vz-receipt'))[0]!), /^Receipt · landing\.mp3 .*answer 4 rows, 0 to 20 s .*heard by faux .*model faux\/ears/);
});

test('with no citation the lane shows the latest transcription; a film transcription is no window of film', () => {
  const latest = view(lines);
  const speech = lane(latest, /^Speech/)!;
  assert.deepEqual(find(speech, cls('vz-line')).map(text), ['0:03–0:06 That\'s one small step for man']);
  assert.match(text(lane(latest, /^Film/)!), /No window of film read yet/, 'a video transcribed is not read in windows');
  assert.match(text(lane(latest, /^Photographs/)!), /1 looked at/);
  // A recording with no transcription draws no speech lane at all.
  assert.equal(lane(view(lines.filter((line) => !/transcribe|landing|walk/.test(JSON.stringify(line.data)))), /^Speech/), undefined);
});

test('a transcription is counted as a look, by its key: paid, priced at its own price, and unknown when its price is', () => {
  const state = reduceTo(visionPanel, lines, lines.length);
  const meters = visionMeters(state);
  assert.equal(meters.paid, 3, 'two transcriptions and one look');
  assert.equal(meters.cost, null, 'the video\'s price is unknown, so the spend is');
  assert.deepEqual(meters.eyes, ['faux/eyes'], 'the speech-to-text model is not one of the eyes');
  const priced = lines.filter((line) => !JSON.stringify(line.data).includes('walk.mp4'));
  const strip = countersOf(reduceTo(counterFold, priced, priced.length), true);
  assert.equal(visionMeters(reduceTo(visionPanel, priced, priced.length)).cost, 0.007);
  assert.equal(strip.cost, 0.007, 'the counters strip folds the same payments');
  const badges = find(view(lines), cls('vz-badge')).map(text);
  assert.ok(badges.includes('eyes: faux/eyes') && badges.includes('speech to text: faux/ears'), badges.join(' | '));
});

test('a long transcript shows a window of its rows around the cited second; a missed transcription shows its code', () => {
  const body = Array.from({ length: 30 }, (_, n) => `${n * 10}.00\t${n * 10 + 8}.00\trow ${n + 1}`).join('\n');
  const long = [started, filed({ key: K.long, path: 'long.mp3', sha: sha256('long'), kind: 'audio', body }), result];
  const at = (fragment: string) => visionPanel.view(reduceTo(visionPanel, long, long.length), { t: 0, cite: K.long,
    json: (sha) => (sha === RESULT ? { format: 'agentrun.cited/1', rows: [{ label: 'x', value: 'y', cites: [{ look: K.long, fragment }] }] } as unknown as Json : undefined) });
  const shown = (node: Node) => find(lane(node, /^Speech/)!, cls('vz-line'));
  const around = at('#t=203');
  assert.deepEqual(shown(around).map((row) => text(row).split(' ').slice(1).join(' ')), Array.from({ length: 12 }, (_, n) => `row ${n + 18}`), 'three rows before the cited one, twelve in all');
  assert.ok(cls('cited')(shown(around)[3]!));
  assert.match(text(lane(around, /^Speech/)!), /rows 18 to 29 of 30/);
  assert.deepEqual(shown(at('#t=295')).map((row) => text(row).split(' ').slice(1).join(' ')), Array.from({ length: 12 }, (_, n) => `row ${n + 19}`), 'near the end, the last twelve rows');
  assert.match(text(lane(at('#t=5'), /^Speech/)!), /rows 1 to 12 of 30/);
  const missed = [started, filed({ key: K.long, path: 'long.mp3', sha: sha256('long'), kind: 'audio', body: '', status: 'failed', miss: { code: 'over_budget', reason: 'too long for one request' } as unknown as Json }), result];
  const failed = lane(view(missed), /^Speech/)!;
  assert.equal(find(failed, cls('vz-line')).length, 0);
  assert.match(text(failed), /missed: over_budget, too long for one request/);
});
