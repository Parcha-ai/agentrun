// The gallery's landing: the site's own line about what a run does, then the featured runs as cards. Every card shows
// only what its run holds (the card the build wrote from it): its title, its question, and the poster the gallery's lock
// names among the run's own pictures. A run with no poster is a card of words.

/** A run's card, written by the build from the run itself; `rank` is its place in the gallery's lock. */
export type LandingCard = { title: string; line?: string; poster?: string; rank?: number };
type LandingEntry = { id: string; blobs: Record<string, string>; card?: LandingCard };

/** What AgentRun is, in the README's own sentence. */
const LANDING_DEFINITION = 'AgentRun is a workflow language for the agents you already run.';
const LANDING_LINE = 'Ask a question about a film, a document or a pile of photos. One agent reads them and shows you where every answer comes from.';
const LANDING_SUB = 'It writes code to look, listen and check; Jev judges what it finds; every run ends with the agent\'s own report, each line citing the page, second or region it rests on.';
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

/** The runs the lock features, in its order. */
export const landingFeatured = <E extends LandingEntry>(entries: readonly E[]): E[] =>
  entries.filter((entry) => typeof entry.card?.rank === 'number').sort((a, b) => a.card!.rank! - b.card!.rank!);

/** A blob of a bundled run as an address this page can load: embedded, a data: URL; shipped as files, its path in the
 *  run's directory beside the page. */
const landingBlobUrl = (entry: LandingEntry, sha: string): string | undefined => {
  const at = entry.blobs[sha];
  return at === undefined ? undefined : new URL(at, new URL(`recordings/${encodeURIComponent(entry.id)}/`, location.href)).href;
};

function landingCard(entry: LandingEntry): HTMLElement {
  const card = entry.card!;
  const poster = card.poster ? landingBlobUrl(entry, card.poster) : undefined;
  return landingEl('a', { class: poster ? 'lcard' : 'lcard words', href: `chat.html?r=${encodeURIComponent(entry.id)}`, 'data-id': entry.id },
    poster && landingEl('span', { class: 'lposter' }, landingEl('img', { loading: 'lazy', src: poster, alt: '' })),
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
    featured.length > 0 && landingEl('div', { class: 'lcards' }, ...featured.map(landingCard)));
  // Posters within a screen and a half of the top load at once; the rest when they come into view.
  requestAnimationFrame(() => {
    for (const img of section.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')) {
      if (img.getBoundingClientRect().top < innerHeight * 1.5) img.loading = 'eager';
    }
  });
  return section;
}
