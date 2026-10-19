# The web example's agent

An agent that signs in to a website through a person, then reads the pages behind the sign-in and writes what it found
to files. A person asks it in a chat. It opens a real browser on Browserbase, opens the site's sign-in page and calls
`request_sign_in`, which ends its turn. The person signs in in the browser's live view and replies "done". The agent goes
on, writes `report.md`, `pages.csv` and `report/index.html` (the report as one script-free page) in its workspace, and
releases the browser. The next run of the same agent starts signed in, because both runs use the agent's Browserbase
context.

Use a test account on a practice site, such as https://the-internet.herokuapp.com/login. In this release the model's
page code can still read what the person types into the page, so a real password must not go through the live view.

| File | What |
| --- | --- |
| `agent.json` | The agent definition: `id`, `version`, `name`, `description`, `instructions`, `skills`, `tools`, `input_schema`, `output_schema`, `max_cost_usd`. It names no model: the host picks it. Its tools are `read`, `write` and `edit` in the workspace, the browser's `snapshot`, `run`, `browser_read` and `browser_release`, and `request_sign_in`. A tool name can also be a whole extension (`browser`). |
| `skills/<name>/SKILL.md` | The skills `agent.json` names, added to the prompt in that order. |
| `frames.ts` | `frameStore(runDir, clock, kept)`: the sink for pi-browser's frame recorder, which keeps what the browser showed in `<run>/frames/` (owner-only, outside `work/`) for the page's replay player, drops every frame while the person signs in, and hands each line it keeps to `kept` (the run's recording). |
| `chrome.ts` | The run's own Chrome for `AGENT_BROWSER=chrome`: its profile directory in the home and the save lease that decides who opens it, the run's download folder, its arguments, and its start and stop by pid. |
| `memory.ts` | The agent's memory between runs: the home's `memory/` into a new run's `work/memory/`, and the run's folder back to the home when the server carries back the run that owns the sign-in. |
| `remember.ts` | "What I remember": `report/remember.html`, written beside the agent's report when the run lets go. |
| `home.mjs` | `ensureAgentHome(dir)`: the agent home of [`@parcha/pi-durable-agent`](../../../packages/pi-durable-agent/README.md), made from `agent.json` and the skills the first time (owner-only), opened after that. |
| `app.ts` | The app `pi-durable-disk run --app` loads: the definition and skills from the home, the model from the environment, the file tools, the browser on the agent's saved sign-in and its frame recorder (2 frames a second), and `request_sign_in`. |
| `record.ts` | The run's recording when `RECORD_DIR` is set: the reference package's recorder inside the run, its redaction, and the finish start-run.mjs calls once the run has exited. |
| `redact.ts` | The rules a recording and a replay (`../replay.mjs`) share: the browser profile's id `[redacted]`, a session's id as its label, any `token=` value `[redacted]`, every `liveView` null, and the ids read from a run's store. It loads node's own modules only. |
| `start-run.mjs` | Runs one started run, with its door on loopback, and finishes its recording. |
| `agent.test.mjs`, `record.test.mjs`, `memory.test.mjs` | Offline tests: no network, no key, no model call. |

## Run one

The server in [`examples/web`](../README.md) makes the agent home and starts each run in it; that is the way to run the
agent. By hand, build the packages the app uses, start a run in a home with `startRun`, then run it:

```sh
npm ci --ignore-scripts
npm run build -w @parcha/pi-durable-disk -w @parcha/pi-browser -w @parcha/pi-durable-agent
export BROWSERBASE_API_KEY=...                       # your Browserbase key
export AGENT_MODEL_BASE_URL=https://api.openai.com/v1 AGENT_MODEL=<model id> AGENT_MODEL_API_KEY=...
node --input-type=module -e '
import { startRun } from "@parcha/pi-durable-agent";
import { ensureAgentHome } from "./examples/web/agent/home.mjs";
const run = await startRun(await ensureAgentHome("examples/web/.data/agent-home"), { runId: "run-1", host: "by-hand" });
console.log(run.dir);'
node examples/web/agent/start-run.mjs examples/web/.data/agent-home/runs/run-1
```

The run is `pi-durable-disk run --dir <home>/runs/<id> --app examples/web/agent/app.ts --serve 0`. Its directory holds
`run.json`, `store/run.sqlite` and `work/`, the workspace and the only place the model's file tools reach. While
`run.json` says `running`, its `holder.serve` is the run's door on loopback:

```sh
door=$(node -p "require('./examples/web/.data/agent-home/runs/run-1/run.json').holder.serve")
curl -s "$door/submit" -H 'content-type: application/json' \
  -d '{"requestId":"ask-1","content":"Log in to https://the-internet.herokuapp.com/login and read the secure area page. Write report.md and pages.csv.","wait":true}'
curl -sN "$door/events"
```

A submit without `conversationId` goes to the run's root conversation. The door creates it on the first request, with
the definition's prompt and tools and the browser's configuration in the commit that creates it. `GET /status` and
`POST /abort` are the door's too.

| Variable | Needed | What |
| --- | --- | --- |
| `AGENT_BROWSER` | no | `browserbase` (default) or `chrome`: the run's own Chrome on this machine, so nothing leaves it but the model. Browserbase stays the default until pi-browser ships `./live-view`: without it the person cannot see or drive the local Chrome, so cannot sign in. |
| `BROWSERBASE_API_KEY` | with Browserbase | Browserbase key. `BROWSERBASE_PROJECT_ID` is optional; Browserbase infers the project from the key. |
| `CHROME_PATH` | with `chrome` | The Chrome executable start-run.mjs starts. `PI_BROWSER_NO_SANDBOX=1` starts it without its sandbox, only where Chrome cannot start one. |
| `AGENT_PAGE_ORIGIN` | no | The origin people open the server's page at; the server sets it. A local Chrome's live view allows only that page to frame it. |
| `AGENT_LIVE_VIEW_MODULE` | no | Where the local Chrome's live view comes from. Default: pi-browser's `./live-view`, when this pi-browser has it. |
| `AGENT_MODEL_BASE_URL` | yes | An OpenAI Responses endpoint. |
| `AGENT_MODEL` | yes | The model id at that endpoint. |
| `AGENT_MODEL_API_KEY` | no | Its key, when it needs one. |
| `AGENT_MODEL_PRICE` | no | `input,output,cacheRead[,cacheWrite]` in USD per million tokens, so the run's usage has a price. Unset, it is $0. |
| `AGENT_THINKING` | no | `minimal`, `low`, `medium` (default), `high` or `xhigh`. Thinking is never off. |
| `AGENT_HOME` | no | The agent home. Default: the run directory's `../..`, the home `startRun` made it in. |
| `RECORD_DIR` | no | A new or empty directory: the run is recorded there (below). |
| `RECORD_REDACT` | no | With `RECORD_DIR`: a JSON array of words the recording must not hold, taken out wherever they appear. |

SIGTERM stops a run. It releases its Browserbase session first, so the sign-in is saved and nothing paid stays open, then
lets go of the run (`run.json` says `sleeping`) and exits 0. Starting the same directory again resumes it. Then
`carryBack(home, { runId }, { outcome })` returns the run's sign-in to the home; the server does this once a run has
answered.

## The sign-in's site, and what the browser showed

`request_sign_in` records the site it asked for on the run's profile (`browser.profiles`, key `default`): its origin goes
into `allowedOrigins` and the sign-in page into `startUrl`, read from the page the browser is on, or from the address
the agent named. The agent's first page on that origin after the person answers sets `verifiedAt`. `carryBack` takes all
three to the home, where the runs page lists them. A name that is no address ("the practice site") with no page open
records nothing, and the page says the sign-in's sites were not recorded. No tool reads a profile.

The app records the browser for the page's replay player with pi-browser's frame recorder, at 2 frames a second, into
`<run>/frames/` (`frames.ts`): owner-only, beside the run, outside `work/`. While the person signs in nothing is kept.
`request_sign_in` holds the frames as the call starts, before its first await, so before its result exists and the run
can say it waits; every other tool lifts the hold before it runs, and since `request_sign_in` ends the turn, that is the
agent's first step after the person's next message. While held, the sink refuses every frame, so the recorder counts
it dropped and no later gap starts from it, and one `frame.gap` (`credential_on_page`, detail `host`) marks where the
frames stopped. The recorder's own check for a password or a code on the page stays on. The recorder sends a frame only
when the page changes, so a page that did not change after the sign-in (the person's own sign-in already opened it)
leaves no frame after the gap until it does. A process started again while the person signs in starts without the hold,
and records nothing either: the recorder captures a session only from its next attach, which only a browser call makes.
When pi-browser's `FrameRecorderOptions.hold` reaches this repo, this hold moves to it.

## A recorded run

With `RECORD_DIR` set to a new or empty directory, the run is recorded as an agentrun.recording/1 directory
([RECORDING.md](../../../apps/viewer/RECORDING.md)) that the viewer replays: `manifest.json`, `events.jsonl` and `blobs/`.
The reference package's recorder runs inside the run (`record.ts`). From `beforeResume` on, before anything commits, it
writes a snapshot of every document, then the lines of each commit (pi's messages and every document; none is dropped),
pi's live events (turns, messages, tool calls) and each line the frame store keeps, all on the run's clock. When the run
lets go of its browser, each session's frames also become a WebM and its index (`frame.track`, when ffmpeg is on the
PATH). Once the run has exited, start-run.mjs finishes the recording: the agent's `report/` (`report/index.html` and what
it shows) as `manifest.artifact`, the manifest (`generations` from the recorded processes, `kills` 0, the model's and the
browser's cost), and the scans.

What a recording never holds, and how:

- The Browserbase key, the browser profile's id (the context id, or the Chrome profile's path), every live view, any
  `token=` value, and each word `RECORD_REDACT` names (a JSON array: words the person types that a page may also print,
  such as a practice site's shared account): each is `[redacted]`. The ids are learned where they arise, from the provider's answers and from the
  profile as it resolves, before anything writes them; the finish reads every id the run's store holds once more.
- A browser session's id: `session-` and 12 hex digits of its hash, so a session's lines and its frames still go together.
- A `liveView` in a document: null.
- The machine: the reference's scrub takes out the user name, the home directory and the run's directories.
- A frame while the person drives: the frame store keeps none, so the recording has none.

Before it lets go, the run scans what it placed for every id it learned, its live views included. The finish scans every
file of the recording for every id the store holds and the key, and writes no manifest when it finds one. Both name the
key and the file, never the value. A replay of the run (`writeReplay`, [`../replay.mjs`](../replay.mjs)) takes the
browser's ids, tokens and live views out of its rows and text files by the same rules (`redact.ts`).

A recording is of one run, finished when the run's process exits: a run started with `RECORD_DIR` naming a finished
recording fails, so record each run into a directory of its own. The server passes its environment to every run it
starts, so set `RECORD_DIR` only for a server that starts one run.

## Memory, downloads and what the agent remembers

What the agent keeps between runs is files in `work/memory/`, written with its own file tools (the memory skill:
`memory/index.md` names every file, `memory/preferences.md` holds how the person wants things done, `memory/accounts.md`
the accounts it works on and their start pages; never a secret). start-run.mjs copies the home's memory into a new
run's `work/memory/` before the agent starts, unless the run already has its own (a resumed run); a home with no
memory yet gives the run a `memory/index.md` that says nothing is remembered, so the agent's first read finds a file.
When the server
carries a run back, the run's folder becomes the home's (`<home>/memory/`, owner-only): each changed file written whole,
a file the run no longer has removed, nothing taken when a name is not a plain `.md` file or the folder is over its caps
(16 KB a file, 64 KB in all, 32 files). Only the run that owns the sign-in writes it: the one that held its save lease,
or made it. So one run writes at a time, as for sign-ins. `GET /agent` returns the memory files beside the sign-ins.
**This folder does not travel in a pack yet**: `packHome` copies the agent store and the runs only. Moving it into the
agent store is pi-durable-agent's to do; `work/memory/` stays the agent's contract either way.

With `AGENT_BROWSER=chrome`, each run's Chrome saves a file the page offers as a download into that run's
`work/downloads/` without asking: start-run.mjs sets the profile's download folder again for every run, since the
profile is shared across runs. The agent's file tools read a downloaded file by its name, and cannot list a folder.

When the run lets go of its browser, the app writes `report/remember.html` beside the agent's report: the sites the
agent is signed in to and when that was last checked, each memory file with its text, and the agent's runs, never a
profile's ref. The report links to it, and a recording carries both pages in `manifest.artifact`.

## A local Chrome

Browserbase is the default. A local Chrome is for a run that must keep everything on this machine but the model, and a
person can sign in through it only once pi-browser ships its live view (`./live-view`).

With `AGENT_BROWSER=chrome`, start-run.mjs starts one headless Chrome for the run, on a debugging port Chrome picks on
127.0.0.1, and pi-browser attaches to it by endpoint (`AGENT_CHROME_ENDPOINT`). Its profile directory is the sign-in:
`<home>/chrome/local-chrome`, owner-only and outside every run's `work/`. The run that holds the profile's save lease
(or the first run, before the agent has the profile) opens it and records it, so `carryBack` gives the home the profile
and its lease; any other run gets a signed-out profile of its own beside the run, removed with its Chrome. A release
leaves Chrome running; start-run.mjs stops it once the run has exited: it asks the browser to close over its debugging
socket, so Chrome writes its cookies, then ends the process by its pid if it is still there. The profile restores its
last session, so a site's session cookie (a sign-in that ends "when the browser closes") is still there next run.

pi-browser's live view shows that Chrome to the person. The run mounts the viewer on a loopback port of its own, named
in `<run>/live-host.json` (0600), and the server reaches it at `/live/<run id>/` on the page's own origin; the viewer's
token is in the URL's fragment, sent as the WebSocket's first message. While the agent is using the browser, what the
person clicks or types is dropped, not queued, and the viewer says so. A pi-browser without `./live-view` has no viewer
yet: live.json then says `live view not available for local Chrome yet`, and the Browser tab shows that.

## Sign-in

- `request_sign_in({ site, reason })` answers `Asked the person to sign in to <site> in the live view; waiting for them
  to reply done.` and ends the run: no model request and no tool call follow until the person's next message, so nothing
  touches the browser while the person signs in. An idle run whose newest entry is that result is waiting for the person.
- The sign-in is the agent's browser profile `default`: a Browserbase context. `startRun` copies the home's
  `browser.profiles` into the run store. Before the run serves anything, the app resolves the profile there with
  `durableProfileStore(harness).resolve("default", make)`: a saved context, or a new one `make` creates in Browserbase and
  commits to the run store. The browser opens on it, and Browserbase saves the context when the session ends.
  `carryBack` returns it to the home, so the next run opens the same context, signed in.
- The home and the run stores hold the context id, which opens a signed-in session: the home is created owner-only, and
  the model's file tools reach only `work/`.
- When a session opens, and each time its page changes, the app writes `<run>/live.json` (mode 0600):
  `{ liveViewUrl, sessionId, change, updatedAt }`. `liveViewUrl` is Browserbase's interactive live view and carries a
  token, so it goes only to the person's page: never to the model, a log or a transcript. It is null once the session is
  released.
- The context id never reaches the model: the browser's redactor scrubs it from every tool result. It is in the run's
  store, in the browser's configuration document, which the model does not read.
- Without `RECORD_DIR` the only recorder is the frame recorder above, and the agent has no screenshot tool.

## Limits

- `max_cost_usd` is in the definition for the host to enforce; this example does not stop a run at it yet.
- Two runs of one agent at the same time: only the run that holds the profile's save lease carries its sign-in back.
  Run them one after the other.
- A sign-in lasts as long as the site keeps it. When a site has ended it by the next run, the agent finds the sign-in
  page and asks the person again.
- Frames after a sign-in come only when the page repaints, until the recorder can capture on demand: a page that does
  not change after the person signs in leaves no frame after the gap, and the player shows the sign-in to the end.
