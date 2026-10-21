# A Vision Agent

One agent that answers questions about a set of files. It is given the question in plain words and the files. It plans
its own steps and writes code in a `code` tool, which has `bash` and pi-vision's functions: `vision.see` (a vision model,
the eyes, answers about pictures), `vision.judge` (Jev, TypeSafe's judge model, makes every yes-or-no, choice, count and
box) and `vision.transcribe` (a speech-to-text model writes what a recording says). It follows every skill pi-vision
ships (how to look, find, verify, report and the others), as the package ships them. It ends with an HTML report that
cites every claim at the file's own page, second or region. The examples beside this folder are each a question and its
files:

```sh
npm ci --ignore-scripts && npm run build
npm run demo:vision -- examples/document-check          # on fakes, $0, no key, no network (its PDFs are committed)
npm run demo:vision -- examples/hear-and-find --live    # real models, your keys
```

Every run, on fakes or live, needs `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path (`brew install ffmpeg
poppler`, or `sudo apt-get install ffmpeg poppler-utils`). "On fakes" means scripted stand-ins for every model: no key
and no network. Of the examples, `document-check` and `lake-mead` commit their files; the six others need
`--fetch-sources` on fakes, which downloads 120 MB to 342 MB (each example's README says how much).

The agent runs shell commands with your user's rights on your machine: run the examples in a container or a VM.

The lead, the model that runs the agent, is Google's **gemini-3.8-flash, thinking at medium**: one value in `demo.json`
(`models.lead.default`, which is also the eyes) and the node's `thinking` in `agent.ts`. Thinking is shown when the model
returns it. A live run needs two keys. The lead's is `GEMINI_API_KEY` (or a gateway that serves it; with only another
provider's key the run uses that provider's models instead). Jev's, which every `--live` run uses, is `TYPESAFE_API_KEY`;
with a gateway (an OpenAI-compatible endpoint that serves every model, named by `VIDEO_MODEL_BASE_URL` with
`VIDEO_MODEL_API_KEY`) that passes TypeSafe through, the gateway's `VIDEO_MODEL_API_KEY` is Jev's key unless
`TYPESAFE_API_KEY` is set. `FAL_KEY` is optional: with it the agent can transcribe a film's speech; without it, it works
from the picture alone. Besides the four programs above, that is all; `TYPESAFE_BASE_URL` is read only when you reach
TypeSafe through a proxy of your own. Each example's README lists its programs, keys and download, and what one measured
live run cost and how long it took.

An example folder holds `question.md` (the question), `inputs.json` (each file by URL, size and SHA-256, or committed
beside it) and a README. To ask something else, write another folder, or give `--input '{"question": "...", "files":
["..."]}'` with the files in place.

| Flag | What it does |
|---|---|
| `--live` | real models, your keys (below) |
| `--record <dir>` | keep the run as an `agentrun.recording/1` directory: the repository's recording format, which the [run viewer](../../apps/viewer/README.md) plays |
| `--fetch-sources` | on fakes, fetch and check the example's files instead of reading committed ones |
| `--max-usd <n>` | stop a run past n dollars; without it a run stops past $1, twice the $0.50 a run is expected to cost (`expectedCost` in `demo.json`) |
| `--thinking <low\|medium\|high>` | the agent's thinking level for the run (default `medium`); a Claude lead thinks reliably at `high`, while at `medium` it may answer without thinking; it goes with an example folder or an inline JSON `--input`, and is refused with an input file |

[`SETUP-PROMPT.md`](SETUP-PROMPT.md) sets up a live run for you: paste it into your coding agent.

On fakes a scripted lead runs one script whatever is asked (one look at the first file, and a report of it); every
answer says it is scripted.

## Keys and programs

| Name | For |
|---|---|
| `ffmpeg`, `ffprobe`, `pdftoppm`, `pdftotext`, `node` | every run: the agent's code cuts frames, clips and audio, renders pages and reads a PDF's text layer |
| `GEMINI_API_KEY` (or `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or a gateway's `VIDEO_MODEL_BASE_URL` and `VIDEO_MODEL_API_KEY`) | the lead and the eyes; the defaults are one value each in `demo.json`. A gateway serves an Anthropic model over its Anthropic Messages API at `/v1/messages` (the gateway's root), which returns the model's thinking when it thinks (Anthropic's adaptive thinking decides, at the effort the node's `thinking` level gives); the other models go over its OpenAI-compatible `/v1` |
| `TYPESAFE_API_KEY` (not needed with a gateway: its `VIDEO_MODEL_API_KEY` is Jev's key unless this is set) | Jev, which judges frames and pages and draws boxes (see below) |
| `FAL_KEY` ([fal.ai](https://fal.ai)) | optional: with it the agent can transcribe a film's speech (Scribe v2 on fal); without it, it works from the picture alone. Not needed when the gateway passes fal's queue through |

Jev takes images and box questions as TypeSafe's experimental features, as TypeSafe's release post for Jev 1.14
([typesafe.ai/blog/jev-1-14](https://typesafe.ai/blog/jev-1-14)) says. A request that carries an image needs the header
`TypeSafe-Danger-Zone-Images: true`, and the agent's runner sends it on exactly the requests that carry an image or a box
question. The box type is enabled only for `jev-1.14.0`, and every judgment the agent makes asks for `jev-1.14.0`.
TypeSafe calls the box type a preview, and says that every model, Jev included, does worse on images than on text. A
TypeSafe key (or a gateway that passes TypeSafe through) is needed: through OpenRouter (`provider: "openrouter"`) the
runner refuses an image or a box question before any request is sent, since that path is not verified for them.

## Runtime dependencies

`@parcha/agentrun-harness` (the host: `demo()`, code mode, the judge seam), `@parcha/pi-vision` (the functions, the skills, the transcribers, the scripted eyes), `@parcha/agentrun-jev` (Jev for a live run), `@earendil-works/pi-ai` (the live models and the scripted lead's messages), `@earendil-works/pi-codemode` (the sandbox, through the host) and `@parcha/agentrun-dsl` (the workflow's types).
