# Apollo 11, read whole

An agent that is never shown an image reads NASA's Apollo 11 film, transcript and photographs through its eyes, writes the landing
minute by minute with every sentence citing a look, survives a kill inside the evidence sink, and pays for each look once.

    npm run demo:apollo11            # on fakes, $0, no key, no network
    npm run demo:apollo11 -- --live  # real models and services, your keys (SETUP-PROMPT.md)

Watch the recorded run: https://parcha-ai.github.io/agentrun/?r=apollo11

## What you will see

1. The job: one workflow reads the landing three ways at once (live, the landing hour: 26 windows of the descent film, 40 scanned
   transcript pages, 60 photographs; on fakes, the committed slice: three 6 s film windows, the three pages that end in "The
   Eagle has landed", one photograph of each class), each item a short agent asking the eyes one question, and you keep an `agentrun.cited/1` account of the landing in which every minute cites the
   page (`#page=`) or film window (`#t=`) it was read from, with the photo sort's accuracy against NASA's captions.
2. A kill and resume: `--kill` ends the process inside the evidence sink at its fifth filing (`vision.filing`), with three answered
   looks held unfiled, and the next process reads those answers back from the run's store instead of asking again: repeated 0.
3. Receipts with cost: every look is filed with its source's SHA-256, question, answer, model and price, and kept with the images the
   eyes were shown; the recording's cost is a number, or unknown where a failed request may have been billed, never an unearned 0.

A live run reads NASA's own files, downloaded once and checked by SHA-256; on fakes, `--fetch-sources` reads them too (the landing
hour is `--input examples/apollo11/inputs/landing.json`). Other inputs, one job: `inputs/gallery.json` (the recorded run: 8 film
windows, 10 pages, 12 photos, about $0.15), `inputs/full.json` (all 626 pages, about $3.50; pass `--max-usd 5`), and
`inputs/weak-eyes.json` with `--eyes-model openai/gpt-6-luna` (the landing's pages and photos through weaker eyes; `--weak-from
<dir>` puts that run's account into the main result, `--see-also` links its recording).

## Keys and programs

_From `demo.json`; `SETUP-PROMPT.md` does the setup for you._

| Needs | For | Why |
| --- | --- | --- |
| one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `APOLLO_MODEL_BASE_URL` with `APOLLO_MODEL_API_KEY` | `--live` | the lead (`openai/gpt-6-luna` by default) and the eyes (`google/gemini-3.8-flash`), each by provider and public id; `--model` and `--eyes-model` name others |
| `ffmpeg`, `ffprobe` | | cut the film's windows into frames |
| `pdftoppm` (optional) | | renders the scanned pages; without it PDFium renders them |

A `--live` run of the default input, the landing hour, costs about $0.55 at the providers' list prices; `--max-usd` defaults to
twice that.

## How it is built

- `@parcha/agentrun-dsl`: the workflow (`workflow.ts`, `job.ts`): three `map`s read the items, a `call` tool takes the landing's
  lines from the pages' receipts, an `extract` writes the account, and a `call` tool resolves each cite to its look (`tools/`).
- `@parcha/pi-vision`: the eyes behind `read`; the lead's limits say it sees no image, so every look goes through them, filed with
  a receipt and kept before the result that reports it.
- `@parcha/agentrun-pi` and pi-durable: the workflow as one durable task, resumed by the next process.
- `sources.json`: NASA's files, each with its URL, size and SHA-256, downloaded once and checked before every run. `slice/`: the
  default's files, cut from those by `slice/cut.sh` (680 kB; `slice/slice.json` fixes each, and `ASSETS.md` names the sources).
- Everything else is the reference entry. `seam.ts` stands in for its `demo()` until that runs vision on fakes, files each look
  with its images and holds filings at `vision.filing`; it takes the same flags.
