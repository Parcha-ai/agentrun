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
  view: (state, { t, focus, baseline }) => node,  // the screen for a state
};
register(myPanel);                // in src/panels.ts's registry, in the order panels show
```

All four functions are pure. `reduce` returns a new state and never changes the one it was given. `view` reads only
its state and its context. RECORDING.md writes the contract as `view(state, blobs, focus)`: here the focus comes in
the context, and blobs are resolved by the shell from the nodes a view returns. That is what makes a scrub a replay: the viewer may compute a panel's state at any point
with a fresh reduce of the lines before it, or by stepping from a state it kept, and both give the same screen. A test
in `test/core.test.ts` checks this for every registered panel at every stop of the test fixture.

## What `view` returns

Plain nodes, not DOM. The viewer draws them.

- `h(tag, props, ...children)`: an element. `props.class`, `props.title`, and `props.path`.
- A string: text.
- `{ tag: 'img', blob, alt }`: an image from the recording's `blobs/`, by its SHA-256.
- `{ tag: 'a', blob, text }`: a link to any file in `blobs/` (an evidence record, the result), opened beside the page.
  A view never reads a blob's bytes: the shell resolves the hash to a URL when it draws.
- `{ tag: 'frame', session }`: a browser session's picture at the current point (below).

Any node with a `path` is clickable: a click focuses that execution path in every panel, and the viewer shows the
focus and a way to clear it. Give a node the `path` of the workflow position it shows.

## The rules

1. **Count only from durable lines** (and the supervisor's `host` lines for processes and kills). A live line shows
   what is in flight; it never changes a count. A count only live lines can give is labelled "observed".
2. **Reduce documents as the latest value per `(doc, key)`**, and treat a line with `snapshot: true` as state that
   replaces that value. A fold of events by generation skips snapshot lines.
3. **Reset at a restore** (RECORDING.md 3.2). When a generation's first snapshot line has a commit below one already
   seen, the store went back to a checkpoint: reset document state there, so a `(doc, key)` the snapshot does not
   carry no longer exists. `restoresOf(lines)` in `src/format.ts` finds those lines. The lines before it with a higher
   commit are the lost branch: they happened, so a panel may still show them, marked as lost.
4. **Take the process a supervisor line is about from its data.** `process.started` and `kill` carry no event-level
   `gen`; use `processOf(line)` from `src/format.ts`.
5. **Read durable `data` as RECORDING.md section 3.1 says**, and refuse a `data.version` you do not know rather than
   misread it.
6. **Skip kinds you do not know.** The format adds kinds without a new version.
7. **Use `t` only to place things in time.** Durable facts are ordered by `(commit, order)`, and after a restore a
   commit number names two commits, so pair it with the line's `gen`.
8. **Show unknown as unknown.** A cost that is `null` is "unknown", never `$0`.

## Browser pictures

A `{ tag: 'frame', session }` node shows the session's `frame.track` (a WebM) at the current time when the recording
has one, else its latest `frame` JPEG, and a `frame.gap` as a gap with its reason (`process_killed`,
`credential_on_page`, `session_released`), never as a frozen picture. The browser panel decides which sessions to show
and lays out the tiles; the viewer draws the picture.

## Focus and the shell

The shell gives `view` a context: `t`, the time of the current point; `focus`, the focused path if there is one; and
`baseline` when the manifest names one (`BaselineView`: its label, the counters of that other recording at its end,
and how long it ran in ms, or null; another real recording, opened beside this one, never typed-in numbers).

Focus is a view input (RECORDING.md section 4 rule 4). The shell drops no line for it: every panel reduces the whole
run, and its `view` shows what is under the focused path its own way (filter, dim, highlight, or zoom on one branch
while the rest stays drawn). Keep the lines that have no `path` in the state: a conversation entry or a driver
checkpoint belongs to a branch without naming it. `under(path, focus)` in `src/format.ts` says whether a path is in
the focused branch. The two panels the viewer ships dim what is outside it. The counters strip never changes with the
focus.

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
