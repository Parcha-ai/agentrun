# Hear and Find

The question in [question.md](question.md), asked of NASA's 1969 Apollo 11 film ([inputs.json](inputs.json)): when the landing call "Tranquility Base here. The Eagle has landed." is made during the descent (it is said more than once in the film), and when and where the planted flag is first seen. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it with a transcript, a coarse-to-fine search and Jev's box.

```sh
npm run demo:vision -- examples/hear-and-find --fetch-sources    # on fakes: $0, no key; downloads the film (about 120 MB) first
npm run demo:vision -- examples/hear-and-find --live             # real models: about $0.57 and 4 minutes, measured once
```

## Programs, keys and cost

Every run, on fakes (scripted stand-ins for every model, $0) or live, needs `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path (`brew install ffmpeg poppler`, or `sudo apt-get install ffmpeg poppler-utils`).

A `--live` run needs:

- `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com)): the model that runs the agent and the model that looks.
- `TYPESAFE_API_KEY` ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)): Jev, TypeSafe's judge model, which answers yes-or-no, choice, count and box questions. Needed unless a gateway (an OpenAI-compatible endpoint that serves every model) that passes TypeSafe through is set (`VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY`); with one, `VIDEO_MODEL_API_KEY` is Jev's key unless this is set.
- `FAL_KEY` ([fal.ai](https://fal.ai)): optional. With it the agent can transcribe the film's speech; without it, it works from the picture alone. This question asks when a line is said, so that half of it needs the key.
- A download of about 120 MB: NASA's film, fetched once and checked by size and SHA-256. On fakes, a run without `--fetch-sources` stops and says so.

One measured live run cost about $0.57 and took about 4 minutes; a run's cost and time vary. A live run prints little until it ends. A run stops past $1 unless `--max-usd <n>` sets another cap.

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
