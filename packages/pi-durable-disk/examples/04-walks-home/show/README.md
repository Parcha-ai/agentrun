# show: the stage for "It Walks Home"

One page: the tab app (D3) on the left in a same-origin iframe, the multiverse panel, cost meter and machine timeline
on the right, the environment switcher across the top. It reads a `ShowState` and never talks to a cloud.

## The feed contract (D1 implements, this package consumes)

Types are in `types.ts`; the fold is `reduce.ts`. The server exposes:

| Route | Meaning |
| --- | --- |
| `GET /api/state` | the fold of every event so far: `ShowState` |
| `GET /api/events` | SSE; each `data:` is one `ShowEvent`, sent after the state the page just fetched (`Last-Event-ID` resumes) |
| `POST /api/command` | body `ShowCommand`: `kill` a universe, `switch` the run, `reset` the fake feed |

Rules a producer must keep:

- Times are ms since the run's origin (`run.origin` is the wall-clock ms of 0).
- `universe.host` is the driver's own machine label, the same string the agent's env.switch notice uses.
- Statuses: `spare starting training killed takeover winner sealed`. A killed universe keeps its `slot` until a spare
  takes it: send `{universe spare1 slot:3 status:takeover replaces:u3}` and `{universe u3 slot:null replacedBy:spare1}`.
- One `sample` per checkpoint with a strictly increasing `at`; `cost` on a sample is the universe's spend to date.
- A `stay` is a stretch on one machine. `lane` is `run` for the main line or `u:<id>` for a universe.

The stage also models two things the live driver will own: `GET/PUT /api/disk/<path>` (the agent's disk, for the tab's
`storage-read`/`storage-write` messages; a missing file is 204) and `/policy/home.json` (the winner's mlp-v1 policy,
served from `POLICY_DIR`). With a live driver, point both at the real disk.

Pointing the stage at a live feed: `SHOW_API=http://host:port node serve.ts` proxies `/api/*` to it.

## Run it

    npm ci && npm run build && node serve.ts          # fake feed, http://127.0.0.1:8750/
    TAB_DIR=<tab dist> node serve.ts                    # with D3's tab app instead of the stub
    npm test && npm run typecheck

## The switch beat (tab, a second host, and back)

The stage can watch a real 03 run through its pipe and drive its switcher. No cloud: the disk is a local directory and the
"second host" is browser-demo's `--cloud remote-local` (`remote-host.ts` as a child process on loopback; environment `remote-local`,
label "Second process"). One launcher starts it: `scripts/take-server.mjs`, which is also how the take's own 03 server starts.

    node scripts/chrome.mjs                              # own Chrome with software WebGL
    CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> node scripts/switch-beat.mjs

`switch-beat.mjs` starts the take server (with the second process) and the stage (`SHOW_PIPE_LINK_FILE`), attaches the real 03 tab page as the
run's writer, then clicks tab, the second process, tab in the stage's switcher and checks 11 things: the four named targets (tab,
sandbox, VM, GPU; the ones the feed does not list are greyed, "wired by name"), the caption tagged MEASURED with the
milliseconds the SERVER timed (from receiving the switch to the new host's notice committed), the timeline stay carrying the
same number, the agent's notice, and the agent's answer through the model broker (a few short answers). Typical numbers on
this box: tab to second host 0.7 to 0.9 s, back to the tab 0.06 s.

`--record recordings/switch-beat.webm` also records the stage tab (VP8/WebM, 15 fps, each caption stack held 5 s so it can be read).
The storyboard (`scripts/storyboard.mjs`) carries a reference block: the real switch times measured on Daytona and published
on `docs.g.parcha.dev` (`reference-timings.json`, with its source), tagged MEASURED on Daytona, beside this stage's own local
numbers from the last `switch-beat` run, tagged MEASURED locally. The two are never mixed.

By hand: `node scripts/take-server.mjs --local <dir> --cloud remote-local` (it writes the run's link to `<its dir>/link`, mode 0600, and
prints only the origin and the PATHS of the token and link files), open the link in a browser as the tab, then
`SHOW_PIPE_LINK_FILE=<that link file> node serve.ts`. Env: `SHOW_PIPE_ROLE` (the hello mode: `operator`, the default, may switch the
run and ask the agent; `view` only watches and is refused both with the pipe's own reason), `SHOW_ASK_AFTER_SWITCH=0` (no
question to the agent), `SHOW_PIPE_TRACE=1` (log each frame's type).

The stage connects as the pipe's `operator` and does not say it can run the agent (`canRun` stays off). A switch into the tab is
therefore answered by a tab page that can run it (the 03 page says so), or is refused before anything moves with "no browser tab
that can run the agent is open on this run". `node scripts/role-check.mjs` checks the roles against the real 03 server. Cloud
targets light up when the feed lists their environments.

## Live day: run the preflight first

    CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> POLICY_DIR=<dir with home.json> SHOW_API=<live feed url> node scripts/preflight.mjs

It reads and probes only (starts nothing, spends nothing) and exits non-zero on any failure. Each check is a way the stage went
wrong in rehearsal: a Chrome with no WebGL (the shared one has none, so the creature's 3D view is blank; start one with
`scripts/chrome.mjs`), a tab app or 03 page built before its sources changed (an old 03 page treats a switch to the tab as an
untimed takeover), a missing or wrong-version policy (the home beat shows a refused policy), a dead model broker (no agent
answers after a switch), a feed that is not answering. For a recorded take use `SHOW_AUTOKILL=off` on the scripted feed so the
only kill is the one the script clicks; against a live feed the stage sends no command until the operator presses a button.

## The live desktop of a VM

When the run is on a VM (an environment of kind `vm`), the stage shows that machine's desktop over the multiverse area, view
only (the agent drives it with its `computer` tool). It uses D4's route on the 03 server: the stage's SERVER trades the run's
secret for a ticket (`POST /run/<id>/desktop-ticket`, bearer secret) and proxies `/desktop/<ticket>.mjpeg` to the page, so the
secret never reaches the page and the picture loads from the stage's own origin, under its COEP. Until the host has a desktop
the panel says "The desktop is not up yet" and asks again every 3 s; it asks again before the 10 minute ticket ends, and when the
run leaves the VM the picture closes, which closes the host's stream. `SHOW_DESKTOP_LINK_FILE` names the 03 run link (default:
the pipe's `SHOW_PIPE_LINK_FILE`); with neither the stage never asks. `node scripts/desktop-check.mjs` checks the whole path in
real Chrome against a stand-in host (10 checks, no Modal machines).

## A policy coming home

When the tab installs a trained policy it reports `policy-arrived` and, ten simulated seconds later, `policy-walked`. The stage
turns each into narration and captions its numbers by basis, never as one lump: the install time and the time to walking are
MEASURED (the tab's own clock, `page/tab-notes.ts`); the simulation's mean speed is SIMULATED (arithmetic over simulated seconds,
not wall time); what the policy file says about itself (its host, its training seconds) is REPORTED. These notes come from the
real tab, so they are never tagged SCRIPTED even when the feed is. `node scripts/arrival-check.mjs` checks it in real Chrome with
the real tab app (6 checks).

## The take's 03 server and the real disk

`scripts/take-server.mjs` starts the one 03 server the take uses, on a free loopback port: a fresh admin token (the server writes the
token file, mode 0600, in a 0700 directory; nothing here reads it), `--tab-writable creature/creature.xml,creature/body.json,
creature/designs.sqlite` (`memory.sqlite` is the agent's and is not tab-writable), the model through the broker, and a private log.
On the real disk it runs under `with-archil` (the keys exist in that child only; the scratch disk the wrapper names) and needs
`--mount-root <your own lane directory under /mnt/pda>/pipe`, which has no default: it must already exist, be a directory, and be owned by
the caller, and the script never creates anything under `/mnt/pda`. `--ledger FILE` names where the disk resources are recorded (default: the private
directory). `--local DIR` is a dry run with no Archil. Its status file holds the origin and the paths, never a secret.

With a pipe feed the stage's `/api/disk/<path>` is that run's `work/`: the tab's `storage-read` (with `ifNoneMatch`, answered by content
hash: `etag`, `notModified`) and `storage-write` go to `GET|PUT /api/runs/<id>/work/<path>` with the run secret the stage's server holds,
a write naming the tab the pipe says holds the run. A 403 (the agent's `memory.sqlite`) and a 409 (`not-holder`: the tab keeps its design and
asks the agent) reach the tab as errors it understands; a read while the run moves is "unchanged", not an error. With the scripted feed the
disk is an in-memory model. `TAKE_STATUS=<status file>` makes the preflight check the server and the token file's mode; with `SHOW_API`
it checks that D1's `/api/winner` names the approved scratch disk and region before anything is adopted.

## A retake: the stage follows the run link

`SHOW_PIPE_LINK_FILE` (and `SHOW_DESKTOP_LINK_FILE`, which defaults to it) is followed live, not read once: whoever starts the 03 server
writes the run's link to that private file, and a restart or a retake (a new run, often a new port and secret) writes a new one. The
feed, the desktop panel and the tab's disk all move to the new run within a second or two; the stage drops everything of the old run,
tells connected pages to fetch the new snapshot (an SSE `reset`), and never prints or logs the secret. With no link file yet the stage
starts anyway and connects when one appears. `test/live-link.test.ts` does a real restart against the real 03 server.

## Takes

`scripts/record.mjs` records a take and writes `<video>.captions.json` beside it: every caption the page showed, with the second it
appeared and its tag. `--kick-after N --kick-forces 60,400` pushes the creature once the policy is in the tab (the operator panel
has the same two kicks: `x` is 60 N, `X` is 400 N). A short take of the home beat: boot the scripted feed at 3:10
(`SHOW_START=190`), then `record.mjs --no-reset`. `scripts/take-page.mjs` turns a take into one self-contained docs page (the video
inline, the captions with their tags, what the policy file reports about itself) and runs the publish gate first.

Every check script refuses to run unless its own server came up: `assertStage` (the server must answer with a stage's state, so
another lane's server on the port is refused) and `waitForStage` (and it stops at once if the child it started has exited) are in
`scripts/cdp.mjs`, and the scripts that take a URL assert before they send anything.

## Honest numbers

A feed says where it comes from: `run.source` is `live` (the default) or `scripted`. A scripted feed gets a permanent
SCRIPTED FEED badge, its handover times read "scripted 908 ms", and every captioned number is tagged SCRIPTED. A live
feed's caption is tagged MEASURED only when the driver set `measured: true` on the note (or wrote "(measured)" in it);
a number it did not flag is tagged UNMEASURED. Lines with no quantity carry no tag. `page/caption.ts` is that rule.

## Run the show from the page (operator mode)

    SHOW_MODE=operator TAB_DIR=<tab dist> POLICY_DIR=<dir with home.json> node serve.ts
    node scripts/operator-check.mjs        # drives the whole show through the panel in real Chrome; 16 checks

The panel is hidden on camera: press `o` (or open `/?operator=1`). Buttons and keys: environment switches, Fan out `f`,
Kill leader `k`, Collapse `c`, Home `h`, Reset take `r`. Each is a command to the feed (`switch`, `fanout`, `kill`,
`collapse`); a refusal prints its reason in the panel. With `SHOW_API` set the same commands go to D1's driver.

## Record and storyboard (own Chrome with software WebGL; the shared one has none)

    node scripts/chrome.mjs                             # headless Chrome on 127.0.0.1:9444 (--stop to end it)
    SHOW_AUTOKILL=off TAB_DIR=<tab dist> node serve.ts  # the take's server, so the only kill is the one the script clicks
    CDP_URL=http://127.0.0.1:9444 node scripts/record.mjs --out recordings/take1.webm --kill-after 40
    CDP_URL=http://127.0.0.1:9444 node scripts/storyboard.mjs --url http://127.0.0.1:8752/   # a second server, scripted feed

`record.mjs` resets the scripted feed to 0:00, clicks KILL THE LEADER itself, and stops after the last narration line; the
video is VP8/WebM from Playwright's bundled ffmpeg (set FFMPEG for another). `recordings/` is git-ignored.
