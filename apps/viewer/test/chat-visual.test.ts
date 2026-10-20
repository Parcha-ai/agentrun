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
  // Fail closed: the span is the video's prefix [0, skipEnd); every place the page ever sends the video to (a segment's start, a chapter) is at or after its end.
  assert.equal(visual.video!.skipEnd, 2);
  assert.ok(visual.video!.segments.every(([start]) => start >= visual.video!.skipEnd) && visual.chapters.every((chapter) => chapter.at >= visual.video!.skipEnd), 'no seek point inside the blurred span');
  assert.deepEqual(visual.chapters.map((chapter) => [chapter.title, chapter.at]), [['Account summary', 2.2], ['Your bills', 3.5]], 'a page read while only a blurred frame was on screen has no seek point, so it is no chapter; the others seek to the kept frame that shows their page (the latest at or before the read), never inside the skipped span and never on to the next page\'s');
});

test('a run with no credential gap blurs nothing and plays whole', async (t) => {
  const { recording } = openedRun(t, { gap: false });
  const visual = (await visualOf(recording))!;
  assert.deepEqual(visual.frames.filter((frame) => frame.sensitive), []);
  assert.deepEqual(visual.video!.segments, [[0, 4]]);
  assert.equal(visual.video!.skipEnd, 0, 'nothing skipped');
  assert.deepEqual(visual.chapters.map((chapter) => chapter.title), ['Sign in', 'Account summary', 'Your bills']);
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

test('in Chrome: the report holds the video, the chapters, the strip of screenshots; the sign-in frames are canvases (never the sharp picture) with no click, the others open enlarged', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { query: '&muse&visual', height: 900, edit: (dir) => browserRun(dir) });
  await until(`!!d()?.querySelector('.mu-report .mu-shot-tile')`, 'the report drawn');
  const report = await value<{ video: [boolean, boolean, string | null]; chapters: string[]; tiles: [boolean, number, number, string][]; wider: number }>(`(() => { const r = d().querySelector('.mu-report'); const v = r.querySelector('video');
    return { video: [v.muted, v.hasAttribute('controls'), (v.getAttribute('src') || '').split('#')[1] ?? null], chapters: [...r.querySelectorAll('.mu-chapter')].map((b) => b.querySelector('.mu-ch-title').textContent + (b.disabled ? '(off)' : '')),
      tiles: [...r.querySelectorAll('.mu-shot-tile')].map((tile) => [tile.classList.contains('blurred'), tile.querySelectorAll('canvas').length, tile.querySelectorAll('img').length, tile.querySelector('.mu-cap').textContent]),
      wider: d().documentElement.scrollWidth - d().documentElement.clientWidth }; })()`);
  assert.deepEqual(report.video, [true, false, 't=2'], 'muted; NO native controls on a video with a credential gap (a scrub bar would let anyone drag into the blurred span, the jump coming only after the frame is shown); it starts at the span\'s end');
  assert.deepEqual(report.chapters, ['Account summary', 'Your bills'], 'a chapter that cannot be sought is not listed');
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
  // A whole frame is scaled into its card, not cut off at its natural size; the keyboard opens a fact picture as the pointer does.
  assert.deepEqual(await value(`(() => { const crop = [...d().querySelectorAll('.mu-fact')].at(-1).querySelector('.mu-crop'); const img = crop.querySelector('img'); return [img.getBoundingClientRect().width <= crop.getBoundingClientRect().width + 1, crop.getAttribute('role'), crop.tabIndex]; })()`), [true, 'button', 0]);
  await value(`(() => { d().querySelector('.mu-fact .mu-crop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 0; })()`);
  assert.equal(await value<number>(`d().querySelectorAll('.mu-lightbox').length`), 1, 'Enter enlarges it');
  await value(`(() => { d().querySelector('.mu-lightbox').click(); return 0; })()`);
  await value(`(() => { d().querySelector('.mu-fact .mu-crop').click(); return 0; })()`);
  assert.equal(await value<number>(`d().querySelectorAll('.mu-lightbox .mu-box').length`), 1, 'the enlarged frame carries the same box');
});

test('in Chrome: a run that skipped its sign-in because it was remembered says so; without &visual the Muse layout draws no report at all', IN_CHROME, async (t) => {
  const remembered = await served(t, { query: '&muse&visual', height: 900, edit: (dir) => browserRun(dir, { gap: false, remembered: true }) });
  await remembered.until(`!!d()?.querySelector('.mu-report .mu-skip')`, 'the skipped tile');
  assert.equal(await remembered.value<string>(`d().querySelector('.mu-skip').textContent`), 'Skippedsign-in, rememberedOpened straight on the account');
  assert.equal(await remembered.value<number>(`d().querySelectorAll('.mu-blurred').length`), 0, 'no gap, nothing blurred');
  assert.equal(await remembered.value<number>(`d().querySelectorAll('.mu-play').length`), 0, 'native controls: no button of its own');
  assert.deepEqual(await remembered.value(`[d().querySelector('.mu-video').hasAttribute('controls'), (d().querySelector('.mu-video').getAttribute('src') || '').includes('#')]`), [true, false], 'no gap: the native controls stay, nothing to fence off');
});

test('in Chrome: without &visual the Muse layout draws no report', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { height: 900, edit: (dir) => browserRun(dir) });
  await until(`!!d()?.querySelector('.mu-memory .mu-rh')`, 'the page drawn');
  assert.equal(await value<number>(`d().querySelectorAll('.mu-report, .mu-video, .mu-blurred').length`), 0);
});

test('chapters: one per distinct page visit; two that land at the same place in the video are the later page', async (t) => {
  const { recording } = openedRun(t, { mergeRead: true });
  assert.deepEqual((await visualOf(recording))!.chapters.map((chapter) => chapter.title), ['Bill March 2026', 'Your bills'], 'Account summary, opened and left within the same moment, is no chapter, and Sign in (read inside the blurred span) has no seek point');
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

test('in Chrome: a blank frame and a picture shown twice are no tiles of the strip of screenshots; a wide window breaks the report out of the chat column, three facts across', IN_CHROME, async (t) => {
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

test('in Chrome: a blank frame is no tile even when it is a sign-in frame (judged on its original pixels), and a near-identical frame of the same page is no second tile while another page\'s is', IN_CHROME, async (t) => {
  // The frame at 500 is blank and blurred; 2700 is the page of 2500 with one pixel lit (a different hash, the same page); 4000 is another page.
  const { value, until } = await served(t, { query: '&muse&visual', height: 900, edit: (dir) => browserRun(dir, { blankAt: 500, nearAt: { 2700: 2500 } }) });
  await until(`!!d()?.querySelector('.mu-report .mu-shot-tile')`, 'the report drawn');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(await value(`[...d().querySelectorAll('.mu-shot-tile')].map((tile) => tile.querySelector('.mu-cap').textContent)`), ['Sign-in (blurred)', 'Account summary', 'Your bills'], 'one blurred sign-in (the blank one is gone), one Account summary, one Your bills');
});

test('a look\'s box that does not fit its frame is clamped into it, or dropped for the whole frame when nothing of it is left', async (t) => {
  const { recording } = openedRun(t, { facts: (known) => [
    { fact: 'below', claim: 'c', frame: known[2500], box: { x: 0, y: 500, w: 600, h: 20 }, label: 'l' },
    { fact: 'flat', claim: 'c', frame: known[2500], box: { x: 10, y: 10, w: 0, h: 20 }, label: 'l' },
    { fact: 'edge', claim: 'c', frame: known[2500], box: { x: 700, y: 300, w: 300, h: 100 }, label: 'l' },
    { fact: 'negative', claim: 'c', frame: known[2500], box: { x: -50, y: 10, w: 80, h: 20 }, label: 'l' },
  ] });
  assert.deepEqual((await visualOf(recording))!.facts.map((fact) => [fact.fact, fact.box]), [['below', null], ['flat', null], ['edge', { x: 700, y: 300, w: 100, h: 53 }], ['negative', { x: 0, y: 10, w: 30, h: 20 }]], 'no invalid crop can be drawn');
});

test('with more than one browser session the report has one video of the first, and no chapter that could seek into the wrong session', async (t) => {
  const { recording } = openedRun(t, { secondSession: true });
  const visual = (await visualOf(recording))!;
  assert.ok(visual.video, 'the first track\'s video');
  assert.deepEqual(visual.chapters, [], 'chapters are tied to one session\'s clock: with two there is no honest place to seek');
});

test('in Chrome: the video plays only from the end of the blurred span, whatever the page does: nothing earlier is ever the current time, it loops back to the span\'s end, and a chapter seeks to its own frame', IN_CHROME, async (t) => {
  const { value, until } = await served(t, { query: '&muse&visual', height: 900, edit: (dir) => browserRun(dir) });
  await until(`!!d()?.querySelector('.mu-video')`, 'the report drawn');
  // Watch the current time for 5 s: a 4 s film whose first 2 s are the blurred span.
  await value(`(() => { const v = d().querySelector('.mu-video'); window.__seen = []; setInterval(() => window.__seen.push(v.currentTime), 40); return 0; })()`);
  await new Promise((resolve) => setTimeout(resolve, 5200));
  const seen = await value<number[]>(`window.__seen`);
  assert.ok(Math.max(...seen) >= 3, `it played (max ${Math.max(...seen)})`);
  assert.ok(Math.min(...seen) >= 1.95, `nothing before the span's end was ever the current time (min ${Math.min(...seen)})`);
  assert.ok(seen.some((time, i) => i > 0 && seen[i - 1]! >= 3.4 && time <= 2.6), 'it looped back to the start of what is kept');
  // No native controls here, so a button of its own pauses and plays (the scrub bar is what is withheld); a video with native controls has none.
  assert.deepEqual(await value(`[d().querySelectorAll('.mu-play').length, d().querySelector('.mu-play')?.textContent ?? null]`), [1, 'Pause'], 'one pause button');
  await value(`(() => { d().querySelector('.mu-play').click(); return 0; })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const frozen = await value<number[]>(`(() => { const v = d().querySelector('.mu-video'); const a = v.currentTime; return [v.paused ? 1 : 0, a]; })()`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual([frozen[0], await value<number>(`d().querySelector('.mu-video').currentTime`) === frozen[1] ? 1 : 0, await value<string>(`d().querySelector('.mu-play').textContent`)], [1, 1, 'Play'], 'paused, and it stays where it is');
  await value(`(() => { d().querySelector('.mu-play').click(); return 0; })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await value<boolean>(`!d().querySelector('.mu-video').paused`), true, 'and plays again');
  await value(`(() => { d().querySelector('.mu-chapter').click(); return 0; })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const at = await value<number>(`d().querySelector('.mu-video').currentTime`);
  assert.ok(at >= 2.1 && at <= 3.0, `the first chapter seeks to its own frame (at ${at})`);
});

test('fail closed by picture: a sign-in picture that comes back after the gap (a re-login\'s empty form) is blurred wherever it shows, and a video that would show it sharp is no video', async (t) => {
  // The frame at 2700 is the very picture of the sign-in frame at 500 (the same blob), taken after the credential gap had ended.
  const { recording, frames } = openedRun(t, { sameAs: { 2700: 500 } });
  const visual = (await visualOf(recording))!;
  assert.equal(frames[2700], frames[500], 'the same picture');
  assert.deepEqual(visual.frames.map((frame) => [frame.t, frame.sensitive]), [[500, true], [1500, true], [2500, false], [2700, true], [4000, false]], 'blurred by picture too, not by time alone');
  assert.equal(visual.video, undefined, 'the track would show that picture sharp after the span: no video at all');
  assert.deepEqual(visual.chapters, [], 'and no chapter seeks into it');
  assert.equal(visual.frames.find((frame) => !frame.sensitive)!.blob, frames[2500], 'the first frame that is not blurred is still a different picture');
});

test('a chapter seeks to the frame it was read on by its time, not to the last appearance of that picture: the same picture kept at several times keeps each chapter at its own', async (t) => {
  // The frame at 4000 is the very picture of the frame at 2500; a page read at 2600 was on the first, so its chapter is at that frame's place (2.0 s), not at 3.5 s.
  const { recording } = openedRun(t, { sameAs: { 4000: 2500 }, reads: [[2600, 'Early page'], [4200, 'Late page']], onlyReads: true });
  const chapters = (await visualOf(recording))!.chapters.map((chapter) => [chapter.title, chapter.at]);
  assert.deepEqual(chapters, [['Early page', 2], ['Late page', 3.5]], 'each at its own frame, in order (by the picture alone the early one would sit at the picture\'s last time, 3.5 s, on top of the late one)');
});
