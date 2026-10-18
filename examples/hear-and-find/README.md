# Hear and Find

One agent listens to NASA's 1969 Apollo 11 film and answers two questions, each to the second. When is the landing call made, during the descent? "Tranquility Base here. The Eagle has landed." is said twice in the film, word for word; the agent finds both and picks the landing by what is said around each. When is the planted flag first seen, and where? It finds the second coarse to fine, for cents, and Jev draws the box on that frame.

```sh
npm ci --ignore-scripts && npm run build
npm run demo:hear-and-find                    # on fakes, $0, no key, no network
npm run demo:hear-and-find -- --live          # real models, your keys (SETUP-PROMPT.md)
```

## What you will see

1. Heard: one row for the landing call, its second and why it is the one the question means, then a row for every other time the phrase is said, each citing the transcript that heard it (`#t=` of the film).
2. Seen: the second the flag is first seen standing planted, Jev's score, and the frame with the box Jev drew, cited as `film#t=S&xywh=percent:x,y,w,h`. The viewer shows the frame.
3. How the agent got there: it writes its own code (a `code` tool with `bash`, `vision.transcribe`, `vision.judge` and `vision.see`), following pi-vision's transcribe and find skills. It transcribes the film once in ten-minute pieces, searches the transcript, narrows the flag search with the words, scans frames with Jev, halves to a few seconds, has the eyes name the second with the sound, and has Jev check that frame and the seconds beside it.
4. Receipts with cost: every transcript, look and judgment is filed with what it read, the model and its price. Each is paid for once.

What it looks for is data: `needles.json` names the film, the phrase and its question, the thing, the name of its box and the words that may name it. Change them to ask about another film.

| Flag | What it does |
|---|---|
| `--live` | real models, your keys |
| `--record <dir>` | keep the run as an `agentrun.recording/1` directory |
| `--input <json\|file>` | the job's input (`job.ts`, Input) |
| `--fetch-sources` | on fakes, fetch and check NASA's film (`sources.json`) instead of reading the clip |
| `--max-usd <n>` | stop a run past n dollars (default twice `expectedCost`) |

## Keys and programs

| Name | For | Where |
|---|---|---|
| one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY` | `--live`: the lead (`openai/gpt-6-luna` by default) and the eyes (`google/gemini-3.8-flash`, which watch a window as video with its sound) | your provider's console, or your gateway |
| `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` when OpenRouter serves jev-1.14.0 | `--live`: Jev, which scores frames and draws the box (jev-1.14.0 is the first Jev that draws boxes) | typesafe.ai, openrouter.ai |
| `FAL_KEY` | `--live`: Scribe v2 on fal, which writes each word with its second (not needed when your gateway passes fal's queue through) | fal.ai |
| `ffmpeg`, `ffprobe`, `node` | the agent's code cuts the audio, frames and windows | your system's package manager |

A `--live` run of the whole film costs about $0.40 at list prices, nine tenths of it the transcript; the search itself is about a cent. `SETUP-PROMPT.md` sets all of this up for you.

## Runtime dependencies

Until the reference host is published as a package that carries them, the example needs these beside it:

| Package | For |
|---|---|
| the reference host (`examples/reference`, to be `@parcha/agentrun-reference`) | `demo()`, the run's place, code mode, the judge seam |
| `@parcha/pi-vision` | `vision.see`, `vision.judge` and `vision.transcribe`; the transcribe and find skills; `falTranscriber`; the scripted eyes |
| `@parcha/agentrun-jev` | Jev for a live run (`createJevRunner`) |
| `@earendil-works/pi-ai` | the live lead and eyes, and the scripted lead's messages |
| `@earendil-works/pi-codemode` | the `code` tool's sandbox (through the reference host) |
| `@parcha/agentrun-dsl` | the workflow's types |

## How it is built

- `needles.json`: what is asked. `job.ts`: the workflow as data: one `agent` with the `code` tool, whose instructions are the task and pi-vision's transcribe and find skills, then a `call` to `answer`.
- `tools.ts`: `answer`, which resolves each hit to the transcript that heard it and the sighting to the Jev look that checked its frame, takes that frame with its box, and builds the cited result. `result.ts` keeps the frame as a blob of the recording.
- `fakes.ts`: the scripted lead runs the skills' own programs; the scripted eyes, Jev and transcriber answer from `clip/clip.json`, never from a model. `models.ts`: the live lead, eyes, Jev and transcriber.
- `sources.json`: NASA's film (and its original, a sharper copy for the box) by URL, size and SHA-256. `clip/`: three pieces of the film, cut by `clip/cut.sh`, what a run on fakes reads (`ASSETS.md` names the source).
- Everything else is the reference entry (`demo()`).
