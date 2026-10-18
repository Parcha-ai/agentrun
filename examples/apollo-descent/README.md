# The Apollo 11 Descent

The question in [question.md](question.md), asked of NASA's own record of the landing ([inputs.json](inputs.json)): the typed air-to-ground transcript (626 scanned pages), twelve photographs of the mission and the mission's descent film. The agent finds the ten pages and the eight film windows that cover the descent itself, reads them and the photographs, and writes the landing minute by minute, each line citing its page, photograph or film moment. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code.

```sh
npm run demo:vision -- examples/apollo-descent --fetch-sources   # on fakes: $0, no key; downloads the files (about 211 MB) first
npm run demo:vision -- examples/apollo-descent --live
```

## Keys, programs and cost

A `--live` run needs:

- `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com)): the model that runs the agent and the model that looks.
- `TYPESAFE_API_KEY` ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)): Jev, the judge that answers yes-or-no, choice, count and box questions. Every `--live` run needs it.
- `FAL_KEY` ([fal.ai](https://fal.ai)): only when the agent needs what the film says written down; the other keys are always needed.
- `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path.
- A download of about 211 MB: NASA's typed transcript (16 MB), twelve photographs and the descent film (192 MB), fetched once and checked by size and SHA-256. On fakes, a run without `--fetch-sources` stops and says so.

Its cost and time vary with the run and are not measured here; `--max-usd <n>` stops a run past n dollars. A live run prints little until it ends. `--max-usd <n>` stops a run past n dollars.

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
