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
  showsResult: (result, { blobType }) => isMine(result), // optional: a result that has this panel drawn even when no line does
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

A panel whose story is in the run's result rather than in its lines gives `showsResult(result, { blobType })`: the
parsed JSON a result names (the manifest's or a `result` line's). The second argument gives `blobType(sha)`, a blob's
media type as the shell knows it (the same function views get), so a panel decides whether it shows a result by the
same rule it draws by; a panel may ignore it. The shell asks it once, when it has read the results as the
recording opens (and, for a run it follows, when the run delivers one), and never for a recording with no result or a
result that is not JSON. It is pure and cheap and reads nothing of the stop: a result is the whole recording's, so a
scrub never makes a panel appear or vanish. The document panel draws only for a result that cites a page, though every
run's result line is one it reduces.

## What `view` returns

Plain nodes, not DOM. The viewer draws them.

- `h(tag, props, ...children)`: an element. `props.class`, `props.title`, `props.path`, `props.cite` (a click selects
  that citation, below) and `props.box` (`{ x, y, w, h }` in percent: the element is placed over its parent, which the
  panel's CSS positions).
- A string: text.
- `{ tag: 'img', blob, alt }`: an image from the recording's `blobs/`, by its SHA-256.
- `{ tag: 'a', blob, text, fragment? }`: a link to any file in `blobs/` (an evidence record, the result), opened beside
  the page, at `fragment` when it has one (`page=2`, `t=30`).
- `{ tag: 'a', href, text }`: a link to a page outside the recording, drawn as a link only when `href` is an `http` or
  `https` address, and opened apart from the viewer (`noopener`, `noreferrer`); any other address is plain text.
  A view never reads a blob's bytes: the shell resolves the hash to a URL when it draws. The one exception is the
  result's JSON, which the shell reads and hands every view (`json`, below).
- `{ tag: 'frame', session }`: a browser session's picture at the current point (below).
- `{ tag: 'pdf-page', blob, page, alt, children }`: page `page` of a PDF in `blobs/`, drawn by the shell with PDF.js
  at the width of its place and its own proportions, with `children` placed over it: give each a `box`, in percent of
  the page as PDF.js draws it (its crop box, which is also the page pi-vision renders and cites, so a cite's
  `xywh=percent:` is a box as it is). Until the page is drawn the shell shows that it is drawing, and when it cannot
  draw it (a page opened from `file://` cannot load PDF.js, a file that is not a PDF, a page past the last) it says
  why and links the file at that page; the children are drawn only over a drawn page, so a view says in its own text
  what they mark.

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
`following` when the run is followed while it goes and has not finished (its cost is not known yet: a view shows cost
as unknown); `cite`, the selected citation if there is one (a node with `cite` selects it, `?cite=` opens with it, and selecting one
moves no stop, so the screen it was clicked on stays); `json(sha)`, the parsed JSON of a blob the manifest's `result`
or a `result` line names, undefined until the shell has read it; `blobType(sha)`, a blob's media type from its name in
`blobs/` (undefined until the shell has found it), so a view can draw a picture a result cites and link any other file;
`manifestResult`, the result the manifest names (`{ blob, title }`) for a recording in which no line delivers one, so a
view that shows a result from its `result` line shows that one at every stop, labelled as the run's final result, since
no line gives its time; and `baseline` when the manifest names one (`BaselineView`: its label, the counters of that other recording at its end,
and how long it ran in ms, or null; another real recording, opened beside this one, never typed-in numbers). When
`counters.measured` is false the recording has no durable line, so its counts are not measured and its cost is
unknown, a box's receipt notwithstanding: show that, never its zeros. `counters.costParts` is the cost by part (the
model's usage as `lead`, `judge`, `eyes`, `browser`, and `boxes`, each box's `box.receipt` at list price); `costLabel`
draws it as the strip does, naming the boxes apart at list price, and in a scripted run the other parts scripted.

A run's result is the demo's own JSON, and two formats are known to the vision panel: `apollo11.account/1`, and the
generic cited result `agentrun.cited/1` (RECORDING.md: rows of a label and a value, each citing a blob, a look or
both, and where and when it was read). A panel that shows what a run delivered reads the generic one and ignores fields it does not know.
The vision panel draws a cited file that is a picture in the recording (PNG, JPEG, WebP or GIF) small in its row, and
for a window of film the eyes saw with no picture of their own, shows the pictures a row cites beside that window,
labelled as that row's keyframe, never as what the eyes saw. A transcription (RECORDING.md draft 38: a record of a
look's shape with tool `transcribe`, its body rows `start<TAB>end<TAB>words` in seconds) is drawn in a speech lane as
those rows, a video's too, never as a picture or a window of film; a `#t=` cite of its look, or of the file it heard,
marks the row its second falls in, and a cited second that falls in no row is said to.

A redraw keeps the reader's place: each scrolled element's offset and the element with the keyboard focus, found again
by place alone (at each step its tag, its first class and its rank among such siblings), never by its text.

Focus is a view input (RECORDING.md section 4 rule 4). The shell drops no line for it: every panel reduces the whole
run, and its `view` shows what is under the focused path its own way (filter, dim, highlight, or zoom on one branch
while the rest stays drawn). Keep the lines that have no `path` in the state: a conversation entry or a driver
checkpoint belongs to a branch without naming it. `under(path, focus)` in `src/format.ts` says whether a path is in
the focused branch. The two panels the viewer ships dim what is outside it, and so do the disk panel's paid calls. The counters strip never changes with the
focus.

## Embedding

A page may frame the viewer with `&embed=1`: no header (a recording that breaks the format still says so), the frame's
full width. Framed, it speaks a small protocol with `postMessage`, and steers only when its URL names the framing
page's origin with `&parent=<origin>` (an http or https origin, written as one, such as `https://example.org`).

The viewer posts, each `{ source: "agentrun-viewer", type, ... }`, to the origin `&parent=` names, else to the framing
page's when the browser gives it (an http or https page), else to any:

| `type` | when | fields |
| --- | --- | --- |
| `ready` | once, before the first draw | `stops` (the last stop), `chapters` (`[{ title, stop }]`) |
| `position` | at every stop it moves to, the first draw included | `stop`, `gen` and `commit` (the last durable line's, or `null`), `t` (ms), `chapter` (`{ title, stop }` or `null`) |
| `focus` | when the focused path changes, and once at the start | `path` (a workflow path, or `null`) |

It obeys only these, and only from the framing page itself (`event.source` is its parent) at the origin `&parent=`
names; any other message, origin or field is ignored, and no message carries code to run:

| `type` | fields | what it does |
| --- | --- | --- |
| `seek` | exactly one of `stop` (a whole number up to the last stop), `commit` with an optional `gen` (whole numbers), or `t` (seconds, finite, not negative) | moves the point there, as the scrubber does |
| `focus` | `path`: a workflow path (`/` then letters, digits and `_ . / : # -`, at most 512 characters), or `null` | focuses that branch, or clears the focus |
| `theme` | `theme`: `light`, `dark` or `auto` | sets the page's colours; `auto` follows the system |

Without `&parent=`, the viewer still posts, and listens to nothing.

## What a public replay shows

A replay shows what the run's agent did. By default the viewer draws no part that tells a kill and a resume, and keeps
the payments and the cost one click away. The view as it was, every part drawn, is behind `?debug=durability`, which no
public page sets.

- **Durability, not drawn.** The shell marks `durability`:
  - the timeline's process lane, with each process, its kill, a restore and the journal's opens (the picture starts
    below the lane);
  - the processes, kills, repeated, asked twice and journal opens counters.

  It leaves out the chapters it would make of each process start and kill, in the page and in the embed protocol's
  `ready`; a manifest's own chapters stay. A panel marks its own such parts with the class `durability`:
  - the vision panel: its kill and resume badges, and its kept, repeated, asked twice and possible payments meters;
  - the workflow map: its kills, a cell's mark of a kill that cut it, and the price of chaos;
  - the transport panel: its kills;
  - the disk panel: a generation that ended without a holder.
- **Receipts, one click away.** The strip's looks paid and cost sit under a disclosure, Receipts. So do the vision
  panel's meters and the receipt of its look.
- **A look leads with its answer.** In the vision panel's film and pages lanes, a look shows what the eyes answered and
  the rows that cite it first. Its picture (the frames, the page with its boxes) is below, in a disclosure a click opens.

A view reads the page's debug views from `ViewContext.debug` (`durability` among them in the debug view).

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

## The run's picture

The run's result so far as an image (RECORDING.md draft 31): the recording's home side draws it from the run's committed
results and writes it as a `picture` host line, `{ blob, label?, commit? }`, with no `gen`, since no process the run can
lose writes it. The picture panel draws the latest picture at or before the stop, a gap before the first, and keeps the
last one after the run ends, a kill included. It is any job's picture, read from the line alone. A recording with no
`picture` line draws no picture panel; one with pictures shows it first (`featured`), since a run that draws its result as
it goes is about that picture. The image is drawn at the panel's width with its pixels kept sharp. Its test is
`test/picture.test.ts`.

## The document panel (`src/document.ts`)

The pages of a PDF a run's result cites, each drawn whole, with every box a row cites over its page. It reads the generic
cited result (`agentrun.cited/1`): a cite that names a blob and a page (`page=N`) is that page of that file, and a cite
whose fragment also names a region (`page=N&xywh=percent:x,y,w,h`, pi-vision's form) is a box on it. Each page is drawn
once (in the order the result first cites it) as a `pdf-page` node; under it, every row that cites the page, numbered,
with its value and its box, or "no box" for a row that cites the page without a region (a mark checked and found
absent). Each box carries its row's number, with the row's words beside it where the page is wide enough, and rows
that cite the same region share one box. A box and a row that cite a look select it when clicked, as a citation chip does, and the
selected one is lit. A cite whose file the shell knows to be a picture is not a page. A recording whose result cites no
page draws no document panel (`showsResult`). PDF.js is the viewer's one dependency, shipped as its release files
(`vendor/pdfjs/README.md`). Its test is `test/document.test.ts`, which also draws a hand-made PDF in Chrome under a
static host's policy that loads scripts, workers and data from its own origin only.
