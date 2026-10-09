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
"second host" is a child process (`second-host.ts`, the way 03's own remote test does it).

    node scripts/chrome.mjs                              # own Chrome with software WebGL
    CDP_URL=http://127.0.0.1:9444 TAB_DIR=<tab dist> node scripts/switch-beat.mjs

`switch-beat.mjs` starts the second-host server and the stage (`SHOW_PIPE_LINK_FILE`), attaches the real 03 tab page as the
run's writer, then clicks tab, second host, tab in the stage's switcher and checks 14 things: the four named targets (tab,
sandbox, VM, GPU; the ones the feed does not list are greyed, "wired by name"), the caption tagged MEASURED with the
milliseconds the SERVER timed (from receiving the switch to the new host's notice committed), the timeline stay carrying the
same number, the agent's notice, and the agent's answer through the model broker (a few short answers). Typical numbers on
this box: tab to second host 0.7 to 0.9 s, back to the tab 0.06 s.

`--record recordings/switch-beat.webm` also records the stage tab (VP8/WebM, 15 fps, each caption stack held 5 s so it can be read).
The storyboard (`scripts/storyboard.mjs`) carries a reference block: the real switch times measured on Daytona and published
on `docs.g.parcha.dev` (`reference-timings.json`, with its source), tagged MEASURED on Daytona, beside this stage's own local
numbers from the last `switch-beat` run, tagged MEASURED locally. The two are never mixed.

By hand: `node second-host.ts` (writes the run link to a 0600 file), open the link in a browser as the tab, then
`SHOW_PIPE_LINK_FILE=<that file> SHOW_TAB_CDP=<chrome cdp url> node serve.ts`. Env: `SHOW_PIPE_ROLE` (hello mode, default
`view`), `SHOW_ASK_AFTER_SWITCH=0` (no question to the agent), `SHOW_PIPE_TRACE=1` (log each frame's type).

Two things a view-only stage cannot do, both for browser-demo's server: (1) the pipe lets any client send `switch` and
`submit` (the TODO in `pipe-feed.ts`: connect as an operator role once it checks roles); (2) a switch to the tab is answered
`run-here` to whoever asked, and only a tab page can then claim the run, so `tab-control.ts` (rehearsal only, `SHOW_TAB_CDP`)
makes the real tab page do the asking. Cloud targets light up when the feed lists their environments.

## Honest numbers

A feed says where it comes from: `run.source` is `live` (the default) or `scripted`. A scripted feed gets a permanent
SCRIPTED FEED badge, its handover times read "scripted 908 ms", and every captioned number is tagged SCRIPTED. A live
feed's caption is tagged MEASURED only when the driver set `measured: true` on the note (or wrote "(measured)" in it);
a number it did not flag is tagged UNMEASURED. Lines with no quantity carry no tag. `page/caption.ts` is that rule.

## Run the show from the page (operator mode)

    SHOW_MODE=operator TAB_DIR=<tab dist> POLICY_DIR=<dir with home.json> node serve.ts
    node scripts/operator-check.mjs        # drives the whole show through the panel in real Chrome; 14 checks

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
