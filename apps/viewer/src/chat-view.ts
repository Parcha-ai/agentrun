// The chat page's body: the run's recorded conversations on the left (the first open, the rest folded), each message as
// recorded, the thinking its own model wrote and one card per tool call; the session timeline under the title; and on
// the right the report (chat-report.ts) or the source a citation or a card points at, its region drawn from an address
// alone. On a phone the right side is a bottom sheet.
import type { ChatDecision, ChatItem, ChatModel, ChatSource, ChatSpan, ChatThread } from './chat-model.ts';
import type { Recording } from './format.ts';
import { drawReport, reportCiteLabel, reportClock, reportEl, reportFragmentOf, reportHeldFile, reportInline, reportParagraphs } from './chat-report.ts';

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
/** How many looks a card's strip shows before "+ N more" (its decisive looks always show). */
const THREAD_CELLS = 8;

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
  const file = href.split('#')[0];
  const cited = reportFragmentOf(href);
  const entries = Object.entries(sources);
  return (entries.find(([, source]) => sourceAddresses(source).includes(href)) ?? entries.find(([, source]) => sourceAddresses(source).some((address) => {
    if (address.split('#')[0] !== file) return false;
    const own = reportFragmentOf(address);
    const page = cited.get('page');
    const t = cited.get('t');
    return (!page || own.get('page') === page) && (!t || sourceWithin(t, own.get('t')));
  })))?.[0];
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
  const picture = reportEl('img', { src: url, alt });
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

const sourceRegionList = (regions: SourceRegion[]) => reportEl('ul', { class: 'regions' },
  ...regions.map((region) => reportEl('li', {}, reportEl('b', { text: region.label ?? 'cited here' }), reportEl('span', { text: region.href }))));

export type SourceShown = { look?: string; item?: ToolItem; href: string; regions: SourceRegion[] };

/** What a citation or a card points at: what was found, then the medium with the regions given and no other. A page
 *  address shows that page's own picture, whichever look cites it. */
function sourceView(recording: Recording, model: ChatModel, shown: SourceShown, back: () => void, pick: (look: string) => void): HTMLElement {
  const source = shown.look ? model.sources[shown.look] : undefined;
  // The look's own address says what it read; when it names a whole file, the citation's address may say more.
  const kind = source && sourceKindOf(source.href) !== 'other' ? sourceKindOf(source.href) : sourceKindOf(shown.href);
  const backButton = reportEl('button', { class: 'back', type: 'button', text: '← Report' });
  backButton.addEventListener('click', back);
  const title = shown.item?.title ?? reportCiteLabel(shown.href);
  const pane = reportEl('div', { class: 'pane' }, reportEl('div', { class: 'phead' }, backButton,
    reportEl('div', {}, reportEl('div', { class: 'kind', text: source ? SOURCE_KIND[kind] : shown.item ? SOURCE_KIND.other : 'Source' }), reportEl('div', { class: 'ptitle', text: title }),
      shown.href !== '' && sourceAddressList(model, recording, [...new Set([shown.href, ...(source ? sourceAddresses(source) : [])])]))));
  if (!source && !shown.item) {
    pane.append(reportEl('div', { class: 'said' }, reportEl('p', { text: 'No look in this recording shows this address.' })));
    if (shown.regions.length) pane.append(sourceRegionList(shown.regions));
    return pane;
  }
  const said = source?.takeaway || shown.item?.takeaway || '';
  const decisions = source ? sourceDecisions(source) : [];
  if (said || decisions.length) pane.append(reportEl('div', { class: 'said' }, reportEl('div', { class: 'kind', text: source ? SOURCE_SAID[kind] : 'Result' }),
    said !== '' && reportEl('p', { text: said }), decisions.length > 0 && reportEl('ul', { class: 'decisions' }, ...decisions.map((text) => reportEl('li', { text })))));
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
        const button = reportEl('button', { type: 'button', 'aria-label': `Frame ${index + 1}` }, reportEl('img', { src: recording.blobUrl(sha), alt: '' }));
        button.addEventListener('click', () => show(index));
        strip.append(button);
      });
      pane.append(shownFrame, strip);
      show(first);
    } else if (shown.regions.length) pane.append(sourceRegionList(shown.regions));
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

/** Thinking the run's own model wrote, folded, its first line as a preview. */
function threadThinking(text: string): HTMLElement {
  const preview = text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  return reportEl('details', { class: 'think' },
    reportEl('summary', {}, reportEl('span', { class: 'lab', text: 'Thinking' }), reportEl('em', {}, ...reportInline(preview))),
    reportEl('div', {}, ...reportParagraphs(text)));
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

/** The run's input as given, as the person's message: its words, or its fields by name. */
function threadInput(input: NonNullable<ChatModel['input']>): HTMLElement | undefined {
  const fields = input.fields ?? [];
  if (fields.length) {
    const list = reportEl('dl', { class: 'bubble fields' }, ...fields.map((field) => reportEl('div', {}, reportEl('dt', { text: field.name }), reportEl('dd', { text: field.value }))));
    return threadYou(list, fields.length > THREAD_LINES || fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) > THREAD_CHARS);
  }
  return input.text ? threadYou(reportEl('div', { class: 'bubble', text: input.text }), threadLong(input.text)) : undefined;
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

/** A decision in a strip cell: a yes-or-no as its score to two places and its word, a choice as its value; named when
 *  the look made more than one. The strip is the one place a score shows. */
const threadDecision = (decision: ChatDecision, named: boolean) => {
  const name = named ? `${decision.name.replace(/_/g, ' ')} ` : '';
  return decision.kind === 'noul' ? `${name}${decision.score.toFixed(2)} ${decision.score >= 0.5 ? 'yes' : 'no'}` : `${named ? `${name.trim()}: ` : ''}${decision.choice}`;
};

/** A tool call's card: what it did, what it found, its own first picture, and a strip of the looks it made (each its
 *  picture or its place, and its decisions), its decisive looks marked. */
function threadCard(recording: Recording, model: ChatModel, item: ToolItem): HTMLElement {
  const look = threadLookOf(model, item);
  const source = look ? model.sources[look] : undefined;
  const looks = item.looks.filter((each) => model.sources[each]);
  const thumb = threadPicture(recording, item.media);
  const cells = looks.map((each) => {
    const found = model.sources[each]!;
    const picture = threadPicture(recording, found.media);
    const addresses = sourceAddresses(found);
    const at = threadPlace(addresses);
    const said = found.decisions.map((decision) => threadDecision(decision, found.decisions.length > 1));
    return reportEl('button', { class: found.decisive ? 'look decisive' : 'look', type: 'button', 'data-look': each, title: addresses.join(', '), 'aria-label': [at, ...said, addresses.join(', ')].join('; ') },
      picture ? reportEl('img', { src: recording.blobUrl(picture), alt: '', loading: 'lazy' }) : undefined,
      reportEl('span', { class: 'cell-at', text: at }), ...said.map((text) => reportEl('span', { class: 'cell-said', text })));
  });
  const shown = cells.filter((cell, index) => index < THREAD_CELLS || cell.classList.contains('decisive'));
  const rest = cells.filter((cell) => !shown.includes(cell));
  for (const cell of rest) cell.hidden = true;
  const more = rest.length > 0 && reportEl('button', { class: 'more cells', type: 'button', text: `+ ${rest.length} more` });
  if (more) more.addEventListener('click', () => { const open = rest[0]!.hidden; for (const cell of rest) cell.hidden = !open; more.textContent = open ? 'Show less' : `+ ${rest.length} more`; });
  return reportEl('div', { class: `step${item.failed ? ' failed' : ''}`, 'data-item': item.id },
    reportEl('button', { class: thumb ? 'step-main' : 'step-main bare', type: 'button', 'data-open': item.id },
      reportEl('div', {}, reportEl('div', { class: 't' }, threadIcon(sourceKindOf(source?.href ?? '')), reportEl('span', { text: item.title }), item.failed && reportEl('small', { class: 'tag', text: 'failed' })),
        item.takeaway !== '' && reportEl('div', { class: 'k', text: item.takeaway })),
      thumb && reportEl('img', { src: recording.blobUrl(thumb), alt: '', loading: 'lazy' })),
    cells.length > 0 && reportEl('div', { class: 'step-looks' }, ...cells, more));
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
      const bar = reportEl('button', { class: span.t1 === undefined ? 'tbar tick' : 'tbar', type: 'button', 'data-goto': span.item, title: span.label, 'aria-label': span.label, disabled: !span.item });
      Object.assign(bar.style, { left: pct(x), top: `${row * 8 + 3}px`, ...(span.t1 === undefined ? {} : { width: pct(Math.min(Math.max(0, span.t1 - span.t0) / end, 1 - x)) }) });
      return bar;
    }));
    track.style.height = `${Math.max(14, count * 8 + 4)}px`;
    return reportEl('div', { class: lane.parent ? 'lane inner' : 'lane' }, reportEl('div', { class: 'ln', text: lane.label, title: lane.label }), track);
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
  const length = end < 10_000 ? `${(end / 1000).toFixed(1)} s` : reportClock(end / 1000);
  const axis = reportEl('div', { class: 'axis' }, reportEl('span'), reportEl('div', {}, reportEl('span', { text: '0:00' }), reportEl('span', { text: length })));
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
    reportEl('a', { class: 'how', href: `./?r=${encodeURIComponent(recording.id)}`, text: 'How this ran' }));

  // Each conversation as recorded: its messages, its thinking, its tool cards (calls of one tool in a row show the first,
  // the rest behind "+ N more").
  const cards = new Map<string, HTMLElement>();
  const nodes = new Map<string, HTMLElement>();
  const runs = new Map<string, { more: HTMLButtonElement; extras: HTMLElement[] }>();
  const toggleRun = (run: { more: HTMLButtonElement; extras: HTMLElement[] }, open = run.extras[0]?.hidden ?? false) => {
    for (const node of run.extras) node.hidden = !open;
    run.more.textContent = open ? 'Show less' : `+ ${run.extras.length} more`;
  };
  const agentMessage = (className = 'msg') => reportEl('div', { class: className }, reportEl('div', { class: 'who' }, threadIcon('brand'), 'Agent'));
  const drawThread = (thread: ChatThread): HTMLElement[] => {
    const out: HTMLElement[] = [];
    let agent: HTMLElement | undefined;
    let steps: HTMLElement | undefined;
    let run: { tool: string; cards: HTMLElement[]; ids: string[] } | undefined;
    const closeRun = () => {
      if (run && steps && run.cards.length > 1) {
        const group = { more: reportEl('button', { class: 'more', type: 'button' }), extras: run.cards.slice(1) };
        group.more.addEventListener('click', () => toggleRun(group));
        toggleRun(group, false);
        for (const id of run.ids.slice(1)) runs.set(id, group);
        steps.append(group.more);
      }
      run = undefined;
    };
    for (const item of thread.items) {
      if (item.kind === 'user') {
        closeRun();
        agent = undefined;
        steps = undefined;
        const node = threadYou(reportEl('div', { class: 'bubble', text: item.text }), threadLong(item.text), item.id);
        nodes.set(item.id, node);
        out.push(node);
        continue;
      }
      if (!agent) { agent = agentMessage(); out.push(agent); }
      if (item.kind === 'tool') {
        if (!steps) { steps = reportEl('div', { class: 'steps' }); agent.append(steps); }
        if (run && run.tool !== item.tool) closeRun();
        const card = threadCard(recording, model, item);
        cards.set(item.id, card);
        nodes.set(item.id, card);
        steps.append(card);
        run ??= { tool: item.tool, cards: [], ids: [] };
        run.cards.push(card);
        run.ids.push(item.id);
        continue;
      }
      closeRun();
      steps = undefined;
      const node = item.kind === 'thinking' ? threadThinking(item.text) : reportEl('div', { class: 'said-text', 'data-item': item.id }, ...reportParagraphs(item.text));
      nodes.set(item.id, node);
      agent.append(node);
    }
    closeRun();
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

  let shown: SourceShown | undefined;
  const mark = () => {
    for (const [id, card] of cards) card.setAttribute('aria-current', String(!source.hidden && id === shown?.item?.id));
    doccard?.setAttribute('aria-current', String(source.hidden));
    history.replaceState(null, '', `${location.pathname}${location.search}${!source.hidden && shown?.look ? `#look=${encodeURIComponent(shown.look)}` : ''}`);
  };
  const openSheet = () => { if (phone()) { art.classList.add('open'); scrim.classList.add('on'); } };
  const closeSheet = () => { art.classList.remove('open'); scrim.classList.remove('on'); };
  const showReport = () => { source.hidden = true; source.replaceChildren(); shown = undefined; mark(); };
  const toolOf = (id: string | undefined) => { const found = id ? items.get(id)?.item : undefined; return found?.kind === 'tool' ? found : undefined; };
  const showSource = (next: SourceShown, sheet = true) => {
    shown = next;
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
  const report = drawReport(reportPane, model, recording, (href, look) => {
    const key = look && model.sources[look] ? look : sourceByHref(model.sources, href);
    const item = toolOf(key ? model.sources[key]!.item : undefined);
    const region = sourceRegionOf(href);
    showSource({ ...(key ? { look: key } : {}), ...(item ? { item } : {}), href, regions: region ? [region] : [] });
  });

  const scrollToItem = (id: string) => {
    const target = id === 'answer' ? answerNode : nodes.get(id);
    if (!target) return;
    const fold = target.closest<HTMLDetailsElement>('details.fold');
    if (fold) fold.open = true;
    const run = runs.get(id);
    if (run && target.hidden) toggleRun(run, true);
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
    const strip = target.closest<HTMLElement>('.step-looks [data-look]');
    if (strip) { showLook(strip.dataset.look!, toolOf(strip.closest<HTMLElement>('.step')!.dataset.item)); return; }
    const opener = target.closest<HTMLElement>('[data-open]');
    const item = opener ? toolOf(opener.dataset.open) : undefined;
    if (item) openCard(item);
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
