# Hear and Find

The question in [question.md](question.md), asked of NASA's 1969 Apollo 11 film ([inputs.json](inputs.json)): when the landing call "Tranquility Base here. The Eagle has landed." is made during the descent (it is said more than once in the film), and when and where the planted flag is first seen. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it with a transcript, a coarse-to-fine search and Jev's box; nothing here is code.

```sh
npm run demo:vision -- examples/hear-and-find --fetch-sources    # on fakes: $0, no key; downloads the film (about 120 MB) first
npm run demo:vision -- examples/hear-and-find --live             # real models: about $0.57 and 4 minutes, measured once
```

## Keys, programs and cost

A `--live` run needs:

- `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com)): the model that runs the agent and the model that looks.
- `TYPESAFE_API_KEY` ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)): Jev, the judge that answers yes-or-no, choice, count and box questions. Needed unless a gateway that passes TypeSafe through is set (`VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY`); with one, `VIDEO_MODEL_API_KEY` is Jev's key unless this is set.
- `FAL_KEY` ([fal.ai](https://fal.ai)): needed here, for the speech-to-text model that writes what the film says.
- `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path.
- A download of about 120 MB: NASA's film, fetched once and checked by size and SHA-256. On fakes, a run without `--fetch-sources` stops and says so.

One measured live run cost about $0.57 and took about 4 minutes; a run's cost and time vary. A live run prints little until it ends. `--max-usd <n>` stops a run past n dollars.

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
