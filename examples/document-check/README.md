# Document Check

The question in [question.md](question.md), asked of two PDFs ([inputs.json](inputs.json), committed in [sample/](sample/)): pages 1 to 4 of a Delaware certified copy filed with the SEC, and the same pages with every mark painted white. For each, which of six marks it carries and where (the seal, the signature, the file and SR numbers, the authentication number and date, the FILED stamp, and whether the file numbers agree). The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code. ASSETS.md names the filing and what was changed in the test copy; `sample/sample.json` holds each page image's source and each mark's measured place, and `sample/build.mjs` rebuilds both PDFs from the page images (a maintainer's script; the example never runs it).

```sh
npm run demo:vision -- examples/document-check            # on fakes: $0, no key, no network (the PDFs are committed)
npm run demo:vision -- examples/document-check --live     # real models: about $0.54 and 8 minutes, measured once
```

## Keys, programs and cost

A `--live` run needs:

- `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com)): the model that runs the agent and the model that looks.
- `TYPESAFE_API_KEY` ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)): Jev, the judge that answers yes-or-no, choice, count and box questions. Needed unless a gateway that passes TypeSafe through is set (`VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY`); with one, `VIDEO_MODEL_API_KEY` is Jev's key unless this is set.
- `FAL_KEY` ([fal.ai](https://fal.ai)): only for a question about speech; this example does not need it.
- `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path.
- No download: its two PDFs are committed in [sample/](sample/).

One measured live run cost about $0.54 and took about 8 minutes; a run's cost and time vary. A live run prints little until it ends. `--max-usd <n>` stops a run past n dollars.

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
