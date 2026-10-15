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

The page opens a recording three ways: a bundled one (`?r=<id>`), one at a URL beside the page (`?src=<url>`, on a
static host), or a recording folder dropped on the page or chosen with its picker (works from `file://` too).

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
  never $0; "at least" when a look may have been paid that no durable line shows), the looks the eyes were paid for
  (per look key: a native look charges nothing, and a look read back after a kill is paid once), and the journal's
  opens. Counts come from durable lines and the supervisor's lines only. Repeated and
  asked twice are per call: an effect's outside calls the host reported as applied, in more than one process (repeated)
  or twice in one (asked twice), and an agent's tool call only when it is paid (the run holds a receipt for its tool
  and arguments). An effect whose host reports no calls makes repeated "not measured", never 0. A lost branch's calls
  were paid, and its redo counts as repeated.
  When the manifest names a baseline (another real recording), its counters at its end show beside these.
- **Panels.** The lines at the current point, by source, and the model's turns. Extensions add their own
  (`PANELS.md`). Click anything with a workflow path to focus that branch: every panel still holds the whole run and
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
It builds the page, then refuses to publish unless what was built passes `scripts/recording/gate.mjs`: every recording
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

## Develop

```sh
npm run test:viewer    # typecheck, the core tests, the build, and the page from file:// in a local Chrome if there is one
```

The source is erasable TypeScript in `src/`, joined by `build.mjs` into one classic script with no dependency (a page
opened from `file://` cannot load module scripts or fetch). Durable lines are read in one file, `src/durable.ts`.
