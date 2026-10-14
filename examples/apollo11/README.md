# Apollo 11, read whole

A lead that is never shown an image reads NASA's Apollo 11 archive through `@parcha/pi-vision`'s eyes: the mission's film in
windows, the scanned 1969 air-to-ground transcript page by page, and sixty Hasselblad photographs one by one. It writes the
landing minute by minute, and every sentence cites the looks it rests on: `#page=` of the scan, `#t=` of the film. The photo sort
is checked against NASA's own captions, and the times the eyes read off the scans are checked against NASA's typed transcript.

It runs on the reference assembly (`../reference/index.ts`): one pi-durable run, one workflow, killed anywhere and resumed from its
store, and no look paid twice.

```sh
npm ci --ignore-scripts && npm run build

# No key, $0: a scripted lead and scripted eyes over the real files (downloaded once and checked by SHA-256).
node examples/apollo11/run.ts --quick

# Killed inside the evidence sink at its 40th filing, holding the filings that arrive while it waits: their answers are
# kept, so the next process reads them back and pays for none of them again. Kept as a recording.
node examples/apollo11/run.ts --quick --kill-in-sink 40:6 --record ./apollo11-recording

# Real models with your own keys (OPENAI_API_KEY for the lead, GEMINI_API_KEY for the eyes).
node examples/apollo11/run.ts --quick --live --max-usd 1

# The same pages and photos through the eyes that drop digits, then the main run with that comparison in its account.
node examples/apollo11/run.ts --quick --live --weak-eyes --dir ./weak
node examples/apollo11/run.ts --quick --live --weak-from ./weak
```

`--quick` reads the landing: the film's two cuts that hold the descent and the first steps (26 windows of 20 s), the transcript's
40 pages from 100:55 to 105:18 mission time, and every photo. Without it, the whole 40-minute film and all 626 pages. `--limit N`
reads at most N items of each lane, for a trial. `--kill-after-look N` kills right after the Nth look is committed, `--kill-at <ms>`
once, `--storm <ms> --kills N` about every `<ms>`. `--max-usd X` stops the run
for good once it has spent X: the eyes' looks, and the lead's turns when the run is recorded.

## What a live run costs

| Part | Model | Cost of `--quick` |
| --- | --- | --- |
| The eyes: 26 film windows (8 frames each), 40 pages, 60 photos | `google/gemini-3.7-flash` | about $0.45 |
| The lead: one short conversation per item, and the account | `openai/gpt-6-luna` | about $0.10 |

A page costs the eyes about $0.004, most of it the transcription they write back; the full archive is about $4.5. A scripted run
costs $0. The recording's manifest lists what a run cost, `null` where a part is unknown and never `0` for an unknown price.

## The models

Every model is named by its provider and its public model id, as pi-ai's catalog names it, in every receipt, recording line and
screen. The lead takes images, and the run's `limits` say it is never shown one (`image: { native: false }`), so the eyes answer
every image and the lead reads only their words.

| Role | pi-ai provider/id | Asked as |
| --- | --- | --- |
| Lead | `openai/gpt-6-luna` | `gpt-6-luna` |
| Eyes | `google/gemini-3.7-flash` | `gemini-3.7-flash` |
| Weak eyes (`--weak-eyes`) | `openai/gpt-6-luna` | `gpt-6-luna` |

With `APOLLO_MODEL_BASE_URL` and `APOLLO_MODEL_API_KEY` set, every request goes to that OpenAI-compatible gateway instead (the
lead to its Responses API, the eyes to its chat completions), under the public id in the right column; no provider key is read.
A gateway that serves a model only under another name is not supported: the public id is what is asked for.

## The data set

`dataset.json` names every file the run reads, each from a NASA source with its URL, size and SHA-256; a file is used only after
its bytes match. Its SHA-256 is in every recording's manifest, and the pi-transport showcase cuts its film from the same files.

| Item | What it is |
| --- | --- |
| `transcript-tec` | NASA's scan of the Technical Air-to-Ground Voice Transcription, 626 typewritten pages |
| `transcript-tec-typed` | the same transcript as typed text, NASA's history office; the ground truth for mission times, never shown to the eyes |
| `film-descent` | NASA Kennedy Space Center's Apollo 11 B-roll; cuts 3 and 4 hold the descent through Eagle's window and the first steps |
| `photo-AS11-...` | sixty Hasselblad frames with NASA's captions, each in one of five classes: `earth`, `moon_from_space`, `spacecraft`, `astronaut`, `lunar_surface` |

A photo's class is the subject of the first sentence of its NASA caption, fixed once in `dataset.json` with the caption beside it.

## What the run hands back

The workflow (`workflow.ts`) fans out three ways at once, each item a short agent that calls `read` once with an `ask` and submits
the receipt: the film's windows (with what the eyes saw), the transcript's pages, the photos (with their class). The lead never
copies a page: a call step reads the landing's lines from the pages' receipts (the eyes answer in JSON lines) and puts them in
mission-time order, and an extract step writes the account. Then the program, not a model, builds `account.json` (`account.ts`), format `apollo11.account/1`:

- `entries`: `{ mission_time: "hhh:mm:ss", text, cites: [{ item, fragment, receipt }] }`. `receipt` is the look's `facts.key`;
  a cite stays only when its receipt is an ok look at exactly that item's bytes, and an entry only when its time is a line on a
  page it cites. What was dropped, and why, is in `dropped`.
- `photos.accuracy`: overall and per class against the captions, and the confusion; a photo counts as sorted only with an ok look
  at its own file.
- `transcript.times`: every time the eyes read, found in the typed transcript or not; one that is not is shown beside the typed
  time it most likely is. Such a time is a misread, or a typo of the 1969 scan that the typed version corrects.
- `photos` and `accuracy`: each photo's label beside its caption's class, overall and by class.
- `counters`, folded from the store's `vision.looks` documents (`looks.ts`): looks paid (ok, not native, not kept; a key whose only
  filings are kept was paid once in a process a kill cut), kept after a kill, repeated (a key paid by two processes; 0), asked
  twice, failed, and their cost. A look whose request threw may have been billed, so its price is unknown and the cost is `null`.
- `weak_eyes`, with `--weak-from`: the weak eyes' model, their run's name, the times they read and their photo sort.

Each `vision.looks` entry holds the look's record and receipt, its data set item, the miss (`code`, `reason`) when it failed, and
the images the eyes were shown: the frames with their seconds, the page render, the photo. The lead's own conversation never holds
an image, so a hook on each `read`'s result, before vision's guard, keeps them; in a recording (`--record`, an
`agentrun.recording/1` directory) they are blobs the entry's line lists.

| File | What |
| --- | --- |
| `run.ts` | The entry: the supervisor (files, kills, the account, the recording) and `--child`, the run |
| `workflow.ts` | The three fan-outs, the landing's lines and the account, and what the eyes are asked |
| `dataset.ts` | The manifest, the checked download, and what a mode reads |
| `looks.ts` | Every look in a `vision.looks` document, and the hook that keeps what the eyes were shown |
| `account.ts` | The account, the accuracy, the times check and the counters |
| `models.ts` | The lead and the eyes by public name, with your keys or a gateway |
| `scripted.ts`, `scripted-pages.json` | The no-key lead and eyes, and the landing pages' first times the eyes answer from |

## What it does not do yet

- Record the full archive. Each of the workflow driver's revisions is written whole into a recording, and it holds every finished
  map item, so a recording grows with the square of the items: `--quick`'s 126 items make 80 to 100 MB of lines, the full
  archive's 800 would make gigabytes. `--full` runs and builds its account; record `--quick`.
- Run ffmpeg and poppler in a pi-transport box. `run()` takes the box as its `env`, but the reference's box image has neither
  program; until one does, the run needs them on this machine (or none for a scan page, which PDFium renders).
- Use `look` for a whole window or a document at once: it is not built yet.
