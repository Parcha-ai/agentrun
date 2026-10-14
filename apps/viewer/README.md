# Run viewer

A static page that replays one agentrun run recorded as `agentrun.recording/1` (`RECORDING.md`): every process of
the run, every kill, every commit of its store. No key, no server: it opens from `file://` or any static host.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Parcha-ai/agentrun/tree/main/apps/viewer)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FParcha-ai%2Fagentrun&root-directory=apps%2Fviewer)

## Use it

```sh
node apps/viewer/build.mjs          # writes apps/viewer/dist/
open apps/viewer/dist/index.html    # the gallery of bundled recordings
```

The page opens a recording three ways: a bundled one (`?r=<id>`), one at a URL beside the page (`?src=<url>`, on a
static host), or a recording folder dropped on the page or chosen with its picker (works from `file://` too).

- **Timeline.** The process lane comes from the supervisor's lines: a band per process, and a red mark with its label
  where a process was killed. The ticks under it are the journal's opens, a fact of the store. Below: the calls (the
  workflow's effects, the agent's tool calls) and the model turns; a turn a kill cut is drawn in red.
- **Scrubber.** Play, pause, speed, the slider, previous and next commit, and a click on the timeline. A scrub stops
  only between commits: the screen at any point is a reduce of the lines before it.
- **Counters.** Paid calls made, repeated, asked twice, unknown, judge asks, model turns, re-asked turns (observed),
  processes, kills, cost (unknown when any part is unknown, never $0), and the journal's opens. Counts come from
  durable lines and the supervisor's lines only.
- **Panels.** The lines at the current point, by source, and the model's turns. Extensions add their own
  (`PANELS.md`). Click anything with a workflow path to focus every panel on that branch.
- **Chapters.** Jump to each process's start, each kill, and the end.
- **Links.** `?at=<commit>` opens at the point after that commit; `?cite=<citation>` opens at the commit that first
  wrote a citation, so a reader of a published brief can jump from a claim to the moment its evidence entered the run;
  `?focus=<path>` opens focused.

## Recordings

`recordings/<id>/` holds the recordings bundled with the build, each a `manifest.json`, an `events.jsonl` and its
`blobs/`. The build embeds them in `gallery.js` (so the gallery works from `file://`) and copies them beside the page.
`recordings/README.md` says where each came from.

## Develop

```sh
npm run test:viewer    # typecheck, the core tests, the build, and the page from file:// in a local Chrome if there is one
```

The source is erasable TypeScript in `src/`, joined by `build.mjs` into one classic script with no dependency (a page
opened from `file://` cannot load module scripts or fetch). Durable lines are read in one file, `src/durable.ts`.
