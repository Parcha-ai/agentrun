# The runs app

A small web server over one agent and its runs. It looks like a job history and a job page: list every run, click one,
watch its timeline live, talk to it, open its files, and see the browser it is driving. It is one file of Node's `http`, one
HTML page and no framework. The agent it starts is [agent/](agent/README.md).

The agent lives in an agent home of [`@parcha/pi-durable-agent`](../../packages/pi-durable-agent/README.md): its definition,
its skills, its saved sign-ins and the index of its runs in `agent.sqlite`, and each run in a directory that
[`@parcha/pi-durable-disk`](../../packages/pi-durable-disk/README.md) runs:

```
<home>/
  agent.sqlite        the agent store: definition, skills, sign-ins, the runs index
  runs/<id>/
    run.json          status, generation, heartbeat, the address of the run's door (holder.serve)
    store/run.sqlite  pi's store for the run, with the sign-in startRun gave it
    work/             the files the agent wrote (its skills under .agents/skills/, hidden here)
    live.json         host file: the agent's live browser view (never inside work/)
    web.json          written by this server for a run it starts: the title and the start time
```

## Run it

You need Node 22.19 or later. The server itself needs no key and no network. A run needs whatever its agent needs (see
[agent/README.md](agent/README.md)), and the agent's start command uses the built packages, so build the repository first.

```sh
npm ci --ignore-scripts && npm run build
node --no-warnings=ExperimentalWarning examples/web/server.mjs
```

Open `http://127.0.0.1:8787/`, type what the agent should do and press Start run. The agent home is
`examples/web/.data/agent-home`, ignored by git. The server makes it from `agent/agent.json` and `agent/skills/` the first
time, owner-only, and opens it as it is after that: to change the agent, start a new home.

Without a start command the server only shows the home's runs: it cannot start or wake one.

The agent's browser is Browserbase by default. `AGENT_BROWSER=chrome` runs each run on its own headless Chrome on this
machine instead (see [agent/README.md](agent/README.md#a-local-chrome)); the person signs in through it once pi-browser
ships its live view (`./live-view`), which this server then shows at `/live/<run id>/`. Until then Browserbase stays the
default.

| Flag | Default | What |
| --- | --- | --- |
| `--home DIR` | `examples/web/.data/agent-home` | The agent home. |
| `--start "CMD ARGS"` | `$AGENT_RUN_LAUNCHER`, else `agent/start-run.mjs` | Starts or wakes a run: the server runs `CMD ARGS <home>/runs/<id>` and keeps the child process. The command stays in the foreground as the run's instance and exits when the run ends or parks. The string is split on spaces, with no shell. The server passes its environment through untouched, so use a launcher script when a key must not sit in it. |
| `--host ADDR` | `127.0.0.1` | The address to bind. Anything but loopback prints a warning: the server has no sign-in. |
| `--port N` | `8787` | The port. |
| `--allow-host NAME` | none | An extra `Host` name to accept on a loopback bind. Repeat it. |
| `--origin URL` | the address it binds | The origin people open the page at, passed to each run as `AGENT_PAGE_ORIGIN`: a local Chrome's live view lets only that page frame it. |

## A run's life

1. `POST /runs` starts the run in the home with `startRun` (host `examples-web`): its directory, its store with the agent's
   saved sign-in, and the save lease for that sign-in when no other live run holds it. The saved sign-ins it starts with
   (ready, and its to use) go into its `web.json`. Then the start command runs it.
2. The agent works, and when a site needs a sign-in it asks the person and its turn ends. The run stays up with its browser
   open, so the person can sign in in the live view and answer "done". The agent app records the site on the run's
   profile, and nothing the browser shows is kept from that call until the agent's next step.
3. Once the run is idle and its newest row is the agent's answer, the server sends its process SIGTERM. The instance
   releases the browser (Browserbase saves the sign-in into the agent's context), then the run.
4. When the process has exited, the server calls `carryBack`: the run's sign-in goes back to the home, and the run's index
   entry gets its outcome, and its answer and cost as its released store holds them (an answer given while the run
   drained included). A server that stopped before a carry back does it when it starts again. A message that comes
   between the exit and the carry back waits for it, so it never starts the run again.
5. A run carried back is finished. A message to it is refused (`409`, `RUN_FINISHED`) and never wakes it; the page says
   so and offers a new run, which starts from the home, signed in. An instance still up for a run that another writer
   of the home carried back is sent SIGTERM.

The next run starts signed in.

## Routes

The page is at `/`. The data follows Grep's job routes.

| Route | What |
| --- | --- |
| `GET /runs` | The history, from the home's runs index: id, agent, status, state (working, waiting for you, or idle), title (the first message), start and end time, outcome, cost. |
| `POST /runs {content}` | Start a run with a first message. Answers `202 {id}`. |
| `GET /runs/{id}` | One run's summary. |
| `GET /runs/{id}/timeline` | Server-sent events while the run is live (`Accept: text/event-stream`); JSON rows for a released run. |
| `GET /runs/{id}/files`, `GET /runs/{id}/files/{path}` | The files under `work/`, and one of them (`?download=1` forces a download). |
| `POST /runs/{id}/messages {content}` | Send a message to the run's door: it steers while the agent is busy and follows up otherwise. A parked run is started again first. |
| `POST /runs/{id}/stop` | Abort the run's current turn. |
| `GET /runs/{id}/live` | A redirect to the live browser view, read from `live.json`. |
| `GET /live/{id}/...` and its WebSocket | A local Chrome's live view, which the run serves on a loopback port (`live-host.json`): passed through as it is, its Origin included. |
| `GET /search?q=` | A substring in every run's files, file names, titles and finished transcripts. |
| `GET /agent` | The agent's name and its saved sign-ins: `{ key, provider, state, sites, verifiedAt, heldBy }` each, `sites` the origins it is for and `heldBy` the live run that holds it. Never a ref or a start address. |
| `GET /runs/{id}/frames`, `GET /runs/{id}/frames/{sha256}.jpg` | What the run's browser showed: its `frames/frames.jsonl` lines, and one JPEG they name. `no-store`, and only to this page: a request another site makes (`Sec-Fetch-Site` or `Origin` says so) is refused. |

## What the page shows

- **Job history.** Every run in the home's index, newest first: input, status, agent, start time, cost. A live run shows the
  state its page shows, so one that asked the person to sign in says **Waiting for you**. Above it, the agent's saved
  sign-ins, one line each: `the-internet.herokuapp.com · Browserbase · saved 05:58`, or `Saved sign-in (Browserbase),
  sites not recorded` for one made before the agent recorded its site.
- **Timeline.** For a live run the server proxies the run's own `GET /events` and turns pi's events into rows with
  `@parcha/pi-durable-agent/timeline` (Grep's `TimelineEvent`: user message, thinking, text, tool calls and results,
  phases, waits, errors, the final answer). Tool calls pair with their results by call id, and calls of one kind fold into one line.
  A banner says **Waiting for you** when the newest thing in the run is a request for the person (the agent's
  `request_sign_in`), and the live browser opens large. A run that started on a saved sign-in says so under its title:
  **Started signed in to the-internet.herokuapp.com**.
- **After the run.** A run whose claim is released (sleeping, paused, done, failed) is read from its `store/run.sqlite`,
  opened read-only, with the same module. A live store is never opened: it is read only through its door.
- **Files.** The tree under `work/`, dotfiles hidden. A "Saved" row links to the file it names, by the row's `path`.
  Markdown is rendered with HTML escaped, CSV as a table, text as text, images inline. Agent-written HTML is shown in a
  frame sandboxed with nothing allowed. Every file can be downloaded, whole: a text file over 512 KiB is shown cut
  short at once, and its Download fetches all of it when clicked (a failed download says so and the preview stays).
- **Live browser.** While the run has a live view, it floats over the page, docked bottom right, with Enlarge, Minimize
  and Close (a **Show browser** chip brings it back). It opens large when the run starts waiting for the person and goes
  back to small once they answer. It is one frame for the run, kept while the run sleeps so a person can sign in after the
  agent's turn ended, and reloaded only when the view's address changes; no tab change reloads it. Leaving the run (a
  new run, a search, another run) removes it, and its connection to the live view with it.
- **Browser tab.** Once the run is not live, a player of what its browser showed: the frame at each time, play and
  pause, a scrubber with times, and each gap drawn on it and named, from where the frames stopped to the next frame, or to
  the end when none came after. The sign-in is one: **You signed in here (not recorded)**. The session's release ends the
  track. While the live view is up, the tab points at the panel.
- **Chat.** One message box under every tab, above the live browser, so a person can sign in and answer "done" without
  leaving the page.

The page imports the same timeline module from `timeline/` beside it, which the server serves from the package's built
files, found where Node resolves `@parcha/pi-durable-agent/timeline`. It has no dependencies and runs in Node and in the
browser.

## The page and its source

The run page is one module that reads only through a source, so the same page shows a live server's runs and a replay of
recorded runs from static files. Every URL it builds is relative, so it works under any path.

| Piece | What |
| --- | --- |
| `page/run-page.js` | `mountRunPage(root, source, { theme })`: draws the history and the run page into `root` and keeps them current; returns `{ unmount }`. `theme` (`auto`, the default, following the system, `light` or `dark`) is `data-theme` on `root`; every color in `app.css` is a `--ar-*` token there (`--ar-bg`, `--ar-fg`, `--ar-muted`, `--ar-line`, `--ar-soft`, `--ar-accent`, `--ar-accent-soft`, `--ar-on-accent`, `--ar-ok`, `--ar-bad`, `--ar-bad-soft`, `--ar-warn`), set with no specificity, so a host overrides any of them with a rule of its own. A sandboxed file frame is told the theme's color scheme. It shows a new-run box, the message box, Stop and the Browser tab only when the source has `start`, `submit`, `stop` and `live`. A source with none of them is a replay: the page says so, reads each run once, and shows no live browser. |
| `page/source.js` | The `RunSource` interface (JSDoc), `httpSource(base)` and `staticSource(base)`, and the rules both sides share: `RUN_ID`, `safePath`, `stateOf`, `costOf`. |
| `replay.mjs` | `writeReplay(outDir, runs)`: the one writer of the static layout, which reads each run itself. `readRunEntries(storePath)`: the one reader of a run's store (the server reads a released run with it too). |
| `pack-page.mjs` | `node examples/web/pack-page.mjs <outDir> [--data ./data/]`: the self-contained replay page. |
| `page/app.js`, `page/replay.js` | The two bootstraps: the server's page on `httpSource`, and a replay on `staticSource`. |

A `RunSource` has `list()` (the history, newest first), `run(id)`, `timeline(id, { live, signal })` (a released run's
`{ rows, state, costUsd }`, or, for a live run, the same view each time it changes, until the run stops serving),
`files(id)`, `file(id, path, { download })` (a `Response`: as the page shows it, where a long text file may come back
cut short with `x-truncated: 1`, or, with `download`, all of it) and `search(q)`. A live source also has `start(text)`,
`submit(id, text)`, `stop(id)`, `live(id, run)` (the live view's frame: `{ key, src }`, or null), `agent()` (the saved
sign-ins), `frames(id)` (the frame lines) and `frameSrc(id, sha256)` (one frame's address).

- `httpSource(base)` is this server's routes under `base`, the address the page is served from.
- `staticSource(base)` reads a replay under `base`. It has no way to act, no live view, no saved sign-in and no frames: a
  replay never carries them, since a live view's address is a full-control token and frames after a sign-in show the
  person's own pages. Search looks at the runs' titles.

A replay site computes nothing: `writeReplay(outDir, runs)` does the reading. Per run it takes `{ id, store, manifest?,
files?, summary? }`:

- `store`: the run's store, an exported one or a released run's own `store/run.sqlite`. Its rows are
  `timelineOf(readRunEntries(store), { settled: true })`. A store that still holds a document of pi-durable-agent's
  `SECRET_KINDS` (`browser.profiles`, `agent.leases`, `agent.bindings`, `agent.aliases`) is not exported, and the run is
  refused: export it first. `rows` in place of `store` takes ready rows (tests).
- `manifest`: a recording's `manifest.json` (`agentrun.recording/1`). The run's files are its result blob, as
  `result.<ext>`, and its job blob, as `job.<ext>`, out of the recording's `blobs/`, each checked against its SHA-256
  name; nothing else (no frame, screenshot or evidence blob). The job blob names the job's input files; a recording does
  not keep their contents. The manifest also gives the summary's title, start and end, and, only when its `providers`
  is `"real"`, the cost.
- `files`: with no manifest, a directory (dotfiles and links left out) or path to text or bytes. A run's own directory is
  refused (its store holds the sign-in, its `frames/` what the browser showed): give it the run's `work/`.
- `summary`, `run`: fields over the ones worked out (title, times, cost, `status: "done"`).

A replay names a dollar figure only for a recording that is real: a run whose cost is `null` (one with neither a real
recording's manifest nor a cost in its `summary`) is written with its usage rows counting model requests and naming no
amount, and the run page's header shows a replay's cost from its summary alone, never from its rows. A live run's
header still falls back to the cost so far.

The layout it writes:

```
<base>/runs.json                  { "version": 1, "runs": [RunSummary, ...] }, newest first
<base>/runs/<id>.json             the Run
<base>/runs/<id>/timeline.json    the rows, in order
<base>/runs/<id>/files.json       [{ "path", "size" }, ...]
<base>/runs/<id>/files/<path>     each file
```

`writeReplay` refuses, before it writes anything, a run id the page could not ask for, a summary or run record for
another id, a run's own directory as its files, a path of the frames layout (`frames/frames.jsonl`,
`frames/blobs/<sha256>.jpg`), a file path that is absolute, has a `.` or `..` segment, names a dotfile, or names a file
and a directory at once, and two runs whose paths collide (ids `a` and `a.json`); every summary and run is written with
`live: false`, no live view, no saved sign-in it started with and no frames. It writes the new replay beside its
directory and swaps it in, so a write that fails leaves the replay that was there whole. `pack-page.mjs` writes `index.html` (its Content-Security-Policy as a meta tag, since a
static host sets no headers), `replay.js`, `run-page.js`, `source.js`, `app.css` and `timeline/`; the page reads the
replay from the `replay-data` meta tag's address, `./data/` unless `--data` says otherwise. So:

```sh
node examples/web/pack-page.mjs site/run
# then write the replay into site/run/data with writeReplay, and serve site/ from any static host
```

A file view keeps the server's guards in a replay too: the page asks only for a path `safePath` allows, shows text as
text, and puts agent-written HTML in a frame sandboxed with nothing allowed (no scripts, an origin of its own).

## Safety

- It binds to loopback and refuses requests whose `Host` is not a loopback name (DNS rebinding), whose `Origin` is another
  site, or that are not JSON when they change something.
- A run's door address from `run.json` is used only if it is `http://` on loopback.
- Files are served from `work/` only. A path with a dot segment, `..` or a symlink anywhere in it is refused.
  Responses carry `X-Content-Type-Options: nosniff`. HTML gets `Content-Security-Policy: default-src 'none'; style-src
  'unsafe-inline'; img-src data:; sandbox; form-action 'none'` and is only shown in an `<iframe sandbox>` with no
  `allow-scripts` and no `allow-same-origin`.
- The live view address is read from `live.json` on the server, at the moment the frame loads. The page never receives it:
  the frame points at `/runs/<id>/live`, which redirects, and the page only learns a short hash that changes with the address.
  The server never logs it and no row, search result or file holds it.
- A run's frames are `<run>/frames/` (`frames.jsonl` and `blobs/<sha256>.jpg`), owner-only (0700, files 0600), beside the
  run and outside `work/`: no tool of the agent's reaches them, the files routes and search never list them, and no
  replay, pack or recording carries them. The agent app keeps none while the person drives the browser: from the moment
  `request_sign_in` is called, before the run can say it waits, until the agent's next step, every frame is dropped and
  one gap marks the place. The recorder's own check for a password or a code on the page stays on as well. When
  pi-browser's `FrameRecorderOptions.hold` reaches this repo, the agent app's hold moves to it.
- `GET /agent` and a run's summary name a saved sign-in by its key, provider and sites; the ref (the Browserbase context
  id) never leaves the home's and the run's stores.
- The server stops the processes it started, by pid, with SIGTERM, and waits up to 45 seconds for a run to drain and release
  its browser before it kills one. Runs are durable: a stopped run resumes the next time someone writes to it.

## Test

```sh
npm run build -w @parcha/pi-durable-disk -w @parcha/pi-browser -w @parcha/pi-durable-agent
node --test examples/web/server.test.mjs examples/web/run-page.test.mjs examples/web/agent/agent.test.mjs
```

The tests use a fake door that emits canned events, a fake run instance, and an agent home made in the test, with no
network and no key. The agent's tests feed its frame store as the recorder would: a frame that arrives between the call to
`request_sign_in` and its result is dropped, the directory's modes are owner-only, and `read`, `write` and `edit` refuse a
path into `frames/`. The page's tests draw the packed page on a small DOM (`fake-dom.mjs`) over a fake source, live and
replay, and read a replay written by `writeReplay` back through `staticSource` from a static host under a subpath.
