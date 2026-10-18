// The Panel contract (PANELS.md): `accepts`, `reduce`, `view`, all pure. A panel's screen at a stop is its reduce over
// the lines before the stop that it accepts, then its view. The shell owns the DOM: a view returns plain nodes, and any
// node with a `path` focuses every panel on that path when clicked. Focus is a view input (RECORDING.md section 4 rule
// 4): the shell drops no line for it, and each view shows what is under the focused path its own way.
import { processOf, under, type Json, type Line } from './format.ts';
import { isAsk } from './live.ts';
import type { Fold } from './replay.ts';
import type { Counters } from './counters.ts';
import { entryOf, imagesOf, textOf, textPartsOf, toolCallsOf } from './durable.ts';

/** A region in percent of the element that holds it: left, top, width, height. */
export type Box = { x: number; y: number; w: number; h: number };
/** An element's props. `cite`: a click selects that citation in every panel (`ViewContext.cite`). `box`: the element is
 *  placed over its parent at that region. */
/** `vars` are numbers a stylesheet reads as custom properties (`--name`): a view's way to say where something is without a style string. */
export type Props = { class?: string; path?: string; title?: string; cite?: string; box?: Box; vars?: Record<string, number> };

/** A node a view returns. `frame` asks the shell to draw a browser session's picture at the stop (frames.ts). */
export type Node =
  | string
  | ({ tag: string; children?: Node[] } & Props)
  | { tag: 'img'; blob: string; alt: string; class?: string }
  | { tag: 'a'; blob: string; text: string; class?: string; fragment?: string }
  | { tag: 'a'; href: string; text: string; class?: string }
  | { tag: 'frame'; session: string; class?: string };

export const h = (tag: string, props: Props = {}, ...children: (Node | false | undefined)[]): Node =>
  ({ tag, ...props, children: children.filter((child): child is Node => child !== false && child !== undefined) });

/** The recording the manifest's `baseline` names, folded by the shell as it folds the one on screen: its label, its
 *  counters at its end, and how long it ran (ms, null when its manifest's times do not parse). */
export type BaselineView = { label: string; counters: Counters; ms: number | null; providers?: 'real' | 'scripted' };
/** What the shell hands a view: the time of the point, the focused path (a view input: no line is dropped for it), and
 *  the baseline when the manifest names one (a real recording, never typed-in numbers). `cite` is the selected
 *  citation, a view input like the focus. `json` is a JSON blob the recording's result names, parsed, by its SHA-256:
 *  undefined until the shell has read it, and for any other blob. */
export type ViewContext = { t: number; /** The playback clock in ms: the time of the point at a stop (a scrub sets it), and running between stops while playing. A view that draws motion reads it. */ now?: number; focus?: string; baseline?: BaselineView; providers?: 'real' | 'scripted'; cite?: string; json?: (sha: string) => Json | undefined;
  /** The run is followed while it goes and has not finished: its cost is not known yet. */
  following?: true;
  /** A blob's media type, from its name in `blobs/` (undefined until the shell has found it): a view tells a picture it may
   *  draw from a file it links. */
  blobType?: (sha: string) => string | undefined };

/** A node's class under a focus: a line with a path outside the focused branch is dimmed; one with no path stays. */
const dimmed = (path: string | undefined, focus: string | undefined) => (focus !== undefined && path !== undefined && !under(path, focus) ? ' dim' : '');

export type Panel<S> = Fold<S> & {
  id: string;
  title: string;
  /** The shell redraws the panels about ten times a second while playing, so a view that moves with `now` moves between stops. */
  animated?: boolean;
  /** True for a recording whose story this panel tells: the shell shows it first, under the title, with the playback controls right under it. */
  featured?(lines: Line[]): boolean;
  view(state: S, context: ViewContext): Node;
  /** Which lines a recording must hold for this panel to be drawn at all; without it, `accepts` says. A panel with no such
   *  line in the whole recording is not drawn, its title included. */
  shows?(line: Line): boolean;
};

/** The panel the shell shows first for this recording: the first registered one whose `featured` says yes. */
export const featuredPanel = <S>(panels: Panel<S>[], lines: Line[]): Panel<S> | undefined => panels.find((panel) => panel.featured?.(lines) === true);

/** The panels the shell redraws between stops: only those that move with the clock. */
export const animatedPanels = <S>(panels: Panel<S>[]): Panel<S>[] => panels.filter((panel) => panel.animated === true);

/** The extensions' panels, in the order they register (each when its module loads). */
export const registry: Panel<any>[] = [];
export const register = <S>(panel: Panel<S>) => { registry.push(panel); };

const describe = (line: Line): string => {
  const data = line.data as { doc?: Json; key?: Json; kind?: Json } | null;
  const what = typeof data?.doc === 'string' ? `${data.doc}${typeof data.key === 'string' ? ` ${data.key.split('\u0000').at(-1)}` : ''}` : line.kind;
  return line.channel === 'durable' ? `commit ${line.commit}.${line.order} ${what}` : `${line.kind} (process ${processOf(line) ?? 'not named'})`;
};

/** The lines at the stop, by source: the newest few of each. */
export const linesPanel: Panel<{ bySource: Record<string, Line[]>; count: number }> = {
  id: 'lines',
  title: 'Lines at this point',
  init: () => ({ bySource: {}, count: 0 }),
  accepts: () => true,
  reduce: (state, line) => ({ count: state.count + 1, bySource: { ...state.bySource, [line.source]: [...(state.bySource[line.source] ?? []), line].slice(-8) } }),
  view: (state, { focus }) => h('div', { class: 'lines' },
    state.count === 0 && h('p', { class: 'empty' }, 'Nothing has happened yet.'),
    ...Object.entries(state.bySource).map(([source, lines]) => h('section', {},
      h('h4', {}, `${source} (${lines.length === 8 ? 'latest 8' : lines.length})`),
      h('ol', {}, ...[...lines].reverse().map((line) => h('li', { class: `${line.channel}${dimmed(line.path, focus)}`, ...(line.path ? { path: line.path, title: line.path } : {}) }, describe(line))))))),
};

/** `more`: what a prompt does not show at once, in full (the rest of its first text part, and every later part, such as a
 *  footer the job adds after the prompt), folded under one toggle. */
type Turn = { conv: number | undefined; role: string; text: string; more?: string[]; calls: string[]; images: string[]; error: boolean; path?: string };

/** The agent's conversations as pi committed them: each turn's words, tool calls, results and images. */
export const turnsPanel: Panel<{ turns: Turn[]; streaming: Record<string, boolean> }> = {
  id: 'pi-turns',
  title: 'Model turns',
  init: () => ({ turns: [], streaming: {} }),
  accepts: (line) => line.source === 'pi',
  reduce(state, line) {
    if (line.channel === 'live') {
      if (isAsk(line)) return { ...state, streaming: { ...state.streaming, [String(line.conv)]: true } };
      return state;
    }
    const entry = entryOf(line);
    if (!entry) return state;
    const turns = entry.model.filter((message) => message.role === 'assistant' || message.role === 'toolResult' || message.role === 'user').map((message): Turn => {
      // A prompt shows the start of its first text part; everything else, the rest of that part and every later part (a
      // footer the job adds after it), folds whole under one toggle, so opening it shows all of it.
      const parts = message.role === 'user' ? textPartsOf(message) : [];
      const first = parts[0] ?? '';
      const folded = [...(first.length > 600 ? [first.slice(600)] : []), ...parts.slice(1)];
      return {
        conv: line.conv, role: message.role, text: message.role === 'user' ? first.slice(0, 600) : textOf(message).slice(0, 600),
        ...(folded.length ? { more: folded } : {}),
        calls: toolCallsOf(message).map((call) => `${call.name}(${JSON.stringify(call.arguments)})`),
        images: imagesOf(message), error: message.isError === true, ...(line.path ? { path: line.path } : {}),
      };
    });
    const answered = entry.model.some((message) => message.role === 'assistant');
    return { turns: [...state.turns, ...turns], streaming: answered ? { ...state.streaming, [String(line.conv)]: false } : state.streaming };
  },
  view: (state, { focus }) => h('div', { class: 'turns' },
    state.turns.length === 0 && h('p', { class: 'empty' }, 'No turn committed yet.'),
    ...state.turns.map((turn) => h('div', { class: `turn ${turn.role}${turn.error ? ' error' : ''}${dimmed(turn.path, focus)}`, ...(turn.path ? { path: turn.path } : {}) },
      h('span', { class: 'who' }, turn.role === 'assistant' ? 'model' : turn.role === 'user' ? 'prompt' : 'tool result'),
      turn.text !== '' && h('p', {}, turn.text),
      turn.more !== undefined && h('details', { class: 'more' }, h('summary', {}, 'more'), ...turn.more.map((part) => h('p', {}, part))),
      ...turn.calls.map((call) => h('code', {}, call)),
      ...turn.images.map((blob): Node => ({ tag: 'img', blob, alt: 'an image the model was shown' })))),
    ...Object.entries(state.streaming).filter(([, live]) => live).map(([conv]) => h('p', { class: 'streaming' }, `conversation ${conv}: a turn is in flight`))),
};

/** The panels the shell shows, in order: the extensions' first, then its own two, the run's lines and the model's turns. */
export const panelsShown = (): Panel<any>[] => [...registry, linesPanel, turnsPanel];

/** The panels a recording draws: each with a line it is for (`shows`, else `accepts`) anywhere in the whole recording.
 *  Judged over every line, never up to the stop, so a panel never appears mid-scrub. */
export const panelsFor = (lines: readonly Line[]): Panel<any>[] => panelsShown().filter((panel) => lines.some((line) => (panel.shows ? panel.shows(line) : panel.accepts(line))));
