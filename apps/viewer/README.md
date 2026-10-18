# Run viewer

A static page that replays one agentrun run recorded as `agentrun.recording/1` (`RECORDING.md`): every process of
the run, every kill, every commit of its store. No key, no server: it opens from `file://` or any static host.

The hosted gallery is at https://parcha-ai.github.io/agentrun/. It is this replay viewer with the recordings in
`recordings/`: it plays recorded runs, and never runs an agent or calls a model.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Parcha-ai/agentrun/tree/main/apps/viewer)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FParcha-ai%2Fagentrun&root-directory=apps%2Fviewer)

## The chat + report view

`chat.html?r=<id>` (or `?src=<url>`) opens a recording as a conversation and a report, the gallery's default view. It
is made from the recording's own events, with nothing per recording: the run's input as given (the workflow's input
record, its fields in plain form) as the user's message; each recorded conversation as a thread (its messages as
recorded, without the prompt the host composed to open it, the assistant's text, the run's own thinking folded, one
card per tool call titled by the tool and its arguments, a failed call by its error's first line, consecutive calls
of one tool folded into "+ N more"); a session timeline under the title, collapsed,
of workflow nodes, LLM calls (by model), tool calls (by name) and the model calls a tool makes, nested under it (a span
when the line names its call and start, else a point at its time); and on the right the agent's artifact
(`manifest.artifact`: its entry and files as blobs), in a frame that runs no script; else the run's cited answer; else
the result record it submitted, its evidence paths as cites; else its final assistant text. The title is the
artifact's, else the first line of the input's question, else the recording's title.
Citations are the cited file's own address (`file.pdf#page=3&xywh=percent:...`, `film.webm#t=10`) and open that page
or frame with its region boxed. "How this ran" opens the same recording in this replay viewer. `src/chat-extract.ts`
makes the model, `src/chat-view.ts` and `src/chat-report.ts` draw it.

A few conventions the view reads beyond the format; any skill or tool can follow them, and a run that does not loses
nothing but the touch each one adds:
- The page's title is the input's `question` field (its first line) when the input has one.
- In a Jev answer, a box decision named `<name>_at` is the place of the yes-or-no decision `<name>`; a box whose
  yes-or-no is no is not drawn.
- A look's answer whose rows start `<start>\t<end>\t` (a transcript's times) is read without those times.
- A look over several addresses files them in its `path` joined by `, `; it opens at the first.
- A call to `submit` (the node runner's delivery tool) shows no reply when it succeeds.
- A recording with no times places each span at its line's position, and the timeline reads "in order".

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
both deploy buttons build that way): PDF.js, `pdfjs-dist` 6.4.299 (Mozilla Foundation, Apache-2.0), with its JavaScript
decoders for a scan's images (PDFium's for CCITT and JBIG2, BSD-3-Clause; OpenJPEG's for JPEG 2000, BSD-2-Clause). The
files are the package's own, unchanged, from https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz
(registry integrity `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`),
in `vendor/pdfjs/` with their licenses; the build copies them to `dist/pdfjs/`. 2,348,024 bytes in all:

| File in `vendor/pdfjs/` | In the package | License | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `pdf.min.mjs` | `build/pdf.min.mjs` | Apache-2.0 | 458,904 | `57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2` |
| `pdf.worker.min.mjs` | `build/pdf.worker.min.mjs` | Apache-2.0 | 1,264,342 | `9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18` |
| `LICENSE.txt` | `LICENSE` | Apache-2.0 | 10,174 | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| `wasm/jbig2_nowasm_fallback.js` | `wasm/jbig2_nowasm_fallback.js` | BSD-3-Clause AND Apache-2.0 | 152,009 | `68686ced624a48c42f84cdaa482ec44b72b0de4dc84a0df903af1fb7b45b5d9a` |
| `wasm/LICENSE_JBIG2.txt` | `wasm/LICENSE_JBIG2` | BSD-3-Clause | 12,862 | `9e66b7f1b934a28b37f3bc4dac97915de1674271e79a0a88182a18ed9731b4d1` |
| `wasm/LICENSE_PDFJS_JBIG2.txt` | `wasm/LICENSE_PDFJS_JBIG2` | Apache-2.0 | 555 | `aad3cce09842e00e9e11ad5e8fef8cc02fbc3a3768fe2f007443b9cee37aaee5` |
| `wasm/openjpeg_nowasm_fallback.js` | `wasm/openjpeg_nowasm_fallback.js` | BSD-2-Clause | 445,781 | `9047b34b6bc142d85e4b0aa1b08b0b9baad4c6f8b7ac87641b9e8f90eb6fd23e` |
| `wasm/LICENSE_OPENJPEG.txt` | `wasm/LICENSE_OPENJPEG` | BSD-2-Clause | 2,112 | `a6af136f3e15038a666b61f376612a07d9a4e48cb7c01adbf3e33b3f14ab49b6` |
| `wasm/LICENSE_PDFJS_OPENJPEG.txt` | `wasm/LICENSE_PDFJS_OPENJPEG` | BSD-2-Clause | 1,285 | `717fc62da03292dbb4dd0c8280bd4ce7bb8550dcf31d772bc93455fb50313425` |

`vendor/pdfjs/vendored.json` holds the same list, and `test/document.test.ts` checks every file against it.

The page loads PDF.js only when it draws a PDF page, as a module script beside it, with its worker a file of the same
origin, and hands it the PDF's bytes: it never gives PDF.js an address to fetch, and asks for no font or character map
from anywhere, so it draws under a host policy that loads scripts, workers and data from the page's own origin only.
A page opened from `file://` cannot load a module script: there the panel says so, links the PDF at its page and lists
each cite on it as text. Pages are drawn one at a time, top first, each at most 1600 pixels wide and 4 million pixels in
all. PDF.js is given no predefined character maps: text set in one (a CJK encoding such as `UniJIS-UTF16-H`) does not
draw, while `Identity-H`, the usual encoding of an embedded font, needs none; add `cmaps/` the way the decoders are
added if a document needs them. `vendor/pdfjs/README.md` says how to move to another release.
