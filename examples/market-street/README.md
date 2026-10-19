# Every Vehicle on Market Street

The question in [question.md](question.md), asked of a 1906 film shot from the front of a moving cable car down San Francisco's Market Street, four days before the earthquake ([inputs.json](inputs.json)): log every vehicle that crosses in front of the camera, with the second it passes, what it is and a box around it in that frame, then count each kind. The film runs nearly ten minutes and the street never empties: cable cars, automobiles, horse carriages and wagons, bicycles. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it. [ASSETS.md](../../ASSETS.md) names the film's source and licence.

```sh
npm run demo:vision -- examples/market-street --fetch-sources       # on fakes: $0, no key; downloads the film (about 227 MB) first
npm run demo:vision -- examples/market-street --live --max-usd 2    # real models: about $1.20 and 35 minutes, measured once
```

## Programs, keys and cost

Every run, on fakes (scripted stand-ins for every model, $0) or live, needs `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path (`brew install ffmpeg poppler`, or `sudo apt-get install ffmpeg poppler-utils`).

A `--live` run needs:

- `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com)): the model that runs the agent and the model that looks.
- `TYPESAFE_API_KEY` ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)): Jev, TypeSafe's judge model, which answers yes-or-no, choice, count and box questions. Needed unless a gateway (an OpenAI-compatible endpoint that serves every model) that passes TypeSafe through is set (`VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY`); with one, `VIDEO_MODEL_API_KEY` is Jev's key unless this is set.
- `FAL_KEY` ([fal.ai](https://fal.ai)): optional, and not used here: the film is silent.
- A download of about 227 MB: the film, fetched once and checked by size and SHA-256. On fakes, a run without `--fetch-sources` stops and says so.

One measured live run cost about $1.20 and took about 35 minutes; a run's cost and time vary. A run stops past $1 unless `--max-usd <n>` sets another cap, and this one went past it, so the command above passes `--max-usd 2`. A live run prints little until it ends.

The gallery recording ran with Claude Sonnet 5.5 as the lead (`--model anthropic/claude-sonnet-5-5 --thinking high --max-usd 4`): about $1.30 in 18 min.

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
