// The gallery's landing: the site's own line about what a run does, then the featured runs as cards. Every card shows
// only what its run holds (the card the build wrote from it): its title, its question, and the poster the gallery's lock
// names among the run's own pictures. A run with no poster is a card of words. Only a run a real model made is featured.

/** A run's card, written by the build from the run itself; `rank` is its place in the gallery's lock. */
export type LandingCard = { title: string; line?: string; poster?: string; rank?: number };
type LandingEntry = { id: string; blobs: Record<string, string>; card?: LandingCard; manifest: { providers?: 'real' | 'scripted' } };

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

/** The colour of a picture's top and bottom rows when they are one colour (each pixel within 12 of their mean in every
 *  channel), else undefined; also undefined when the page may not read its pixels. */
function landingEdgeColour(picture: HTMLImageElement): string | undefined {
  try {
    const width = 64;
    const height = Math.max(2, Math.round((width * picture.naturalHeight) / picture.naturalWidth));
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(picture, 0, 0, width, height);
    const rows = [context.getImageData(0, 0, width, 1).data, context.getImageData(0, height - 1, width, 1).data];
    const pixels = rows.flatMap((row) => Array.from({ length: width }, (_, x) => [row[x * 4]!, row[x * 4 + 1]!, row[x * 4 + 2]!]));
    const mean = [0, 1, 2].map((channel) => pixels.reduce((sum, pixel) => sum + pixel[channel]!, 0) / pixels.length);
    if (pixels.some((pixel) => pixel.some((value, channel) => Math.abs(value - mean[channel]!) > 12))) return undefined;
    return `rgb(${mean.map(Math.round).join(', ')})`;
  } catch {
    return undefined;
  }
}

function landingCard(entry: LandingEntry): HTMLElement {
  const card = entry.card!;
  const poster = card.poster ? landingBlobUrl(entry, card.poster) : undefined;
  const picture = poster ? landingEl('img', { loading: 'lazy', src: poster, alt: '' }) : undefined;
  const frame = picture && landingEl('span', { class: 'lposter' }, picture);
  // A poster wider than its box is drawn whole: a crop to fill would cut its sides. Its bands take the colour of its own
  // top and bottom edges when those are one colour, so a white page reads as one white card; else the card's background.
  if (picture && frame) {
    picture.addEventListener('load', () => {
      const box = frame.getBoundingClientRect();
      if (!(box.height > 0 && picture.naturalWidth / picture.naturalHeight > (box.width / box.height) * 1.05)) return;
      frame.classList.add('wide');
      const edge = landingEdgeColour(picture);
      if (edge) frame.style.background = edge;
    }, { once: true });
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
