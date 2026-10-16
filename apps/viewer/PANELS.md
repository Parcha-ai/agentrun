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
  shows: (line) => line.kind === 'frame',          // optional: the lines a recording needs to draw this panel at all
};
register(myPanel);                // when its module loads; extensions' panels show first, in this order
```

All four functions are pure. `reduce` returns a new state and never changes the one it was given. `view` reads only
its state and its context. RECORDING.md writes the contract as `view(state, blobs, focus)`: here the focus comes in
the context, and blobs are resolved by the shell from the nodes a view returns. That is what makes a scrub a replay: the viewer may compute a panel's state at any point
with a fresh reduce of the lines before it, or by stepping from a state it kept, and both give the same screen. A test
in `test/core.test.ts` checks this for every registered panel at every stop of the test fixture.

A panel is drawn only for a recording that has a line it is for: one its `shows` says yes to, or, without `shows`, one
it `accepts`. With none in the whole recording, the shell draws nothing for it, not even its title. The shell judges
this once over every line of the recording, never up to the stop, so a panel never appears or vanishes mid-scrub: at a
stop before its first line it is drawn with its state before any line. Give a panel `shows` when its `accepts` takes
lines that are not its story: the transport panel reduces the counters' lines for its own counters, but draws only for
a recording with `transport` lines.

## What `view` returns

Plain nodes, not DOM. The viewer draws them.

- `h(tag, props, ...children)`: an element. `props.class`, `props.title`, `props.path`, `props.cite` (a click selects
  that citation, below) and `props.box` (`{ x, y, w, h }` in percent: the element is placed over its parent, which the
  panel's CSS positions).
- A string: text.
- `{ tag: 'img', blob, alt }`: an image from the recording's `blobs/`, by its SHA-256.
- `{ tag: 'a', blob, text }`: a link to any file in `blobs/` (an evidence record, the result), opened beside the page.
  A view never reads a blob's bytes: the shell resolves the hash to a URL when it draws. The one exception is the
  result's JSON, which the shell reads and hands every view (`json`, below).
- `{ tag: 'frame', session }`: a browser session's picture at the current point (below).

Any node with a `path` is clickable: a click focuses that execution path in every panel, and the viewer shows the
focus and a way to clear it. Give a node the `path` of the workflow position it shows.

## The rules

1. **Count only from durable lines** (and the supervisor's `host` lines for processes and kills). A live line shows
   what is in flight; it never changes a count. A count only live lines can give is labelled "observed".
2. **Reduce documents as the latest value per `(doc, key, conv, task)`**: a conversation-scoped document exists once
   per conversation, a task-scoped one once per task. Treat a line with `snapshot: true` as state that replaces that
   value. A fold of events by generation skips snapshot lines. `documentFold` in `src/documents.ts` does this, restores
   included; fold it into your own state rather than writing the reduce again.
3. **Read durable lines through `src/durable.ts` and live lines through `src/live.ts`** (a model's ask is `isAsk`:
   pi's assistant `message_start`, since a resumed generation emits no `turn_start`).
4. **Reset at a restore** (RECORDING.md 3.2). When a generation's first snapshot line has a commit below one already
   seen, the store went back to a checkpoint: reset document state there, so a `(doc, key)` the snapshot does not
   carry no longer exists. `restoresOf(lines)` in `src/format.ts` finds those lines. The lines before it with a higher
   commit are the lost branch: they happened, so a panel may still show them, marked as lost.
5. **Take the process a supervisor line is about from its data.** `process.started` and `kill` carry no event-level
   `gen`; use `processOf(line)` from `src/format.ts`.
6. **Read durable `data` as RECORDING.md section 3.1 says**, and refuse a `data.version` you do not know rather than
   misread it.
7. **Skip kinds you do not know.** The format adds kinds without a new version.
8. **Use `t` only to place things in time.** Durable facts are ordered by `(commit, order)`, and after a restore a
   commit number names two commits, so pair it with the line's `gen`.
9. **Show unknown as unknown.** A cost that is `null` is "unknown", never `$0`.

## Browser pictures

A `{ tag: 'frame', session }` node shows the session's `frame.track` (a WebM) at the current time when the recording
has one, else its latest `frame` JPEG, and a `frame.gap` as a gap with its reason (`process_killed`,
`credential_on_page`, `session_released`), never as a frozen picture. A `credential_on_page` gap's `detail` (`field`,
`typed`, `too_deep`, `unreadable_frame` or `host`) is its tooltip. The browser panel decides which sessions to show
and lays out the tiles; the viewer draws the picture.

## Focus and the shell

The shell gives `view` a context: `t`, the time of the current point; `focus`, the focused path if there is one;
`cite`, the selected citation if there is one (a node with `cite` selects it, `?cite=` opens with it, and selecting one
moves no stop, so the screen it was clicked on stays); `json(sha)`, the parsed JSON of a blob the manifest's `result`
or a `result` line names, undefined until the shell has read it; and `baseline` when the manifest names one (`BaselineView`: its label, the counters of that other recording at its end,
and how long it ran in ms, or null; another real recording, opened beside this one, never typed-in numbers). When
`counters.measured` is false the recording has no durable line, so its counts are not measured and its cost is
unknown: show that, never its zeros.

A redraw keeps the reader's place: each scrolled element's offset and the element with the keyboard focus, found again
by place alone (at each step its tag, its first class and its rank among such siblings), never by its text.

Focus is a view input (RECORDING.md section 4 rule 4). The shell drops no line for it: every panel reduces the whole
run, and its `view` shows what is under the focused path its own way (filter, dim, highlight, or zoom on one branch
while the rest stays drawn). Keep the lines that have no `path` in the state: a conversation entry or a driver
checkpoint belongs to a branch without naming it. `under(path, focus)` in `src/format.ts` says whether a path is in
the focused branch. The two panels the viewer ships dim what is outside it, and so do the disk panel's paid calls. The counters strip never changes with the
focus.

## Rebuild a v4 item's state

A v4 run (RECORDING.md section 5, draft 26: the keyed layout) keeps each map item in an `agentrun.items` document, its
states as deltas against its map's base, and each base in an `agentrun.states` document. A panel never rebuilds an
item's state itself: it imports `itemStateOf(item, states, path)` from `./items.ts`, which runs the DSL's own
`itemState` with the page's SHA-256 (`sha256Hex`, `./receipt-key.ts`). It returns `{ state }`, or `{ unreadable }`
saying why (the base is missing, a digest differs, the item keeps no state at that path), and a panel shows such an item
as unreadable, never a guess. `statesBySha(values)` turns the `agentrun.states` values a panel keeps into the lookup
`itemStateOf` takes.

A failed map's finished results (draft 27) are the driver's `state.pin.partial.results`. A v3 pin keeps them inline. In
the keyed layout, `results` is the SHA-256 of an `agentrun.states` document whose state is the list of slots, one per
item in index order, each `null` (the item never finished) or the SHA-256 of the document holding that item's result,
any JSON value. A panel never reads them itself: it imports `partialResultsOf(partial, states)` from `./items.ts`, which
runs the DSL's own `partialResults` with the page's SHA-256, for either layout. It returns `{ slots }`, each `null`,
`{ result }` or `{ unreadable }`, or a whole `{ unreadable }` when the list is missing, does not hash to its digest or
is not a list of digests; every digest is checked.

A map with `onItemFailure: "collect"` (draft 28) collects an item that fails instead of failing, and keeps how the item
ended in exactly one place: in the keyed layout, the item's `agentrun.items` record, with status `"failed"` and
`outcome: { code, label, message }`; otherwise the driver state's `pin.failures`,
`{ <item path>: { code, label, message } }`, which holds every failed item of a v3 run and, in the keyed layout, only an
item of a map that committed before the run moved to it (such an item has no record). A panel reads it with
`itemFailureOf(path, item, pin)` from `./items.ts`, passing the item's record when the run keeps one: it returns
`{ failed, from }` (`from` is `"item"` or `"pin"`), `undefined` when the item did not fail, or `{ unreadable }` when
that place holds no `{ code, label, message }` (three strings, nothing else, as the DSL commits one) or the item is kept
in both. A panel shows a failed item as failed, with its outcome, and has nothing to rebuild for it. The failed-items
panel (`./failed-items.ts`) draws them: every failed item the run keeps at the stop, in map order, with its code, the
label of the node that failed, its message and where it was read from, and an unreadable one as unreadable. It keeps
each item's latest record and the driver's latest `pin`, starts over at each open's snapshot (a restore rolls back an
item that failed later), and is drawn only for a recording with a failed item.

The DSL's module, `itemState` and `partialResults` both, is read from `packages/dsl/src/recovery/item-state.ts` each time
the viewer is built, never copied here: it is the one file outside `apps/viewer` a viewer module may import, the build
inlines it in a scope of its own, and it refuses to build if that module ever imports anything.

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

Put the panel in `src/`, import it from `src/app.ts` so the build includes it, and add a test beside the others. The
extensions' panels show in the order they register, and the shell's own two (the run's lines and the model's turns)
come after them (`panelsShown` in `src/panels.ts`).

The build joins every module into one classic script, so two rules hold: import a name (`import { mapPanel } from
'./map.ts'`), never a bare `import './map.ts'`, which the build refuses; and keep every top-level name unique across
`src/`, since a duplicate is refused too.

## Motion, and a panel the recording is about

A view may draw motion by time. Four additions to the contract make that work without wall-clock animation, so a scrub
is still a replay:

- **`vars` on a node.** `h('div', { class: 'token', vars: { row: 2.4, age: 0.3 } })` sets `--row: 2.4` and `--age: 0.3`
  on the element. The values are numbers (a non-finite one is dropped), and a name is letters, digits and dashes starting with a letter
  (any other name is skipped, so a name is never a style string); the stylesheet reads them: `top: calc(var(--row) * 40px)`, or a paused animation with
  `animation-delay: calc(var(--age) * -1s)` that draws the frame for an age. Position and age are functions of the
  state and the clock, so the same time draws the same screen.
- **`now` in the context.** `ViewContext.now` is the playback clock in ms. At a stop it is the time of the point (what
  `t` is); while playing it runs between stops, and a link opened with `?t=` sets it to that time. `t` still says which
  lines have happened; `now` says how far into the run the screen is. A view that draws motion reads `now`.
- **`animated: true` on a panel.** While playing, the shell redraws the panels about ten times a second even when no
  new line has been reached, so a view that moves with `now` moves between stops. A panel that does not set it is drawn
  at each stop only, as before. A redraw is a fresh `view` of the same state, so a view stays pure.
- **`featured(lines)` on a panel.** When it returns true for the recording, the shell shows that panel first, under the
  title, with the playback controls directly under it, and the counters, timeline and the other panels after. Use it
  when the panel tells the recording's story (boxes and flights, a browser session). When several panels say they are
  featured, the first registered wins; the others are drawn in the usual place.

`?t=<seconds>` opens the viewer at a time (a number of seconds, no less than 0; anything else is ignored). It wins over
`at` and `cite`. The stop is the last whose lines all happened by then, so a time between two commits shows the stop
before it (never the inside of a commit), with the clock at the time asked for.

## The disk panel (`src/disk.ts`)

One panel for every demo that runs on a disk place. It reads the supervisor's `host` lines `run.json`, `delegation`,
`revoke` and `fenced` (RECORDING.md section 5), the shell's own `process.started` and `kill`, and the durable
`agentrun.effects` documents; it draws a lane per claim generation (who held it, from when, and how it ended: released
with its sealed sequence, killed or its box taken away, fenced, or replaced between two polls), the events between them
in order (the orphan flag as seen, the revoke and the takeover time, the fence), and each paid call marked made once,
repeated, cut by a kill (unknown, not sent again) or in flight. The paid-call verdicts are the shell's own counter fold
(`appliedIn`), so the panel and the counters strip agree. A recording with no disk claim line (`shows`: a `run.json`, `delegation`, `revoke` or `fenced` host line) does not draw the
panel at all, its title included. Its test, `test/disk.test.ts`, renders `test/fixtures/disk-takeover`.
