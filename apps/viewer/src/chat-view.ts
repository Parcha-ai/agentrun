// The chat page's body: the run's recorded conversations on the left (the first open, the rest folded), each message as
// recorded, the thinking its own model wrote and one card per tool call; the session timeline under the title; and on
// the right the report (chat-report.ts) or the source a citation or a card points at, its region drawn from an address
// alone. On a phone the right side is a bottom sheet.
import type { ChatCall, ChatDecision, ChatItem, ChatModel, ChatSource, ChatSpan, ChatThread } from './chat-model.ts';
import type { Recording } from './format.ts';
import { drawReport, reportCiteLabel, reportClock, reportEl, reportFragmentOf, reportHeldFile, reportHowHref, reportInline, reportParagraphs } from './chat-report.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type SourceKind = 'page' | 'image' | 'video' | 'other';

const THREAD_ICONS: Record<string, string> = {
  page: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 13h3"/></svg>',
  image: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11"/><circle cx="5.5" cy="6.5" r="1.3"/><path d="M1.5 12l4-4 3 3 2-2 4 4"/></svg>',
  video: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11"/><path d="M4.5 2.5v11M11.5 2.5v11M1.5 5.5h3M1.5 8h3M1.5 10.5h3M11.5 5.5h3M11.5 8h3M11.5 10.5h3"/></svg>',
  other: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11"/><path d="M4 6l2.5 2L4 10M8 10.5h4"/></svg>',
  doc: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#ff8700" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5"/></svg>',
  brand: '<svg width="18" height="18" viewBox="0 0 64 64"><path d="M18 12L42 32L18 52" fill="none" stroke="#ff8700" stroke-width="8" stroke-linecap="square"/></svg>',
};
const SOURCE_KIND: Record<SourceKind, string> = { page: 'Page', image: 'Image', video: 'Video', other: 'Tool call' };
const SOURCE_SAID: Record<SourceKind, string> = { page: 'Read on the page', image: 'Seen in the image', video: 'Seen in the video', other: 'Found' };
/** How many lines, or characters, of a long message show before "Show the whole message". */
const THREAD_LINES = 8;
const THREAD_CHARS = 600;
/** How many of a step's looks show before "+ N more" (its decisive ones always show). */
const THREAD_SHOWN = 3;

const threadIcon = (name: string): Element => {
  const holder = document.createElement('template');
  holder.innerHTML = THREAD_ICONS[name] ?? THREAD_ICONS.other!;
  return holder.content.firstElementChild!;
};

/** What an address reads, from the address alone: a page of a document, a window of a video, an image, or another thing. */
export function sourceKindOf(href: string): SourceKind {
  const file = href.split('#')[0]!;
  const at = reportFragmentOf(href);
  if (at.has('page')) return 'page';
  if (at.has('t') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file)) return 'video';
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file)) return 'image';
  return 'other';
}

/** Whether a blob is a video, by its type; a type the recording does not say is drawn as a picture. */
const sourceIsVideo = (recording: Recording, sha: string) => /^video\//.test(recording.blobType(sha) ?? '');

/** A cited time (#t=a or #t=a,b) belongs to the look whose window holds its start. */
export function sourceWithin(cited: string, window: string | null): boolean {
  if (!window) return false;
  const at = parseFloat(cited);
  const [from, to] = window.split(',').map(parseFloat) as [number, number | undefined];
  return at === from || (at >= from && at < (to === undefined || Number.isNaN(to) ? from : to));
}

/** Every address a look read: the one it opens at, then the rest, in order. */
export const sourceAddresses = (source: ChatSource) => [source.href, ...(source.more ?? [])];

/** The look a citation's address names: one that read that exact address, else one that read the same file at the cited
 *  page or over a window holding the cited second. */
export function sourceByHref(sources: Record<string, ChatSource>, href: string): string | undefined {
  const entries = Object.entries(sources);
  return (entries.find(([, source]) => sourceAddresses(source).includes(href)) ?? entries.find(([, source]) => sourceAddresses(source).some((address) => sourceHolds(address, href))))?.[0];
}

/** Whether an address a look read holds a cited one: the same file, at the cited page, over a window holding the cited
 *  second. */
export function sourceHolds(address: string, cited: string): boolean {
  if (address.split('#')[0] !== cited.split('#')[0]) return false;
  const own = reportFragmentOf(address);
  const at = reportFragmentOf(cited);
  const page = at.get('page');
  const t = at.get('t');
  return (!page || own.get('page') === page) && (!t || sourceWithin(t, own.get('t')));
}

/** The look that shows page N of the cited file by itself (its address is exactly file#page=N, with one medium). */
export function sourcePageOf(sources: Record<string, ChatSource>, href: string): ChatSource | undefined {
  const file = href.split('#')[0];
  const page = reportFragmentOf(href).get('page');
  return page ? Object.values(sources).find((source) => source.href === `${file}#page=${page}` && source.media.length === 1) : undefined;
}

export type SourceRegion = { href: string; unit: 'percent' | 'pixel'; x: number; y: number; w: number; h: number; t?: number; label?: string };

/** A region in its source's own addressing: #page=N&xywh=percent:x,y,w,h, #xywh=x,y,w,h (pixels), and #t=a&xywh=... on
 *  the video's frame at second a. None when the address carries no xywh. */
export function sourceRegionOf(href: string, label?: string): SourceRegion | undefined {
  const at = reportFragmentOf(href);
  const match = /^(?:(percent|pixel):)?([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(at.get('xywh') ?? '');
  if (!match) return undefined;
  const t = at.get('t');
  const named = at.get('label') ?? label;
  return { href, unit: (match[1] as 'percent' | 'pixel' | undefined) ?? 'pixel', x: +match[2]!, y: +match[3]!, w: +match[4]!, h: +match[5]!,
    ...(t !== null && Number.isFinite(parseFloat(t)) ? { t: parseFloat(t) } : {}), ...(named ? { label: named } : {}) };
}

/** Which of a video look's frames shows second `t`: its window (#t=from,to in its own address) cut evenly by its frames. */
export function sourceFrameAt(href: string, frames: number, t: number | undefined): number {
  const [from, to] = (reportFragmentOf(href).get('t') ?? '').split(',').map(parseFloat) as [number, number | undefined];
  if (t === undefined || frames === 0 || !Number.isFinite(from) || to === undefined || !Number.isFinite(to) || to <= from) return 0;
  return Math.max(0, Math.min(frames - 1, Math.floor((t - from) / ((to - from) / frames))));
}

/** A region's box over a medium: a percent box at once, a pixel box once the picture's natural size is known. */
function sourceBox(region: SourceRegion, picture: HTMLImageElement): HTMLElement {
  const box = reportEl('div', { class: 'jbox' }, reportEl('span', { text: region.label ?? 'cited here' }));
  const place = (x: number, y: number, w: number, h: number) => Object.assign(box.style, { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` });
  if (region.unit === 'percent') place(region.x, region.y, region.w, region.h);
  else {
    box.hidden = true;
    const put = () => {
      if (!picture.naturalWidth || !picture.naturalHeight) return;
      place(region.x / picture.naturalWidth * 100, region.y / picture.naturalHeight * 100, region.w / picture.naturalWidth * 100, region.h / picture.naturalHeight * 100);
      box.hidden = false;
    };
    if (picture.complete) put(); else picture.addEventListener('load', put, { once: true });
  }
  return box;
}

/** One medium in a frame of its own, with the boxes of `regions` over it. */
function sourceMedium(recording: Recording, sha: string, alt: string, regions: SourceRegion[] = [], className = ''): HTMLElement | undefined {
  const url = recording.blobUrl(sha);
  if (!url) return undefined;
  if (sourceIsVideo(recording, sha)) return reportEl('div', { class: `media ${className}` }, reportEl('video', { src: url, controls: true, muted: true, playsinline: true, preload: 'metadata' }));
  const picture = reportEl('img', { loading: 'lazy', decoding: 'async', src: url, alt });
  return reportEl('div', { class: `media ${className}` }, picture, ...regions.map((region) => sourceBox(region, picture)));
}

/** What a look's decisions said, in words: a yes or a no, or the choice. */
const sourceDecisions = (source: ChatSource) => source.decisions.map((each) => `${each.name.replace(/_/g, ' ')}: ${each.kind === 'noul' ? (each.score >= 0.5 ? 'yes' : 'no') : each.choice}`);

/** Regions no picture carries, listed: each label with its address. */
/** The addresses shown, one a line; each opens in a tab at its page or second when the agent's page holds its file. */
function sourceAddressList(model: ChatModel, recording: Recording, addresses: string[]): HTMLElement {
  return reportEl('div', { class: 'addrs' }, ...addresses.map((address) => {
    const line = reportEl('a', { class: 'addr', text: address });
    const at = reportFragmentOf(address);
    const page = at.get('page');
    const t = at.get('t');
    void reportHeldFile(model, recording, address.split('#')[0]!).then((url) => {
      if (!url) return;
      Object.assign(line, { href: page ? `${url}#page=${encodeURIComponent(page)}` : t ? `${url}#t=${encodeURIComponent(t)}` : url, target: '_blank', rel: 'noopener', title: page ? `Open page ${page}` : 'Open the file' });
    });
    return line;
  }));
}

/** The picture a region is drawn on, among a look's pictures: the one whose address holds it; of several, the cited one
 *  when it is among them, else the first of them; of none, the cited one. */
export function sourcePictureFor<P extends { href: string }>(pictures: readonly P[], cited: P, region: string): P {
  const holders = pictures.filter((picture) => sourceHolds(picture.href, region));
  if (holders.length === 1) return holders[0]!;
  if (holders.length > 1) return holders.includes(cited) ? cited : holders[0]!;
  return cited;
}

const sourceRegionList = (regions: SourceRegion[]) => reportEl('ul', { class: 'regions' },
  ...regions.map((region) => reportEl('li', {}, reportEl('b', { text: region.label ?? 'cited here' }), reportEl('span', { text: region.href }))));

export type SourceShown = { look?: string; item?: ToolItem; href: string; regions: SourceRegion[]; picture?: { blob: string; label?: string } };

/** What a citation or a card points at: what was found, then the medium with the regions given and no other. A page
 *  address shows that page's own picture, whichever look cites it. */
/** A call's whole command: shown under what it found, or folded under its look's own view so the picture stays first. */
function sourceCommand(detail: string, folded: boolean): HTMLElement {
  const text = reportEl('pre', { text: detail });
  return folded ? reportEl('details', { class: 'command' }, reportEl('summary', { text: 'Command' }), text)
    : reportEl('div', { class: 'command' }, reportEl('div', { class: 'kind', text: 'Command' }), text);
}

function sourceView(recording: Recording, model: ChatModel, shown: SourceShown, back: () => void, pick: (look: string) => void): HTMLElement {
  const pane = sourceViewOf(recording, model, shown, back, pick);
  if (shown.item?.detail && shown.look && model.sources[shown.look]) pane.append(sourceCommand(shown.item.detail, true));
  return pane;
}

function sourceViewOf(recording: Recording, model: ChatModel, shown: SourceShown, back: () => void, pick: (look: string) => void): HTMLElement {
  const source = shown.look ? model.sources[shown.look] : undefined;
  // The look's own address says what it read; when it names a whole file, the citation's address may say more.
  const kind = source && sourceKindOf(source.href) !== 'other' ? sourceKindOf(source.href) : sourceKindOf(shown.href);
  const backButton = reportEl('button', { class: 'back', type: 'button', text: '← Report' });
  backButton.addEventListener('click', back);
  const title = shown.item?.title ?? shown.picture?.label ?? reportCiteLabel(shown.href);
  // A look a judge made: its boxes are the judge's, drawn in its accent.
  const judged = !!shown.look && model.threads.some((thread) => thread.items.some((item) => item.kind === 'tool' && item.calls.some((call) => call.judge && call.look === shown.look)));
  const pane = reportEl('div', { class: judged ? 'pane judge' : 'pane' }, reportEl('div', { class: 'phead' }, backButton,
    reportEl('div', {}, reportEl('div', { class: 'kind', text: source ? SOURCE_KIND[kind] : shown.item ? SOURCE_KIND.other : shown.picture ? SOURCE_KIND.image : 'Source' }), reportEl('div', { class: 'ptitle', text: title }),
      shown.href !== '' && sourceAddressList(model, recording, [...new Set([shown.href, ...(source ? sourceAddresses(source) : [])])]))));
  // A picture the citation names by itself: drawn with the region its address carries.
  if (!source && !shown.item && shown.picture) {
    const medium = sourceMedium(recording, shown.picture.blob, title, shown.regions);
    if (medium) { pane.append(medium); return pane; }
  }
  if (!source && !shown.item) {
    pane.append(reportEl('div', { class: 'said' }, reportEl('p', { text: 'No look in this recording shows this address.' })));
    if (shown.regions.length) pane.append(sourceRegionList(shown.regions));
    return pane;
  }
  const said = source?.takeaway || shown.item?.takeaway || '';
  const decisions = source ? sourceDecisions(source) : [];
  if (said || decisions.length) pane.append(reportEl('div', { class: 'said' }, reportEl('div', { class: 'kind', text: source ? SOURCE_SAID[kind] : 'Result' }),
    said !== '' && reportEl('p', { text: said }), decisions.length > 0 && reportEl('ul', { class: 'decisions' }, ...decisions.map((text) => reportEl('li', { text })))));
  if (!source && shown.item?.detail) pane.append(sourceCommand(shown.item.detail, false));
  // The other looks the same call made, to switch to.
  const others = (shown.item?.looks ?? []).filter((look) => look !== shown.look && model.sources[look]);
  if (others.length) {
    pane.append(reportEl('div', { class: 'looks' }, reportEl('span', { class: 'kind', text: 'Other looks in this call' }), ...others.map((look) => {
      const button = reportEl('button', { class: 'cite', type: 'button', text: reportCiteLabel(model.sources[look]!.href) });
      button.addEventListener('click', () => pick(look));
      return button;
    })));
  }
  const media = source?.media ?? shown.item?.media ?? [];
  if (source && kind === 'video') {
    const videos = media.filter((sha) => sourceIsVideo(recording, sha));
    const frames = media.filter((sha) => !sourceIsVideo(recording, sha) && recording.blobUrl(sha));
    for (const sha of videos) pane.append(sourceMedium(recording, sha, title) ?? '');
    if (frames.length) {
      const citedT = reportFragmentOf(shown.href).get('t');
      const at = (t: number | undefined) => sourceFrameAt(source.href, frames.length, t);
      const first = at(shown.regions.find((region) => region.t !== undefined)?.t ?? (citedT !== null ? parseFloat(citedT) : undefined));
      const shownFrame = reportEl('div', { class: 'frame-shown' });
      const strip = reportEl('div', { class: 'strip' });
      const show = (index: number) => {
        // A region belongs to the frame its second names (the first frame when it names none), and to no other.
        shownFrame.replaceChildren(sourceMedium(recording, frames[index]!, `Frame ${index + 1}`, shown.regions.filter((region) => at(region.t) === index)) ?? '');
        for (const [n, button] of [...strip.children].entries()) button.setAttribute('aria-current', String(n === index));
      };
      frames.forEach((sha, index) => {
        const button = reportEl('button', { type: 'button', 'aria-label': `Frame ${index + 1}` }, reportEl('img', { loading: 'lazy', src: recording.blobUrl(sha), alt: '' }));
        button.addEventListener('click', () => show(index));
        strip.append(button);
      });
      pane.append(shownFrame, strip);
      show(first);
    } else if (shown.regions.length) pane.append(sourceRegionList(shown.regions));
    return pane;
  }
  // A look over several addresses with a picture for each: the cited address's picture first, each region on the
  // picture sourcePictureFor gives it.
  const pictures = source?.pictures;
  const cited = pictures?.find((picture) => sourceHolds(picture.href, shown.href));
  if (pictures && cited) {
    const ordered = [cited, ...pictures.filter((picture) => picture !== cited)];
    const placed = (picture: { href: string }) => shown.regions.filter((region) => sourcePictureFor(pictures, cited, region.href) === picture);
    const paper = kind === 'page' ? 'paper' : '';
    pane.append(sourceMedium(recording, cited.sha, cited.href, placed(cited), paper) ?? '');
    if (ordered.length > 1) pane.append(reportEl('div', { class: 'crops' }, ...ordered.slice(1).map((picture) => sourceMedium(recording, picture.sha, picture.href, placed(picture), paper))));
    return pane;
  }
  const page = sourcePageOf(model.sources, shown.href);
  const main = page ? page.media[0] : media[0];
  if (main) {
    const rest = media.filter((sha) => sha !== main);
    const paper = kind === 'page' || page ? 'paper' : '';
    // Without the page's own picture, a box is drawn only when there is one medium for it to sit on.
    pane.append(sourceMedium(recording, main, title, page || rest.length === 0 ? shown.regions : [], paper) ?? '');
    if (rest.length) pane.append(reportEl('div', { class: 'crops' }, ...rest.map((sha) => sourceMedium(recording, sha, '', [], paper))));
    if (!page && rest.length > 0 && shown.regions.length) pane.append(sourceRegionList(shown.regions));
  } else if (shown.regions.length) pane.append(sourceRegionList(shown.regions));
  return pane;
}

/** How many characters of a thought's first line show as its title. */
const THREAD_TITLE = 120;

/** A thinking part as its title and its body: the title is its first line (a wholly bold line without its markers, as
 *  a model's thought summary writes it, else the line, clipped); the body is the rest. A clipped title is a preview
 *  only, so its body is the whole part from that line on. */
export function threadThought(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() !== '');
  if (at < 0) return { title: '', body: '' };
  const line = lines[at]!.trim();
  const bold = /^(\*\*|__)(?=\S)(.+?\S)\1$/.exec(line);
  if (bold && !bold[2]!.includes(bold[1]!)) return { title: bold[2]!, body: lines.slice(at + 1).join('\n').trim() };
  if (line.length > THREAD_TITLE) return { title: `${line.slice(0, THREAD_TITLE - 1).trimEnd()}…`, body: lines.slice(at).join('\n').trim() };
  return { title: line, body: lines.slice(at + 1).join('\n').trim() };
}

/** A thought the provider redacted: its mark, and none of its words. */
const threadRedacted = () => reportEl('div', { class: 'thought redacted' }, reportEl('span', { class: 'thought-tag', text: 'thinking · redacted' }));

/** Thinking the run's own model wrote, in the agent's voice: its title as a line in the chat with its "thinking" tag,
 *  its body folded behind it (a thought of one line has no fold, and no chevron). */
function threadThinking(text: string): HTMLElement {
  const { title, body } = threadThought(text);
  const line = reportEl('span', { class: 'thought-title' }, ...reportInline(title));
  if (body === '') return reportEl('div', { class: 'thought' }, line, reportEl('span', { class: 'thought-tag', text: 'thinking' }));
  return reportEl('details', { class: 'thought' },
    reportEl('summary', {}, line, reportEl('span', { class: 'thought-tag', text: 'thinking' })),
    reportEl('div', { class: 'thought-body' }, ...reportParagraphs(body)));
}

/** A message from the person: its body, and past a few lines a fold with "Show the whole message". */
function threadYou(body: HTMLElement, long: boolean, id?: string): HTMLElement {
  const node = reportEl('div', { class: 'msg user', 'data-item': id }, reportEl('div', { class: 'who', text: 'You' }), body);
  if (long) {
    body.classList.add('clamped');
    const all = reportEl('button', { class: 'more', type: 'button', text: 'Show the whole message' });
    all.addEventListener('click', () => { const clamped = body.classList.toggle('clamped'); all.textContent = clamped ? 'Show the whole message' : 'Show less'; });
    node.append(all);
  }
  return node;
}

const threadLong = (text: string) => text.split('\n').length > THREAD_LINES || text.length > THREAD_CHARS;

const threadFields = (fields: { name: string; value: string }[]) => reportEl('dl', { class: 'bubble fields' }, ...fields.map((field) => reportEl('div', {}, reportEl('dt', { text: field.name }), reportEl('dd', { text: field.value }))));

/** The run's input as given, as the person's message: its question in plain words with its files as chips and its
 *  other fields behind a toggle; else its words; else its fields by name. */
function threadInput(input: NonNullable<ChatModel['input']>): HTMLElement | undefined {
  const fields = input.fields ?? [];
  const files = input.files ?? [];
  const words = input.question ?? input.text;
  if (words === undefined && !files.length) {
    return fields.length ? threadYou(threadFields(fields), fields.length > THREAD_LINES || fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) > THREAD_CHARS) : undefined;
  }
  const node = threadYou(reportEl('div', { class: input.question !== undefined ? 'bubble prose' : 'bubble', text: words ?? '' }), threadLong(words ?? ''));
  if (files.length) node.append(reportEl('div', { class: 'files' }, ...files.map((file) => reportEl('span', { class: 'file', title: file, text: file.split('/').at(-1) || file }))));
  if (fields.length) node.append(reportEl('details', { class: 'input-fields' }, reportEl('summary', { text: 'details' }), threadFields(fields)));
  return node;
}

/** The look a card opens first: the decisive one, else its first look the recording describes. */
const threadLookOf = (model: ChatModel, item: ToolItem) => item.looks.find((look) => model.sources[look]?.decisive) ?? item.looks.find((look) => model.sources[look]);

const threadPicture = (recording: Recording, media: readonly string[]) => media.find((sha) => recording.blobUrl(sha) && !sourceIsVideo(recording, sha));

/** A look's place in a few characters, from its address: its page, or the second it starts at. */
const threadAt = (href: string) => {
  const at = reportFragmentOf(href);
  const page = at.get('page');
  const t = parseFloat(at.get('t') ?? '');
  return page ? `p. ${page}` : Number.isFinite(t) ? `t ${reportClock(t)}` : href.split('#')[0]!.split('/').at(-1) || href;
};

/** Pages as runs: 1, 2, 3, 5 is "1–3, 5". */
const threadRuns = (pages: number[]) => pages.reduce<[number, number][]>((runs, page) => {
  const last = runs.at(-1);
  if (last && page === last[1] + 1) last[1] = page; else runs.push([page, page]);
  return runs;
}, []).map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(', ');

/** The place of a look over several addresses: of one file, its pages as runs or its seconds as one span; of several
 *  files, the first address's place and how many more. */
export function threadPlace(addresses: readonly string[]): string {
  if (addresses.length < 2) return threadAt(addresses[0] ?? '');
  const files = new Set(addresses.map((address) => address.split('#')[0]));
  const at = addresses.map(reportFragmentOf);
  const pages = at.map((each) => each.get('page') ?? '');
  const times = at.map((each) => (each.get('t') ?? '').split(',').map(parseFloat));
  if (files.size === 1 && pages.every((page) => /^\d+$/.test(page))) return `p. ${threadRuns(pages.map(Number))}`;
  if (files.size === 1 && times.every(([from]) => Number.isFinite(from))) {
    const from = Math.min(...times.map(([start]) => start!));
    const to = Math.max(...times.map(([start, end]) => (Number.isFinite(end) ? end! : start!)));
    return to > from ? `t ${reportClock(from)}–${reportClock(to)}` : `t ${reportClock(from)}`;
  }
  return `${threadAt(addresses[0]!)} +${addresses.length - 1}`;
}

/** A decision as a few words: a yes-or-no as its score to two places and its word, a choice as its value; named when
 *  the look made more than one. */
const threadDecision = (decision: ChatDecision, named: boolean) => {
  const name = named ? `${decision.name.replace(/_/g, ' ')} ` : '';
  return decision.kind === 'noul' ? `${name}${decision.score.toFixed(2)} ${decision.score >= 0.5 ? 'yes' : 'no'}` : `${named ? `${name.trim()}: ` : ''}${decision.choice}`;
};

/** A look's picture for its call's card (the first of its own), and the regions that picture carries. */
function threadThumb(recording: Recording, source: ChatSource): { sha: string; regions: SourceRegion[] } | undefined {
  const regions = source.regions.flatMap((region) => sourceRegionOf(region.href, region.label) ?? []);
  const first = source.pictures?.[0];
  if (first) return { sha: first.sha, regions: regions.filter((region) => sourcePictureFor(source.pictures!, first, region.href) === first) };
  const frames = source.media.filter((sha) => recording.blobUrl(sha) && !sourceIsVideo(recording, sha));
  if (!frames[0]) return undefined;
  if (sourceKindOf(source.href) === 'video') return { sha: frames[0], regions: regions.filter((region) => sourceFrameAt(source.href, frames.length, region.t) === 0) };
  return { sha: frames[0], regions: frames.length === 1 ? regions : [] };
}

/** The judge's mark at the start of a judge's label. */
const threadJudge = () => reportEl('span', { class: 'judge-chip', text: 'judge' });

/** A model call made inside a tool call, as its own card: its look's picture with that look's boxes; what it asked (a
 *  typed ask reads as the call's name); what it said (else the scores on its line); its look's place; its raw output
 *  behind a click. */
function threadCall(recording: Recording, model: ChatModel, call: ChatCall): HTMLElement {
  const found = call.look ? model.sources[call.look] : undefined;
  const thumb = found && threadThumb(recording, found);
  const addresses = found ? sourceAddresses(found) : [];
  const place = found ? threadPlace(addresses) : '';
  const scores = call.label.startsWith(call.name) ? call.label.slice(call.name.length).replace(/^\s*·\s*/, '') : call.label;
  const said = call.said ?? scores;
  return reportEl('div', { class: `call${found?.decisive ? ' decisive' : ''}${call.judge ? ' judge' : ''}`, 'data-call': call.id, 'data-look': found ? call.look : undefined, role: found ? 'button' : undefined,
    tabindex: found ? 0 : undefined, title: addresses.join(', ') || undefined, 'aria-label': [call.ask ?? call.name, said, place, addresses.join(', ')].filter(Boolean).join('; ') },
  thumb && sourceMedium(recording, thumb.sha, '', thumb.regions, 'thumb'),
  reportEl('div', { class: 'call-body' },
    reportEl('span', { class: 'call-title', title: call.label }, call.judge && threadJudge(), ...reportInline(call.ask ?? call.name)),
    said !== '' && reportEl('span', { class: 'call-said' }, ...reportInline(said)),
    place !== '' && reportEl('span', { class: 'call-at', text: place }),
    call.raw !== '' && reportEl('details', { class: 'raw' }, reportEl('summary', { text: 'Raw output' }), reportEl('pre', { text: call.raw }))));
}

/** A tool call's card: what it did, what it found, its own first picture, and under it a card per model call it made
 *  (a look it made with no call of its own reads as its place and decisions); three show, the decisive ones always,
 *  the rest behind "+ N more". `fold` gets each folded call's card with the opener of its group. */
function threadCard(recording: Recording, model: ChatModel, item: ToolItem, fold: (node: HTMLElement, open: () => void) => void, register: (id: string, node: HTMLElement) => void): HTMLElement {
  const look = threadLookOf(model, item);
  const source = look ? model.sources[look] : undefined;
  const thumb = threadPicture(recording, item.media);
  const called = new Set(item.calls.map((call) => call.look));
  const unread = item.looks.filter((each) => model.sources[each] && !called.has(each)).map((each, n): ChatCall => {
    const found = model.sources[each]!;
    const decided = found.decisions.map((decision) => threadDecision(decision, found.decisions.length > 1)).join(' · ');
    const place = threadPlace(sourceAddresses(found));
    return { id: `${item.id}:look-${n}`, name: place, label: decided ? `${place} · ${decided}` : place, raw: '', look: each, ...(decided ? { said: decided } : {}) };
  });
  const calls = [...item.calls, ...unread].map((call) => {
    const node = threadCall(recording, model, call);
    register(call.id, node);
    return node;
  });
  const shown = calls.filter((node, index) => index < THREAD_SHOWN || node.classList.contains('decisive'));
  const rest = calls.filter((node) => !shown.includes(node));
  const more = rest.length > 0 && reportEl('button', { class: 'more calls-more', type: 'button' });
  if (more) {
    const toggle = (open = rest[0]!.hidden) => { for (const node of rest) node.hidden = !open; more.textContent = open ? 'Show less' : `+ ${rest.length} more`; };
    toggle(false);
    more.addEventListener('click', () => toggle());
    for (const node of rest) fold(node, () => toggle(true));
  }
  const voice = item.voice && reportEl('p', { class: 'voice' }, ...reportInline(item.voice));
  // A step that made looks shows them first; the step itself is a quiet line under them, its result and command a click
  // away.
  if (item.looks.length > 0) {
    const named = item.title.startsWith(`${item.tool} `) ? item.title.slice(item.tool.length + 1) : item.title;
    // Its looks speak for it (the first card's ask), so its voice line is not drawn.
    return reportEl('div', { class: `step looking${item.failed ? ' failed' : ''}${item.judge ? ' judge' : ''}`, 'data-item': item.id },
      reportEl('div', { class: 'calls' }, ...calls, more),
      reportEl('button', { class: 'made', type: 'button', 'data-open': item.id, title: item.title },
        item.judge && threadJudge(), reportEl('span', { class: 'made-in', text: `made in ${item.tool} ·` }), reportEl('span', { class: 'made-title', text: named }),
        item.failed && reportEl('small', { class: 'tag', text: 'failed' })));
  }
  return reportEl('div', { class: `step${item.failed ? ' failed' : ''}${item.judge ? ' judge' : ''}`, 'data-item': item.id },
    // A step nothing the agent thought or wrote leads into speaks with what its look asked, inside its card.
    voice,
    reportEl('button', { class: thumb ? 'step-main' : 'step-main bare', type: 'button', 'data-open': item.id },
      reportEl('div', {}, reportEl('div', { class: 't' }, threadIcon(sourceKindOf(source?.href ?? '')), item.judge && threadJudge(), reportEl('span', { text: item.title }), item.failed && reportEl('small', { class: 'tag', text: 'failed' })),
        item.takeaway !== '' && reportEl('div', { class: 'k', text: item.takeaway })),
      thumb && reportEl('img', { loading: 'lazy', src: recording.blobUrl(thumb), alt: '' })),
    calls.length > 0 && reportEl('div', { class: 'calls' }, ...calls, more));
}

/** The session timeline, collapsed under the title: a lane per span lane, a call made inside a tool on a lane under its
 *  tool's; each span at its recorded times (one time is a tick), spans at once on rows of their own; the answer a point
 *  at the time it was delivered. A click calls `go` with the span's card or thread, or 'answer'. */
function timelineOf(model: ChatModel, go: (id: string) => void): HTMLElement | undefined {
  const spans = model.spans;
  if (spans.length === 0) return undefined;
  const end = Math.max(model.durationMs ?? 0, model.answeredAt ?? 0, ...spans.map((span) => span.t1 ?? span.t0)) || 1;
  const pct = (value: number) => `${(Math.min(1, Math.max(0, value)) * 100).toFixed(2)}%`;
  // Lanes in the order they first begin; a nested lane right under its parent's, keyed by both.
  const lanes = new Map<string, { label: string; parent?: string; spans: ChatSpan[] }>();
  const laneKey = (span: ChatSpan) => (span.parentLane ? `${span.parentLane}\n${span.lane}` : span.lane);
  for (const span of [...spans].sort((a, b) => a.t0 - b.t0)) {
    const key = laneKey(span);
    if (!lanes.has(key)) lanes.set(key, { label: span.lane, ...(span.parentLane ? { parent: span.parentLane } : {}), spans: [] });
    lanes.get(key)!.spans.push(span);
  }
  // Workflow nodes, then each model, then each tool with the calls made inside it right under it.
  const rank = (lane: { parent?: string; spans: ChatSpan[] }) => ({ node: 0, llm: 1, tool: 2, inner: 3 })[lane.spans[0]!.actor];
  const top = [...lanes].filter(([, lane]) => !lane.parent || !lanes.has(lane.parent)).sort(([, a], [, b]) => rank(a) - rank(b));
  const order = top.flatMap(([key, lane]) => [[key, lane] as const, ...[...lanes].filter(([, child]) => child.parent === key)]);
  const rowsOf = (list: ChatSpan[]) => {
    const ends: number[] = [];
    return { rows: list.map((span) => {
      const x = span.t0 / end;
      let row = ends.findIndex((free) => free <= x);
      if (row < 0) { row = ends.length; ends.push(0); }
      ends[row] = Math.max(x + 0.004, (span.t1 ?? span.t0) / end);
      return { span, row };
    }), count: ends.length };
  };
  const laneNodes = order.map(([, lane]) => {
    const { rows, count } = rowsOf(lane.spans);
    const track = reportEl('div', { class: 'track' }, ...rows.map(({ span, row }) => {
      const x = Math.min(1, Math.max(0, span.t0 / end));
      const bar = reportEl('button', { class: `tbar${span.t1 === undefined ? ' tick' : ''}${span.judge ? ' judge' : ''}`, type: 'button', 'data-goto': span.item, title: span.label, 'aria-label': span.label, disabled: !span.item });
      Object.assign(bar.style, { left: pct(x), top: `${row * 8 + 3}px`, ...(span.t1 === undefined ? {} : { width: pct(Math.min(Math.max(0, span.t1 - span.t0) / end, 1 - x)) }) });
      return bar;
    }));
    track.style.height = `${Math.max(14, count * 8 + 4)}px`;
    return reportEl('div', { class: lane.parent ? 'lane inner' : 'lane' },
      reportEl('div', { class: 'ln', title: lane.label }, lane.spans.some((span) => span.judge) && reportEl('i', { class: 'judge-dot', 'aria-hidden': 'true' }), lane.label), track);
  });
  if (model.answeredAt !== undefined) {
    const dot = reportEl('button', { class: 'dot', type: 'button', 'data-goto': 'answer', title: 'The answer', 'aria-label': 'The answer' });
    dot.style.left = `min(${pct(model.answeredAt / end)}, calc(100% - 7px))`;
    laneNodes.push(reportEl('div', { class: 'lane' }, reportEl('div', { class: 'ln', text: 'answer' }), reportEl('div', { class: 'track' }, dot)));
  }
  const mini = reportEl('span', { class: 'mini', 'aria-hidden': 'true' },
    ...spans.filter((span) => span.actor === 'tool').map((span) => reportEl('i', { style: `left:${pct(span.t0 / end)}` })),
    model.answeredAt !== undefined && reportEl('i', { class: 'rep', style: `left:calc(${pct(model.answeredAt / end)} - 2px)` }));
  const toggle = reportEl('button', { class: 'tl-toggle', type: 'button', 'aria-expanded': 'false' },
    reportEl('span', { class: 'lab', text: 'Timeline' }), mini, reportEl('span', { class: 'chev', 'aria-hidden': 'true' }));
  // A recording with no times places each span at its line's position: the axis is an order, never a clock.
  const length = end < 10_000 ? `${(end / 1000).toFixed(1)} s` : reportClock(end / 1000);
  const axis = reportEl('div', { class: 'axis' }, reportEl('span'), model.inOrder
    ? reportEl('div', {}, reportEl('span', { text: 'in order' }), reportEl('span'))
    : reportEl('div', {}, reportEl('span', { text: '0:00' }), reportEl('span', { text: length })));
  const body = reportEl('div', { class: 'tl-body', hidden: true }, ...laneNodes, axis);
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  });
  body.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('[data-goto]');
    if (!target) return;
    for (const lit of body.querySelectorAll('.tbar.on')) lit.classList.remove('on');
    if (target.classList.contains('tbar')) target.classList.add('on');
    go(target.dataset.goto!);
  });
  return reportEl('div', { class: 'tl' }, toggle, body);
}

/** The whole page body: the chat on the left, the report or a source on the right (a bottom sheet on a phone). */
export function drawChat(root: HTMLElement, model: ChatModel, recording: Recording): void {
  const phone = () => matchMedia('(max-width: 860px)').matches;
  const motion = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  const reportTitle = model.artifact?.title ?? model.answer?.title;
  const items = new Map<string, { item: ChatItem; thread: ChatThread }>();
  for (const thread of model.threads) for (const item of thread.items) items.set(item.id, { item, thread });

  const header = reportEl('header', { class: 'top' },
    reportEl('span', { class: 'brand' }, threadIcon('brand'), reportEl('b', {}, 'agent', reportEl('span', { text: '.run()' })), reportEl('small', { text: 'by grep.ai' })),
    reportEl('div', { class: 'title', text: model.title }),
    reportEl('a', { class: 'how', href: reportHowHref(recording), text: 'How this ran' }));

  // Each conversation as recorded: its messages, its thinking, its tool cards, every one shown but the steps that only ran
  // a command, which fold into one line. A folded card is opened by its group's opener.
  const cards = new Map<string, HTMLElement>();
  const nodes = new Map<string, HTMLElement>();
  const openers = new Map<HTMLElement, () => void>();
  const agentMessage = (className = 'msg') => reportEl('div', { class: className }, reportEl('div', { class: 'who' }, threadIcon('brand'), 'Agent'));
  const drawThread = (thread: ChatThread): HTMLElement[] => {
    const out: HTMLElement[] = [];
    let agent: HTMLElement | undefined;
    let steps: HTMLElement | undefined;
    // Steps that only ran a command or a script, in a row, fold into one quiet line.
    let plumbing: { line: HTMLButtonElement; body: HTMLElement; count: number; failed: number } | undefined;
    const plumbingOf = (into: HTMLElement) => {
      if (plumbing) return plumbing;
      const body = reportEl('div', { class: 'plumb-steps', hidden: true });
      const line = reportEl('button', { class: 'plumb-line', type: 'button', 'aria-expanded': 'false' });
      const open = (to = body.hidden) => { body.hidden = !to; line.setAttribute('aria-expanded', String(to)); };
      line.addEventListener('click', () => open());
      openers.set(body, () => open(true));
      into.append(reportEl('div', { class: 'plumbing' }, line, body));
      return (plumbing = { line, body, count: 0, failed: 0 });
    };
    const endPlumbing = () => { plumbing = undefined; };
    for (const item of thread.items) {
      if (item.kind === 'user') {
        endPlumbing();
        agent = undefined;
        steps = undefined;
        const node = threadYou(reportEl('div', { class: 'bubble', text: item.text }), threadLong(item.text), item.id);
        nodes.set(item.id, node);
        out.push(node);
        continue;
      }
      if (item.kind === 'host') {
        // A message the host added sits where it was recorded, inside the agent's turn, as the host's.
        endPlumbing();
        steps = undefined;
        const node = reportEl('div', { class: 'host-note', 'data-item': item.id }, reportEl('span', { class: 'host-who', text: 'Host' }), reportEl('span', { class: 'host-text', text: item.text }));
        nodes.set(item.id, node);
        if (agent) agent.append(node); else out.push(node);
        continue;
      }
      if (!agent) { agent = agentMessage(); out.push(agent); }
      if (item.kind === 'tool') {
        if (!steps) { steps = reportEl('div', { class: 'steps' }); agent.append(steps); }
        const card = threadCard(recording, model, item, (node, open) => openers.set(node, open), (id, node) => nodes.set(id, node));
        cards.set(item.id, card);
        nodes.set(item.id, card);
        if (item.plumbing) {
          const group = plumbingOf(steps);
          group.body.append(card);
          group.count += 1;
          if (item.failed) group.failed += 1;
          group.line.textContent = `ran ${group.count === 1 ? 'a command' : `${group.count} commands`}${group.failed ? `, ${group.failed} failed` : ''}`;
          continue;
        }
        endPlumbing();
        steps.append(card);
        continue;
      }
      endPlumbing();
      steps = undefined;
      const node = item.kind === 'thinking' ? (item.redacted ? threadRedacted() : threadThinking(item.text)) : reportEl('div', { class: 'said-text', 'data-item': item.id }, ...reportParagraphs(item.text));
      nodes.set(item.id, node);
      agent.append(node);
    }
    endPlumbing();
    return out;
  };
  const input = model.input && threadInput(model.input);
  const thread = reportEl('div', { class: 'thread' }, input);
  model.threads.forEach((each, index) => {
    if (index === 0) {
      const drawn = drawThread(each);
      if (drawn[0]) nodes.set(each.id, drawn[0]);
      thread.append(...drawn);
      return;
    }
    const first = each.items.find((item) => item.kind === 'user' || item.kind === 'tool');
    const preview = first?.kind === 'user' ? first.text : first?.kind === 'tool' ? first.title : '';
    const fold = reportEl('details', { class: 'think fold', 'data-item': each.id },
      reportEl('summary', {}, reportEl('span', { class: 'lab', text: each.label }), reportEl('em', { text: preview.split('\n')[0] ?? '' })),
      reportEl('div', { class: 'fold-body' }, ...drawThread(each)));
    nodes.set(each.id, fold);
    thread.append(fold);
  });
  if (model.threads.length === 0) thread.append(reportEl('p', { class: 'none', text: 'This run recorded no conversation.' }));
  // The card that opens the report closes the chat, after every conversation.
  const doccard = reportTitle === undefined ? undefined : reportEl('button', { class: 'doccard', type: 'button' }, reportEl('span', { class: 'ic' }, threadIcon('doc')),
    reportEl('span', {}, reportEl('b', { text: reportTitle }), reportEl('small', { text: model.artifact ? 'The page the agent wrote, with the sources it rests on.'
      : model.answer?.from === 'text' ? 'The run\'s final message.' : 'The run\'s answer, with the sources it cites.' })));
  const answerNode = doccard && agentMessage('msg answer');
  if (answerNode && doccard) { answerNode.append(doccard); thread.append(answerNode); }

  const reportButton = reportEl('button', { class: 'run report-btn', type: 'button', text: 'Open the report' });
  const composer = reportEl('div', { class: 'composer' }, reportEl('div', { class: 'bar' }, reportEl('span', { text: 'This is a replay of a recorded run.' }), reportButton));
  const chat = reportEl('section', { class: 'chat', 'aria-label': 'Conversation' }, timelineOf(model, (id) => scrollToItem(id)), thread, composer);
  const reportPane = reportEl('div', { class: 'report-host' });
  const source = reportEl('div', { class: 'src', hidden: true });
  const shut = reportEl('button', { class: 'back shut', type: 'button', text: 'Close' });
  const art = reportEl('aside', { class: 'art', 'aria-label': 'The report' }, reportEl('div', { class: 'grab' }, reportEl('i')), shut, reportPane, source);
  const scrim = reportEl('div', { class: 'scrim' });
  root.replaceChildren(header, reportEl('div', { class: 'app' }, chat, art), scrim);
  // Pictures within a screen and a half of the top load at once; the rest wait until they come into view.
  requestAnimationFrame(() => {
    for (const img of root.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')) {
      if (img.checkVisibility() && img.getBoundingClientRect().top < innerHeight * 1.5) img.loading = 'eager';
    }
  });

  /** Opens every fold that hides a node: its conversation's, and each folded group it sits in. */
  const reveal = (node: HTMLElement) => {
    const fold = node.closest<HTMLDetailsElement>('details.fold');
    if (fold) fold.open = true;
    for (let at: HTMLElement | null = node; at; at = at.parentElement) if (at.hidden) openers.get(at)?.();
  };
  let shown: SourceShown | undefined;
  const mark = () => {
    for (const [id, card] of cards) card.setAttribute('aria-current', String(!source.hidden && id === shown?.item?.id));
    for (const call of thread.querySelectorAll<HTMLElement>('.call')) call.setAttribute('aria-current', String(!source.hidden && !!shown?.look && call.dataset.look === shown.look));
    doccard?.setAttribute('aria-current', String(source.hidden));
    history.replaceState(null, '', `${location.pathname}${location.search}${!source.hidden && shown?.look ? `#look=${encodeURIComponent(shown.look)}` : ''}`);
  };
  const openSheet = () => { if (phone()) { art.classList.add('open'); scrim.classList.add('on'); } };
  const closeSheet = () => { art.classList.remove('open'); scrim.classList.remove('on'); };
  const showReport = () => { source.hidden = true; source.replaceChildren(); shown = undefined; mark(); };
  const toolOf = (id: string | undefined) => { const found = id ? items.get(id)?.item : undefined; return found?.kind === 'tool' ? found : undefined; };
  const showSource = (next: SourceShown, sheet = true) => {
    shown = next;
    // The card of the call that made the look shown is opened in the chat, wherever it was folded.
    const made = next.look ? thread.querySelector<HTMLElement>(`.call[data-look="${CSS.escape(next.look)}"]`) : null;
    if (made) reveal(made);
    source.replaceChildren(sourceView(recording, model, next, showReport, (look) => showLook(look, next.item)));
    source.hidden = false;
    source.scrollTop = 0;
    mark();
    if (sheet) openSheet();
  };
  // A look opened from its card: its own address and the regions its answer boxed.
  const showLook = (look: string, item = toolOf(model.sources[look]?.item), sheet = true) => {
    const found = model.sources[look]!;
    showSource({ look, ...(item ? { item } : {}), href: found.href, regions: found.regions.flatMap((region) => sourceRegionOf(region.href, region.label) ?? []) }, sheet);
  };
  const openCard = (item: ToolItem) => {
    const look = threadLookOf(model, item);
    if (look) showLook(look, item);
    else showSource({ item, href: '', regions: [] });
  };
  // A citation: the look it names, with the region its own address carries and no other.
  const report = drawReport(reportPane, model, recording, (href, look, picture) => {
    const key = look && model.sources[look] ? look : picture ? undefined : sourceByHref(model.sources, href);
    const item = toolOf(key ? model.sources[key]!.item : undefined);
    const region = sourceRegionOf(href);
    showSource({ ...(key ? { look: key } : {}), ...(item ? { item } : {}), ...(picture ? { picture } : {}), href, regions: region ? [region] : [] });
  });

  const scrollToItem = (id: string) => {
    const target = id === 'answer' ? answerNode : nodes.get(id);
    if (!target) return;
    reveal(target);
    target.scrollIntoView({ block: 'center', behavior: motion() });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  };

  // "In the report" on each card whose look the report cites: the report again, at that spot (a phone opens the sheet).
  void report.cited.then((cited) => {
    for (const [id, card] of cards) {
      const item = toolOf(id)!;
      const key = item.looks.find((look) => cited.has(look)) ?? (cited.has(id) ? id : undefined);
      if (!key) continue;
      const chip = reportEl('button', { class: 'inrep', type: 'button', text: 'In the report' });
      chip.addEventListener('click', () => { showReport(); openSheet(); report.scrollToLook(key); });
      card.append(reportEl('div', { class: 'step-foot' }, chip));
    }
  });

  thread.addEventListener('click', (event) => {
    const target = event.target as Element;
    if (target.closest('details.raw')) return;
    const call = target.closest<HTMLElement>('.call[data-look]');
    if (call) { showLook(call.dataset.look!, toolOf(call.closest<HTMLElement>('.step')!.dataset.item)); return; }
    const opener = target.closest<HTMLElement>('[data-open]');
    const item = opener ? toolOf(opener.dataset.open) : undefined;
    if (item) openCard(item);
  });
  thread.addEventListener('keydown', (event) => {
    const call = (event.target as Element).closest<HTMLElement>('.call[data-look]');
    if (call && event.target === call && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); call.click(); }
  });
  doccard?.addEventListener('click', () => { showReport(); openSheet(); });
  reportButton.addEventListener('click', () => { showReport(); openSheet(); });
  shut.addEventListener('click', closeSheet);
  scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSheet(); });

  const linked = /^#look=(.+)$/.exec(location.hash);
  const look = linked ? decodeURIComponent(linked[1]!) : undefined;
  if (look && model.sources[look]) showLook(look, undefined, false);
  else mark();
}
