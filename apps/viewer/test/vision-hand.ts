// A recording built line by line in the shapes a vision run writes: a text-only lead reads a film in windows, scanned
// pages and photographs through eyes; each LookRecord is filed into its look key's `vision.looks` document; a kill lands while a
// page read is in flight, after its eyes answered; the next process files that look as kept, and delivers an account
// (`apollo11.account/1`) with its photo sort and a weaker eyes model's reading. Every picture is a PNG this file draws,
// and every name and number in it is made up.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { counterFold, countersOf } from '../src/counters.ts';
import type { Json, Line } from '../src/format.ts';
import { reduceTo } from '../src/replay.ts';

/** A PNG of `w` by `h` whose pixel at (x, y) is `paint(x, y)`, as RGB. */
export function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])));
    return Buffer.concat([head, Buffer.from(type), body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) rows.set(paint(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const blobs = new Map<string, { ext: string; bytes: Buffer }>();
const keep = (bytes: Buffer, ext: string) => { const sha = sha256(bytes); blobs.set(sha, { ext, bytes }); return sha; };

const frame = (shade: number) => keep(png(64, 40, (x, y) => [40 + shade + (x >> 2), 34 + shade + (y >> 1), 30 + (shade >> 1)]), 'png');
/** A typed page: pale paper with dark bands for its lines. */
const scan = (seed: number) => keep(png(120, 156, (x, y) => (y > 10 && y % 9 < 3 && x > 8 && x < 112 - ((y * seed) % 37) ? [70, 66, 58] : [232, 227, 214])), 'png');
const photo = (r: number, g: number, b: number) => keep(png(48, 48, (x, y) => [r + ((x * y) % 23), g + (x % 17), b + (y % 19)]), 'png');

export const FILM = [frame(0), frame(30), frame(60), frame(90)];
export const PAGES = [scan(3), scan(5), scan(7)];
export const PHOTOS = [photo(120, 110, 96), photo(60, 70, 120), photo(150, 120, 70)];

/** A look's key, as the package names one: here any fixed hex per name. */
export const key = (name: string) => sha256(`look ${name}`);
export const K = { film: key('film 0-30'), page1: key('page 1'), page2: key('page 2'), page3: key('page 3'), photo1: key('photo 1'), photo2: key('photo 2'), photo3: key('photo 3'), weak1: key('weak page 1') };

const SOURCE = { film: sha256('film'), scans: sha256('scans') };
const EYES = 'faux/eyes-sharp';
const WEAK = 'faux/eyes-weak';

type LookInput = { key: string; item: string; path: string; kind: string; fragment: string; sha: string; model?: string; ask: string; body: string; cost?: number | null; status?: 'ok' | 'failed'; kept?: boolean; extra?: Record<string, Json>; images: Json[]; miss?: Json };
/** A filing: the receipt the host's sink returned, the LookRecord as the package files one, and what the host adds. */
const filing = (look: LookInput) => {
  const record = {
    tool: 'look', args: { path: look.path, ask: look.ask, ...look.extra, model: look.model ?? EYES, native: false }, status: look.status ?? 'ok',
    facts: { sha256: look.sha, kind: look.kind, fragment: look.fragment, key: look.key, tokens_in: 1200, tokens_out: 80, ...(look.cost === undefined ? {} : { cost_usd: look.cost }), ...(look.kept ? { kept: true } : {}) },
    body: look.body,
  } as Json;
  const receipt = `evidence/read/look-${sha256(JSON.stringify(record)).slice(0, 12)}.json`;
  return { receipt, record, item: look.item, images: look.images, ...(look.miss ? { miss: look.miss } : {}) } as Json;
};

export const LOOKS = {
  film: filing({ key: K.film, item: 'film-window', path: 'film.mp4', kind: 'video', fragment: 't=0,30', sha: SOURCE.film, ask: 'What changes in this window?', body: 'The ground slides past; at 20 s a shadow crosses the frame.', cost: 0.0015, extra: { from_s: 0, to_s: 30 }, images: [] }),
  page1: filing({ key: K.page1, item: 'scan-pages', path: 'scans.pdf', kind: 'pdf', fragment: 'page=1', sha: SOURCE.scans, ask: 'Every line with its timestamp', body: '{"time":"00 00 00 05","speaker":"A","text":"Starting the run."}\n{"time":"00 00 00 12","speaker":"B","text":"Copy."}', cost: 0.0018, extra: { page: 1 }, images: [PAGES[0]!] }),
  page2: filing({ key: K.page2, item: 'scan-pages', path: 'scans.pdf', kind: 'pdf', fragment: 'page=2', sha: SOURCE.scans, ask: 'Every line with its timestamp', body: '{"time":"00 00 00 40","speaker":"A","text":"An alarm, number 9."}\n{"time":"00 00 00 44","speaker":"B","text":"Go on."}', cost: 0.0018, extra: { page: 2 }, images: [PAGES[1]!] }),
  photo1: filing({ key: K.photo1, item: 'photo-001', path: 'photos/photo-001.png', kind: 'image', fragment: '', sha: sha256('photo-001'), ask: 'Which class: ground, craft, crew, sky, tool?', body: 'ground', cost: 0.0012, images: [] }),
  photo2: filing({ key: K.photo2, item: 'photo-002', path: 'photos/photo-002.png', kind: 'image', fragment: '', sha: sha256('photo-002'), ask: 'Which class: ground, craft, crew, sky, tool?', body: '', cost: 0, status: 'failed', images: [], miss: { code: 'over_budget', reason: 'an image over the eyes\' limit' } }),
  page3: filing({ key: K.page3, item: 'scan-pages', path: 'scans.pdf', kind: 'pdf', fragment: 'page=3', sha: SOURCE.scans, ask: 'Every line with its timestamp', body: '{"time":"00 00 01 02","speaker":"A","text":"Contact."}', cost: 0.0018, extra: { page: 3 }, images: [PAGES[2]!] }),
  page3Kept: filing({ key: K.page3, item: 'scan-pages', path: 'scans.pdf', kind: 'pdf', fragment: 'page=3', sha: SOURCE.scans, ask: 'Every line with its timestamp', body: '{"time":"00 00 01 02","speaker":"A","text":"Contact."}', cost: 0.0018, kept: true, extra: { page: 3 }, images: [PAGES[2]!] }),
  photo3Kept: filing({ key: K.photo3, item: 'photo-003', path: 'photos/photo-003.png', kind: 'image', fragment: '', sha: sha256('photo-003'), ask: 'Which class: ground, craft, crew, sky, tool?', body: 'crew', cost: 0.0012, kept: true, images: [] }),
  weak1: filing({ key: K.weak1, item: 'scan-pages', path: 'scans.pdf', kind: 'pdf', fragment: 'page=1', sha: SOURCE.scans, model: WEAK, ask: 'Every line with its timestamp', body: '{"time":"00 00 0 05","speaker":"A","text":"Starting the run."}\n{"time":"00 00 00 2","speaker":"B","text":"Copy."}', cost: 0.0004, extra: { page: 1 }, images: [PAGES[0]!] }),
};

export const ACCOUNT = {
  format: 'apollo11.account/1', dataset_sha256: sha256('dataset'),
  entries: [
    { mission_time: '000:00:05', text: 'The run starts; the window shows the ground sliding past.', cites: [{ item: 'film-window', fragment: '#t=0,30', receipt: K.film }, { item: 'scan-pages', fragment: '#page=1', receipt: K.page1 }] },
    { mission_time: '000:00:40', text: 'An alarm is called out, number 9.', cites: [{ item: 'scan-pages', fragment: '#page=2&xywh=percent:6,8,80,6', receipt: K.page2 }] },
    { mission_time: '000:01:02', text: 'Contact.', cites: [{ item: 'scan-pages', fragment: '#page=3', receipt: K.page3 }] },
  ],
  dropped: [{ entry: 3, item: '', why: '000:02:00 is no time of a line on a page the entry cites' }],
  photos: [{ item: 'photo-001', label: 'ground', truth: 'ground', fragment: '#xywh=percent:0,0,100,100', receipt: K.photo1 }, { item: 'photo-003', label: 'crew', truth: 'tool', fragment: '#xywh=percent:0,0,100,100', receipt: K.photo3 }],
  accuracy: { overall: { right: 1, total: 2, rate: 0.5 }, by_class: { ground: { right: 1, total: 1, rate: 1 }, tool: { right: 0, total: 1, rate: 0 } }, confusion: { ground: { ground: 1 }, tool: { crew: 1 } }, unsorted: [] },
  transcript: {
    pages: [1, 2, 3].map((page) => ({ item: 'scan-pages', page, lines: 2, fragment: `#page=${page}`, receipt: [K.page1, K.page2, K.page3][page - 1]! })),
    times: { pages: 3, times: 5, in_typed: 5, unreadable: 0, not_in_typed: [] },
  },
  film: [{ item: 'film-window', from_s: 0, to_s: 30, seen: 'The ground slides past.', fragment: '#t=0,30', receipt: K.film }],
  models: { lead: 'faux/text-lead', eyes: EYES, scripted: true },
  counters: { looks: 9, paid: 7, kept: 2, repeated: 0, asked_twice: 0, failed: 1, cost_usd: 0.0097, cost_unknown: 0 },
  weak_eyes: { model: WEAK, source: 'vision-hand-weak', photos: { right: 1, total: 2 }, times: { pages: 1, times: 2, in_typed: 0, unreadable: 0, not_in_typed: [{ page: 1, read: '00 00 0 05', truth: '00 00 00 05', receipt: K.weak1 }, { page: 1, read: '00 00 00 2', truth: '00 00 00 12', receipt: K.weak1 }] } },
};
export const RESULT = keep(Buffer.from(JSON.stringify(ACCOUNT)), 'json');

/** The same run delivering the generic cited result (`agentrun.cited/1`): rows citing a look and where in it, a file,
 *  both, a page known only by its address, or nothing. */
export const CITED = {
  format: 'agentrun.cited/1', title: 'Three pages and three photographs, read',
  rows: [
    { label: 'The alarm', value: 'number 9', note: 'read off page 2', cites: [{ look: K.page2, fragment: '#page=2&xywh=percent:6,8,80,6', note: 'the line it stands on' }] },
    { label: 'The first photograph', value: 'ground', cites: [{ look: K.photo1 }, { blob: PHOTOS[0]! }] },
    { label: 'A share read from a picture', value: 41, note: 'published 41.5, gap 0.5', cites: [{ blob: FILM[0]!, fragment: '#t=3.75', note: 'the picture it was read from' }] },
    { label: 'A page that was not the dashboard', value: 'failed', cites: [] },
    { label: 'The published figure', value: '41.5%', cites: [{ url: 'https://data.example.org/figures.csv', at: '2026-10-15T00:00:00Z', note: 'the operator\'s own table' }] },
    { label: 'A page with no web address', value: 'n/a', cites: [{ url: 'javascript:alert(1)' }] },
  ],
};

/** A recording written by `writeRecording`, made to deliver `value` as its result instead. */
export function deliverInstead(dir: string, value: Json): string {
  const bytes = Buffer.from(JSON.stringify(value));
  const sha = sha256(bytes);
  writeFileSync(join(dir, 'blobs', `${sha}.json`), bytes);
  for (const file of ['manifest.json', 'events.jsonl']) writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8').replaceAll(RESULT, sha));
  return sha;
}

let t = 0;
let seq = 0;
const host = (kind: string, data: Json, blobs?: string[]): Line => ({ channel: 'live', source: 'host', kind, t: (t += 10), seq: (seq += 1), data, ...(blobs ? { blobs } : {}) });
const liveSeq: Record<number, number> = {};
type Where = { conv: number; path?: string };
const LEAD: Where = { conv: 1 };
const SORT = (n: number): Where => ({ conv: 2, path: `/root/steps/1/items/${n}` });
const live = (gen: number, at: Where, source: Line['source'], kind: string, data: Json): Line => ({ channel: 'live', source, kind, gen, t: (t += 10), seq: (liveSeq[gen] = (liveSeq[gen] ?? 0) + 1), ...at, data });
const durable = (gen: number, commit: number, at: Where | undefined, source: Line['source'], kind: string, data: Json, snapshot = false, blobs?: string[]): Line =>
  ({ channel: 'durable', source, kind, gen, t: (t += 10), commit, order: 0, ...at, ...(snapshot ? { snapshot: true } : {}), data, ...(blobs?.length ? { blobs } : {}) });
const driver = (gen: number, commit: number, generation: number, snapshot = false) => durable(gen, commit, undefined, 'workflow', 'agentrun.driver', { doc: 'agentrun.driver', value: { generation } }, snapshot);
const imagesOf = (look: Json) => ((look as { images: Json[] }).images).map((image) => (typeof image === 'string' ? image : (image as { blob: string }).blob));
// One `vision.looks` document per look key and conversation, its filings appended in order; a revision carries them all.
const filings = new Map<string, Json[]>();
const keyOf = (look: Json) => (look as { record: { facts: { key: string } } }).record.facts.key;
const filed = (gen: number, commit: number, at: Where, look: Json, snapshot = false) => {
  const key = keyOf(look);
  const list = snapshot ? filings.get(key)! : [...(filings.get(key) ?? []), look];
  filings.set(key, list);
  return durable(gen, commit, at, 'vision', 'vision.looks', { doc: 'vision.looks', key, value: { looks: list } }, snapshot, list.flatMap(imagesOf));
};
const usage = { input: 900, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 930, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const ask = (gen: number, commit: number, at: Where, call: string, args: Json) => durable(gen, commit, at, 'pi', 'pi.assistant', { kind: 'pi.assistant', model: [{ role: 'assistant', provider: 'faux', model: 'text-lead', usage, stopReason: 'toolUse', content: [{ type: 'toolCall', id: call, name: 'read', arguments: args }] }] });
const answered = (gen: number, commit: number, at: Where, call: string, text: string) => durable(gen, commit, at, 'pi', 'pi.tool-result', { kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: call, toolName: 'read', content: [{ type: 'text', text }], isError: false }] });
const start = (gen: number, at: Where, call: string, args: Json) => live(gen, at, 'pi', 'tool_execution_start', { type: 'tool_execution_start', toolCallId: call, toolName: 'read', args });
const end = (gen: number, at: Where, call: string) => live(gen, at, 'pi', 'tool_execution_end', { type: 'tool_execution_end', toolCallId: call, toolName: 'read' });
/** The images a read returned before the eyes looked, each after its caption, as the host's recorder keeps them. */
const shownLine = (gen: number, at: Where, call: string, args: Json, media: Json, images: string[], captions: string[] = []) =>
  ({ ...live(gen, at, 'vision', 'shown', { conversationId: String(at.conv), callId: call, args, media, content: images.flatMap((blob, n): Json[] => [...(captions[n] ? [{ type: 'text', text: captions[n] }] : []), { type: 'image', mimeType: 'image/png', blob }]) }), blobs: images } as Line);
const told = (gen: number, at: Where, look: Json) => live(gen, at, 'vision', 'LookEvent', { tool: 'read', source: (look as { record: { args: { path: string } } }).record.args.path, record: (look as { record: Json }).record, receipt: (look as { receipt: string }).receipt });
const bodyOf = (look: Json) => (look as { record: { body: string } }).record.body;

/** One read: the lead's call, the read running (and what it showed, when the host kept it), its look filed and told, its
 *  result committed. */
const read = (gen: number, commit: number, at: Where, call: string, args: Json, look: Json, shown?: () => Line): Line[] =>
  [ask(gen, commit, at, call, args), start(gen, at, call, args), ...(shown ? [shown()] : []), filed(gen, commit + 1, at, look), told(gen, at, look), answered(gen, commit + 2, at, call, bodyOf(look)), end(gen, at, call)];
const filmShown = (gen: number) => shownLine(gen, LEAD, 'c1', { path: 'film.mp4', from_s: 0, to_s: 30 }, { kind: 'video', path: 'film.mp4', fromS: 0, toS: 30 }, FILM, FILM.map((_, n) => `Frame at ${3.75 + n * 7.5} s.`));
const photoShown = (gen: number, n: number, call: string) => shownLine(gen, SORT(n), call, { path: `photos/photo-00${n + 1}.png` }, { kind: 'image', path: `photos/photo-00${n + 1}.png` }, [PHOTOS[n]!]);

const filmArgs = { path: 'film.mp4', from_s: 0, to_s: 30, ask: 'What changes in this window?' };
const pageArgs = (page: number) => ({ path: 'scans.pdf', page, ask: 'Every line with its timestamp' });
const photoArgs = (n: number) => ({ path: `photos/photo-00${n}.png`, ask: 'Which class: ground, craft, crew, sky, tool?' });
const receiptOf = (look: Json) => (look as { receipt: string }).receipt;

export const lines: Line[] = [
  host('process.started', { gen: 1 }),
  driver(1, 1, 1),
  ...read(1, 2, LEAD, 'c1', filmArgs, LOOKS.film, () => filmShown(1)),
  ...read(1, 5, LEAD, 'c2', pageArgs(1), LOOKS.page1),
  ...read(1, 8, LEAD, 'c3', pageArgs(2), LOOKS.page2),
  ...read(1, 11, SORT(0), 'p1', photoArgs(1), LOOKS.photo1, () => photoShown(1, 0, 'p1')),
  // A miss: the photo is over the eyes' limit, filed before any request, so it cost nothing.
  ask(1, 14, SORT(1), 'p2', photoArgs(2)), start(1, SORT(1), 'p2', photoArgs(2)), photoShown(1, 1, 'p2'), filed(1, 15, SORT(1), LOOKS.photo2),
  live(1, SORT(1), 'vision', 'MissEvent', { tool: 'read', source: 'photos/photo-002.png', code: 'over_budget', reason: 'an image over the eyes\' limit', receipt: receiptOf(LOOKS.photo2) }),
  answered(1, 16, SORT(1), 'p2', '(withheld)'), end(1, SORT(1), 'p2'),
  // Two reads in flight at the kill: page 3's look is filed, paid, before its result commits; photo 3's eyes answered
  // into the call's memo, and the process dies before that look is filed.
  ask(1, 17, LEAD, 'c4', pageArgs(3)), start(1, LEAD, 'c4', pageArgs(3)), filed(1, 18, LEAD, LOOKS.page3), told(1, LEAD, LOOKS.page3),
  ask(1, 19, SORT(2), 'p3', photoArgs(3)), start(1, SORT(2), 'p3', photoArgs(3)), photoShown(1, 2, 'p3'),
  host('kill', { gen: 1, label: 'two reads in flight', crossing: { point: 'vision.answered', n: 6 } }),
  host('process.started', { gen: 2 }),
  // Process 2's snapshot: the state at commit 19, written by process 1 (gen 1).
  driver(1, 19, 1, true),
  ...[LOOKS.film, LOOKS.page1, LOOKS.page2, LOOKS.page3].map((look) => filed(1, 19, LEAD, look, true)),
  ...[LOOKS.photo1, LOOKS.photo2].map((look, n) => filed(1, 19, SORT(n), look, true)),
  driver(2, 20, 2),
  // Both cut reads run again and read their answers back from the memo: each look is filed kept, and nothing is paid.
  start(2, LEAD, 'c4', pageArgs(3)), filed(2, 21, LEAD, LOOKS.page3Kept), answered(2, 22, LEAD, 'c4', bodyOf(LOOKS.page3Kept)), end(2, LEAD, 'c4'),
  start(2, SORT(2), 'p3', photoArgs(3)), photoShown(2, 2, 'p3'), filed(2, 23, SORT(2), LOOKS.photo3Kept), answered(2, 24, SORT(2), 'p3', bodyOf(LOOKS.photo3Kept)), end(2, SORT(2), 'p3'),
  // The weaker eyes read page 1 again, for the comparison scene.
  ...read(2, 25, LEAD, 'c5', pageArgs(1), LOOKS.weak1),
  host('result', { gen: 2, blob: RESULT, title: 'The account' }, [RESULT]),
].map((line, at, all) => (line.channel === 'durable' && line.snapshot ? { ...line, order: all.slice(0, at).filter((each) => each.snapshot && each.commit === line.commit).length } : line));

export const manifest = {
  format: 'agentrun.recording/1', title: 'A vision run, built by hand (synthetic)', task: 'vision-hand', recorded: { started: '2026-10-14T00:00:00Z', ended: '2026-10-14T00:05:00Z' },
  code: { repo: 'https://github.com/Parcha-ai/agentrun', commit: '0'.repeat(40), packages: {} }, model: 'faux/text-lead', generations: 2, kills: 1, providers: 'scripted' as const,
  cost: { usd: countersOf(reduceTo(counterFold, lines, lines.length), true).cost, parts: { 'faux/text-lead': 0, eyes: countersOf(reduceTo(counterFold, lines, lines.length), true).cost } },
  source: { run: 'hand', store_sha256: '0'.repeat(64) }, result: { blob: RESULT, title: 'The account' },
};

/** The recording as a directory: manifest.json, events.jsonl and blobs/. */
export function writeRecording(dir: string): void {
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'events.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  for (const [sha, { ext, bytes }] of blobs) writeFileSync(join(dir, 'blobs', `${sha}.${ext}`), bytes);
}
