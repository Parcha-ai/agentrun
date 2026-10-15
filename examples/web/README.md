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
   saved sign-in, and the save lease for that sign-in when no other live run holds it. Then the start command runs it.
2. The agent works, and when a site needs a sign-in it asks the person and its turn ends. The run stays up with its browser
   open, so the person can sign in in the live view and answer "done".
3. Once the run is idle and its newest row is the agent's answer, the server sends its process SIGTERM. The instance
   releases the browser (Browserbase saves the sign-in into the agent's context), then the run.
4. When the process has exited, the server calls `carryBack`: the run's sign-in goes back to the home, and the run's index
   entry gets its outcome, and its answer and cost as its released store holds them (an answer given while the run
   drained included). A server that stopped before a carry back does it when it starts again.
5. A run carried back is finished. A message to it is refused (`409`, `RUN_FINISHED`) and never wakes it; the page says
   so and offers a new run, which starts from the home, signed in.

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

## What the page shows

- **Job history.** Every run in the home's index, newest first: input, status, agent, start time, cost. A live run shows the
  state its page shows, so one that asked the person to sign in says **Waiting for you**.
- **Timeline.** For a live run the server proxies the run's own `GET /events` and turns pi's events into rows with
  `@parcha/pi-durable-agent/timeline` (Grep's `TimelineEvent`: user message, thinking, text, tool calls and results,
  phases, waits, errors, the final answer). Tool calls pair with their results by call id, and calls of one kind fold into one line.
  A banner says **Waiting for you** when the newest thing in the run is a request for the person (the agent's
  `request_sign_in`), and opens the Browser tab.
- **After the run.** A run whose claim is released (sleeping, paused, done, failed) is read from its `store/run.sqlite`,
  opened read-only, with the same module. A live store is never opened: it is read only through its door.
- **Files.** The tree under `work/`, dotfiles hidden. A "Saved" row links to the file it names, by the row's `path`. Markdown is rendered with HTML escaped, CSV as a table, text as text,
  images inline. Agent-written HTML is shown in a sandboxed frame with no scripts. Other types are downloads.
- **Browser.** The run's live view in one frame, kept while the run sleeps so a person can sign in after the agent's turn
  ended. The frame reloads only when the view's address changes.
- **Chat.** One message box under every tab, so a person can sign in on the Browser tab and answer "done" without leaving it.

The page imports the same timeline module from `/timeline/`, which the server serves from the package's built files, found
where Node resolves `@parcha/pi-durable-agent/timeline`. It has no dependencies and runs in Node and in the browser.

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
- The server stops the processes it started, by pid, with SIGTERM, and waits up to 45 seconds for a run to drain and release
  its browser before it kills one. Runs are durable: a stopped run resumes the next time someone writes to it.

## Test

```sh
npm run build -w @parcha/pi-durable-disk -w @parcha/pi-browser -w @parcha/pi-durable-agent
node --test examples/web/server.test.mjs examples/web/agent/agent.test.mjs
```

The tests use a fake door that emits canned events, a fake run instance, and an agent home made in the test, with no
network and no key.
