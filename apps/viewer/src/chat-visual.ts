// The visual report of a browser run (`chat.html?r=<id>&muse&visual`): what the run's own browser showed, put where the answer is. The recording's browser video
// front and centre (muted, looped, its waits skipped, with a chapter strip that seeks it), the screenshots as a strip of screenshots under their page titles, the files the
// agent's artifact holds as first-page thumbnails, a tile for a sign-in memory skipped, and each fact of the answer as the crop where it was read, boxed only by a look
// that recorded a box. Everything is read from the recording's own lines and blobs: nothing here knows a site, an agent or a run.
//
// One safety rule, generic: a session that had a credential on its page (`frame.gap`, reason `credential_on_page`) has every frame from its first up to the gap's
// end BLURRED (pixels, not styling; never enlarged), and the video's playback skips that span. A run with no such gap blurs nothing.
import type { ChatModel } from './chat-model.ts';
import { reportEl } from './chat-report.ts';
import type { Json, Recording } from './format.ts';
import { pdfDrawer } from './pdf.ts';

/** One screenshot of the run: when it was taken, the picture's blob, its size, the page it showed (by the next page read), and whether it is blurred. */
export type VisualFrame = { t: number; blob: string; w: number; h: number; session: string; title?: string; sensitive: boolean };
/** A page the run read, as a place in the video (`at`, seconds, never inside a skipped span: a page read while only a blurred frame was on screen has no place, so it is no chapter). */
export type VisualChapter = { title: string; t: number; at: number };
/** One fact of the answer and the look that boxed it, as the recording's `manifest.facts` blob says. `box` is in the frame's own pixels, null where the look found none. */
export type VisualFact = { fact: string; claim: string; frame: string; box: { x: number; y: number; w: number; h: number } | null; label: string; why?: string; inferred?: boolean; receipt?: { sha256?: string; model?: string; usd?: number } };
export type Visual = {
  /** `skipEnd`: seconds of the video's start that are never shown (the blurred span is always its prefix: one track per session, blurred from the session's first frame). */
  video?: { blob: string; poster?: string; duration: number; skipEnd: number; segments: [number, number][] };
  frames: VisualFrame[];
  chapters: VisualChapter[];
  files: { name: string; sha: string }[];
  facts: VisualFact[];
};

const obj = (value: Json | undefined): Record<string, Json> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : undefined);
const list = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);
const str = (value: Json | undefined): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: Json | undefined): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A held frame plays this long in the video, however long the run held it (the waits are skipped). */
const HOLD_MS = 1500;
/** A frame at or before a gap's start was taken before it; the first one after is the gap's end. */
const GAP_SLACK_MS = 100;
/** Chapters closer than this in the video are one visit. */
const MERGE_S = 0.75;
/** Air around a boxed fact in its crop, in the frame's own pixels, and what the drawn box stands out by (the look's box is a little tight on its word at times). */
const CROP_PAD = 24;
const BOX_PAD = 4;

/** The page a read result names: a snapshot's `RootWebArea: <title>` or a read's `title: <title>` line. */
const titleOf = (text: string): string | undefined => {
  const found = /^\s*\[[^\]]*\]\s*RootWebArea:\s*(.+)$/m.exec(text) ?? /^title:\s*(.+)$/m.exec(text);
  return found?.[1]?.trim().slice(0, 60) || undefined;
};

/** A blob's JSON. An embedded recording keeps its blobs as data: URLs, which a host's `connect-src 'self'` will not let a fetch() read, so those are decoded here. */
async function blobJson(recording: Recording, sha: string): Promise<Json | undefined> {
  const url = recording.blobUrl(sha);
  if (!url) return undefined;
  try {
    const data = /^data:[^,]*?(;base64)?,/.exec(url);
    if (data) {
      const body = url.slice(data[0].length);
      return JSON.parse(data[1] ? new TextDecoder().decode(Uint8Array.from(atob(body), (each) => each.charCodeAt(0))) : decodeURIComponent(body)) as Json;
    }
    const response = await fetch(url);
    return response.ok ? await response.json() as Json : undefined;
  } catch { return undefined; }
}

export async function visualOf(recording: Recording): Promise<Visual | undefined> {
  const readJson = (sha: string) => blobJson(recording, sha);
  const lines = recording.lines;
  const frames: VisualFrame[] = [];
  for (const line of lines) {
    if (line.channel !== 'live' || line.kind !== 'frame') continue;
    const d = obj(line.data as Json);
    const blob = str(line.blobs?.[0] as Json | undefined);
    const session = str(d?.session) ?? '';
    if (!blob || !recording.blobUrl(blob) || num(d?.w) === undefined || num(d?.h) === undefined) continue;
    frames.push({ t: line.t, blob, w: num(d!.w)!, h: num(d!.h)!, session, sensitive: false });
  }
  frames.sort((a, b) => a.t - b.t);

  // The safety rule: per session, from its first frame to the end of a credential gap.
  const spans = new Map<string, { from: number; to: number }>();
  for (const line of lines) {
    if (line.channel !== 'live' || line.kind !== 'frame.gap') continue;
    const d = obj(line.data as Json);
    const session = str(d?.session) ?? '';
    const from = num(d?.from);
    if (d?.reason !== 'credential_on_page' || from === undefined) continue;
    const mine = frames.filter((frame) => frame.session === session);
    if (mine.length === 0) continue;
    const to = mine.find((frame) => frame.t > from + GAP_SLACK_MS)?.t ?? Infinity;
    const before = spans.get(session);
    spans.set(session, { from: Math.min(before?.from ?? Infinity, mine[0]!.t), to: Math.max(before?.to ?? 0, to) });
  }
  for (const frame of frames) { const span = spans.get(frame.session); if (span && frame.t >= span.from && frame.t < span.to) frame.sensitive = true; }
  // Fail closed BY PICTURE as well as by time: the picture of a blurred frame is blurred wherever it shows (a re-login's empty form comes back as the same picture, after the
  // gap's end), so a frame whose picture is a blurred one is blurred too.
  const blurred = new Set(frames.filter((frame) => frame.sensitive).map((frame) => frame.blob));
  for (const frame of frames) if (blurred.has(frame.blob)) frame.sensitive = true;

  // The pages the run read, in order: a chapter each time the page changes.
  const reads: { t: number; title: string }[] = [];
  for (const line of lines) {
    if (line.channel !== 'durable' || line.kind !== 'pi.tool-result') continue;
    const model = list(obj(line.data as Json)?.model)[0];
    const text = list(obj(model)?.content).map((part) => str(obj(part)?.text) ?? '').join('\n');
    const title = titleOf(text);
    if (title) reads.push({ t: line.t, title });
  }
  const pages = reads.filter((read, index) => index === 0 || read.title !== reads[index - 1]!.title);
  // A frame is the page the run read next; with no read soon after it (a click, then nothing read), the page it last read.
  for (const frame of frames) frame.title = reads.find((read) => read.t >= frame.t - 200 && read.t <= frame.t + 12_000)?.title ?? [...reads].reverse().find((read) => read.t <= frame.t)?.title ?? reads.find((read) => read.t > frame.t)?.title;

  // The browser video: the frame track's webm and its index, whose clock is the frames' own (video second = (t - from) / 1000).
  let video: Visual['video'];
  // One track per browser session: the video is the first's; with more than one, a chapter (a page read, by no session) has no honest place to seek.
  const tracks = lines.filter((line) => line.channel === 'live' && line.kind === 'frame.track');
  const track = tracks[0];
  const videoBlob = str(track?.blobs?.[0] as Json | undefined);
  const indexBlob = str(track?.blobs?.[1] as Json | undefined);
  const index = indexBlob ? obj(await readJson(indexBlob)) : undefined;
  const from = num(index?.from);
  const to = num(index?.to);
  let skipEnd = 0;
  if (videoBlob && recording.blobUrl(videoBlob) && from !== undefined && to !== undefined) {
    const held = list(index?.frames).map((each) => obj(each)).filter((each): each is Record<string, Json> => !!each && num(each.ms) !== undefined);
    const segments: [number, number][] = [];
    // The blurred span is the video's prefix (one track per session, blurred from the session's first frame): the leading held frames whose picture is a blurred one.
    // A blurred picture anywhere after it would play sharp (a video cannot be blurred in the page), so then there is no video at all.
    let prefix = true;
    let recurs = false;
    held.forEach((each, i) => {
      const start = num(each.ms)!;
      const end = i + 1 < held.length ? num(held[i + 1]!.ms)! : to - from;
      if (blurred.has(str(each.sha256) ?? '')) {
        if (prefix) skipEnd = Math.max(skipEnd, end / 1000); else recurs = true;
        return;
      }
      prefix = false;
      const playTo = start + Math.min(end - start, HOLD_MS);
      const last = segments.at(-1);
      if (last && Math.abs(last[1] * 1000 - start) < 1) last[1] = playTo / 1000; else segments.push([start / 1000, playTo / 1000]);
    });
    if (recurs) segments.length = 0;
    const poster = frames.find((frame) => !frame.sensitive)?.blob;
    if (segments.length > 0) video = { blob: videoBlob, ...(poster ? { poster } : {}), duration: (to - from) / 1000, skipEnd, segments };
  }
  // A chapter seeks to the kept frame that shows its page: the latest frame at or before the read (the page the run was looking at). A read made while only a blurred frame
  // was on screen has none, so it is no chapter; with more than one session's track there is no honest place to seek, so none either. One chapter per distinct page
  // visit: two that land on the same frame are the later page.
  // The track's held frames, each with its own time: a chapter's frame is found by its time and its picture, never by the picture alone (the recorder can keep one picture at
  // several times).
  const heldFrames = list(index?.frames).flatMap((each) => { const f = obj(each); return str(f?.sha256) && num(f?.ms) !== undefined && num(f?.t) !== undefined ? [{ sha: str(f!.sha256)!, t: num(f!.t)!, ms: num(f!.ms)! }] : []; });
  const heldAt = (frame: VisualFrame) => heldFrames.filter((held) => held.sha === frame.blob).sort((a, b) => Math.abs(a.t - frame.t) - Math.abs(b.t - frame.t))[0];
  const chapters: VisualChapter[] = [];
  for (const page of video && tracks.length === 1 ? pages : []) {
    const shown = [...frames].reverse().find((frame) => frame.t <= page.t);
    const held = shown && !shown.sensitive ? heldAt(shown) : undefined;
    if (!shown || !held) continue;
    const chapter = { title: page.title, t: page.t, at: held.ms / 1000 };
    const last = chapters.at(-1);
    if (last && chapter.at - last.at < MERGE_S) chapters[chapters.length - 1] = chapter; else chapters.push(chapter);
  }
  const manifest = obj(recording.manifest as unknown as Json);
  const files = Object.entries(obj(obj(manifest?.artifact)?.files) ?? {}).filter(([name, sha]) => /\.pdf$/i.test(name) && typeof sha === 'string').map(([name, sha]) => ({ name, sha: sha as string }));
  const facts: VisualFact[] = [];
  const factsBlob = str(obj(manifest?.facts)?.blob);
  const document = factsBlob ? obj(await readJson(factsBlob)) : undefined;
  if (document?.format === 'agentrun.facts/1') {
    for (const each of list(document.facts)) {
      const f = obj(each);
      const frame = str(f?.frame);
      const fact = str(f?.fact);
      if (!f || !fact || !frame || !frames.some((known) => known.blob === frame)) continue;
      const b = obj(f.box);
      // A box is clamped into its frame; when nothing of it is left (no area, or off the frame) it is none, and the fact shows its whole frame.
      const known = frames.find((each) => each.blob === frame)!;
      const raw = b && [b.x, b.y, b.w, b.h].every((n) => num(n) !== undefined) ? { x: Math.max(0, num(b.x)!), y: Math.max(0, num(b.y)!), right: Math.min(known.w, num(b.x)! + num(b.w)!), bottom: Math.min(known.h, num(b.y)! + num(b.h)!) } : undefined;
      const box = raw && raw.right > raw.x && raw.bottom > raw.y && num(b?.w)! > 0 && num(b?.h)! > 0 ? { x: raw.x, y: raw.y, w: raw.right - raw.x, h: raw.bottom - raw.y } : null;
      const r = obj(f.receipt);
      facts.push({ fact, claim: str(f.claim) ?? '', frame, box, label: str(f.label) ?? '', ...(str(f.why) ? { why: str(f.why)! } : {}), ...(f.inferred === true ? { inferred: true } : {}),
        ...(r ? { receipt: { ...(str(r.sha256) ? { sha256: str(r.sha256)! } : {}), ...(str(r.model) ? { model: str(r.model)! } : {}), ...(num(r.usd) !== undefined ? { usd: num(r.usd)! } : {}) } } : {}) });
    }
  }
  if (frames.length === 0 && !video && files.length === 0) return undefined;
  return { ...(video ? { video } : {}), frames, chapters, files, facts };
}

/** The part of a frame a boxed fact is shown in, in the frame's pixels: the box with CROP_PAD of air on every side (clamped to the frame, never a sliver); a box across
 *  most of the frame's width (a table row) is the whole row at full width with the lines above it, so its table header comes with it. */
export function cropOf(frame: { w: number; h: number }, box: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  if (box.w >= frame.w * 0.5) {
    const top = Math.max(0, box.y - Math.max(3 * box.h, 70));
    const bottom = Math.min(frame.h, box.y + box.h + CROP_PAD);
    return { x: 0, y: top, w: frame.w, h: bottom - top };
  }
  const w = Math.min(frame.w, Math.max(box.w + 2 * CROP_PAD, 240));
  const h = Math.min(frame.h, Math.max(box.h + 2 * CROP_PAD, 110));
  return { x: Math.max(0, Math.min(frame.w - w, box.x + box.w / 2 - w / 2)), y: Math.max(0, Math.min(frame.h - h, box.y + box.h / 2 - h / 2)), w, h };
}

/** A rectangle in a frame as the percentages of a crop it sits at, grown by `grow` pixels each way. */
const placed = (box: { x: number; y: number; w: number; h: number }, crop: { x: number; y: number; w: number; h: number }, grow = 0) =>
  `left:${((box.x - grow - crop.x) / crop.w) * 100}%;top:${((box.y - grow - crop.y) / crop.h) * 100}%;width:${((box.w + 2 * grow) / crop.w) * 100}%;height:${((box.h + 2 * grow) / crop.h) * 100}%`;

/** A picture drawn blurred, as pixels: the sharp picture is never put on screen. */
export function blurredCanvas(url: string, w: number, h: number): HTMLCanvasElement {
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.className = 'mu-blurred';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'A page with a sign-in on it, blurred');
  const image = new Image();
  image.onload = () => {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.filter = 'blur(14px)';
    // Drawn over a margin so the blur's edge does not show.
    context.drawImage(image, -24, -24, w + 48, h + 48);
  };
  image.src = url;
  return canvas;
}

/** The full frame, enlarged, over the page: a click or Escape closes it. A blurred frame is never enlarged. */
function lightbox(host: HTMLElement, url: string, alt: string, box?: VisualFact['box'], size?: { w: number; h: number }): void {
  const overlay = reportEl('div', { class: 'mu-lightbox', role: 'dialog', 'aria-label': alt });
  const stage = reportEl('div', { class: 'mu-lb-stage' }, reportEl('img', { src: url, alt }));
  if (box && size) stage.append(styled(reportEl('span', { class: 'mu-box' }), placed(box, { x: 0, y: 0, w: size.w, h: size.h }, BOX_PAD)));
  overlay.append(stage);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  host.append(overlay);
}

/** Sets an element's style through the CSSOM: a host whose policy allows no inline style still lets this. */
const styled = <T extends HTMLElement>(element: T, cssText: string): T => { element.style.cssText = cssText; return element; };

/** A frame's original pixels, sampled on a small grid and never put on screen (loaded off the page): whether it is one flat colour, within a few levels, and its
 *  grey values for comparing it with another frame of the same page. */
function pixelsOf(url: string): Promise<{ blank: boolean; grey: number[] } | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onerror = () => resolve(undefined);
    image.onload = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 32, height: 16 });
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || !image.naturalWidth) { resolve(undefined); return; }
      context.drawImage(image, 0, 0, 32, 16);
      const data = context.getImageData(0, 0, 32, 16).data;
      const low = [255, 255, 255];
      const high = [0, 0, 0];
      const grey: number[] = [];
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c += 1) { low[c] = Math.min(low[c]!, data[i + c]!); high[c] = Math.max(high[c]!, data[i + c]!); }
        grey.push((data[i]! + data[i + 1]! + data[i + 2]!) / 3);
      }
      resolve({ blank: high.every((value, c) => value - low[c]! < 12), grey });
    };
    image.src = url;
  });
}
/** Two frames are one picture when their grey grids differ by this little on average (a button lit, a hover), out of 255. */
const SAME_PAGE_DIFF = 6;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** The report: video and chapters, the sign-in that was skipped, the strip of screenshots, the files, the facts. */
export function drawVisual(visual: Visual, model: ChatModel, recording: Recording, host: HTMLElement): HTMLElement {
  const report = reportEl('section', { class: 'mu-report', 'aria-label': 'What the browser showed' }, reportEl('div', { class: 'mu-rep-title', text: 'What the browser showed' }));
  const urlOf = (sha: string) => recording.blobUrl(sha) ?? '';

  if (visual.video) {
    const { blob, poster, segments, duration, skipEnd } = visual.video;
    const first = segments[0]![0];
    // Fail closed: with a span that is never shown (a credential on its page), the video has NO native controls, so no scrub bar can drag into it ahead of the page's own jump,
    // and it starts at the span's end (a media fragment). The only things that move it are the chapters and the loop, and each goes to a kept segment's start.
    const video = reportEl('video', { class: 'mu-video', muted: '', playsinline: '', preload: 'auto', ...(skipEnd > 0 ? {} : { controls: '' }), 'aria-label': 'The run\'s browser, as recorded', ...(poster ? { poster: urlOf(poster) } : {}), src: skipEnd > 0 ? `${urlOf(blob)}#t=${first}` : urlOf(blob) }) as HTMLVideoElement;
    video.muted = true;
    // Playback runs only the kept segments: a wait, and any span with a credential on the page, are jumped over; at the end it starts again.
    const next = () => {
      const now = video.currentTime;
      const here = segments.findIndex(([start, end]) => now >= start - 0.05 && now < end);
      if (here >= 0) return;
      const after = segments.find(([start]) => start > now);
      video.currentTime = (after ?? segments[0]!)[0];
    };
    video.addEventListener('timeupdate', next);
    video.addEventListener('ended', () => { video.currentTime = first; void video.play().catch(() => undefined); });
    video.addEventListener('loadedmetadata', () => { video.currentTime = first; });
    video.addEventListener('seeked', () => { video.dataset.ready = 'true'; });
    const chapters = visual.chapters.length > 0 && reportEl('div', { class: 'mu-chapters', role: 'group', 'aria-label': 'Chapters' }, ...visual.chapters.map((chapter) => {
      const button = reportEl('button', { class: 'mu-chapter', type: 'button', title: `${chapter.title} · ${clock(chapter.at)}` },
        reportEl('span', { class: 'mu-ch-title', text: chapter.title }), reportEl('span', { class: 'mu-ch-time', text: clock(chapter.at) }));
      button.addEventListener('click', () => { video.currentTime = chapter.at; void video.play().catch(() => undefined); });
      return button;
    }));
    // With no native controls (the scrub bar is what is withheld), a button of its own pauses and plays: playback only ever goes to kept segments.
    const play = skipEnd > 0 ? reportEl('button', { class: 'mu-play', type: 'button', 'aria-label': 'Pause the browser video', text: 'Pause' }) : undefined;
    if (play) {
      play.addEventListener('click', () => { if (video.paused) void video.play().catch(() => undefined); else video.pause(); });
      video.addEventListener('play', () => { play.textContent = 'Pause'; play.setAttribute('aria-label', 'Pause the browser video'); });
      video.addEventListener('pause', () => { play.textContent = 'Play'; play.setAttribute('aria-label', 'Play the browser video'); });
    }
    report.append(reportEl('div', { class: 'mu-stage' }, video, ...(play ? [play] : []), reportEl('div', { class: 'mu-stage-note', text: `Frames the recorder kept · waits skipped${segments.length > 1 ? ` (${clock(duration)} of browsing in ${clock(segments.reduce((sum, [a, b]) => sum + (b - a), 0))})` : ''}` })), ...(chapters ? [chapters] : []));
    // Autoplay muted once it can; a page that forbids it stays paused on its poster.
    video.addEventListener('canplay', () => { void video.play().catch(() => undefined); }, { once: true });
  }

  const remembered = (model.waits ?? []).some((wait) => wait.remembered);
  if (visual.frames.length > 0 || remembered) {
    const strip = reportEl('div', { class: 'mu-frames', role: 'list', 'aria-label': 'Screenshots, in order' });
    if (remembered) strip.append(reportEl('div', { class: 'mu-skip', role: 'listitem' }, reportEl('div', { class: 'mu-skip-body' }, reportEl('span', { class: 'mu-skip-title', text: 'Skipped' }), reportEl('span', { class: 'mu-skip-sub', text: 'sign-in, remembered' })), reportEl('div', { class: 'mu-cap', text: 'Opened straight on the account' })));
    const seen = new Set<string>();
    const tiles: { tile: HTMLElement; frame: VisualFrame }[] = [];
    for (const frame of visual.frames) {
      // The same picture twice is one tile.
      if (seen.has(frame.blob)) continue;
      seen.add(frame.blob);
      const url = urlOf(frame.blob);
      const picture = frame.sensitive ? blurredCanvas(url, frame.w, frame.h) : reportEl('img', { loading: 'lazy', src: url, alt: frame.title ? `The browser on ${frame.title}` : 'The browser' });
      const tile = reportEl('figure', { class: `mu-shot-tile${frame.sensitive ? ' blurred' : ''}`, role: 'listitem' }, styled(reportEl('div', { class: 'mu-tile-pic' }, picture), `aspect-ratio:${frame.w}/${frame.h}`), reportEl('figcaption', { class: 'mu-cap', text: frame.sensitive ? 'Sign-in (blurred)' : frame.title ?? clock((frame.t - (visual.frames[0]?.t ?? frame.t)) / 1000) }));
      if (!frame.sensitive) { tile.tabIndex = 0; tile.addEventListener('click', () => lightbox(host, url, frame.title ?? 'The browser')); tile.addEventListener('keydown', (event) => { if (event.key === 'Enter') lightbox(host, url, frame.title ?? 'The browser'); }); }
      strip.append(tile);
      tiles.push({ tile, frame });
    }
    // Each frame is judged on its original pixels, sharp or blurred on screen: a blank one (a page not yet drawn) is no tile, and neither is a frame near-identical to an
    // earlier tile of the same page (the page, by its title, and a small pixel difference: not the hash alone); one tile per distinct page.
    void Promise.all(tiles.map(({ frame }) => pixelsOf(urlOf(frame.blob)))).then((all) => {
      const kept: { title?: string; grey: number[] }[] = [];
      tiles.forEach(({ tile, frame }, i) => {
        const pixels = all[i];
        if (!pixels) return;
        if (pixels.blank) { tile.remove(); return; }
        const same = kept.some((each) => frame.title !== undefined && each.title === frame.title && each.grey.reduce((sum, value, k) => sum + Math.abs(value - pixels.grey[k]!), 0) / each.grey.length < SAME_PAGE_DIFF);
        if (same) tile.remove(); else kept.push({ ...(frame.title !== undefined ? { title: frame.title } : {}), grey: pixels.grey });
      });
    });
    report.append(strip);
  }

  if (visual.files.length > 0) {
    const draw = pdfDrawer(recording, () => place());
    const row = reportEl('div', { class: 'mu-docs' });
    const slots = visual.files.map((file) => {
      const pic = reportEl('div', { class: 'mu-doc-pic' }, reportEl('span', { class: 'mu-doc-wait', text: 'Reading…' }));
      row.append(reportEl('figure', { class: 'mu-doc' }, pic, reportEl('figcaption', { class: 'mu-cap', text: file.name })));
      return { file, pic };
    });
    function place() {
      for (const { file, pic } of slots) {
        const page = draw(file.sha, 1);
        if (page.kind === 'drawn' && !pic.querySelector('img')) pic.replaceChildren(reportEl('img', { src: page.url, alt: `The first page of ${file.name}`, width: String(page.w), height: String(page.h) }));
        else if (page.kind === 'failed') pic.replaceChildren(reportEl('span', { class: 'mu-doc-wait', text: 'Not shown here' }));
      }
    }
    report.append(row);
    place();
  }

  if (visual.facts.length > 0) {
    const facts = reportEl('div', { class: 'mu-facts' });
    for (const fact of visual.facts) {
      const frame = visual.frames.find((each) => each.blob === fact.frame)!;
      const url = urlOf(fact.frame);
      const pic = reportEl('div', { class: 'mu-crop' });
      // A crop of the frame around the box (with some page around it); no box, the whole frame, said so.
      if (frame.sensitive) pic.append(blurredCanvas(url, frame.w, frame.h));
      else if (fact.box) {
        const crop = cropOf(frame, fact.box);
        pic.style.cssText = `aspect-ratio:${crop.w}/${crop.h}`;
        pic.append(styled(reportEl('img', { src: url, alt: fact.claim || fact.fact }), `position:absolute;width:${(frame.w / crop.w) * 100}%;max-width:none;height:auto;left:${-(crop.x / crop.w) * 100}%;top:${-(crop.y / crop.h) * 100}%`),
          styled(reportEl('span', { class: 'mu-box' }), placed(fact.box, crop, BOX_PAD)));
      } else pic.append(reportEl('img', { class: 'mu-whole', src: url, alt: fact.claim || fact.fact }));
      if (!frame.sensitive) {
        // A control for the pointer and the keyboard alike.
        const open = () => lightbox(host, url, fact.claim || fact.fact, fact.box, { w: frame.w, h: frame.h });
        pic.setAttribute('role', 'button');
        pic.setAttribute('aria-label', `Enlarge the picture for ${fact.claim || fact.fact}`);
        pic.tabIndex = 0;
        pic.addEventListener('click', open);
        pic.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      }
      facts.append(reportEl('figure', { class: `mu-fact${fact.box && !frame.sensitive && fact.box.w >= frame.w * 0.5 ? ' wide' : ''}` }, pic, reportEl('figcaption', fact.receipt ? { title: [fact.receipt.model, fact.receipt.usd !== undefined ? `$${fact.receipt.usd}` : ''].filter((each) => each !== '').join(' · ') } : {}, reportEl('span', { class: 'mu-fact-value', text: fact.fact }), reportEl('span', { class: 'mu-cap', text: [fact.claim, fact.label].filter((each) => each !== '').join(' · ') }), fact.inferred ? reportEl('span', { class: 'mu-cap', text: 'The page shows the evidence, not the conclusion: this is the agent\'s own flag.' }) : false, fact.why && !fact.box ? reportEl('span', { class: 'mu-cap', text: fact.why }) : false)));
    }
    report.append(facts);
  }
  return report;
}
