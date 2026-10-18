# A Vision Agent

One agent, any question about a set of files. It is given the question in plain words and the files; it plans its own steps and writes code (a `code` tool with `bash`, `vision.see`, `vision.judge` and `vision.transcribe`; Jev, through `vision.judge`, makes every yes-or-no, choice, count and box) following every skill pi-vision ships (how to look, find, and the others), as the package ships them. It ends with an HTML report that cites every claim at the file's own page, second or region. The examples beside this folder are questions and files, nothing more:

```sh
npm ci --ignore-scripts && npm run build
npm run demo:vision -- examples/document-check          # on fakes, $0, no key, no network (its PDFs are committed)
npm run demo:vision -- examples/hear-and-find --live    # real models, your keys
```

The agent runs shell commands with your user's rights on your machine: run the examples in a container or a VM.

The agent is Google's **gemini-3.8-flash, thinking at medium**: one value in `demo.json` (`models.lead.default`, also the eyes) and the node's `thinking` in `agent.ts`. Thinking is shown when the model returns it. A live run needs two keys: the lead model's, `GEMINI_API_KEY` (or a gateway that serves it; with only another provider's key it runs that provider's models instead), and `TYPESAFE_API_KEY` for Jev, which every `--live` run uses. It also needs `FAL_KEY` for a question about speech, and nothing else. Each example's README lists its keys, programs, download, and what one measured live run cost and how long it took.

An example folder holds `question.md` (the question), `inputs.json` (each file by URL, size and SHA-256, or committed beside it) and a README. To ask something else, write another folder, or give `--input '{"question": "...", "files": ["..."]}'` with the files in place.

| Flag | What it does |
|---|---|
| `--live` | real models, your keys (below) |
| `--record <dir>` | keep the run as an `agentrun.recording/1` directory |
| `--fetch-sources` | on fakes, fetch and check the example's files instead of reading committed ones |
| `--max-usd <n>` | stop a run past n dollars |

`SETUP-PROMPT.md` sets up a live run for you.

On fakes a scripted lead runs one script whatever is asked (one look at the first file, and a report of it); every answer says it is scripted.

## Keys and programs

| Name | For |
|---|---|
| `GEMINI_API_KEY` (or `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or a gateway's `VIDEO_MODEL_BASE_URL` and `VIDEO_MODEL_API_KEY`) | the lead and the eyes; the defaults are one value each in `demo.json` |
| `TYPESAFE_API_KEY` | Jev, which judges frames and pages and draws boxes (see below) |
| `FAL_KEY` | Scribe v2 on fal, only for a question about speech (not needed when the gateway passes fal's queue through) |
| `ffmpeg`, `ffprobe`, `pdftoppm`, `pdftotext`, `node` | the agent's code cuts frames, clips and audio, renders pages and reads a PDF's text layer |

Jev reads still images and answers box questions as TypeSafe early features: their format, answers and limits can change
between releases. TypeSafe keeps them off unless a request carries the header `TypeSafe-Danger-Zone-Images: true`, and the
runner sends it on exactly the requests that carry an image or a box question. A TypeSafe key is needed: through OpenRouter
(`provider: "openrouter"`) Jev takes images and box questions only on OpenRouter's Decisions API, not on the path this runner
uses, so the runner refuses an image or a box question there before any request is sent. We have run them against
TypeSafe's own API with a standard key; TypeSafe's documentation names no further access step and we have not tested a newly
issued key, so if a request is refused, check with TypeSafe that your key's account has them turned on.

## Runtime dependencies

`@parcha/agentrun-harness` (the host: `demo()`, code mode, the judge seam), `@parcha/pi-vision` (the functions, the skills, the transcribers, the scripted eyes), `@parcha/agentrun-jev` (Jev for a live run), `@earendil-works/pi-ai` (the live models and the scripted lead's messages), `@earendil-works/pi-codemode` (the sandbox, through the host) and `@parcha/agentrun-dsl` (the workflow's types).
