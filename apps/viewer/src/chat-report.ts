// The right side of the chat page: the agent's own page (manifest.artifact) in a frame that runs nothing and loads only
// the recording's blobs, else the run's cited answer drawn here. A citation in either calls `open` with its address.
import type { ChatArtifact, ChatModel } from './chat-model.ts';
import type { Recording } from './format.ts';

type ReportChild = Node | string | undefined | false;

/** An element with its attributes (`text` sets its text; undefined or false leaves an attribute out) and children. */
export const reportEl = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | number | boolean | undefined> = {}, ...children: ReportChild[]) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name === 'text') node.textContent = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== undefined && child !== false) node.append(child);
  return node;
};

const REPORT_INLINE = /`([^`\n]+)`|\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__|(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g;

/** Inline markdown as nodes (bold, italic, inline code); everything else stays text. */
export function reportInline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  let at = 0;
  for (const match of text.matchAll(REPORT_INLINE)) {
    if (match.index > at) out.push(text.slice(at, match.index));
    const code = match[1];
    const strong = match[2] ?? match[3];
    const em = match[4] ?? match[5];
    if (code !== undefined) out.push(reportEl('code', { text: code }));
    else if (strong !== undefined) out.push(reportEl('strong', {}, ...reportInline(strong)));
    else out.push(reportEl('em', {}, ...reportInline(em ?? '')));
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Text in paragraphs (a blank line between), each with its inline markdown. */
export const reportParagraphs = (text: string) => text.split(/\n\s*\n/).filter((part) => part.trim() !== '').map((part) => reportEl('p', {}, ...reportInline(part.trim())));

/** A citation address's fragment as parameters: `page=3&xywh=percent:1,2,3,4`, `t=1260,1280`. A fragment written
 *  without its file or its '#' (`xywh=...`) reads the same. */
export const reportFragmentOf = (href: string) => {
  const at = href.indexOf('#');
  return new URLSearchParams((at >= 0 ? href.slice(at + 1) : /^[a-z]+=/.test(href) ? href : '').replace(/&amp;/g, '&'));
};

export const reportClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** A citation's address in a few words: the file's name, then the page or the second it points at. */
export function reportCiteLabel(href: string): string {
  const file = href.split('#')[0]!.split('/').at(-1) || href;
  const at = reportFragmentOf(href);
  const page = at.get('page');
  const t = at.get('t');
  return page ? `${file} p. ${page}` : t && Number.isFinite(parseFloat(t)) ? `${file} ${reportClock(parseFloat(t))}` : file;
}

/** A data: URL as an object URL, made once per blob: a frame's document then holds short addresses, and its policy names
 *  no data: source. Any other URL is made absolute. */
const reportObjectUrls = new Map<string, Promise<string | undefined>>();
function reportBlobUrl(recording: Recording, sha: string): Promise<string | undefined> {
  const url = recording.blobUrl(sha);
  if (!url) return Promise.resolve(undefined);
  if (!url.startsWith('data:')) return Promise.resolve(new URL(url, location.href).href);
  const key = `${recording.id}\n${sha}`;
  let held = reportObjectUrls.get(key);
  if (!held) {
    held = fetch(url).then((response) => response.blob()).then((blob) => URL.createObjectURL(blob)).catch(() => undefined);
    reportObjectUrls.set(key, held);
  }
  return held;
}

/** A file the agent's page carries, by its path there, as a URL a tab of this page may open; undefined when it carries
 *  none by that path. */
export function reportHeldFile(model: ChatModel, recording: Recording, path: string): Promise<string | undefined> {
  const files = model.artifact?.files ?? {};
  const sha = files[path] ?? files[`./${path}`];
  return sha ? reportBlobUrl(recording, sha) : Promise.resolve(undefined);
}

/** A reference in the artifact, relative to the file `from`, as the artifact file it names and its fragment; undefined
 *  for a reference that names no file it holds: another scheme or host, a path above its root, a name not in its files. */
export function reportFileOf(files: Record<string, string>, from: string, ref: string): { path: string; fragment: string } | undefined {
  const raw = ref.trim();
  if (raw === '' || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined;
  const cut = raw.search(/[?#]/);
  const named = cut < 0 ? raw : raw.slice(0, cut);
  const hash = raw.indexOf('#');
  const fragment = hash < 0 ? '' : raw.slice(hash);
  let decoded = named;
  try { decoded = decodeURIComponent(named); } catch { /* kept as written */ }
  const parts = decoded.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (parts.length === 0) return undefined; parts.pop(); } else parts.push(part);
  }
  const path = parts.join('/');
  return files[path] === undefined ? undefined : { path, fragment };
}

const REPORT_CSS_REF = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*?))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;

/** A style sheet with every url() and @import through the artifact's files: a local `#id` stays, anything else is dropped. */
async function reportCss(css: string, from: string, resolve: (from: string, ref: string) => Promise<string | undefined>): Promise<string> {
  const found = [...css.matchAll(REPORT_CSS_REF)].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
  const urls = await Promise.all(found.map((ref) => (ref.trim().startsWith('#') ? Promise.resolve(undefined) : resolve(from, ref))));
  let at = 0;
  return css.replace(REPORT_CSS_REF, (whole) => {
    const ref = found[at]!;
    const url = urls[at];
    at += 1;
    if (ref.trim().startsWith('#')) return whole;
    if (whole.startsWith('@')) return url ? `@import url("${url}")` : '@import url("about:invalid")';
    return url ? `url("${url}")` : 'none';
  });
}

const REPORT_DROPPED = 'script, base, meta[http-equiv], iframe, frame, frameset, object, embed, applet, portal';
const REPORT_FLASH = '[data-chat-flash]{outline:2px solid #ff8700;outline-offset:4px;animation:chat-flash 1.6s ease-out}@keyframes chat-flash{0%{background-color:#ff870040}100%{background-color:transparent}}';

/** The artifact's entry as a document that runs nothing and loads only its own files from the recording: every
 *  reference rewritten through `files`, every script and handler removed, a policy naming only the blobs' origins. */
export async function reportPage(artifact: ChatArtifact, recording: Recording, parser = new DOMParser()): Promise<{ html: string; looks: Set<string> } | undefined> {
  const files = Object.fromEntries(Object.entries(artifact.files).map(([path, sha]) => [path.replace(/^\.\//, ''), sha]));
  const entry = artifact.entry.replace(/^\.\//, '');
  const entrySha = files[entry];
  if (!entrySha) return undefined;
  const held = recording.heldText?.(entrySha);
  const entryUrl = recording.blobUrl(entrySha);
  const text = held ?? (entryUrl ? await fetch(entryUrl).then((response) => (response.ok ? response.text() : undefined)).catch(() => undefined) : undefined);
  if (text === undefined) return undefined;
  const origins = new Set<string>(['blob:']);
  const resolve = async (from: string, ref: string) => {
    const file = reportFileOf(files, from, ref);
    const url = file && await reportBlobUrl(recording, files[file.path]!);
    if (!url) return undefined;
    const parsed = new URL(url);
    origins.add(parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : parsed.protocol);
    return url + file.fragment;
  };

  const doc = parser.parseFromString(text, 'text/html');
  for (const node of doc.querySelectorAll(REPORT_DROPPED)) node.remove();
  const all = [...doc.querySelectorAll('*')];
  for (const node of all) for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || attr.name === 'ping') node.removeAttribute(attr.name);
  const jobs: Promise<void>[] = [];
  const through = (node: Element, name: string) => jobs.push(resolve(entry, node.getAttribute(name)!).then((url) => { if (url) node.setAttribute(name, url); else node.removeAttribute(name); }));
  for (const node of doc.querySelectorAll('[src]')) through(node, 'src');
  for (const node of doc.querySelectorAll('[poster]')) through(node, 'poster');
  for (const node of doc.querySelectorAll('[srcset]')) {
    const candidates = node.getAttribute('srcset')!.split(',').map((each) => each.trim()).filter(Boolean);
    jobs.push(Promise.all(candidates.map(async (candidate) => {
      const [ref = '', ...descriptor] = candidate.split(/\s+/);
      const url = await resolve(entry, ref);
      return url ? [url, ...descriptor].join(' ') : undefined;
    })).then((kept) => {
      const set = kept.filter((each): each is string => each !== undefined);
      if (set.length) node.setAttribute('srcset', set.join(', ')); else node.removeAttribute('srcset');
    }));
  }
  for (const node of doc.querySelectorAll('image, use, feImage')) {
    for (const name of ['href', 'xlink:href']) {
      const ref = node.getAttribute(name);
      if (ref !== null && !ref.trim().startsWith('#')) through(node, name);
    }
  }
  for (const node of doc.querySelectorAll('[style]')) jobs.push(reportCss(node.getAttribute('style')!, entry, resolve).then((css) => node.setAttribute('style', css)));
  for (const node of doc.querySelectorAll('style')) jobs.push(reportCss(node.textContent ?? '', entry, resolve).then((css) => { node.textContent = css; }));
  for (const link of doc.querySelectorAll('link')) {
    if (!/(^|\s)stylesheet(\s|$)/i.test(link.getAttribute('rel') ?? '')) { link.remove(); continue; }
    const file = reportFileOf(files, entry, link.getAttribute('href') ?? '');
    const url = file && recording.blobUrl(files[file.path]!);
    // A sheet is read and inlined, its own references resolved from its own path.
    jobs.push((url ? fetch(url).then((response) => (response.ok ? response.text() : undefined)).catch(() => undefined) : Promise.resolve(undefined)).then(async (css) => {
      if (css === undefined || !file) { link.remove(); return; }
      const style = doc.createElement('style');
      style.textContent = await reportCss(css, file.path, resolve);
      link.replaceWith(style);
    }));
  }
  await Promise.all(jobs);

  const sources = [...origins].join(' ');
  const policy = doc.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', `default-src 'none'; img-src ${sources}; media-src ${sources}; style-src 'unsafe-inline' ${sources}; font-src ${sources}`);
  const flash = doc.createElement('style');
  flash.textContent = REPORT_FLASH;
  doc.head.prepend(policy);
  doc.head.append(flash);
  const looks = new Set([...doc.querySelectorAll('[data-look]')].map((node) => node.getAttribute('data-look')!).filter(Boolean));
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, looks };
}

/** Where a click on a link in the artifact goes: a citation (a relative address, with or without a fragment) opens its
 *  source; `#id` scrolls inside the page; a web address opens in a new tab from this page; nothing else goes anywhere. */
export function reportLinkOf(href: string): 'inside' | 'cite' | 'web' | 'none' {
  const raw = href.trim();
  if (raw.startsWith('#')) return 'inside';
  if (/^https?:\/\//i.test(raw)) return 'web';
  if (raw === '' || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return 'none';
  return 'cite';
}

const reportFlash = (node: Element) => {
  node.removeAttribute('data-chat-flash');
  void (node as HTMLElement).offsetWidth;
  node.setAttribute('data-chat-flash', '');
  setTimeout(() => node.removeAttribute('data-chat-flash'), 1700);
};

/** Scrolls `scroller` (a window or an element) so `node` sits in its middle. */
const reportCenter = (scroller: Window | HTMLElement, node: Element) => {
  const box = node.getBoundingClientRect();
  if ('document' in scroller) scroller.scrollTo({ top: box.top + scroller.scrollY - scroller.innerHeight / 2 + box.height / 2 });
  else scroller.scrollTo({ top: box.top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight / 2 + box.height / 2 });
};

/** A cite that points somewhere: an address, or a look of the run. */
const reportCites = (cite: { href: string; look?: string }) => cite.href !== '' || cite.look !== undefined;

/** The run's answer, drawn here (cited, its submitted record, or its final message): each row with its chips, each chip
 *  opening the source it cites. */
function reportAnswer(pane: HTMLElement, model: ChatModel, recording: Recording, open: (href: string, look?: string) => void, none = 'This run has no report.') {
  const scroller = reportEl('div', { class: 'report' });
  const answer = model.answer;
  if (!answer) {
    scroller.append(reportEl('div', { class: 'pane' }, reportEl('p', { class: 'report-none', text: none }),
      reportEl('p', { class: 'report-none' }, reportEl('a', { href: `./?r=${encodeURIComponent(recording.id)}`, text: 'How this ran' }), ': every call, look and file of the run.')));
    pane.append(scroller);
    return { scroller, cited: new Set<string>() };
  }
  const cited = new Set<string>();
  const rows = answer.rows.map((row) => reportEl('li', { class: row.label === '' ? 'arow wide' : 'arow' },
    row.label !== '' && reportEl('span', { class: 'alabel', text: row.label }),
    reportEl('div', {}, ...reportParagraphs(row.text), row.cites.some(reportCites) && reportEl('div', { class: 'cites' }, ...row.cites.filter(reportCites).map((cite) => {
      if (cite.look) cited.add(cite.look);
      if (cite.item) cited.add(cite.item);
      const chip = reportEl('button', { class: 'cite', type: 'button', 'data-look': cite.look, 'data-item': cite.item, title: cite.href || undefined, text: reportCiteLabel(cite.href) || 'the look it cites' });
      chip.addEventListener('click', () => open(cite.href, cite.look));
      return chip;
    })))));
  scroller.append(reportEl('div', { class: 'pane' },
    reportEl('div', { class: 'kicker', text: answer.from === 'text' ? 'The run\'s final message' : 'The run\'s answer' }),
    reportEl('h1', { class: 'atitle', text: answer.title }),
    reportEl('ol', { class: 'arows' }, ...rows)));
  pane.append(scroller);
  return { scroller, cited };
}

/** The right side: the artifact when the run wrote one (the answer when it cannot be read), else the run's answer. A
 *  citation calls `open(href, look)`; `scrollToLook` scrolls to the first element citing that look (or the card a row
 *  cites, or an id) and flashes it; `cited` holds the looks and card ids the report cites once it is read. */
export function drawReport(pane: HTMLElement, model: ChatModel, recording: Recording, open: (href: string, look?: string) => void): { scrollToLook(look: string): boolean; cited: Promise<Set<string>> } {
  pane.replaceChildren();
  const native = (none?: string) => {
    const { scroller, cited } = reportAnswer(pane, model, recording, open, none);
    return {
      cited,
      scrollToLook(look: string) {
        const chip = scroller.querySelector(`[data-look="${CSS.escape(look)}"], [data-item="${CSS.escape(look)}"]`);
        const row = chip?.closest('.arow');
        if (!row) return false;
        reportCenter(scroller, row);
        reportFlash(row);
        return true;
      },
    };
  };
  if (!model.artifact) {
    const shown = native();
    return { scrollToLook: shown.scrollToLook, cited: Promise.resolve(shown.cited) };
  }
  const frame = reportEl('iframe', { class: 'report-frame', title: 'The page the agent wrote', sandbox: 'allow-same-origin' });
  pane.append(frame);
  let ready: Document | undefined;
  let wanted: string | undefined;
  let fallback: ReturnType<typeof native> | undefined;
  let looks: Set<string> | undefined;
  const find = (doc: Document, look: string) => doc.querySelector(`[data-look="${CSS.escape(look)}"]`) ?? doc.getElementById(look);
  const scrollToLook = (look: string): boolean => {
    if (fallback) return fallback.scrollToLook(look);
    if (!ready) { wanted = look; return looks ? looks.has(look) : true; }
    const node = find(ready, look);
    if (!node) return false;
    reportCenter(ready.defaultView!, node);
    reportFlash(node);
    return true;
  };
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc || doc.URL !== 'about:srcdoc') return;
    ready = doc;
    doc.addEventListener('click', (event) => {
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('href')!;
      const where = reportLinkOf(href);
      if (where === 'inside') {
        const id = decodeURIComponent(href.slice(1));
        const target = id ? doc.getElementById(id) ?? doc.getElementsByName(id)[0] : doc.body;
        if (target) target.scrollIntoView({ block: 'start' });
      } else if (where === 'cite') open(href, link.getAttribute('data-look') ?? undefined);
      else if (where === 'web') window.open(href, '_blank', 'noopener,noreferrer');
    });
    if (wanted) { const look = wanted; wanted = undefined; scrollToLook(look); }
  });
  const cited = reportPage(model.artifact, recording).then((page) => {
    if (!page) {
      frame.remove();
      fallback = native('The page the agent wrote could not be read from this recording.');
      if (wanted) fallback.scrollToLook(wanted);
      return fallback.cited;
    }
    looks = page.looks;
    frame.srcdoc = page.html;
    return page.looks;
  });
  return { scrollToLook, cited };
}
