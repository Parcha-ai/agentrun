# Writing a panel

A panel shows one part of a run: the workflow's graph, the browser's tiles, what vision saw, where a session lives.
The viewer replays a recording (`RECORDING.md`) by reducing its lines up to a point, and a panel is one of those
reduces. This page is the whole contract.

## The contract

```ts
import type { Line } from './src/format.ts';
import type { Node, Panel } from './src/panels.ts';

const myPanel: Panel<MyState> = {
  id: 'browser-tiles',            // unique
  title: 'Browser sessions',      // shown above the panel
  init: () => initialState,       // the state before any line
  accepts: (line) => line.source === 'browser',   // which lines it reduces
  reduce: (state, line) => nextState,             // one line in, the next state out
  view: (state, { t, focus }) => node,            // the screen for a state
};
register(myPanel);                // in src/panels.ts's registry, in the order panels show
```

All four functions are pure. `reduce` returns a new state and never changes the one it was given. `view` reads only
its state and its context. That is what makes a scrub a replay: the viewer may compute a panel's state at any point
with a fresh reduce of the lines before it, or by stepping from a state it kept, and both give the same screen. A test
in `test/core.test.ts` checks this for every registered panel at every stop of the bundled recordings.

## What `view` returns

Plain nodes, not DOM. The viewer draws them.

- `h(tag, props, ...children)`: an element. `props.class`, `props.title`, and `props.path`.
- A string: text.
- `{ tag: 'img', blob, alt }`: an image from the recording's `blobs/`, by its SHA-256.
- `{ tag: 'a', blob, text }`: a link to any file in `blobs/` (an evidence record, the result), opened beside the page.
  A view never reads a blob's bytes: the shell resolves the hash to a URL when it draws.
- `{ tag: 'frame', session }`: a browser session's picture at the current point (below).

Any node with a `path` is clickable: a click focuses every panel on lines under that execution path, and the viewer
shows the focus and a way to clear it. Give a node the `path` of the workflow position it shows.

## The rules

1. **Count only from durable lines** (and the supervisor's `host` lines for processes and kills). A live line shows
   what is in flight; it never changes a count. A count only live lines can give is labelled "observed".
2. **Reduce documents as the latest value per `(doc, key)`**, and treat a line with `snapshot: true` as state that
   replaces that value. A fold of events by generation skips snapshot lines.
3. **Read durable `data` as RECORDING.md section 3.1 says**, and refuse a `data.version` you do not know rather than
   misread it.
4. **Skip kinds you do not know.** The format adds kinds without a new version.
5. **Use `t` only to place things in time.** Durable facts are ordered by `(commit, order)`.
6. **Show unknown as unknown.** A cost that is `null` is "unknown", never `$0`.

## Browser pictures

A `{ tag: 'frame', session }` node shows the session's `frame.track` (a WebM) at the current time when the recording
has one, else its latest `frame` JPEG, and a `frame.gap` as a gap with its reason (`process_killed`,
`credential_on_page`, `session_released`), never as a frozen picture. The browser panel decides which sessions to show
and lays out the tiles; the viewer draws the picture.

## Focus and the shell

The shell gives `view` a context: `t`, the time of the current point, and `focus`, the focused path if there is one.
While a path is focused, a panel reduces only the lines whose `path` is that path or under it; clearing the focus
gives it the whole run again. The counters strip is never focused.

## A panel in full

```ts
import { docOf } from './src/durable.ts';
import { h, register, type Panel } from './src/panels.ts';

/** Every effect the journal admitted, and whether it completed. */
const effectsPanel: Panel<Record<string, string>> = {
  id: 'effects',
  title: 'Effects',
  init: () => ({}),
  accepts: (line) => line.channel === 'durable' && line.kind === 'agentrun.effects',
  reduce: (state, line) => {
    const doc = docOf(line);
    const value = doc?.value as { name?: string; status?: string } | undefined;
    return doc?.key && value?.status ? { ...state, [doc.key.split('\u0000').at(-1)!]: `${value.name}: ${value.status}` } : state;
  },
  view: (state) => h('ul', {}, ...Object.values(state).map((row) => h('li', {}, row))),
};
register(effectsPanel);
```

Put the panel in `src/`, import it from `src/app.ts` so the build includes it, and add a test beside the others.
