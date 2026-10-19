# A Robot in a Long Film

The question in [question.md](question.md), asked of a 1939 Technicolor drama filmed at the New York World's Fair ([inputs.json](inputs.json)): when a golden robot is first seen, and where it is in the frame. The robot is on screen for a few minutes of a film of nearly an hour, and small in its first shot. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it.

```sh
npm run demo:vision -- examples/fair-robot --fetch-sources       # on fakes: $0, no key; downloads the film (about 342 MB) first
npm run demo:vision -- examples/fair-robot --live                # real models: about $0.30 and 5 minutes, measured once
```

## Programs, keys and cost

Every run, on fakes (scripted stand-ins for every model, $0) or live, needs `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path (`brew install ffmpeg poppler`, or `sudo apt-get install ffmpeg poppler-utils`).

A `--live` run needs:

- `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com)): the model that runs the agent and the model that looks.
- `TYPESAFE_API_KEY` ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)): Jev, TypeSafe's judge model, which answers yes-or-no, choice, count and box questions. Needed unless a gateway (an OpenAI-compatible endpoint that serves every model) that passes TypeSafe through is set (`VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY`); with one, `VIDEO_MODEL_API_KEY` is Jev's key unless this is set.
- `FAL_KEY` ([fal.ai](https://fal.ai)): optional. With it the agent can transcribe the film's speech; without it, it works from the picture alone.
- A download of about 342 MB: the film, fetched once and checked by size and SHA-256. On fakes, a run without `--fetch-sources` stops and says so.

One measured live run cost about $0.30 and took about 5 minutes; a run's cost and time vary. A live run prints little until it ends. A run stops past $1 unless `--max-usd <n>` sets another cap.

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
