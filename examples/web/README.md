# The runs app

A small web server over a directory of durable runs. It looks like a job history and a job page: list every run, click one,
watch its steps live, talk to it, open its files, and see the browser it is driving. It is one file of Node's `http`, one
HTML page and no framework.

It reads the layout that [`@parcha/pi-durable-disk`](../../packages/pi-durable-disk/README.md) writes for a run on a
directory of this machine:

```
<runs>/<id>/
  run.json          status, generation, heartbeat, the address of the run's door (holder.serve)
  store/run.sqlite  pi's store
  work/             the files the agent wrote
  live.json         host file: the agent's live browser view (never inside work/)
  web.json          written by this server for a run it starts: the title and the start time
```

## Run it

You need Node 22.19 or later. The server itself needs no install, no key and no network. A run needs whatever its agent
needs, and the agent's start command uses the built packages, so build the repository first.

```sh
npm ci --ignore-scripts && npm run build
node --no-warnings=ExperimentalWarning examples/web/server.mjs \
  --runs ./runs \
  --start "node examples/web/agent/start-run.mjs"
```

Open `http://127.0.0.1:8787/`. Type what the agent should do and press Start run. The start command is the agent's own
(see [agent/](agent/)); it needs its keys in the environment, and the server passes its environment through untouched.

Without `--start` the server only shows runs that already exist in `--runs`: any run directory of
`pi-durable-disk run --dir`, live or finished.

| Flag | Default | What |
| --- | --- | --- |
| `--runs DIR` | `./runs` | The runs directory. |
| `--start "CMD ARGS"` | none | Starts or wakes a run: the server runs `CMD ARGS <runs>/<id>` and keeps the child process. The command stays in the foreground as the run's instance and exits when the run ends or parks. The string is split on spaces, with no shell. |
| `--host ADDR` | `127.0.0.1` | The address to bind. Anything but loopback prints a warning: the server has no sign-in. |
| `--port N` | `8787` | The port. |
| `--allow-host NAME` | none | An extra `Host` name to accept on a loopback bind. Repeat it. |

## What it does

- **Job history.** Every `<runs>/*/run.json`, newest first, with status, start time and, for a finished run, its cost.
- **Live steps.** For a live run the server proxies the run's own `GET /events` and turns pi's agent events into rows: your
  message, the agent's text, thinking as a collapsed "Thinking, Ns" row, tool calls grouped by kind ("Browser, 4 actions",
  expandable to each call with its arguments and result), files written, and errors. A banner says **Waiting for you**
  when the agent has ended its turn.
- **After the run.** A run whose claim is released (sleeping, paused, done, failed) is read from its `store/run.sqlite`,
  opened read-only, with the same row code. A live store is never opened: it is read only through its door.
- **Chat.** Send a message with `POST /submit` to the run's door: it steers while the agent is busy and follows up
  otherwise. Stop calls `/abort`. A message to a parked run starts it again with the start command and waits for its door.
- **Files.** The tree under `work/`, dotfiles hidden. Markdown is rendered with HTML escaped, CSV as a table, text as text,
  images inline. Agent-written HTML is shown in a sandboxed frame with no scripts. Other types are downloads.
- **Live browser.** The run's live view in a frame, from `live.json`, read by the server only.
- **Search.** `GET /api/search?q=` finds a substring in every run's `work/` files, their names, the run title and the
  transcript of finished runs.

## Safety

- It binds to loopback and refuses requests whose `Host` is not a loopback name (DNS rebinding), whose `Origin` is another
  site, or that are not JSON when they change something.
- A run's door address from `run.json` is used only if it is `http://` on loopback.
- Files are served from `work/` only. A path with a dot segment, `..` or a symlink anywhere in it is refused.
  Responses carry `X-Content-Type-Options: nosniff`. HTML gets `Content-Security-Policy: default-src 'none'; style-src
  'unsafe-inline'; img-src data:; sandbox; form-action 'none'` and is only shown in an `<iframe sandbox>` with no
  `allow-scripts` and no `allow-same-origin`.
- The live view address is read from `live.json` on the server. The page never receives it: the frame points at
  `/api/runs/<id>/live`, which redirects. The server never logs it.
- The server kills only the processes it started, by pid, when it stops. Runs are durable: a stopped run resumes the next
  time someone writes to it.

## Test

```sh
node --test examples/web/server.test.mjs
```

The tests use a fake door that emits canned events, and a runs directory built in the test, with no network and no key.
