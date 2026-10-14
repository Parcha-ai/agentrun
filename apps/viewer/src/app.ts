// The page: load a recording, draw its timeline and counters, and replay it. Everything on screen at a stop is a
// reduce of the lines before that stop; the DOM is redrawn from those reduces, never patched by events.
import { FORMAT, parseLines, processOf, under, validate, type Line, type Manifest, type Recording } from './format.ts';
import { counterFold, countersOf, repeatedLabel, type Counters } from './counters.ts';
import { lanesOf, type Lanes, type Span } from './lanes.ts';
import { panelsShown, type BaselineView, type Node, type Panel } from './panels.ts';
import { frameFold, pictureAt, type FrameState } from './frames.ts';
import { nextStop, previousStop, reduceTo, snap, stopAt, stopsOf, type Fold } from './replay.ts';
import { citeStop } from './cite.ts';

type GalleryEntry = { id: string; manifest: Manifest; events: string; blobs: Record<string, string> };
declare const window: Window & { AGENTRUN_GALLERY?: GalleryEntry[] };

const BLOB_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'json', 'html', 'md', 'txt', 'pdf'];
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

// ---- loading ---------------------------------------------------------------------------------------------------

function fromGallery(entry: GalleryEntry): Recording {
  return { id: entry.id, manifest: entry.manifest, lines: parseLines(entry.events), blobUrl: (sha) => entry.blobs[sha] };
}

/** Every blob a recording names: its lines', its images', its result's. */
function blobsNamed(manifest: Manifest, lines: Line[]): string[] {
  const named = new Set<string>(manifest.result ? [manifest.result.blob] : []);
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
  return { id: root, manifest, lines, blobUrl: (sha) => urls[sha] };
}

async function fromFiles(files: File[]): Promise<Recording> {
  const byPath = new Map(files.map((file) => [(file.webkitRelativePath || file.name).split('/').slice(-2).join('/'), file]));
  const find = (name: string) => [...byPath].find(([path]) => path === name || path.endsWith(`/${name}`))?.[1];
  const manifestFile = find('manifest.json');
  const eventsFile = find('events.jsonl');
  if (!manifestFile || !eventsFile) throw new Error('The folder needs manifest.json and events.jsonl.');
  const urls: Record<string, string> = {};
  for (const [path, file] of byPath) {
    const name = path.split('/').at(-1)!;
    if (path.startsWith('blobs/')) urls[name.split('.')[0]!] = URL.createObjectURL(file);
  }
  return { id: 'dropped', manifest: JSON.parse(await manifestFile.text()) as Manifest, lines: parseLines(await eventsFile.text()), blobUrl: (sha) => urls[sha] };
}

// ---- the player state ------------------------------------------------------------------------------------------

type Player = {
  recording: Recording;
  stops: boolean[];
  lanes: Lanes;
  p: number;
  focus?: string;
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

function drawCounters(counters: Counters): HTMLElement {
  const item = (label: string, value: string, title: string, extra = '') => el('div', { class: `counter${extra}`, title }, el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label }));
  return el('div', { class: 'counters' },
    item('paid calls made', String(counters.paid.total), `Workflow effects completed: ${counters.paid.workflow}. Agent receipts: ${counters.paid.agent}.`),
    item('repeated', repeatedLabel(counters), counters.repeatedNotMeasured > 0 ? `An applied call in a later process than an earlier applied one. ${counters.repeatedNotMeasured} effects report no calls: their repeats are not measured, never shown as 0.` : 'An applied call in a later process than an earlier applied one.', counters.repeated > 0 ? ' alarm' : ''),
    item('asked twice', String(counters.askedTwice), 'A call dispatched twice in one process: the model asking again.'),
    item(counters.inFlight > 0 ? 'unknown (in flight)' : 'unknown', counters.inFlight > 0 ? `${counters.unknown} (${counters.inFlight})` : String(counters.unknown), 'Effects admitted and never completed.'),
    item('judge asks', String(counters.judge.answered + counters.judge.failed), `Answered ${counters.judge.answered}, failed ${counters.judge.failed}, re-asked ${counters.judge.reasked}.`),
    item('model turns', String(counters.turns.committed), 'Committed assistant turns.'),
    item('re-asked turns', counters.turns.reasked === null ? 'not measured' : String(counters.turns.reasked), counters.turns.reasked === null
      ? 'No ask start was committed to this run\'s pi.live (or its version is not one this viewer knows), so a turn asked again cannot be proven.'
      : 'Turns asked more than once at one position, proven from the store\'s pi.live.', counters.turns.reasked ? ' alarm' : ''),
    item('processes', String(counters.processes), 'From the supervisor\'s process lines.'),
    item('kills', String(counters.kills), 'From the supervisor\'s kill lines.'),
    item('cost', counters.cost === null ? 'unknown' : `$${counters.cost.toFixed(4)}`, 'Unknown when any priced part is unknown, never shown as $0.'),
    item('journal opens', String(counters.journalOpens), 'A fact of the store: agentrun.driver\'s generation. It counts journal opens, which can exceed processes.', ' fact'),
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

function renderNode(node: Node, player: Player, frames: FrameState, t: number, onFocus: (path: string) => void): globalThis.Node {
  if (typeof node === 'string') return document.createTextNode(node);
  if (node.tag === 'img' && 'blob' in node) {
    const url = player.recording.blobUrl(node.blob);
    return url ? Object.assign(el('img', { class: node.class ?? 'blob' }), { src: url, alt: node.alt }) : el('span', { class: 'missing', text: `[${node.alt}: not in this recording]` });
  }
  if (node.tag === 'a' && 'blob' in node && 'text' in node) {
    const url = player.recording.blobUrl(node.blob);
    return url ? Object.assign(el('a', { class: node.class ?? 'blob', text: node.text }), { href: url, target: '_blank' }) : el('span', { class: 'missing', text: `[${node.text}: not in this recording]` });
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
    if (picture.kind === 'gap') return el('div', { class: 'frame gap', text: `no picture: ${picture.reason.replaceAll('_', ' ')}` });
    return el('div', { class: 'frame none', text: 'no picture yet' });
  }
  const props = node as { tag: string; class?: string; path?: string; title?: string; children?: Node[] };
  const out = document.createElement(props.tag);
  if (props.class) out.className = props.class;
  if (props.title) out.title = props.title;
  if (props.path) {
    out.classList.add('has-path');
    if (player.focus && under(props.path, player.focus)) out.classList.add('focused');
    out.addEventListener('click', (event) => { event.stopPropagation(); onFocus(props.path!); });
  }
  for (const child of props.children ?? []) out.append(renderNode(child, player, frames, t, onFocus));
  return out;
}

// ---- the page --------------------------------------------------------------------------------------------------

/** The baseline the manifest names: another real recording, opened beside this one, its counters at its end. */
async function baselineOf(recording: Recording, base: string | undefined): Promise<BaselineView | undefined> {
  const named = recording.manifest.baseline;
  if (!named) return undefined;
  const id = named.recording.replace(/\/$/, '').split('/').at(-1)!;
  const entry = (window.AGENTRUN_GALLERY ?? []).find((each) => each.id === id || each.id === named.recording);
  const other = entry ? fromGallery(entry) : base ? await fromUrl(new URL(named.recording, base).href) : undefined;
  if (!other) return undefined;
  const ms = Date.parse(other.manifest.recorded.ended) - Date.parse(other.manifest.recorded.started);
  return { label: named.label, counters: countersOf(reduceTo(counterFold, other.lines, other.lines.length), true), ms: Number.isFinite(ms) ? ms : null };
}

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
  player.focus = params.get('focus') ?? undefined;

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
  let baseline: BaselineView | undefined;
  const baselineRow = el('div', { class: 'baseline' });

  const header = el('header', {}, el('h1', { text: recording.manifest.title }), el('p', { class: 'meta', text:
    `${recording.manifest.task} · ${recording.manifest.model} · ${recording.manifest.generations} processes · ${recording.manifest.kills} kills · recorded ${recording.manifest.recorded.started} · code ${recording.manifest.code.commit.slice(0, 8)}` }));
  if (problems.length) header.append(el('p', { class: 'problems', text: `This recording breaks the format: ${problems.slice(0, 3).join('; ')}` }));
  if (recording.manifest.result) {
    const url = recording.blobUrl(recording.manifest.result.blob);
    if (url) header.append(Object.assign(el('a', { class: 'result', text: recording.manifest.result.title }), { href: url, target: '_blank' }));
  }
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
  root.replaceChildren(header, counters, baselineRow, timeline, controls, chapterList, focusBar, panels);
  const [previousButton, , nextButton] = [...controls.querySelectorAll('button')];

  const setFocus = (path: string | undefined) => { player.focus = path; draw(); };
  const scrubTo = (p: number) => { player.p = snap(player.stops, p); draw(); };

  function draw() {
    const t = player.p > 0 ? lines[player.p - 1]!.t : 0;
    player.clock = t;
    const counterState = cachedReduce(counterFold, lines, player.p, cacheOf(counterFold) as Map<number, never>);
    counters.replaceChildren(drawCounters(countersOf(counterState, player.p === last)));
    timeline.replaceChildren(drawTimeline(player, (at) => scrubTo(stopAt(lines, player.stops, at)), setFocus));
    range.value = String(player.p);
    const line = lines[player.p - 1];
    position.textContent = player.p === 0 ? 'before the first line' : `${(t / 1000).toFixed(2)} s · ${line?.channel === 'durable' ? `after commit ${line.commit}${restored ? ` of generation ${line.gen}` : ''}` : `${line?.kind}`} · line ${player.p} of ${last}`;
    chapterList.replaceChildren(...chapters.map((chapter) => {
      const button = el('button', { class: chapter.p === player.p ? 'current' : '', text: chapter.title });
      button.addEventListener('click', () => { if (chapter.focus) player.focus = chapter.focus; scrubTo(chapter.p); });
      return button;
    }));
    focusBar.replaceChildren(...(player.focus ? [el('span', { text: `Focused on ${player.focus}` }), Object.assign(el('button', { text: 'clear focus' }), { onclick: () => setFocus(undefined) })] : []));
    const frames = cachedReduce(frameFold, lines, player.p, cacheOf(frameFold) as Map<number, never>);
    panels.replaceChildren(...panelsShown().map((panel: Panel<unknown>) => {
      // Focus is the view's input: every panel reduces the whole run (RECORDING.md section 4 rule 4).
      const state = cachedReduce(panel, lines, player.p, cacheOf(panel.id) as Map<number, never>);
      return el('section', { class: 'panel' }, el('h3', { text: panel.title }),
        renderNode(panel.view(state, { t, ...(player.focus ? { focus: player.focus } : {}), ...(baseline ? { baseline } : {}) }), player, frames, t, setFocus));
    }));
    const url = new URL(location.href);
    if (line?.channel === 'durable') url.searchParams.set('at', restored ? `${line.gen}:${line.commit}` : String(line.commit)); else url.searchParams.delete('at');
    url.searchParams.delete('cite');
    if (player.focus) url.searchParams.set('focus', player.focus); else url.searchParams.delete('focus');
    if (location.protocol !== 'file:') history.replaceState(null, '', url);
  }

  range.addEventListener('input', () => scrubTo(Number(range.value)));
  previousButton!.addEventListener('click', () => scrubTo(previousStop(player.stops, player.p)));
  nextButton!.addEventListener('click', () => scrubTo(nextStop(player.stops, player.p)));
  speed.addEventListener('change', () => { player.speed = Number((speed as HTMLSelectElement).value); });
  let frame = 0;
  let wall = 0;
  const tick = (now: number) => {
    if (!player.playing) return;
    if (wall) player.clock += (now - wall) * player.speed;
    wall = now;
    const p = stopAt(lines, player.stops, player.clock);
    if (p !== player.p) { player.p = p; draw(); }
    if (player.p >= last) { player.playing = false; playButton.textContent = 'play'; return; }
    frame = requestAnimationFrame(tick);
  };
  playButton.addEventListener('click', () => {
    player.playing = !player.playing;
    playButton.textContent = player.playing ? 'pause' : 'play';
    if (player.playing) { if (player.p >= last) { player.p = 0; player.clock = 0; } wall = 0; cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); }
  });
  draw();
  if (recording.manifest.baseline) {
    baselineRow.replaceChildren(el('p', { class: 'meta', text: `Baseline: ${recording.manifest.baseline.label} (loading)` }));
    baselineOf(recording, base).then((loaded) => {
      baseline = loaded;
      baselineRow.replaceChildren(loaded
        ? el('div', {}, el('p', { class: 'meta', text: `Beside it, ${loaded.label}, at its end:` }), drawCounters(loaded.counters))
        : el('p', { class: 'meta', text: `Baseline ${recording.manifest.baseline!.label}: not available here` }));
      draw();
    }).catch(() => baselineRow.replaceChildren(el('p', { class: 'meta', text: `Baseline ${recording.manifest.baseline!.label}: could not be opened` })));
  }
}

function gallery(root: HTMLElement, onOpen: (recording: Recording) => void) {
  const entries = window.AGENTRUN_GALLERY ?? [];
  const list = el('ul', { class: 'gallery' }, ...entries.map((entry) => {
    const link = Object.assign(el('a', { text: entry.manifest.title }), { href: `?r=${encodeURIComponent(entry.id)}` });
    return el('li', {}, link, el('span', { class: 'meta', text: ` ${entry.manifest.generations} processes, ${entry.manifest.kills} kills, ${entry.manifest.model}` }));
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
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of children) await walk(child, `${path}/${child.name}`);
      }
    };
    for (const item of [...(event.dataTransfer?.items ?? [])]) {
      const entry = item.webkitGetAsEntry();
      if (entry) await walk(entry, entry.name);
    }
    onOpen(await fromFiles(files));
  });
  root.replaceChildren(el('header', {}, el('h1', { text: 'agentrun run viewer' }), el('p', { class: 'meta', text: 'Replays a run recorded as agentrun.recording/1: every process, every kill, every commit.' })),
    el('h2', { text: 'Recordings' }), entries.length ? list : el('p', { class: 'empty', text: 'No recordings yet.' }), drop);
}

async function main() {
  const root = document.getElementById('viewer')!;
  const params = new URLSearchParams(location.search);
  const open = (recording: Recording, base?: string) => play(recording, root, params, base);
  try {
    const id = params.get('r');
    const src = params.get('src');
    const entry = id ? (window.AGENTRUN_GALLERY ?? []).find((each) => each.id === id) : undefined;
    if (entry) open(fromGallery(entry), new URL(`recordings/${entry.id}/`, location.href).href);
    else if (src) open(await fromUrl(src), new URL(src.endsWith('/') ? src : `${src}/`, location.href).href);
    else gallery(root, open);
  } catch (error) {
    root.replaceChildren(el('p', { class: 'problems', text: `This recording could not be opened: ${error instanceof Error ? error.message : String(error)}` }));
  }
}

if (typeof document !== 'undefined') void main();
