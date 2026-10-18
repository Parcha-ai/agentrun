# Document Check

The question in [question.md](question.md), asked of two PDFs ([inputs.json](inputs.json), committed in [sample/](sample/)): pages 1 to 4 of a Delaware certified copy filed with the SEC, and the same pages with every mark painted white. For each, which of six marks it carries and where (the seal, the signature, the file and SR numbers, the authentication number and date, the FILED stamp, and whether the file numbers agree). The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code. ASSETS.md names the filing and what was changed in the test copy; `sample/sample.json` holds each page image's source and each mark's measured place, and `sample/build.mjs` rebuilds both PDFs from the page images (a maintainer's script; the example never runs it).

```sh
npm run demo:vision -- examples/document-check            # on fakes, $0, the committed PDFs
npm run demo:vision -- examples/document-check --live
```

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
