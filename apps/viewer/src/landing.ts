// The gallery's landing: the site's own line about what a run does, then the featured runs as cards. Every card shows
// only what its run holds (the card the build wrote from it): its title, its question, and the poster the gallery's lock
// names among the run's own pictures, with the boxes the run's own report marked for the looks the lock names (each with
// its label). A run with no poster is a card of words. Only a run a real model made is featured.

/** A run's card, written by the build from the run itself; `rank` is its place in the gallery's lock. */
export type LandingCard = { title: string; line?: string; poster?: string; looks?: string[]; boxes?: { x: number; y: number; w: number; h: number; at: string; look: string }[]; rank?: number };
type LandingEntry = { id: string; blobs: Record<string, string>; card?: LandingCard; manifest: { providers?: 'real' | 'scripted'; artifact?: { entry: string; files: Record<string, string> } } };
/** A box drawn on a poster, in percent of its picture, with its label. */
type LandingBox = { label: string; x: number; y: number; w: number; h: number };
/** A rectangle in percent of whatever it is placed on. */
type LandingRect = { x: number; y: number; w: number; h: number };

/** What AgentRun is, in the site's own line. */
const LANDING_DEFINITION = 'Open-source packages for your pi agent.';
const LANDING_LINE = 'Watch an agent answer questions about films, documents and images.';
const LANDING_SUB = 'Open a run to see each step it took and the report it wrote. Every answer cites its page, second or region.';
const LANDING_LINKS = [['GitHub', 'https://github.com/Parcha-ai/agentrun'], ['Docs', 'https://github.com/Parcha-ai/agentrun/blob/main/docs/guide.md']] as const;
const LANDING_BRAND = '<svg width="18" height="18" viewBox="0 0 64 64" aria-hidden="true"><path d="M18 12L42 32L18 52" fill="none" stroke="#ff8700" stroke-width="8" stroke-linecap="square"/></svg>';

const landingEl = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | undefined> = {}, ...children: (Node | string | undefined | false)[]) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (name === 'text') node.textContent = value; else node.setAttribute(name, value);
  }
  for (const child of children) if (child !== undefined && child !== false) node.append(child);
  return node;
};

/** The public gallery shows only runs a real model made: a scripted run is never a card or a list item. */
export const landingPublic = (entry: { manifest: { providers?: 'real' | 'scripted' } }) => entry.manifest.providers === 'real';

/** The runs the lock features, in its order, whatever else the lock names. */
export const landingFeatured = <E extends LandingEntry>(entries: readonly E[]): E[] =>
  entries.filter((entry) => typeof entry.card?.rank === 'number' && landingPublic(entry)).sort((a, b) => a.card!.rank! - b.card!.rank!);

/** A blob of a bundled run as an address this page can load: embedded, a data: URL; shipped as files, its path in the
 *  run's directory beside the page. */
const landingBlobUrl = (entry: LandingEntry, sha: string): string | undefined => {
  const at = entry.blobs[sha];
  return at === undefined ? undefined : new URL(at, new URL(`recordings/${encodeURIComponent(entry.id)}/`, location.href)).href;
};

/** The colour of a picture's edges beside its bands (its top and bottom rows, or its left and right columns) when those
 *  are one colour (each pixel within 12 of their mean in every channel), else undefined; also undefined when the page may
 *  not read its pixels. */
function landingEdgeColour(picture: HTMLImageElement, edges: 'rows' | 'columns'): string | undefined {
  try {
    const width = 64;
    const height = Math.max(2, Math.round((width * picture.naturalHeight) / picture.naturalWidth));
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(picture, 0, 0, width, height);
    const strips = edges === 'rows'
      ? [context.getImageData(0, 0, width, 1).data, context.getImageData(0, height - 1, width, 1).data]
      : [context.getImageData(0, 0, 1, height).data, context.getImageData(width - 1, 0, 1, height).data];
    const pixels = strips.flatMap((strip) => Array.from({ length: strip.length / 4 }, (_, at) => [strip[at * 4]!, strip[at * 4 + 1]!, strip[at * 4 + 2]!]));
    const mean = [0, 1, 2].map((channel) => pixels.reduce((sum, pixel) => sum + pixel[channel]!, 0) / pixels.length);
    if (pixels.some((pixel) => pixel.some((value, channel) => Math.abs(value - mean[channel]!) > 12))) return undefined;
    return `rgb(${mean.map(Math.round).join(', ')})`;
  } catch {
    return undefined;
  }
}

/** A `percent:x,y,w,h` address as a rectangle; undefined for any other. */
function landingPercent(xywh: string): LandingRect | undefined {
  const at = /^percent:([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(xywh.trim());
  return at ? { x: +at[1]!, y: +at[2]!, w: +at[3]!, h: +at[4]! } : undefined;
}

/** How much two rectangles overlap: their shared area over the area either covers (0 to 1). */
function landingOverlap(a: LandingRect, b: LandingRect): number {
  const across = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const down = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const shared = across * down;
  const union = a.w * a.h + b.w * b.h - shared;
  return union > 0 ? shared / union : 0;
}

/** The boxes a card draws: each box its looks' answers found that the run's own report marks (an element of its page
 *  with that look's `data-look` and a `data-xywh` overlapping the answer's address by 0.8 or more), labelled with the
 *  mark's text. None when the run has no report or the page cannot be read. */
async function landingMarked(entry: LandingEntry, boxes: NonNullable<LandingCard['boxes']>): Promise<LandingBox[]> {
  const artifact = entry.manifest.artifact;
  const sha = artifact?.files[artifact.entry.replace(/^\.\//, '')];
  const url = sha ? landingBlobUrl(entry, sha) : undefined;
  if (!url || boxes.length === 0) return [];
  try {
    const page = new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/html');
    const marks = [...page.querySelectorAll('[data-look][data-xywh]')].flatMap((node) => {
      const at = landingPercent(node.getAttribute('data-xywh')!);
      return at ? [{ look: node.getAttribute('data-look')!, at, label: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) }] : [];
    });
    return boxes.flatMap((box) => {
      const at = landingPercent(box.at);
      // A report can mark one look twice (a row's thumbnail and its picture): the mark with words gives the label.
      const matches = at ? marks.filter((each) => each.look === box.look && landingOverlap(each.at, at) >= 0.8) : [];
      const mark = matches.find((each) => each.label !== '') ?? matches[0];
      return mark ? [{ label: mark.label, x: box.x, y: box.y, w: box.w, h: box.h }] : [];
    });
  } catch {
    return [];
  }
}

/** The share of a picture's height a label over its box takes, in percent. */
const LANDING_LABEL = 9;

/** A poster in its box, its boxes drawn on it. It fills the box, cropped where every drawn box and its label stays in
 *  view (centred when it has none): a wider poster across, a narrower one up and down. When no crop can keep them all, it
 *  is drawn whole, with bands above and below (wider) or at the sides (narrower), each band the colour of the poster's
 *  own edge beside it when that edge is one colour, else the card's. */
function landingFit(frame: HTMLElement, layer: HTMLElement, picture: HTMLImageElement, boxes: LandingBox[]): void {
  if (!picture.naturalWidth || !picture.naturalHeight) return;
  const ratio = picture.naturalWidth / picture.naturalHeight;
  frame.style.setProperty('--ar', `${picture.naturalWidth} / ${picture.naturalHeight}`);
  const box = frame.getBoundingClientRect();
  const boxRatio = box.height > 0 ? box.width / box.height : 16 / 10;
  const wider = ratio > boxRatio;
  // Filled, the box shows this share of the picture: across when it is wider, down when it is narrower.
  const shown = (wider ? boxRatio / ratio : ratio / boxRatio) * 100;
  const [from, to] = wider
    ? [Math.min(...boxes.map((each) => each.x)), Math.max(...boxes.map((each) => each.x + each.w))]
    : [Math.min(...boxes.map((each) => (each.y >= LANDING_LABEL ? each.y - LANDING_LABEL : each.y))), Math.max(...boxes.map((each) => each.y + each.h + (each.y < LANDING_LABEL ? LANDING_LABEL : 0)))];
  const fills = boxes.length === 0 || to - from <= shown;
  frame.classList.toggle('across', fills && wider);
  frame.classList.toggle('wide', !fills && wider);
  frame.classList.toggle('tall', !fills && !wider);
  if (fills) {
    const start = Math.max(0, Math.min(100 - shown, (boxes.length ? (from + to) / 2 : 50) - shown / 2));
    layer.style.top = '0';
    layer.style.transform = wider ? `translateX(-${start}%)` : `translateY(-${start}%)`;
  } else {
    layer.style.top = '';
    layer.style.transform = '';
  }
  const edge = fills ? undefined : landingEdgeColour(picture, wider ? 'rows' : 'columns');
  frame.style.background = edge ?? '';
}

/** A marked box over the picture, its label above it (below when the box starts at the picture's top). */
const landingBox = (each: LandingBox) => landingEl('span', { class: each.y < LANDING_LABEL ? 'lbox below' : 'lbox', style: `left:${each.x}%;top:${each.y}%;width:${each.w}%;height:${each.h}%` },
  each.label !== '' && landingEl('span', { class: 'llabel', text: each.label }));

/** The labels laid out so each reads whole, in order: each takes the first of four places (above its box or below it,
 *  from its left edge or ending at its right edge) that lies inside the poster's visible part and covers no label placed
 *  before it; when none does, the first place inside the poster, else its own. */
function landingLabels(frame: HTMLElement, layer: HTMLElement): void {
  const seen = frame.getBoundingClientRect();
  if (seen.width === 0) return;
  const placed: DOMRect[] = [];
  const inside = (rect: DOMRect) => rect.left >= seen.left - 0.5 && rect.right <= seen.right + 0.5 && rect.top >= seen.top - 0.5 && rect.bottom <= seen.bottom + 0.5;
  const clear = (rect: DOMRect) => !placed.some((other) => rect.left < other.right - 0.5 && other.left < rect.right - 0.5 && rect.top < other.bottom - 0.5 && other.top < rect.bottom - 0.5);
  for (const label of layer.querySelectorAll<HTMLElement>('.llabel')) {
    const box = label.parentElement!;
    const places = [[false, false], [true, false], [false, true], [true, true]] as const;
    const fits = places.map(([flip, swap]) => { box.classList.toggle('flip', flip); box.classList.toggle('swap', swap); const rect = label.getBoundingClientRect(); return { flip, swap, rect, inside: inside(rect), clear: clear(rect) }; });
    const pick = fits.find((each) => each.inside && each.clear) ?? fits.find((each) => each.inside) ?? fits[0]!;
    box.classList.toggle('flip', pick.flip);
    box.classList.toggle('swap', pick.swap);
    placed.push(label.getBoundingClientRect());
  }
}

function landingCard(entry: LandingEntry): HTMLElement {
  const card = entry.card!;
  const poster = card.poster ? landingBlobUrl(entry, card.poster) : undefined;
  const picture = poster ? landingEl('img', { loading: 'lazy', src: poster, alt: '' }) : undefined;
  const layer = picture && landingEl('span', { class: 'lframe' }, picture);
  const frame = layer && landingEl('span', { class: 'lposter' }, layer);
  if (picture && layer && frame) {
    let boxes: LandingBox[] = [];
    const fit = () => { landingFit(frame, layer, picture, boxes); landingLabels(frame, layer); };
    picture.addEventListener('load', fit, { once: true });
    if (card.boxes?.length) {
      void landingMarked(entry, card.boxes).then((found) => {
        boxes = found;
        layer.append(...found.map(landingBox));
        if (picture.complete && picture.naturalWidth) fit();
      });
    }
  }
  return landingEl('a', { class: poster ? 'lcard' : 'lcard words', href: `chat.html?r=${encodeURIComponent(entry.id)}`, 'data-id': entry.id },
    frame,
    landingEl('span', { class: 'ltitle', text: card.title }),
    card.line && landingEl('span', { class: 'lline', text: card.line }));
}

/** The landing, the page's header: the brand row with the repository's links, what AgentRun is and the site's line,
 *  then a card per featured run (none when the lock features none). */
export function landingOf(entries: readonly LandingEntry[]): HTMLElement {
  const brand = landingEl('span', { class: 'lbrand' });
  brand.innerHTML = `${LANDING_BRAND}<b>agent<span>.run()</span></b><small>by grep.ai</small>`;
  const featured = landingFeatured(entries);
  const section = landingEl('section', { class: 'landing', 'aria-label': 'Featured runs' },
    landingEl('div', { class: 'ltop' }, brand, landingEl('nav', { class: 'llinks' }, ...LANDING_LINKS.map(([text, href]) => landingEl('a', { href, text })))),
    landingEl('p', { class: 'ldefine', text: LANDING_DEFINITION }), landingEl('h1', { class: 'lhero', text: LANDING_LINE }), landingEl('p', { class: 'lsub', text: LANDING_SUB }),
    featured.length > 0 && landingEl('div', { class: 'lcards', 'data-n': String(featured.length) }, ...featured.map(landingCard)));
  // Posters within a screen and a half of the top load at once; the rest when they come into view.
  requestAnimationFrame(() => {
    for (const img of section.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')) {
      if (img.getBoundingClientRect().top < innerHeight * 1.5) img.loading = 'eager';
    }
  });
  return section;
}
