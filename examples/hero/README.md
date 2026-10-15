# The hero job

One agent reads nine electricity grid operators' public fuel-mix dashboards, each in a browser session of its own and all at
once. The numbers exist only in the charts, so vision reads them: a screenshot of the chart, answered from the pixels. Where the
operator also publishes the mix as data, a `call` fetches it as the check, and the snapshot shows vision's reading beside it. The
run ends in `snapshot.html`, a table of the nine grids with each reading linked to the screenshot it came from.

```sh
npm ci --ignore-scripts && npm run build && npm run demo:hero
```

It needs no key and no network: the lead, the eyes, the pages and the published figures are scripted. It prints the run's calls
and the path of `snapshot.html`.

| Flag | What it does |
|---|---|
| `--json` | print the summary as one JSON object |
| `--dir <path>` | keep the run's directory |
| `--record <dir>` | keep the run as an `agentrun.recording/1` directory |
| `--kill1` | kill the first process with SIGKILL inside a paid call and resume the run in a fresh one |

## Kill 1

A kill lands after the host has kept a paid call's answer (the operator's published figure) and before the driver committed it.
The resumed process settles the call from the kept answer: the figure is fetched once per grid in all, never again after the
kill, and the recording's own fold reads repeated 0. The model requests the kill cut are asked again, once each, as the
reference host documents.

## Chrome and live

| Flag | What it does |
|---|---|
| `--chrome` | a local Chrome (`CHROME_PATH`) on the job's own pages: no network, the lead and the eyes scripted. It checks the wiring: each browser session is screencast into the recording and leaves a video. A local Chrome never visits a real page |
| `--live` | the real dashboards on Browserbase (a sandboxed browser: no address of yours reaches a site), the eyes and the lead on a broker, the manifest's `providers` `real`. It spends money and visits real sites: it refuses unless `HERO_LIVE_SPEND_OK=1`, which you set only once the run is approved |
| `--see` | `vision.see` from code mode, for the chart beat. It waits on agentrun #506 and refuses until then |

`--live` takes `PI_BROWSER_PROVIDER=browserbase` and `BROWSERBASE_API_KEY` (and `BROWSERBASE_PROJECT_ID` if your account needs it) in the environment of the one process that runs it: set them in a
subshell for that command, never print them and never write them to a file. The models: `HERO_BROKER_URL` (an OpenAI-compatible gateway; default `http://127.0.0.1:9421/v1`), `HERO_EYES`
(`<provider>/<model id>` of pi-ai's catalog, default `openrouter/google/gemini-3.7-flash`) and `HERO_LEAD` (a broker model id, default `openai/gpt-6-luna`; a model pi-ai's catalog describes keeps its
price, and any other id is built as an OpenAI-compatible chat model priced by `HERO_LEAD_PRICE=<in>,<out>` dollars per million tokens, or left unpriced, in which case its cost is unknown: null in the recording and the manifest, never 0). The gateway
swaps in its own credential: the example holds a placeholder and never a provider key. The frame recorder (`@parcha/pi-browser/recorder`) hands its lines to the recorder's own live write, and
`exportFrameTracks` makes one WebM and its index per session at the end. Until the browser's screenshot clip lands, each branch frames its chart by scrolling.

## The workflow

`job.ts`. A `map` over the grids with nine at a time; each branch is an `agent` that opens its dashboard and takes one screenshot
(`read the chart`), a `call` for the published figure, and a `code` check that files the reading with its gap to the published
figure. A page that is not the dashboard is filed failed, with no screenshot cited. A last `code` step builds the snapshot.

## The looks

The vision guard answers a screenshot's image through the eyes and reports the look; nothing else keeps it. `looks.ts` keeps each
reported look, the whole `LookRecord`, in a `vision.looks` document of the run's store (one per look key), so the recording's
counters read `paid.vision` and the manifest's cost holds the eyes' price. A test fails if the strip understates it.

The look is filed with the screenshot's evidence path as its receipt and the image the eyes were shown as a blob (`blobs/<sha256>.jpg`),
so the vision panel shows the chart and a citation is tied to its look. The recording's result is `agentrun.cited/1`: rows of a label, a
value, a note and `cites`, each cite naming the screenshot's `blob` and the look's `facts.key`. A grid that was not read is a row with no cite.

## Costs

The costs in a recording and in the snapshot are at list prices: the models' catalog rates (the default lead, `openai/gpt-6-luna`, is $0.10 in and $0.50 out per million tokens) and
Browserbase's own price list. A list price is a stated price, not what an account may pay. A model nothing prices is unknown (null), never 0. The no-key run costs 0: its parts are scripted.

## The sources

`sources.json` lists the nine operators and how each page was checked by hand: the dashboard, which chart, the two numbers, where
the same mix is published as data, and the site's `robots.txt`. It also lists the operators left out and why. The rules for every
entry:

1. A page with a bot check, or one that needs more than an ordinary visit and a cookie banner, is excluded.
2. A site whose `robots.txt` disallows the dashboard path is excluded.
3. The agent reads every number from the chart with vision, even where the page prints it as text. The page text or the published data is the check, shown beside the reading.
4. Each screenshot is cropped to the chart itself, without the operator's logo or page chrome.

## The fakes

The fake browser has no navigation of its own, so the example's plane turns the lead's `page.goto("<url>")` into the fake's `goto`
action and each session stands on its own grid's page. Its screenshots are blank, so the backend gives each grid's a width of
its own, which tells the scripted eyes whose chart they look at. A live host swaps these for a real browser and a real eyes
model through the host's functions.
