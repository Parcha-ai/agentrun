// The visual report of a browser run (`chat.html?r=<id>&muse&visual`): read from the recording's own lines, nothing more. The data (which frames are blurred, what plays,
// which chapters seek, the facts a look boxed) is checked on a small hand-written browser run; the page in a real Chrome under the docs site's policy. The safety rule is
// the point: a session that had a credential on its page has every frame from its first to the gap's end blurred as pixels, never enlarged, and skipped by the video.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cropOf, visualOf } from '../src/chat-visual.ts';
import { parseLines, type Recording } from '../src/format.ts';
import { chrome, closeLeftBrowsers } from './driven-page.ts';
import { browserRun, readManifest, served, writeManifest } from './muse-served.ts';

const here = new URL('.', import.meta.url).pathname;
const IN_CHROME = { skip: existsSync(chrome) ? false : `no Chrome at ${chrome}`, timeout: 120_000 };
after(async () => { assert.deepEqual(await closeLeftBrowsers(), [], 'every browser a test started was closed by that test'); });

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', json: 'application/json', html: 'text/html', webm: 'video/webm', pdf: 'application/pdf' };

/** The fixture made into a browser run in a scratch directory, opened as the shell would (every blob a data: URL, as an embedded build keeps them). */
function openedRun(t: { after(fn: () => unknown): void }, options: Parameters<typeof browserRun>[1] = {}, edit?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-visual-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(here, 'fixtures', 'chat-browser'), dir, { recursive: true });
  const frames = browserRun(dir, options);
  edit?.(dir);
  const files = Object.fromEntries(readdirSync(join(dir, 'blobs')).map((name) => [name.split('.')[0]!, name]));
  const recording: Recording = {
    id: 'run', manifest: readManifest(dir) as never, lines: parseLines(readFileSync(join(dir, 'events.jsonl'), 'utf8')),
    blobUrl: (sha) => (files[sha] ? `data:${TYPES[files[sha]!.split('.').at(-1)!] ?? 'application/octet-stream'};base64,${readFileSync(join(dir, 'blobs', files[sha]!)).toString('base64')}` : undefined),
    blobType: (sha) => TYPES[files[sha]?.split('.').at(-1) ?? ''],
  };
  return { recording, frames };
}

test('the safety rule: in a session that had a credential on its page, every frame from its first to the gap\'s end is blurred, the video skips that span, and a page read inside it has no place to seek', async (t) => {
  const { recording, frames } = openedRun(t);
  const visual = (await visualOf(recording))!;
  assert.deepEqual(visual.frames.map((frame) => [frame.t, frame.sensitive]), [[500, true], [1500, true], [2500, false], [2700, false], [4000, false]]);
  // The film: its first two held frames are the blurred ones; playback starts after them and runs the rest (each held frame plays at most 1.5 s).
  assert.deepEqual(visual.video!.segments, [[2, 4]], 'only the kept frames play, from the gap\'s end');
  assert.equal(visual.video!.poster, frames[2500], 'its poster is the first frame that is not blurred');
  assert.deepEqual(visual.chapters.map((chapter) => [chapter.title, chapter.hidden, chapter.at]), [['Sign in', true, 0], ['Account summary', false, 2.5], ['Your bills', false, 3.7]], 'a page read while only a blurred frame was on screen is not shown, never inside the skipped span');
});

test('a run with no credential gap blurs nothing and plays whole', async (t) => {
  const { recording } = openedRun(t, { gap: false });
  const visual = (await visualOf(recording))!;
  assert.deepEqual(visual.frames.filter((frame) => frame.sensitive), []);
  assert.deepEqual(visual.video!.segments, [[0, 4]]);
  assert.deepEqual(visual.chapters.map((chapter) => chapter.hidden), [false, false, false]);
});

test('the facts a look boxed are read as the recording\'s facts blob says: a box in the frame\'s pixels, none where the look found none, the look\'s own label and receipt; a fact on a frame the run does not have is dropped', async (t) => {
  const { recording, frames } = openedRun(t, { facts: (known) => [
    { fact: '$112.40', claim: 'Amount due', frame: known[2500], box: { x: 100, y: 120, w: 80, h: 20 }, label: 'boxed by a look after the run', receipt: { sha256: 'a'.repeat(64), model: 'jev-1', usd: 0.0001 } },
    { fact: 'over $100', claim: 'Flagged: over $100', frame: known[2500], box: { x: 100, y: 120, w: 80, h: 20 }, label: 'boxed by a look after the run', inferred: true },
    { fact: 'Due', claim: 'Status', frame: known[2700], box: null, label: 'no box found', why: 'it was not visible' },
    { fact: 'nowhere', claim: 'x', frame: '0'.repeat(64), box: { x: 0, y: 0, w: 1, h: 1 }, label: '' },
  ] });
  void frames;
  const visual = (await visualOf(recording))!;
  assert.deepEqual(visual.facts.map((fact) => [fact.fact, fact.box, fact.label, fact.inferred === true, fact.why ?? null, fact.receipt?.model ?? null]), [
    ['$112.40', { x: 100, y: 120, w: 80, h: 20 }, 'boxed by a look after the run', false, null, 'jev-1'],
    ['over $100', { x: 100, y: 120, w: 80, h: 20 }, 'boxed by a look after the run', true, null, null],
    ['Due', null, 'no box found', false, 'it was not visible', null],
  ]);
});

test('the files an artifact holds as PDFs are the report\'s thumbnails; no browser run, no report', async (t) => {
  const { recording } = openedRun(t, {}, (dir) => { const manifest = readManifest(dir) as { artifact: { files: Record<string, string> } }; manifest.artifact.files['statement.pdf'] = 'f'.repeat(64); writeManifest(dir, manifest); });
  assert.deepEqual((await visualOf(recording))!.files, [{ name: 'statement.pdf', sha: 'f'.repeat(64) }]);
  assert.equal(await visualOf({ ...recording, lines: recording.lines.filter((line) => line.kind !== 'frame' && line.kind !== 'frame.track'), manifest: { ...recording.manifest, artifact: undefined } as never }), undefined, 'nothing to show');
});

test('in Chrome: the report holds the video, the chapters, the filmstrip; the sign-in frames are canvases (never the sharp picture) with no click, the others open enlarged', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { query: '&muse&visual', height: 900, edit: (dir) => browserRun(dir) });
  await until(`!!d()?.querySelector('.mu-report .mu-shot-tile')`, 'the report drawn');
  const report = await value<{ video: [boolean, boolean]; chapters: [string, boolean][]; tiles: [boolean, number, number, string][]; wider: number }>(`(() => { const r = d().querySelector('.mu-report'); const v = r.querySelector('video');
    return { video: [v.muted, v.hasAttribute('controls')], chapters: [...r.querySelectorAll('.mu-chapter')].map((b) => [b.querySelector('.mu-ch-title').textContent, b.disabled]),
      tiles: [...r.querySelectorAll('.mu-shot-tile')].map((tile) => [tile.classList.contains('blurred'), tile.querySelectorAll('canvas').length, tile.querySelectorAll('img').length, tile.querySelector('.mu-cap').textContent]),
      wider: d().documentElement.scrollWidth - d().documentElement.clientWidth }; })()`);
  assert.deepEqual(report.video, [true, true], 'muted, scrubbable');
  assert.deepEqual(report.chapters, [['Sign in', true], ['Account summary', false], ['Your bills', false]], 'the chapter read inside the blurred span cannot be sought');
  assert.deepEqual(report.tiles.map(([blurred, canvases, images]) => [blurred, canvases, images]), [[true, 1, 0], [true, 1, 0], [false, 0, 1], [false, 0, 1], [false, 0, 1]], 'a blurred frame is a canvas and has no picture element at all');
  assert.equal(report.tiles[0]![3], 'Sign-in (blurred)');
  assert.equal(report.wider <= 1, true, 'nothing sideways');
  // A blurred frame is never enlarged; any other opens, and Escape closes it.
  await value(`(() => { d().querySelector('.mu-shot-tile.blurred').click(); return 0; })()`);
  assert.equal(await value<number>(`d().querySelectorAll('.mu-lightbox').length`), 0, 'no enlarged sign-in');
  await value(`(() => { d().querySelector('.mu-shot-tile:not(.blurred)').click(); return 0; })()`);
  assert.equal(await value<number>(`d().querySelectorAll('.mu-lightbox img').length`), 1, 'another frame opens');
  await value(`(() => { d().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); d().defaultView.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 0; })()`);
});

test('in Chrome: a crop is the frame around its box, the box is the look\'s, no box means the whole frame said so, and an inference is not shown as text on the page', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { query: '&muse&visual', height: 900, edit: (dir) => browserRun(dir, { facts: (known) => [
    { fact: '$112.40', claim: 'Amount due', frame: known[2500], box: { x: 100, y: 120, w: 80, h: 20 }, label: 'boxed by a look after the run' },
    { fact: 'over $100', claim: 'Flagged: over $100', frame: known[2500], box: { x: 100, y: 120, w: 80, h: 20 }, label: 'boxed by a look after the run', inferred: true },
    { fact: 'Due', claim: 'Status', frame: known[2700], box: null, label: 'no box found', why: 'it was not visible' },
  ] }) });
  await until(`!!d()?.querySelector('.mu-fact')`, 'the facts drawn');
  assert.deepEqual(await value(`[...d().querySelectorAll('.mu-fact')].map((f) => [f.querySelector('.mu-fact-value').textContent, f.querySelectorAll('.mu-box').length, [...f.querySelectorAll('.mu-cap')].map((c) => c.textContent)])`), [
    ['$112.40', 1, ['Amount due · boxed by a look after the run']],
    ['over $100', 1, ['Flagged: over $100 · boxed by a look after the run', 'The page shows the evidence, not the conclusion: this is the agent\'s own flag.']],
    ['Due', 0, ['Status · no box found', 'it was not visible']],
  ]);
  await value(`(() => { d().querySelector('.mu-fact .mu-crop').click(); return 0; })()`);
  assert.equal(await value<number>(`d().querySelectorAll('.mu-lightbox .mu-box').length`), 1, 'the enlarged frame carries the same box');
});

test('in Chrome: a run that skipped its sign-in because it was remembered says so; without &visual the Muse layout draws no report at all', IN_CHROME, async (t) => {
  const remembered = await served(t, { query: '&muse&visual', height: 900, edit: (dir) => browserRun(dir, { gap: false, remembered: true }) });
  await remembered.until(`!!d()?.querySelector('.mu-report .mu-skip')`, 'the skipped tile');
  assert.equal(await remembered.value<string>(`d().querySelector('.mu-skip').textContent`), 'Skippedsign-in, rememberedOpened straight on the account');
  assert.equal(await remembered.value<number>(`d().querySelectorAll('.mu-blurred').length`), 0, 'no gap, nothing blurred');
});

test('in Chrome: without &visual the Muse layout draws no report', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { height: 900, edit: (dir) => browserRun(dir) });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  assert.equal(await value<number>(`d().querySelectorAll('.mu-report, .mu-video, .mu-blurred').length`), 0);
});

test('chapters: one per distinct page visit; two that land at the same place in the video are the later page', async (t) => {
  const { recording } = openedRun(t, { mergeRead: true });
  assert.deepEqual((await visualOf(recording))!.chapters.map((chapter) => [chapter.title, chapter.hidden]), [['Sign in', true], ['Bill March 2026', false], ['Your bills', false]], 'Account summary, opened and left within the same moment, is no chapter');
});

test('a crop holds its box with 24 px of air on every side (the frame\'s edge excepted), never a sliver; a box across a table row is the whole row with the lines above it', () => {
  const frame = { w: 800, h: 353 };
  for (const box of [{ x: 232, y: 177, w: 48, h: 18 }, { x: 560, y: 173, w: 112, h: 25 }, { x: 640, y: 251, w: 56, h: 21 }, { x: 88, y: 265, w: 64, h: 18 }, { x: 2, y: 3, w: 40, h: 12 }]) {
    const crop = cropOf(frame, box);
    assert.ok(crop.x <= Math.max(0, box.x - 24) && crop.y <= Math.max(0, box.y - 24), `air above and left of ${JSON.stringify(box)}`);
    assert.ok(crop.x + crop.w >= Math.min(frame.w, box.x + box.w + 24) && crop.y + crop.h >= Math.min(frame.h, box.y + box.h + 24), `air below and right of ${JSON.stringify(box)}`);
    assert.ok(crop.w >= 240 && crop.h >= 110, 'not a sliver');
  }
  const row = cropOf(frame, { x: 88, y: 212, w: 600, h: 28 });
  assert.deepEqual([row.x, row.w], [0, 800], 'the whole width');
  assert.ok(row.y <= 212 - 70 && row.y + row.h >= 212 + 28 + 24, 'the row with the table\'s header above it and air below');
});

test('in Chrome: a blank frame and a picture shown twice are no tiles of the filmstrip; a wide window breaks the report out of the chat column, three facts across', IN_CHROME, async (t) => {
  const facts = (known: Record<number, string>) => [2500, 2700, 4000].map((at, i) => ({ fact: `fact ${i}`, claim: 'c', frame: known[at], box: { x: 100, y: 100, w: 60, h: 18 }, label: 'boxed by a look after the run' }));
  const { value, until } = await served(t, { query: '&muse&visual', width: 1440, height: 900, edit: (dir) => browserRun(dir, { blankAt: 2700, sameAs: { 4000: 2500 }, facts }) });
  await until(`!!d()?.querySelector('.mu-fact')`, 'the report drawn');
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(await value(`[...d().querySelectorAll('.mu-shot-tile')].map((tile) => tile.querySelector('.mu-cap').textContent)`), ['Sign-in (blurred)', 'Sign-in (blurred)', 'Account summary'], 'the flat frame and the repeated one are gone');
  assert.deepEqual(await value(`(() => { const r = d().querySelector('.mu-report').getBoundingClientRect(); const chat = d().querySelector('.mu-row.person').getBoundingClientRect(); const lefts = new Set([...d().querySelectorAll('.mu-fact')].map((f) => Math.round(f.getBoundingClientRect().left)));
    return [r.width >= 1000, chat.width <= 640, lefts.size, d().documentElement.scrollWidth - d().documentElement.clientWidth <= 1]; })()`), [true, true, 3, true], 'the report is wide, the chat stays a column, the facts are three across, nothing sideways');
});

test('in Chrome: with &visual the chat\'s own browser card shows a sign-in frame blurred; the plain Muse card is left as it was', IN_CHROME, async (t) => {
  // The credential gap starts after the last frame (4000): every frame, the browser card's last one included, is the sign-in's.
  const visual = await served(t, { query: '&muse&visual', edit: (dir) => browserRun(dir, { gapFrom: 4000 }) });
  await visual.until(`!!d()?.querySelector('.mu-browser .mu-shot')`, 'the card drawn');
  assert.deepEqual(await visual.value(`[d().querySelectorAll('.mu-browser .mu-shot canvas.mu-blurred').length, d().querySelectorAll('.mu-browser .mu-shot img').length]`), [1, 0], 'blurred pixels, no sharp picture');
  const plain = await served(t, { edit: (dir) => browserRun(dir, { gapFrom: 4000 }) });
  await plain.until(`!!d()?.querySelector('.mu-browser .mu-shot')`, 'the plain card drawn');
  assert.deepEqual(await plain.value(`[d().querySelectorAll('.mu-browser .mu-shot canvas').length, d().querySelectorAll('.mu-browser .mu-shot img').length]`), [0, 1], 'the plain Muse card is as it was (on Wednesday\'s list)');
});
