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
run and ask the agent; `view` only watches and is refused both with the pipe's own reason), `SHOW_ASK_AFTER_SWITCH=1` (the v1 switch beat: ask the agent where it is after each switch; off by default, so the v2 chat holds only real turns), `SHOW_PIPE_TRACE=1` (log each frame's type).

The stage connects as the pipe's `operator` and does not say it can run the agent (`canRun` stays off). A switch into the tab is
therefore answered by a tab page that can run it (the 03 page says so), or is refused before anything moves with "no browser tab
that can run the agent is open on this run". `node scripts/role-check.mjs` checks the roles against the real 03 server. Cloud
targets light up when the feed lists their environments.

## Live day: run the preflight first

    CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> POLICY_DIR=<dir with home.json> SHOW_API=<live feed url> node scripts/preflight.mjs
    SHOW_URL=http://127.0.0.1:8752/ CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> node scripts/preflight.mjs   # the stage is already running

It reads and probes only (starts nothing, spends nothing) and exits non-zero on any failure. Each check is a way the stage went
wrong in rehearsal: a Chrome with no WebGL (the shared one has none, so the creature's 3D view is blank; start one with
`scripts/chrome.mjs`), a tab app or 03 page built before its sources changed (an old 03 page treats a switch to the tab as an
untimed takeover), a home policy the tab would refuse (the home beat shows "Policy refused": no `POLICY_DIR`, no `home.json`, or a
file the tab's own `Policy.load` refuses; a live take with `SHOW_PIPE_LINK_FILE` checks the run link instead, since the policy
comes from the run's `work/home/policy.json`; with `SHOW_URL` the check asks the running stage instead (`/api/stage`, then the
`/tab/versions.json` and `/policy/home.json` it serves), so a stage started with another `POLICY_DIR`, or none, fails), a dead
model broker (no agent answers after a switch), a feed that is not answering. For a recorded take use `SHOW_AUTOKILL=off` on the
scripted feed so the only kill is the one the script clicks; against a live feed the stage sends no command until the operator
presses a button.

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

## The take server's read-back, as evidence

Start the take server with `--evidence-readback` and give the stage `SHOW_TAKE_STATUS=<the take server's status.json>`. After each
handover 03's server reads the run's `work/` back from the disk's object store and logs `pipe.readback`; the stage tails that log (the
file `status.json` names, followed across retakes) and turns the three read-back events into notes. A read-back whose digest equals
both what the pipe sealed and what the leaving host acknowledged (`match` and `ackedMatch` both strictly true) is the one note that says
nothing was lost, with evidence `independent-readback`, so its caption is MEASURED. A difference is shown as a difference; a read-back with
no acknowledged workspace to compare, or one that could not finish, is a note with no claim. Notes carry counts and sizes: never a digest,
a path or the server's error text. The log also holds the run's link, so the watcher reads only lines that are one of those three events,
only for the run on the stage, and starts at the end of the file it first sees (earlier handovers are not replayed). Each result is tagged with the key of the run link that was current when it was read (origin, run and a hash of the secret, so a restarted server has a new one even on the same port with the same run name) and is shown only once the stage's feed is connected to that link: a read-back logged before the stage switches to a retake waits for it, a retake that keeps the run's name cannot borrow an old result, and if another retake appears before the feed follows the first, the first's held results are dropped. The server lists at most 50 paths per kind in a difference, so a full list is worded "at least 50". `readback.ts` is the
parser and the watcher; `test/readback-live.test.ts` runs it against the real take server's log file.
## The v2 stage (default) and `?debug=1`

The page is the v2 take (DEMO-V2.md): the creature large in the middle (D3's tab in clean mode, `/tab/?clean=1`), one large location badge
on top ("Agent: running in your browser" or "Agent: running on <machine>", with a track under it where the agent marker slides between the
browser and the machine), the chat with the agent on the right (user and agent turns only, big type, newest
last, with an input under it: a line typed there goes to the agent as the operator), and one caption at the bottom, held at least 4 s, with
its tag. Nothing else is drawn: the timeline, log, HUD numbers, cost meter, multiverse, VM desktop and buttons are behind `?debug=1`, and the
operator panel stays on the `o` key. The v1 checks and recordings open the page with `?debug=1` (`withDebug` in `scripts/cdp.mjs`).

- **Chat.** The translator folds the transcript (03's `ChatView`) into `chat` events: the user's words and the agent's own text. Tool calls,
  thinking and the system notice about a switch are not turns. The stage's own "which machine are you on" question is off unless
  `SHOW_ASK_AFTER_SWITCH=1`, so a v2 chat holds only real turns.
- **Captions.** One at a time, 4 s minimum; when several wait, the one a viewer needs most first (`Note.rank`), and the desk catches up rather than
  lag behind a burst. The agent's own lines are the chat's job. The learning beat reads the distance each version of the brain's policy file reports
  (`page/lessons.ts`; bands from D2's measurements on the take body: "Lesson 1: don't fall over." under 0.1 m in 10 s, "Lesson 2: shuffling forward."
  to 1 m, "First steps." to 4 m, then "Walking: N m in 10 s" from the tab's own simulation). Seconds are whole or to a tenth. The words are plain:
  "a new version of its brain", never "checkpoint", "policy" or "getup brain" (a test keeps them out). No SIMULATED pill is drawn in this view
  (`?debug=1` keeps every tag): that the creature is a physics simulation in the browser is said once, at the start. Nothing says the agent lives in
  the tab: it runs there. The stage says two things itself, once each (`page/story-notes.ts`): at the first move "Its memory is on a cloud disk, so
  it can change machines without forgetting anything."; on the way back "Done training. The agent came back to your browser, and so did what it
  learned.". The clean view says nothing about Wi-Fi or being offline; `v2-check` holds that.
- **Setting up.** Between the user's request and the first version of the brain there is a real wait. From the agent's first `bash` command after it
  arrived on a machine (read from the transcript) the caption slot counts "Setting up the training program on the GPU... N s" on the stage's clock
  (measured on a live feed, scripted in a rehearsal); the tab's first checkpoint ends it with "Learning started N s after the agent began." The
  server's wake-up message to the agent at home (prefix `[from the server] `) is not shown in the chat; the agent's reply is.
- **The decision card.** The 03 server's typed model (Jev) decides where the run goes and broadcasts a `decision` frame right before the move
  (`{ t: "decision", decision: { id, phase: "start"|"done", question, options: [{ id, label, probability }], choice, latency_ms, model:
  "jev"|"scripted" } }`; the `viewing` frame's `decisions` replays the last few). The stage shows "Where should this run?" with a bar per option for
  6 s, then the badge moves. `decision.ts` refuses a frame it cannot show truthfully; the numbers are tagged MEASURED only for `model: "jev"` on
  a live feed, else SCRIPTED.
- **Rehearsal.** `SHOW_SCENARIO=v2 node serve.ts` plays a scripted take (all numbers SCRIPTED; it has no real checkpoints, so the creature does not
  learn in it). `node scripts/v2-frames.mjs <url> <dir> --evenly 8` samples frames from it; `node scripts/v2-check.mjs` checks the layout, badge,
  chat, typed line, decision card and offline behavior in real Chrome (`CDP_URL=http://127.0.0.1:9444`, own Chrome from `scripts/chrome.mjs`).

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

## Episode 2: "It Comes Home Obsessed" (`episode2/`, served at `/ep2/`)

The same shape as Walks Home (tab, then a GPU, then back to the tab) with a different story: the agent trains itself a small model and brings it home. It lives in its own directory and page and reuses Walks Home's pure modules (feed, chat, badge, caption desk) without changing them.

- **Header and cloud-disk line**: the same as Walks Home.
- **Training panel** (the centre while the agent is away): the step counter, time in and left, a loss curve, the line about where the practice answers came from ("Trained on N example answers in the bridge's voice, written by a larger model and checked ahead of time."), and one question as a large before/after pair (`episode2/panel.ts`; the file holds all three questions, the panel shows the first). Captions carry no step number or loss: the live counter and curve are those numbers. It reads `train/progress.jsonl` from the run's disk (`/api/disk/train/progress.jsonl`), one JSON object per line; the format is in `episode2/progress.ts`. A line that does not parse is counted and skipped. The stage computes no number of its own. A live batch of new practice answers (`teacher` lines) is shown as it is written, and only an answer the checker kept has text.
- **The chat switches to the model**: the tab says so (`model-loading`, `model-download`, `model-loaded`, `model-switched`, `model-answer`, `model-refused`, `model-failed`; `episode2/notes.ts`). The banner over the agent's chat follows those messages and never claims the switch before the tab does. The answers themselves never leave the tab.
- **The payoff pane**: once the viewer has asked the model something, the big pane shows the latest question and its answer large (`episode2/talk.ts`), over the tab's own model card; the banner says why it is the bridge ("The bridge is in the model's weights, not in a prompt.").
- **One chat**: before the tab says the chat switched, what the viewer types goes to the agent; after `model-switched` it goes to the tab as `chat-send` and the answer streams back (`chat-start`, cumulative `chat-delta`, `chat-done`) as "The model" turns (`episode2/model-chat.ts`). The stage renders exactly what the tab sends: the tab's own judge has already passed it, a refusal's text replaces the whole bubble, and the stage never judges again. `POST /api/judge` forwards the tab's `{prompt, answer}` to the run's judge with the run's secret held server-side and returns its JSON untouched (`episode2/judge.ts`); it fails closed: with no run (or an unreachable judge) it answers `refuse` with a 503/502, never `show`. Only the explicit rehearsal (`SHOW_SCENARIO=ep2` with no run link) has a scripted judge, which refuses an answer containing `[[refuse]]`.
- **Captions**: plain words, one at a time, each said once (`EpisodeNotes`). A number from the trainer is MEASURED on a live feed and SCRIPTED in a rehearsal; the practice-answer count is REPORTED; the tab's load time is the tab's own clock. No tag pill is drawn in the clean view; the tag is the caption's `data-tag`.
- **Rehearsal**: `SHOW_SCENARIO=ep2 node serve.ts`, then open `/ep2/`. The training progress is a replay of a real recorded run of the training command (`episode2/recorded-progress.json`, the file's lines as an array, one machine-path field removed), at its own timings; the stage still calls it scripted because the replay is not live. The model's chat answers in the rehearsal are scripted placeholders. With no tab that loads a model, the page plays the tab's model messages from the moment the run is home (`episode2/rehearsal.ts`), scripted.
- **Checks**: `CDP_URL=... node scripts/ep2-check.mjs [shots-dir]` (real Chrome, scripted). `scripts/ep2-model-check.mjs` is the whole way home with the real tab: with `SHOW_MODEL_DISK` (a model laid out by the tab's `make-model-disk` script) the rehearsal serves a real GGUF to the real tab once its recorded training is over; the tab downloads it, loads it, passes its self-check through the judge, says `model-switched`, and answers a line typed into the stage's chat.
