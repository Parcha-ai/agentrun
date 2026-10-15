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

## The workflow

`job.ts`. A `map` over the grids with nine at a time; each branch is an `agent` that opens its dashboard and takes one screenshot
(`read the chart`), a `call` for the published figure, and a `code` check that files the reading with its gap to the published
figure. A page that is not the dashboard is filed failed, with no screenshot cited. A last `code` step builds the snapshot.

## The looks

The vision guard answers a screenshot's image through the eyes and reports the look; nothing else keeps it. `looks.ts` keeps each
reported look, the whole `LookRecord`, in a `vision.looks` document of the run's store (one per look key), so the recording's
counters read `paid.vision` and the manifest's cost holds the eyes' price. A test fails if the strip understates it.

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
