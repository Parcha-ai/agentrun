// The page: load a recording, draw its timeline and counters, and replay it. Everything on screen at a stop is a
// reduce of the lines before that stop; the DOM is redrawn from those reduces, never patched by events.
import { FORMAT, parseLines, processOf, under, validate, type Json, type Line, type Manifest, type Recording } from './format.ts';
import { askedTwiceLabel, counterFold, countersOf, repeatedLabel, type Counters } from './counters.ts';
import { lanesOf, type Lanes, type Span } from './lanes.ts';
import { animatedPanels, featuredPanel, panelsFor, type BaselineView, type Node, type Panel, type Props, type ViewContext } from './panels.ts';
import { frameFold, gapTitle, pictureAt, type FrameState } from './frames.ts';
import { nextStop, playback, previousStop, reduceTo, snap, stopAt, stopsOf, linkedTime, timeParam, type Fold } from './replay.ts';
import { citeStop } from './cite.ts';
import { workflowMapPanel } from './workflow-map.ts';
import { opensInPage, typeOfName } from './blobs.ts';
import { readAllEntries } from './folder.ts';
import { diskPanel } from './disk.ts';
import { transportPanel } from './transport.ts';
import { visionPanel } from './vision.ts';

/** A bundled recording: embedded in gallery.js (its lines, and each blob as a data: URL), or, in a build that ships
 *  recordings as files, listed in `recordings/index.json` (each blob as its path in the recording's directory). */
type GalleryEntry = { id: string; manifest: Manifest; events: string; blobs: Record<string, string> };
type IndexEntry = { id: string; manifest: Manifest; blobs: Record<string, string> };
declare const window: Window & { AGENTRUN_GALLERY?: GalleryEntry[]; AGENTRUN_GALLERY_INDEX?: string };

const BLOB_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'json', 'html', 'md', 'txt', 'pdf', 'sqlite'];
const SPEEDS = [0.5, 1, 2, 4, 10];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: { class?: string; text?: string; title?: string } = {}, ...children: (globalThis.Node | string)[]) => {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const child of children) node.append(child);
  return node;
};
const svgEl = (tag: string, attrs: Record<string, string | number>) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
};

/** A link to a blob: a passive type opens in a new tab, anything else (a page, an SVG, an unknown type) downloads, so
 *  a recording's file never runs with the viewer's origin. A fragment (`page=2`, `t=30`) is where in the file it opens. */
function blobLink(recording: Recording, sha: string, text: string, className: string, fragment?: string): HTMLAnchorElement | undefined {
  const url = recording.blobUrl(sha);
  if (!url) return undefined;
  const at = fragment?.replace(/^#/, '');
  const link = Object.assign(el('a', { class: className, text }), { href: at ? `${url.split('#')[0]}#${encodeURI(at)}` : url, rel: 'noopener' });
  if (opensInPage(recording.blobType(sha))) link.target = '_blank';
  else link.download = sha;
  return link;
}

// ---- loading ---------------------------------------------------------------------------------------------------

/** A recording the index lists: its lines fetched from its directory, each blob at the path the index names. */
async function fromIndex(entry: IndexEntry, root: string): Promise<Recording> {
  const lines = parseLines(await (await fetch(`${root}events.jsonl`)).text());
  const urls = Object.fromEntries(Object.entries(entry.blobs).map(([sha, path]) => [sha, new URL(path, root).href]));
  return { id: entry.id, manifest: entry.manifest, lines, blobUrl: (sha) => urls[sha], blobType: (sha) => (urls[sha] ? typeOfName(urls[sha]!) : undefined) };
}

/** The bundled recordings: embedded in gallery.js, or listed in the index a files build ships beside them, read once and
 *  only when something needs them (a gallery, a `?r=`, a bundled baseline). */
let bundled: Promise<(GalleryEntry | IndexEntry)[]> | undefined;
const bundledRecordings = () => (bundled ??= window.AGENTRUN_GALLERY ? Promise.resolve(window.AGENTRUN_GALLERY)
  : window.AGENTRUN_GALLERY_INDEX ? fetch(window.AGENTRUN_GALLERY_INDEX).then((response) => {
    if (!response.ok) throw new Error(`${window.AGENTRUN_GALLERY_INDEX} answered ${response.status}`);
    return response.json() as Promise<IndexEntry[]>;
  }) : Promise.resolve([]));
const isEmbedded = (each: GalleryEntry | IndexEntry): each is GalleryEntry => 'events' in each && typeof each.events === 'string';
/** A bundled recording, opened from gallery.js or fetched from its directory beside the page, with that directory. */
async function openBundled(entry: GalleryEntry | IndexEntry): Promise<{ recording: Recording; dir: string }> {
  const dir = new URL(`recordings/${entry.id}/`, location.href).href;
  return { recording: isEmbedded(entry) ? fromGallery(entry) : await fromIndex(entry, dir), dir };
}

function fromGallery(entry: GalleryEntry): Recording {
  return { id: entry.id, manifest: entry.manifest, lines: parseLines(entry.events), blobUrl: (sha) => entry.blobs[sha],
    blobType: (sha) => /^data:([^;,]+)/.exec(entry.blobs[sha] ?? '')?.[1] };
}

/** Every blob a recording names: its lines', its images', its result's. */
export function blobsNamed(manifest: Manifest, lines: Line[]): string[] {
  const named = new Set<string>([manifest.result?.blob, manifest.job?.blob, manifest.store?.blob].filter((sha): sha is string => sha !== undefined));
  for (const line of lines) {
    for (const sha of line.blobs ?? []) named.add(sha);
    for (const match of JSON.stringify(line.data).matchAll(/"blob":"([0-9a-f]{64})"/g)) named.add(match[1]!);
  }
  return [...named];
}

async function fromUrl(base: string): Promise<Recording> {
  const root = base.endsWith('/') ? base : `${base}/`;
  const manifest = await (await fetch(`${root}manifest.json`)).json() as Manifest;
  const lines = parseLines(await (await fetch(`${root}events.jsonl`)).text());
  // blobs/<sha>.<ext>: the line names the hash, so the extension is found by asking.
  const urls: Record<string, string> = {};
  await Promise.all(blobsNamed(manifest, lines).map(async (sha) => {
    for (const ext of BLOB_TYPES) {
      const url = `${root}blobs/${sha}.${ext}`;
      if ((await fetch(url, { method: 'HEAD' }).catch(() => undefined))?.ok) { urls[sha] = url; return; }
    }
  }));
  return { id: root, manifest, lines, blobUrl: (sha) => urls[sha], blobType: (sha) => (urls[sha] ? typeOfName(urls[sha]!) : undefined) };
}

async function fromFiles(files: File[]): Promise<Recording> {
  const byPath = new Map(files.map((file) => [(file.webkitRelativePath || file.name).split('/').slice(-2).join('/'), file]));
  const find = (name: string) => [...byPath].find(([path]) => path === name || path.endsWith(`/${name}`))?.[1];
  const manifestFile = find('manifest.json');
  const eventsFile = find('events.jsonl');
  if (!manifestFile || !eventsFile) throw new Error('The folder needs manifest.json and events.jsonl.');
  const urls: Record<string, string> = {};
  const types: Record<string, string> = {};
  for (const [path, file] of byPath) {
    const name = path.split('/').at(-1)!;
    if (!path.startsWith('blobs/')) continue;
    const sha = name.split('.')[0]!;
    types[sha] = typeOfName(name) ?? (file.type || 'application/octet-stream');
    // A blob URL has the viewer's origin: a page in one must never render, so an active type becomes opaque bytes.
    urls[sha] = URL.createObjectURL(opensInPage(types[sha]) || types[sha]!.startsWith('image/') ? file : new Blob([file], { type: 'application/octet-stream' }));
  }
  return { id: 'dropped', manifest: JSON.parse(await manifestFile.text()) as Manifest, lines: parseLines(await eventsFile.text()), blobUrl: (sha) => urls[sha], blobType: (sha) => types[sha] };
}

// ---- the player state ------------------------------------------------------------------------------------------

type Player = {
  recording: Recording;
  stops: boolean[];
  lanes: Lanes;
  p: number;
  focus?: string;
  cite?: string;
  playing: boolean;
  speed: number;
  clock: number;
};

/** A fold's state at `p`, from the nearest kept state before it: scrubbing is replaying. */
function cachedReduce<S>(fold: Fold<S>, lines: Line[], p: number, cache: Map<number, S>): S {
  const every = 256;
  let from = Math.floor(p / every) * every;
  while (from > 0 && !cache.has(from)) from -= every;
  let state = from > 0 ? cache.get(from)! : fold.init();
  for (let index = from; index < p; index += 1) {
    const line = lines[index]!;
    if (fold.accepts(line)) state = fold.reduce(state, line);
    if ((index + 1) % every === 0 && !cache.has(index + 1)) cache.set(index + 1, state);
  }
  return state;
}

// ---- drawing -------------------------------------------------------------------------------------------------

/** The strip. `measured`: the recording has durable lines; without them every count from the store is not measured
 *  and cost is unknown, never 0 (processes and kills still come from the supervisor's lines). */
/** The cost on the strip: unknown when it is; a scripted run (its manifest's `providers`: at least one priced part was a
 *  fake, a cassette or a script) says so, and its zero is "$0", never "$0.0000", since that is not a provider's bill; a
 *  real run's in dollars to four places. */
export const costLabel = (cost: number | null, lowerBound: boolean, providers?: 'real' | 'scripted'): string => {
  if (cost === null) return 'unknown';
  const dollars = providers === 'scripted' && cost === 0 ? '$0' : `$${cost.toFixed(4)}`;
  return `${lowerBound ? 'at least ' : ''}${providers === 'scripted' ? `scripted, ${dollars}` : dollars}`;
};

function drawCounters(counters: Counters, measured = counters.measured, providers?: 'real' | 'scripted'): HTMLElement {
  const reasked = counters.modelTurns.reasked;
  const item = (label: string, value: string, title: string, extra = '') => el('div', { class: `counter${extra}`, title }, el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label }));
  const stored = (label: string, value: string, title: string, extra = '') => (measured ? item(label, value, title, extra)
    : item(label, 'not measured', 'This recording has no durable lines: nothing from the store can be counted.'));
  return el('div', { class: 'counters' },
    stored('paid calls made', String(counters.paid.total), `Workflow effects completed: ${counters.paid.workflow}. Agent receipts: ${counters.paid.agent}. Vision looks paid: ${counters.paid.vision}.`),
    stored('looks paid', `${counters.paid.vision}${counters.vision.possible ? ` + ${counters.vision.possible} possible` : ''}`,
      `Looks the eyes answered and billed, per look key${counters.vision.native ? `; ${counters.vision.native} the lead looked at itself, which charge nothing` : ''}.${counters.vision.possible ? ` ${counters.vision.possible} more possible: a look started in a process that ended before filing it, so no durable line shows whether it was paid, and the cost is a lower bound.` : ''}`),
    stored('repeated', `${repeatedLabel(counters)}${counters.pageActions.possible ? ` + ${counters.pageActions.possible} possible` : ''}`,
      `An applied call in a later process than an earlier applied one.${counters.repeatedNotMeasured > 0 ? ` ${counters.repeatedNotMeasured} effects report no calls: their repeats are not measured, never shown as 0.` : ''}${counters.pageActions.possible ? ` ${counters.pageActions.possible} more possible: a browser page action dispatched again after one that never showed reaching the page, so no durable line says whether it was applied twice.` : ''}${counters.pageActions.measured ? '' : ' The browser\'s page actions are not measured: its session records are an export\'s, which keeps only their latest revision.'}`,
      counters.repeated > 0 ? ' alarm' : ''),
    stored('asked twice', askedTwiceLabel(counters), `A call dispatched twice in one process: the model asking again.${counters.pageActions.measured ? '' : ' The browser\'s page actions are not measured: its session records are an export\'s.'}`),
    stored(counters.inFlight > 0 ? 'unknown (in flight)' : 'unknown', counters.inFlight > 0 ? `${counters.unknown} (${counters.inFlight})` : String(counters.unknown), 'Effects admitted and never completed.'),
    stored('judge asks', String(counters.judge.answered + counters.judge.failed), `Answered ${counters.judge.answered}, failed ${counters.judge.failed}, re-asked ${counters.judge.reasked}.`),
    stored('model turns', String(counters.modelTurns.committed), 'Committed assistant turns.'),
    stored('re-asks', reasked === null ? 'not measured'
      : `${reasked.proven.reasks}${reasked.proven.reasks ? ` over ${reasked.proven.turns} turn${reasked.proven.turns === 1 ? '' : 's'}` : ''}${reasked.possible.reasks ? ` + ${reasked.possible.reasks} possible` : ''}`,
      reasked === null
        ? 'No ask start was committed to this run\'s pi.live (or its version is not one this viewer knows), so a turn asked again cannot be shown.'
        : 'Extra asks after a kill cut an ask, each counted once: proven when the cut ask had committed a partial (the model was answering), possible when only its start (the process may have died before calling the model). Only proven ones count.',
      reasked?.proven.reasks ? ' alarm' : ''),
    item('processes', String(counters.processes), 'From the supervisor\'s process lines.'),
    item('kills', String(counters.kills), 'From the supervisor\'s kill lines.'),
    item('cost', costLabel(counters.cost, counters.costLowerBound, providers),
      `Unknown until a durable line prices a part, and when any priced part is unknown: never shown as $0.${counters.costLowerBound ? ' A lower bound: a possible look payment is not in it.' : ''}${providers === 'scripted' ? ' Scripted: at least one priced part was served by a fake, a cassette or a script, so this is not a provider\'s bill, though it may include real charges for the other parts.' : ''}`),
    stored('journal opens', String(counters.journalOpens), 'A fact of the store: agentrun.driver\'s generation. It counts journal opens, which can exceed processes.', ' fact'),
  );
}

function drawTimeline(player: Player, onScrub: (t: number) => void, onFocus: (path: string) => void): SVGSVGElement {
  const { lanes } = player;
  const width = 1000;
  const rows = [{ name: 'process', y: 18 }, { name: 'calls', y: 70 }, { name: 'model turns', y: 120 }];
  const svg = svgEl('svg', { viewBox: `0 0 ${width} 160`, class: 'timeline', role: 'img', 'aria-label': 'The run over time' }) as SVGSVGElement;
  const x = (t: number) => 90 + (lanes.end > 0 ? (t / lanes.end) * (width - 100) : 0);
  for (const row of rows) {
    const label = svgEl('text', { x: 4, y: row.y + 14, class: 'lane-label' });
    label.textContent = row.name;
    svg.append(label, svgEl('line', { x1: 90, x2: width - 10, y1: row.y + 26, y2: row.y + 26, class: 'lane-rule' }));
  }
  for (const band of lanes.processes) {
    const rect = svgEl('rect', { x: x(band.from), y: 18, width: Math.max(2, x(band.to) - x(band.from)), height: 22, rx: 4, class: `band band-${band.process % 4}` });
    const title = svgEl('title', {}); title.textContent = `process ${band.process}`; rect.append(title);
    svg.append(rect);
    const name = svgEl('text', { x: x(band.from) + 6, y: 33, class: 'band-label' }); name.textContent = `process ${band.process}`;
    svg.append(name);
    if (band.kill) {
      // The label in full where it fits before the next kill; else the kill's number, with the label on hover.
      const full = `killed: ${band.kill.label}`;
      const next = lanes.processes.find((other) => other.kill && other.kill.t > band.kill!.t)?.kill?.t;
      const fits = next === undefined ? x(band.kill.t) + full.length * 6.5 < width : x(next) - x(band.kill.t) > full.length * 6.5 + 10;
      const mark = svgEl('rect', { x: x(band.kill.t), y: 14, width: 3, height: 30, class: 'kill' });
      const hover = svgEl('title', {}); hover.textContent = `${full}${band.kill.crossing ? ` (crossing ${band.kill.crossing})` : ''}`; mark.append(hover);
      svg.append(mark);
      const label = svgEl('text', { x: x(band.kill.t) + 6, y: 56, class: 'kill-label' });
      label.textContent = fits ? full : `k${band.process}`;
      label.append(hover.cloneNode(true));
      svg.append(label);
    }
  }
  for (const restore of lanes.restores) {
    svg.append(svgEl('line', { x1: x(restore.t), x2: x(restore.t), y1: 8, y2: 156, class: 'restore' }));
    const label = svgEl('text', { x: x(restore.t) + 4, y: 66, class: 'restore-label' });
    label.textContent = `restored to commit ${restore.to}: what came after it is a lost branch`;
    svg.append(label);
  }
  for (const open of lanes.opens) {
    const tick = svgEl('rect', { x: x(open.t), y: 41, width: 1.5, height: 6, class: 'open-tick' });
    const title = svgEl('title', {}); title.textContent = `journal opened (generation ${open.generation})`; tick.append(title);
    svg.append(tick);
  }
  const spans = (list: Span[], y: number) => list.forEach((span, index) => {
    const from = x(span.from);
    const to = span.to === undefined ? x(lanes.end) : x(span.to);
    const rect = svgEl('rect', { x: from, y: y + (index % 3) * 6, width: Math.max(3, to - from), height: 5, rx: 2, class: `span ${span.status}${span.path ? ' has-path' : ''}` });
    const title = svgEl('title', {}); title.textContent = `${span.label}${span.path ? ` at ${span.path}` : ''} (${span.status})`; rect.append(title);
    if (span.path) rect.addEventListener('click', (event) => { event.stopPropagation(); onFocus(span.path!); });
    svg.append(rect);
  });
  spans(lanes.calls, 76);
  spans(lanes.turns, 126);
  const t = player.p > 0 ? player.recording.lines[player.p - 1]!.t : 0;
  svg.append(svgEl('line', { x1: x(t), x2: x(t), y1: 8, y2: 156, class: 'playhead' }));
  svg.addEventListener('click', (event) => {
    const box = svg.getBoundingClientRect();
    const at = ((event.clientX - box.left) / box.width) * width;
    onScrub(Math.max(0, ((at - 90) / (width - 100)) * lanes.end));
  });
  return svg;
}

/** A node's `vars` as CSS custom properties: numbers only, a name never a style string. */
export function applyVars(target: { style: { setProperty(name: string, value: string): void } }, vars: Record<string, number> | undefined): void {
  for (const [name, value] of Object.entries(vars ?? {})) if (/^[a-z][a-z0-9-]*$/i.test(name) && typeof value === 'number' && Number.isFinite(value)) target.style.setProperty(`--${name}`, String(value));
}

function renderNode(node: Node, player: Player, frames: FrameState, t: number, onFocus: (path: string) => void, onCite: (cite: string) => void): globalThis.Node {
  if (typeof node === 'string') return document.createTextNode(node);
  if (node.tag === 'img' && 'blob' in node) {
    const url = player.recording.blobUrl(node.blob);
    return url ? Object.assign(el('img', { class: node.class ?? 'blob' }), { src: url, alt: node.alt }) : el('span', { class: 'missing', text: `[${node.alt}: not in this recording]` });
  }
  if (node.tag === 'a' && 'href' in node) {
    // A page outside the recording: linked only when it is a web address, and opened apart from the viewer.
    const web = URL.canParse(node.href) && ['http:', 'https:'].includes(new URL(node.href).protocol);
    return web ? Object.assign(el('a', { class: node.class ?? 'blob', text: node.text }), { href: node.href, target: '_blank', rel: 'noopener noreferrer' }) : el('span', { class: node.class ?? 'blob', text: node.text });
  }
  if (node.tag === 'a' && 'blob' in node && 'text' in node) {
    return blobLink(player.recording, node.blob, node.text, node.class ?? 'blob', 'fragment' in node ? node.fragment : undefined) ?? el('span', { class: 'missing', text: `[${node.text}: not in this recording]` });
  }
  if (node.tag === 'frame' && 'session' in node) {
    const picture = pictureAt(frames, node.session, t);
    if (picture.kind === 'track') {
      const url = player.recording.blobUrl(picture.blob);
      const video = Object.assign(el('video', { class: 'frame' }), { muted: true, src: url ?? '' });
      video.addEventListener('loadedmetadata', () => { video.currentTime = picture.offset; });
      return video;
    }
    if (picture.kind === 'frame') {
      const url = player.recording.blobUrl(picture.blob);
      return Object.assign(el('img', { class: 'frame' }), { src: url ?? '', alt: `session ${node.session}` });
    }
    if (picture.kind === 'gap') {
      const title = gapTitle(picture.detail);
      return el('div', { class: 'frame gap', text: `no picture: ${picture.reason.replaceAll('_', ' ')}`, ...(title ? { title } : {}) });
    }
    return el('div', { class: 'frame none', text: 'no picture yet' });
  }
  const props = node as { tag: string; children?: Node[] } & Props;
  const out = document.createElement(props.tag);
  if (props.class) out.className = props.class;
  if (props.title) out.title = props.title;
  applyVars(out, props.vars);
  if (props.path) {
    out.classList.add('has-path');
    if (player.focus && under(props.path, player.focus)) out.classList.add('focused');
  }
  // A click on a node that names a citation selects it; one that names only a path focuses it.
  if (props.cite !== undefined) {
    const cite = props.cite;
    Object.assign(out, { tabIndex: 0 });
    out.setAttribute('role', 'button');
    out.classList.add('has-cite');
    out.addEventListener('click', (event) => { event.stopPropagation(); onCite(cite); });
    out.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onCite(cite); } });
  } else if (props.path) out.addEventListener('click', (event) => { event.stopPropagation(); onFocus(props.path!); });
  if (props.box) {
    // Only numbers reach the style: a recording's strings never do.
    const percent = (value: number) => `${Math.min(100, Math.max(0, Number(value) || 0))}%`;
    Object.assign(out.style, { position: 'absolute', left: percent(props.box.x), top: percent(props.box.y), width: percent(props.box.w), height: percent(props.box.h) });
  }
  for (const child of props.children ?? []) out.append(renderNode(child, player, frames, t, onFocus, onCite));
  return out;
}

/** An element's place under `root`, as each step's tag, first class and rank among its siblings of both: the same place
 *  in the next draw of the same view. */
export function placeKey(node: Element, root: Element): string {
  const steps: string[] = [];
  for (let at: Element | null = node; at && at !== root; at = at.parentElement) {
    const kind = `${at.tagName}.${at.classList[0] ?? ''}`;
    steps.push(`${kind}:${at.parentElement ? [...at.parentElement.children].filter((sibling) => `${sibling.tagName}.${sibling.classList[0] ?? ''}` === kind).indexOf(at) : 0}`);
  }
  return steps.reverse().join('/');
}

/** Where the reader is in the panels, by place only: each scrolled element's offsets, the `details` they opened, and the element with the keyboard
 *  focus. A place is `placeKey`: the element's tag and class among its siblings, so an element added elsewhere does not move it. */
export function placeIn(root: HTMLElement): { scrolls: Map<string, [number, number]>; opened: Set<string>; focus?: string } {
  const all = [...root.querySelectorAll('*')];
  const scrolls = new Map(all.filter((node) => node.scrollTop > 0 || node.scrollLeft > 0).map((node): [string, [number, number]] => [placeKey(node, root), [node.scrollTop, node.scrollLeft]]));
  const opened = new Set(all.filter((node) => node.tagName === 'DETAILS' && (node as HTMLDetailsElement).open).map((node) => placeKey(node, root)));
  const active = document.activeElement;
  return { scrolls, opened, ...(active && active !== root && root.contains(active) ? { focus: placeKey(active, root) } : {}) };
}

/** A redraw keeps the reader's place: the scroll offsets, the `details` they opened, and the focus on the element at the place it was, without
 *  scrolling it into view. Used for the full redraw at a stop and for the in-place redraw between stops. */
export function restorePlace(root: HTMLElement, place: ReturnType<typeof placeIn>) {
  const all = [...root.querySelectorAll('*')];
  for (const node of all) {
    if (node.tagName === 'DETAILS' && place.opened.has(placeKey(node, root))) (node as HTMLDetailsElement).open = true;
    if (place.scrolls.size && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) {
      const offsets = place.scrolls.get(placeKey(node, root));
      if (offsets) [node.scrollTop, node.scrollLeft] = offsets;
    }
  }
  if (place.focus !== undefined) (all.find((node) => placeKey(node, root) === place.focus) as HTMLElement | undefined)?.focus({ preventScroll: true });
}

/** The JSON blobs a recording's result names (the manifest's and each `result` line's), parsed. One that does not load
 *  or parse is left out, and the views say they cannot read it. */
async function resultJson(recording: Recording): Promise<Map<string, Json>> {
  const named = new Set<string>(recording.manifest.result ? [recording.manifest.result.blob] : []);
  for (const line of recording.lines) {
    const blob = line.source === 'host' && line.kind === 'result' ? (line.data as { blob?: unknown } | null)?.blob : undefined;
    if (typeof blob === 'string') named.add(blob);
  }
  const parsed = new Map<string, Json>();
  await Promise.all([...named].map(async (sha) => {
    const url = recording.blobUrl(sha);
    if (!url || recording.blobType(sha)?.split(';')[0] !== 'application/json') return;
    try { parsed.set(sha, await (await fetch(url)).json() as Json); } catch { /* not readable here */ }
  }));
  return parsed;
}

// ---- the page --------------------------------------------------------------------------------------------------

/** The baseline the manifest names: another real recording, opened beside this one, its counters at its end. */
async function baselineOf(recording: Recording, base: string | undefined): Promise<BaselineView | undefined> {
  const named = recording.manifest.baseline;
  if (!named) return undefined;
  const id = named.recording.replace(/\/$/, '').split('/').at(-1)!;
  const entry = (await bundledRecordings().catch(() => [])).find((each) => each.id === id || each.id === named.recording);
  const other = entry ? (await openBundled(entry)).recording : base ? await fromUrl(new URL(named.recording, base).href) : undefined;
  if (!other) return undefined;
  return baselineViewOf(named.label, other);
}

/** The baseline a panel's view gets: another recording's label, its counters at its end, how long it ran, and the providers its manifest says. */
export function baselineViewOf(label: string, other: Recording): BaselineView {
  const ms = Date.parse(other.manifest.recorded.ended) - Date.parse(other.manifest.recorded.started);
  return { label, counters: countersOf(reduceTo(counterFold, other.lines, other.lines.length), true), ms: Number.isFinite(ms) ? ms : null,
    ...(other.manifest.providers ? { providers: other.manifest.providers } : {}) };
}

/** What the shell hands a panel's view at a stop: the time, the run's own providers (`real` or `scripted`) when its manifest says, and
 *  the view inputs it holds: the focus, the baseline the manifest names, the selected citation, the result's JSON blobs read so far, and the
 *  playback clock (`now`, the time of the point at a stop). */
export function viewContext(t: number, manifest: Manifest, inputs: { focus?: string; baseline?: BaselineView; cite?: string; json?: Map<string, Json>; now?: number } = {}): ViewContext {
  const { focus, baseline, cite, json, now } = inputs;
  return { t, now: now ?? t, ...(focus ? { focus } : {}), ...(baseline ? { baseline } : {}), ...(manifest.providers ? { providers: manifest.providers } : {}),
    ...(cite !== undefined ? { cite } : {}), ...(json ? { json: (sha: string) => json.get(sha) } : {}) };
}

/** The chapter a point is in: the one with the greatest stop at or before it (a manifest's chapters keep the order it
 *  declares, which need not be the order of their stops), by its index in that list, or -1 before every chapter. */
export const chapterAt = (chapters: readonly { p: number }[], p: number): number =>
  chapters.reduce((at, chapter, index) => (chapter.p <= p && (at < 0 || chapter.p >= chapters[at]!.p) ? index : at), -1);

/** The embed protocol (PANELS.md, "Embedding"): what a framed viewer posts to the page that frames it. */
export const embedMessage = (type: 'ready' | 'position' | 'focus', body: Record<string, Json>) => ({ source: 'agentrun-viewer', type, ...body });

/** The origin of the page that frames this one, when the browser says what it is (an http or https page); else `*`, as
 *  for a page opened from a file. */
export const parentOrigin = (ancestor: string | undefined, referrer: string): string => {
  const known = ancestor ?? (referrer ? new URL(referrer).origin : undefined);
  return known !== undefined && /^https?:\/\//.test(known) ? known : '*';
};

/** The origin a framing page names with `&parent=`: an http or https origin, written as one. Only it may steer the viewer. */
export const parentParam = (value: string | null): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.origin === value ? url.origin : undefined;
  } catch { return undefined; }
};

/** A command a framing page may send: seek (to a stop, a commit of a generation, or a time in seconds), focus (a workflow
 *  path, or none), or theme. */
export type Steer = { type: 'seek'; stop: number } | { type: 'seek'; commit: number; gen?: number } | { type: 'seek'; t: number }
  | { type: 'focus'; path: string | null } | { type: 'theme'; theme: 'light' | 'dark' | 'auto' };

/** A message as a command the viewer obeys, each field checked; anything else (another type, a field of the wrong kind,
 *  a stop past the end, a path that is not a workflow path) is nothing. A message never carries code to run. */
export function steerOf(data: unknown, last: number): Steer | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const message = data as Record<string, unknown>;
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const only = (...keys: string[]) => Object.keys(message).every((key) => key === 'type' || key === 'source' || keys.includes(key));
  if (message.type === 'seek') {
    if (only('stop') && whole(message.stop) && message.stop <= last) return { type: 'seek', stop: message.stop };
    if (only('commit', 'gen') && whole(message.commit) && (message.gen === undefined || whole(message.gen))) return { type: 'seek', commit: message.commit, ...(message.gen === undefined ? {} : { gen: message.gen as number }) };
    if (only('t') && typeof message.t === 'number' && Number.isFinite(message.t) && message.t >= 0) return { type: 'seek', t: message.t };
    return undefined;
  }
  if (message.type === 'focus' && only('path')) {
    if (message.path === null) return { type: 'focus', path: null };
    if (typeof message.path === 'string' && message.path.length <= 512 && /^\/[\w./:#-]*$/.test(message.path)) return { type: 'focus', path: message.path };
    return undefined;
  }
  if (message.type === 'theme' && only('theme') && (message.theme === 'light' || message.theme === 'dark' || message.theme === 'auto')) return { type: 'theme', theme: message.theme };
  return undefined;
}

/** A message may steer the viewer only when it comes from the framing page itself, at the origin its URL named. */
export const fromParent = (origin: string, isParent: boolean, allowed: string | undefined): boolean => allowed !== undefined && isParent && origin === allowed;

function play(recording: Recording, root: HTMLElement, params: URLSearchParams, base?: string) {
  const problems = validate(recording.manifest, recording.lines);
  const player: Player = { recording, stops: stopsOf(recording.lines), lanes: lanesOf(recording.lines), p: 0, playing: false, speed: 1, clock: 0 };
  const caches = new Map<unknown, Map<number, unknown>>();
  const cacheOf = (key: unknown) => caches.get(key) ?? caches.set(key, new Map()).get(key)!;
  const lines = recording.lines;
  const last = lines.length;
  const atParam = params.get('at');
  const citeParam = params.get('cite');
  /** The stop just after a commit, of a generation when given (a restore reuses commit numbers). */
  const afterCommit = (commit: number, gen?: number) => {
    const at = lines.findLastIndex((line) => line.channel === 'durable' && line.commit === commit && (gen === undefined || line.gen === gen));
    return at >= 0 ? snap(player.stops, at + 1) : 0;
  };
  if (atParam !== null) {
    const [first, second] = atParam.split(':').map(Number);
    player.p = second === undefined ? afterCommit(first!) : afterCommit(second, first);
  } else if (citeParam !== null) player.p = citeStop(lines, citeParam) ?? 0;
  else player.p = last;
  // Only a seek sets the playback clock; playing advances it (a redraw never does).
  const head = playback(lines, player.stops);
  player.p = head.seek(player.p);
  // `?t=<seconds>` opens at that time (it wins over `at` and `cite`): a link that shows the same moment to whoever opens it.
  const opened = timeParam(params.get('t'));
  if (opened !== undefined) player.p = head.seekTime(opened);
  player.focus = params.get('focus') ?? undefined;
  player.cite = citeParam ?? undefined;
  let json: Map<string, Json> | undefined;

  // The manifest's chapters when it names them; else each process start, each kill, and the end.
  const chapters: { title: string; p: number; focus?: string }[] = recording.manifest.chapters
    ? recording.manifest.chapters.map((chapter) => ({ title: chapter.title, p: afterCommit(chapter.at.commit, chapter.at.gen), ...(chapter.focus ? { focus: chapter.focus } : {}) }))
    : [
      ...lines.flatMap((line, index) => (line.source === 'host' && line.kind === 'process.started' ? [{ title: `process ${processOf(line)} starts`, p: index + 1 }] : [])),
      ...lines.flatMap((line, index) => (line.source === 'host' && line.kind === 'kill' ? [{ title: `killed: ${(line.data as { label?: string }).label ?? ''}`, p: snap(player.stops, index) }] : [])),
      { title: 'the end', p: last },
    ].sort((a, b) => a.p - b.p);
  // After a restore a commit number names two commits (3.2), so the position says whose.
  const restored = player.lanes.restores.length > 0;
  // With no durable line anywhere, nothing from the store is measured; before a recording's first one, its zeros are true.
  const measured = lines.some((line) => line.channel === 'durable');
  let baseline: BaselineView | undefined;
  const baselineRow = el('div', { class: 'baseline' });

  const header = el('header', {}, el('h1', { text: recording.manifest.title }), el('p', { class: 'meta', text:
    `${recording.manifest.task} · ${recording.manifest.model} · ${recording.manifest.generations} process${recording.manifest.generations === 1 ? '' : 'es'} · ${recording.manifest.kills} kill${recording.manifest.kills === 1 ? '' : 's'}${recording.manifest.providers ? ` · ${recording.manifest.providers} providers` : ''} · recorded ${recording.manifest.recorded.started} · code ${recording.manifest.code.commit.slice(0, 8)}` }));
  // Embedded (`?embed=1`), the page is its frame's: no header, but a recording that breaks the format still says so.
  const embedded = params.get('embed') === '1';
  const problemsNote = problems.length ? el('p', { class: 'problems', text: `This recording breaks the format: ${problems.slice(0, 3).join('; ')}` }) : undefined;
  if (problemsNote && !embedded) header.append(problemsNote);
  if (recording.manifest.result) {
    const link = blobLink(recording, recording.manifest.result.blob, recording.manifest.result.title, 'result');
    if (link) header.append(link);
  }
  // The job that ran and the run's store at its end, when the manifest keeps them (draft 24): the job is JSON and opens in
  // a tab; the store is a SQLite file and downloads.
  // A field of the wrong shape is a format problem the page notes, never a reason not to play the run: no link for it.
  const { job, store } = recording.manifest;
  const jobLink = typeof job?.blob === 'string' ? blobLink(recording, job.blob, 'The job', 'job') : undefined;
  const at = store?.at;
  const storeLink = typeof store?.blob === 'string' && typeof at?.commit === 'number' && typeof at.gen === 'number'
    ? blobLink(recording, store.blob, `The store at commit ${at.commit} of generation ${at.gen}`, 'store') : undefined;
  for (const link of [jobLink, storeLink]) if (link) header.append(' ', link);
  const counters = el('div');
  const timeline = el('div', { class: 'timeline-wrap' });
  const position = el('span', { class: 'position' });
  const range = Object.assign(el('input'), { type: 'range', min: '0', max: String(last), value: String(player.p) }) as HTMLInputElement;
  const playButton = el('button', { text: 'play' });
  const speed = el('select');
  for (const value of SPEEDS) speed.append(Object.assign(el('option', { text: `${value}x` }), { value: String(value), selected: value === 1 }));
  const chapterList = el('nav', { class: 'chapters' });
  const focusBar = el('div', { class: 'focus' });
  const panels = el('div', { class: 'panels' });
  const controls = el('div', { class: 'controls' }, el('button', { text: 'previous commit' }), playButton, el('button', { text: 'next commit' }), speed, range, position);
  // The first registered panel that calls itself featured for this recording is shown first, with the controls right under it; the rest follow as before.
  // The panels this recording draws, judged once over all its lines: a panel with nothing here never shows, not even its title.
  const shown = panelsFor(lines);
  const featured = featuredPanel(shown, lines);
  const featuredBox = el('div', { class: 'featured' });
  const top = embedded ? (problemsNote ? [problemsNote] : []) : [header];
  if (embedded) document.documentElement.classList.add('embed');
  if (featured) root.replaceChildren(...top, featuredBox, controls, counters, baselineRow, timeline, chapterList, focusBar, panels);
  else root.replaceChildren(...top, counters, baselineRow, timeline, controls, chapterList, focusBar, panels);
  // Framed, the viewer tells the framing page where the point is and what is focused, and obeys it (seek, focus, theme)
  // only when its URL names that page's origin (`&parent=`): PANELS.md, "Embedding".
  const framed = embedded && window.parent !== window;
  const steeredBy = parentParam(params.get('parent'));
  const target = steeredBy ?? parentOrigin(location.ancestorOrigins?.item(0) ?? undefined, document.referrer);
  const post = (message: ReturnType<typeof embedMessage>) => window.parent.postMessage(message, target);
  let postedStop: number | undefined;
  let postedFocus: string | null | undefined;
  const tellParent = () => {
    if (player.p !== postedStop) {
      postedStop = player.p;
      const index = chapterAt(chapters, player.p);
      const durable = lines.slice(0, player.p).findLast((line) => line.channel === 'durable');
      post(embedMessage('position', { stop: player.p, gen: durable?.gen ?? null, commit: durable?.commit ?? null, t: player.p > 0 ? lines[player.p - 1]!.t : 0,
        chapter: index < 0 ? null : { title: chapters[index]!.title, stop: chapters[index]!.p } }));
    }
    const focus = player.focus ?? null;
    if (focus !== postedFocus) { postedFocus = focus; post(embedMessage('focus', { path: focus })); }
  };
  const [previousButton, , nextButton] = [...controls.querySelectorAll('button')];

  const setFocus = (path: string | undefined) => { player.focus = path; draw(); };
  // Selecting a citation is a view input: it moves no stop, so the account it was clicked in stays on screen.
  const setCite = (cite: string | undefined) => { player.cite = cite; draw(); };
  const scrubTo = (p: number) => { player.p = head.seek(p); draw(); };

  function draw() {
    const t = player.p > 0 ? lines[player.p - 1]!.t : 0;
    player.clock = head.clock;
    const counterState = cachedReduce(counterFold, lines, player.p, cacheOf(counterFold) as Map<number, never>);
    counters.replaceChildren(drawCounters(countersOf(counterState, player.p === last), measured, recording.manifest.providers));
    timeline.replaceChildren(drawTimeline(player, (at) => scrubTo(stopAt(lines, player.stops, at)), setFocus));
    range.value = String(player.p);
    const line = lines[player.p - 1];
    position.textContent = player.p === 0 ? 'before the first line' : `${(t / 1000).toFixed(2)} s · ${line?.channel === 'durable' ? `after commit ${line.commit}${restored ? ` of generation ${line.gen}` : ''}` : `${line?.kind}`} · line ${player.p} of ${last}`;
    if (framed) tellParent();
    chapterList.replaceChildren(...chapters.map((chapter) => {
      const button = el('button', { class: chapter.p === player.p ? 'current' : '', text: chapter.title });
      button.addEventListener('click', () => { if (chapter.focus) player.focus = chapter.focus; scrubTo(chapter.p); });
      return button;
    }));
    focusBar.replaceChildren(...(player.focus ? [el('span', { text: `Focused on ${player.focus}` }), Object.assign(el('button', { text: 'clear focus' }), { onclick: () => setFocus(undefined) })] : []),
      ...(player.cite !== undefined ? [el('span', { text: `Citation ${player.cite.length > 16 ? `${player.cite.slice(0, 12)}…` : player.cite}` }), Object.assign(el('button', { text: 'clear citation' }), { onclick: () => setCite(undefined) })] : []));
    drawPanels(t);
    syncUrl();
  }

  /** The address names where the screen is: the commit, the selected citation, the focus, and (only while the clock is still where a `?t=` link opened it) the time. */
  function syncUrl() {
    const line = lines[player.p - 1];
    const url = new URL(location.href);
    if (line?.channel === 'durable') url.searchParams.set('at', restored ? `${line.gen}:${line.commit}` : String(line.commit)); else url.searchParams.delete('at');
    // ?cite= names the selected citation; opened without ?at=, it lands at the commit that first wrote it.
    if (player.cite !== undefined) url.searchParams.set('cite', player.cite); else url.searchParams.delete('cite');
    // A link that opened at a time keeps it only while the screen is still at that time: a scrub or a play would otherwise be undone by a reload.
    const linked = linkedTime(opened, head.clock);
    if (linked !== undefined) url.searchParams.set('t', linked); else url.searchParams.delete('t');
    if (player.focus) url.searchParams.set('focus', player.focus); else url.searchParams.delete('focus');
    if (location.protocol !== 'file:') history.replaceState(null, '', url);
  }

  /** The panels at the stop; what they draw by time is drawn at the playback clock. */
  const sections = new Map<string, HTMLElement>();
  /** `onlyAnimated`: between stops, redraw just the panels that move with the clock, in place; the others keep their elements (and their scroll). */
  function drawPanels(t: number, onlyAnimated = false) {
    const frames = cachedReduce(frameFold, lines, player.p, cacheOf(frameFold) as Map<number, never>);
    // Focus is the view's input: every panel reduces the whole run (RECORDING.md section 4 rule 4).
    const drawn = (panel: Panel<unknown>) => {
      const state = cachedReduce(panel, lines, player.p, cacheOf(panel.id) as Map<number, never>);
      const section = el('section', { class: 'panel' }, el('h3', { text: panel.title }),
        renderNode(panel.view(state, viewContext(t, recording.manifest, { focus: player.focus, baseline, cite: player.cite, json, now: head.clock })), player, frames, t, setFocus, setCite));
      sections.set(panel.id, section);
      return section;
    };
    if (onlyAnimated) {
      for (const panel of animatedPanels(shown)) {
        const before = sections.get(panel.id);
        const after = drawn(panel);
        if (before !== undefined) { const place = placeIn(before); before.replaceWith(after); restorePlace(after, place); }
      }
      return;
    }
    if (featured) { const kept = placeIn(featuredBox); featuredBox.replaceChildren(drawn(featured)); restorePlace(featuredBox, kept); }
    const place = placeIn(panels);
    panels.replaceChildren(...shown.filter((panel: Panel<unknown>) => panel !== featured).map(drawn));
    restorePlace(panels, place);
  }

  range.addEventListener('input', () => scrubTo(Number(range.value)));
  previousButton!.addEventListener('click', () => scrubTo(previousStop(player.stops, player.p)));
  nextButton!.addEventListener('click', () => scrubTo(nextStop(player.stops, player.p)));
  speed.addEventListener('change', () => { player.speed = Number((speed as HTMLSelectElement).value); });
  let frame = 0;
  let wall = 0;
  let lastPanels = 0;
  const tick = (now: number) => {
    if (!player.playing) return;
    const p = head.advance(wall ? now - wall : 0, player.speed);
    wall = now;
    if (p !== player.p) { player.p = p; draw(); lastPanels = now; } else if (now - lastPanels > 90 && animatedPanels(shown).length > 0) { drawPanels(player.p > 0 ? lines[player.p - 1]!.t : 0, true); syncUrl(); lastPanels = now; }
    if (player.p >= last) { player.playing = false; playButton.textContent = 'play'; return; }
    frame = requestAnimationFrame(tick);
  };
  playButton.addEventListener('click', () => {
    player.playing = !player.playing;
    playButton.textContent = player.playing ? 'pause' : 'play';
    if (player.playing) { if (player.p >= last) player.p = head.seek(0); wall = 0; cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); } else syncUrl();
  });
  if (framed) {
    post(embedMessage('ready', { stops: last, chapters: chapters.map((chapter) => ({ title: chapter.title, stop: chapter.p })) }));
    if (steeredBy) {
      window.addEventListener('message', (event) => {
        if (!fromParent(event.origin, event.source === window.parent, steeredBy)) return;
        const steer = steerOf(event.data, last);
        if (steer?.type === 'seek') {
          if ('stop' in steer) scrubTo(steer.stop);
          else if ('commit' in steer) scrubTo(afterCommit(steer.commit, steer.gen));
          else { player.p = head.seekTime(steer.t * 1000); draw(); }
        } else if (steer?.type === 'focus') setFocus(steer.path ?? undefined);
        else if (steer?.type === 'theme') {
          if (steer.theme === 'auto') delete document.documentElement.dataset.theme;
          else document.documentElement.dataset.theme = steer.theme;
        }
      });
    }
  }
  draw();
  void resultJson(recording).then((read) => { if (read.size) { json = read; draw(); } });
  if (recording.manifest.baseline) {
    baselineRow.replaceChildren(el('p', { class: 'meta', text: `Baseline: ${recording.manifest.baseline.label} (loading)` }));
    baselineOf(recording, base).then((loaded) => {
      baseline = loaded;
      baselineRow.replaceChildren(loaded
        ? el('div', {}, el('p', { class: 'meta', text: `Beside it, ${loaded.label}, at its end:` }), drawCounters(loaded.counters, loaded.counters.measured, loaded.providers))
        : el('p', { class: 'meta', text: `Baseline ${recording.manifest.baseline!.label}: not available here` }));
      draw();
    }).catch(() => baselineRow.replaceChildren(el('p', { class: 'meta', text: `Baseline ${recording.manifest.baseline!.label}: could not be opened` })));
  }
}

function gallery(root: HTMLElement, onOpen: (recording: Recording) => void, entries: readonly { id: string; manifest: Manifest }[], unread?: string) {
  const list = el('ul', { class: 'gallery' }, ...entries.map((entry) => {
    const link = Object.assign(el('a', { text: entry.manifest.title }), { href: `?r=${encodeURIComponent(entry.id)}` });
    return el('li', {}, link, el('span', { class: 'meta', text: ` ${entry.manifest.generations} process${entry.manifest.generations === 1 ? '' : 'es'}, ${entry.manifest.kills} kill${entry.manifest.kills === 1 ? '' : 's'}, ${entry.manifest.model}` }));
  }));
  const picker = Object.assign(el('input'), { type: 'file', multiple: true }) as HTMLInputElement;
  picker.setAttribute('webkitdirectory', '');
  picker.addEventListener('change', async () => onOpen(await fromFiles([...(picker.files ?? [])])));
  const drop = el('div', { class: 'drop', text: `Drop a recording folder (${FORMAT}) here, or choose one: ` }, picker);
  drop.addEventListener('dragover', (event) => event.preventDefault());
  drop.addEventListener('drop', async (event) => {
    event.preventDefault();
    const files: File[] = [];
    const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        files.push(new File([file], path, { type: file.type }));
        Object.defineProperty(files.at(-1)!, 'webkitRelativePath', { value: path });
      } else if (entry.isDirectory) {
        for (const child of await readAllEntries<FileSystemEntry>((entry as FileSystemDirectoryEntry).createReader())) await walk(child, `${path}/${child.name}`);
      }
    };
    for (const item of [...(event.dataTransfer?.items ?? [])]) {
      const entry = item.webkitGetAsEntry();
      if (entry) await walk(entry, entry.name);
    }
    onOpen(await fromFiles(files));
  });
  root.replaceChildren(el('header', {}, el('h1', { text: 'agentrun run viewer' }), el('p', { class: 'meta', text: 'Replays a run recorded as agentrun.recording/1: every process, every kill, every commit.' })),
    el('h2', { text: 'Recordings' }), unread !== undefined ? el('p', { class: 'problems', text: `The gallery could not be read (${unread}); a recording folder can still be opened below.` })
      : entries.length ? list : el('p', { class: 'empty', text: 'No recordings yet.' }), drop);
}

async function main() {
  const root = document.getElementById('viewer')!;
  const params = new URLSearchParams(location.search);
  const open = (recording: Recording, base?: string) => play(recording, root, params, base);
  try {
    const id = params.get('r');
    const src = params.get('src');
    // The bundled recordings are read only when they are needed: a recording at a URL (`?src=`) opens without them, and
    // a gallery whose index cannot be read still offers the folder picker.
    let entries: (GalleryEntry | IndexEntry)[] = [];
    let unread: string | undefined;
    if (id || !src) {
      try { entries = await bundledRecordings(); } catch (error) { unread = error instanceof Error ? error.message : String(error); }
    }
    const entry = id ? entries.find((each) => each.id === id) : undefined;
    if (entry) { const { recording, dir } = await openBundled(entry); open(recording, dir); }
    else if (src) open(await fromUrl(src), new URL(src.endsWith('/') ? src : `${src}/`, location.href).href);
    else gallery(root, open, entries, unread);
  } catch (error) {
    root.replaceChildren(el('p', { class: 'problems', text: `This recording could not be opened: ${error instanceof Error ? error.message : String(error)}` }));
  }
}

if (typeof document !== 'undefined') void main();
