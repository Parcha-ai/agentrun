# Nine Grids Read

One agent reads nine grid operators' fuel-mix charts with vision, survives a kill inside a paid call, and pays for each call once.

```sh
npm ci --ignore-scripts && npm run build
npm run demo:hero                 # on fakes, $0, no key
npm run demo:hero -- --live       # real models and services, your keys (SETUP-PROMPT.md); refused until the demo's live parts land
```

The recorded gallery take is a real run and comes with the live run; `--record <dir>` keeps the scripted one now.

## What you will see

1. The job: nine operators' dashboards, each opened in a browser session of its own and all at once. The numbers exist only in the charts, so vision reads them; where the operator also publishes the mix as data, a `call` fetches it as the check. The run ends in `snapshot.html`, a table of the nine grids with each reading linked to the screenshot it came from.
2. A kill and resume (`--kill`): the process dies after the host has kept the third published figure and before the driver committed it. The resumed process settles the call from the kept answer, so each figure is fetched once per grid in all and the recording's own fold reads repeated 0.
3. Receipts with cost: every look the eyes were shown is filed with its screenshot, so the strip counts it and the manifest's cost holds the eyes' price (a number, never a 0 it did not earn). The result is `agentrun.cited/1`: each number names the screenshot (`blob`) and the look (`look`) that read it, and a grid that was not read is a row with no cite.

| Flag | What it does |
|---|---|
| `--live` | real models and services, your keys |
| `--kill` | the demo's kill (`demo.json`), then the resume |
| `--record <dir>` | keep the run as an `agentrun.recording/1` directory |
| `--input <json\|file>` | the job's input: `{ "at": "<ISO time>", "operators": ["caiso", ...] }`; the default is all nine |
| `--max-usd <n>` | stop a run past n dollars (default twice `expectedCost`) |
| `--json`, `--dir <path>` | print the summary as JSON, keep the run's directory |

## Keys and programs

| Name | For | Where |
|---|---|---|
| `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` (both) | the browser a live run drives: nine sessions on the operators' real dashboards | your Browserbase project |

The models come from the shared sign-in or a provider key, not from this demo. `SETUP-PROMPT.md` sets all of this up for you.

## How it is built

- `job.ts`: the workflow as data (a `map` over the operators nine at a time; each branch an `agent` that opens its dashboard and takes one screenshot, a `call` for the published figure, and a `code` check that files the reading with its gap to the published figure; a last `code` step builds the snapshot), its default input, and nothing else. It is the unit `agent.run()` and the playground take.
- `fakes.ts`: the scripted lead, eyes, pages and published figures, and the screenshot widths that tell the eyes whose chart they look at. A live host brings its own.
- `result.ts`: the cited result and the snapshot files.
- `looks.ts`: files each look the vision guard reports into a `vision.looks` document of the run's store, with the screenshot's evidence path and the image as a blob.
- `sources.json`: the nine operators and how each page was checked by hand (below).
- `run.ts`: the reference entry (`examples/reference`) plus the above. The host, recorder, supervisor, kills and spend cap are the entry's.

## The looks

The vision guard answers a screenshot's image through the eyes and reports the look; nothing else keeps it. `looks.ts` keeps each
reported look, the whole `LookRecord`, in a `vision.looks` document of the run's store (one per look key), so the recording's
counters read `paid.vision` and the manifest's cost holds the eyes' price. A test fails if the strip understates it.

The look is filed with the screenshot's evidence path as its receipt and the image the eyes were shown as a blob (`blobs/<sha256>.jpg`),
so the vision panel shows the chart and a citation is tied to its look. The recording's result is `agentrun.cited/1`: rows of a label, a
value, a note and `cites`, each cite naming the screenshot's `blob` and the look's `facts.key`. A grid that was not read is a row with no cite.

## The sources

`sources.json` lists the nine operators as `pages` (visited live by the agent, never fetched) and how each was checked by hand: the dashboard, which chart, the two numbers, where
the same mix is published as data, and the site's `robots.txt`. It also lists the operators left out and why. The rules for every
entry:

1. A page with a bot check, or one that needs more than an ordinary visit and a cookie banner, is excluded.
2. A site whose `robots.txt` disallows the dashboard path is excluded.
3. The agent reads every number from the chart with vision, even where the page prints it as text. The page text or the published data is the check, shown beside the reading.
4. Each screenshot is cropped to the chart itself, without the operator's logo or page chrome.

## Tests

`examples/hero.test.mjs` runs the template's three beats on fakes: the job, a kill and resume (repeated 0, measured, unknown 0), and receipts with cost.
