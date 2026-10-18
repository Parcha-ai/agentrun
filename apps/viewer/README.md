# Run viewer

A static page that replays one agentrun run recorded as `agentrun.recording/1` (`RECORDING.md`): every process of
the run, every kill, every commit of its store. No key, no server: it opens from `file://` or any static host.

The hosted gallery is at https://parcha-ai.github.io/agentrun/. It is this replay viewer with the recordings in
`recordings/`: it plays recorded runs, and never runs an agent or calls a model.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Parcha-ai/agentrun/tree/main/apps/viewer)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FParcha-ai%2Fagentrun&root-directory=apps%2Fviewer)

## Use it

```sh
node apps/viewer/build.mjs          # writes apps/viewer/dist/
open apps/viewer/dist/index.html    # the gallery of recorded runs, or drop a recording folder on the page
```

When the manifest keeps the job that ran and the run's store at its end (`job`, `store`), the header links both: the job
is JSON and opens in a tab; the store is a SQLite file and downloads.

The page opens a recording three ways: a bundled one (`?r=<id>`), one at a URL beside the page (`?src=<url>`, on a
static host), or a recording folder dropped on the page or chosen with its picker (works from `file://` too).

It also follows a run while it goes (`?follow=<url>`, a URL on the page's own server only): a recording directory served
over HTTP that grows. Its `events.jsonl` gains whole lines (asked for from the last byte read, with a `Range` header; a
server that sends the whole file works too), each blob is in `blobs/` before a line names it, and `manifest.json` is
written last, once the run finished. About once a second the page reads what is new, places it in the format's file
order (section 3 of `RECORDING.md`, the order a recorder's merge writes), and redraws keeping the reader's place, with
the time cursor on the newest line unless the reader scrubbed back; a file its writer replaced whole is read again from
its start. While the run goes its cost reads unknown, and a
blob not read yet shows as loading. When the manifest appears the page reads `events.jsonl` whole, as a fresh load
does, checks it against the format, and plays it as any recording, at the time the reader was at.

Add `&embed=1` to frame it in another page: no header (a recording that breaks the format still says so), the full
width of its frame, and a small `postMessage` protocol (`PANELS.md`, "Embedding"): it posts `ready`, its `position`
at each stop and its `focus`, and obeys `seek`, `focus` and `theme` only from the framing page whose origin its URL
names with `&parent=<origin>`, each checked.

- **Timeline.** The process lane comes from the supervisor's lines: a band per process, and a red mark with its label
  where a process was killed. The ticks under it are the journal's opens, a fact of the store. A restore (the run
  reopened a checkpoint after its box died) is a dashed mark: the commits after the checkpoint are a lost branch.
  Below: the calls (the workflow's effects, the agent's tool calls) and the model turns; a turn a kill cut is drawn in
  red.
- **Scrubber.** Play, pause, speed, the slider, previous and next commit, and a click on the timeline. A scrub stops
  only between commits: the screen at any point is a reduce of the lines before it.
- **Counters.** Paid calls made, repeated, asked twice, unknown, judge asks, model turns (not counting a cut answer's
  `aborted` entry), re-asks (from the store's `pi.live` asks, each ask a kill cut counted once: proven when it had
  committed a partial, possible when only its start, with the turns they fell on; only proven ones count; "not
  measured" when no ask start was committed or its version is unknown), processes, kills, cost (unknown when any part is unknown,
  never $0; a scripted run, as its manifest's `providers` says, reads "scripted, $0" rather than $0.0000; "at least" when a look may have been paid that no durable line shows), the looks the eyes were paid for
  (per look key: a native look charges nothing, and a look read back after a kill is paid once), and the journal's
  opens. Counts come from durable lines and the supervisor's lines only. Repeated and
  asked twice are per call: an effect's outside calls the host reported as applied, in more than one process (repeated)
  or twice in one (asked twice), and an agent's tool call only when it is paid (the run holds a receipt for its tool
  and arguments). An effect whose host reports no calls makes repeated "not measured", never 0. A lost branch's calls
  were paid, and its redo counts as repeated. The browser's page actions count the same way, per conversation, tool and
  code: a dispatch after one that reached the page is an extra, and one after dispatches that never showed reaching it
  reads "+ N possible" beside repeated; a recording whose session records are a bare export's (no line carries a `t`)
  shows them not measured.
  When the manifest names a baseline (another real recording), its counters at its end show beside these.
- **Panels.** The lines at the current point, by source, and the model's turns. Extensions add their own
  (`PANELS.md`). A result that cites pages of a PDF (`page=N`, with a box as `xywh=percent:`) has them drawn whole in
  the document panel, each box over its page. Click anything with a workflow path to focus that branch: every panel still holds the whole run and
  shows the branch its own way (the two built in dim the rest).
- **Chapters.** The manifest's chapters when it has them; else each process's start, each kill, and the end.
- **Links.** `?at=<commit>` opens at the point after that commit, and `?at=<gen>:<commit>` after that commit of that
  generation (after a restore one number names two commits); `?cite=<citation>` opens at the commit that first
  wrote a citation, so a reader of a published brief can jump from a claim to the moment its evidence entered the run,
  with that citation selected in every panel (a citation chip selects one in place);
  `?focus=<path>` opens focused.

## Deploy

Both buttons above build the page with `node build.mjs` and serve `dist/` as static files: `wrangler.json` for
Cloudflare (static assets, no Worker code) and `vercel.json` for Vercel.
The buttons deploy this replay viewer only: it plays recorded runs, never runs an agent or calls a model, and asks for no key.
A test (`test/deploy.test.ts`) holds both configs and both buttons to that: no variable, secret or binding.

The hosted gallery is published by `.github/workflows/pages.yml` on each push to `main` that touches `apps/viewer/`.
It builds the page with `--files`, so the recordings ship as files with `recordings/index.json` and the page stays
small however many runs it holds, then refuses to publish unless what was built passes `scripts/recording/gate.mjs`: every recording
in it valid (`scripts/recording/validate.mjs`), holding only its manifest, its lines and its blobs; every text file
free of credential shapes and machine paths; the gallery embedding exactly the recordings beside it. It deploys with the
job's own token, scoped to Pages, and names no secret. `scripts/pages-workflow.test.mjs` holds the workflow to that.

## Recordings

`recordings/<id>/` holds the recordings bundled with the build, each a `manifest.json`, an `events.jsonl` and its
`blobs/`. The build embeds them in `gallery.js` (so the gallery works from `file://`) and copies them beside the page.
Two are bundled: the reference example's job with scripted providers, once uncut and once killed ten times and resumed
(`recordings/README.md` says how each was recorded). A test holds each to the format and its manifest's cost to the
counters' fold. The tests play a fixture cut by hand from a
real run; it lives in `test/fixtures/` and is never bundled (`test/fixtures/README.md` says how it was cut). A
restore is tested on a recording built line by line (`test/restore-drill.ts`), and re-asks on a real 30-kill storm cut
down to the lines their fold reads (`test/fixtures/spacedeck-asks`).

`node apps/viewer/build.mjs --files` (off by default) ships the recordings as files instead: `recordings/index.json` lists
each one's manifest and blob paths, `gallery.js` embeds nothing, and the page fetches a recording only when it is
opened, so a gallery of large runs stays a small page. It needs a static host: a page opened from `file://` cannot
fetch.

## Develop

```sh
npm run test:viewer    # typecheck, the core tests, the build, and the page from file:// in a local Chrome if there is one
```

The source is erasable TypeScript in `src/`, joined by `build.mjs` into one classic script that imports no package (a
page opened from `file://` cannot load module scripts or fetch). Durable lines are read in one file, `src/durable.ts`.

## Dependencies

One, shipped with the page rather than installed, so `node build.mjs` needs no install anywhere (the hosted gallery and
both deploy buttons build that way):

| What | Version | License | Where | Used for |
| --- | --- | --- | --- | --- |
| PDF.js (`pdfjs-dist`, Mozilla Foundation) | 6.4.299 | Apache-2.0 | `vendor/pdfjs/`, copied to `dist/pdfjs/` | drawing a page of a PDF the result cites (the document panel) |
| its JavaScript image decoders: PDFium's JBIG2 and CCITT, and OpenJPEG | as in 6.4.299 | BSD-3-Clause, BSD-2-Clause | `vendor/pdfjs/wasm/`, each with its licenses | a scan's images |

The page loads PDF.js only when it draws a PDF page, as a module script beside it, with its worker a file of the same
origin, and hands it the PDF's bytes (never a `data:` or `blob:` address to fetch), so it draws under a host policy that
loads scripts, workers and data from the page's own origin only. A page opened from `file://` cannot load a module
script: there the panel says so and links the PDF at its page. `vendor/pdfjs/README.md` lists each file's SHA-256 and
how to move to another release.
