# The Apollo 11 Descent

The question in [question.md](question.md), asked of NASA's own record of the landing ([inputs.json](inputs.json)): the typed air-to-ground transcript (626 scanned pages), twelve photographs of the mission and the mission's descent film. The agent finds the ten pages and the eight film windows that cover the descent itself, reads them and the photographs, and writes the landing minute by minute, each line citing its page, photograph or film moment. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it.

```sh
npm run demo:vision -- examples/apollo-descent --fetch-sources   # on fakes: $0, no key; downloads the files (about 211 MB) first
npm run demo:vision -- examples/apollo-descent --live
```

## Programs, keys and cost

Every run, on fakes (scripted stand-ins for every model, $0) or live, needs `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path (`brew install ffmpeg poppler`, or `sudo apt-get install ffmpeg poppler-utils`).

A `--live` run needs:

- `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com)): the model that runs the agent and the model that looks.
- `TYPESAFE_API_KEY` ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)): Jev, TypeSafe's judge model, which answers yes-or-no, choice, count and box questions. Needed unless a gateway (an OpenAI-compatible endpoint that serves every model) that passes TypeSafe through is set (`VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY`); with one, `VIDEO_MODEL_API_KEY` is Jev's key unless this is set.
- `FAL_KEY` ([fal.ai](https://fal.ai)): optional. With it the agent can transcribe the film's speech; without it, it works from the picture alone.
- A download of about 211 MB: NASA's typed transcript (16 MB), twelve photographs and the descent film (192 MB), fetched once and checked by size and SHA-256. On fakes, a run without `--fetch-sources` stops and says so.

Its cost and time vary with the run and are not measured here. A live run prints little until it ends. A run stops past $1 unless `--max-usd <n>` sets another cap.

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
