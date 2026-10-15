# Apollo 11, read whole

An agent that is never shown an image reads NASA's Apollo 11 film, transcript and photographs through its eyes, writes the landing
minute by minute with every sentence citing a look, survives a kill inside the evidence sink, and pays for each look once.

    npm run demo:apollo11            # on fakes, $0, no key
    npm run demo:apollo11 -- --live  # real models and services, your keys (SETUP-PROMPT.md)

Watch the recorded run: https://parcha-ai.github.io/agentrun/?r=apollo11

## What you will see

1. The job: one workflow reads the landing hour three ways at once (26 film windows, 40 scanned transcript pages, 60 photographs),
   each item a short agent asking the eyes one question, and you keep an `agentrun.cited/1` account of the landing in which every
   minute cites the page (`#page=`) or film window (`#t=`) it was read from, with the photo sort's accuracy against NASA's captions.
2. A kill and resume: `--kill` ends the process inside the evidence sink at its 40th filing (`vision.filing`), with six answered
   looks held unfiled, and the next process reads those answers back from the run's store instead of asking again: repeated 0.
3. Receipts with cost: every look is filed with its source's SHA-256, question, answer, model and price, and kept with the images the
   eyes were shown; the recording's cost is a number, or unknown where a failed request may have been billed, never an unearned 0.

Other inputs, one job: `--input examples/apollo11/inputs/gallery.json` (the gallery's smaller take: 8 film windows, 10 pages, 12
photos), `inputs/full.json` (all 626 pages, about $3.50), and `inputs/weak-eyes.json` with `--eyes openai/gpt-6-luna` (the same
pages and photos through weaker eyes; `--weak-from <dir>` puts that run's account into the main result, `--see-also` links its
recording).

## Keys and programs

_From `demo.json`; `SETUP-PROMPT.md` does the setup for you._

| Needs | For | Why |
| --- | --- | --- |
| one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `APOLLO_MODEL_BASE_URL` with `APOLLO_MODEL_API_KEY` | `--live` | the lead (`openai/gpt-6-luna` by default) and the eyes (`google/gemini-3.7-flash`), each by provider and public id; `--lead` and `--eyes` name others |
| `ffmpeg`, `ffprobe` | | cut the film's windows into frames |
| `pdftoppm` (optional) | | renders the scanned pages; without it PDFium renders them |

A `--live` run of the default input costs about $0.55 at the providers' list prices; `--max-usd` defaults to twice that.

## How it is built

- `@parcha/agentrun-dsl`: the workflow (`workflow.ts`, `job.ts`): three `map`s read the items, a `call` tool takes the landing's
  lines from the pages' receipts, an `extract` writes the account, and a `call` tool resolves each cite to its look (`tools/`).
- `@parcha/pi-vision`: the eyes behind `read`; the lead's limits say it sees no image, so every look goes through them, filed with
  a receipt and kept before the result that reports it.
- `@parcha/agentrun-pi` and pi-durable: the workflow as one durable task, resumed by the next process.
- `sources.json`: NASA's files, each with its URL, size and SHA-256, downloaded once and checked before every run.
- Everything else is the reference entry. `seam.ts` stands in for its `demo()` until that runs vision on fakes, files each look
  with its images and holds filings at `vision.filing`; it takes the same flags.
