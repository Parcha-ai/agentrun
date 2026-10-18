# A Certificate, Checked

One agent checks a Delaware certified copy against a checklist of the marks Delaware law gives it, and answers yes or no for each one. The marks are:

- the Secretary of State's seal and signature;
- the file and SR numbers;
- the authentication number and its date;
- the FILED stamp;
- the file numbers agreeing.

Each mark that is there is boxed on its page.

```sh
npm ci --ignore-scripts && npm run build
npm run demo:document-check                          # the filed pages, on fakes: $0, no key, no network
npm run demo:document-check -- --input test-copy     # the TEST COPY with the marks removed: every mark no
npm run demo:document-check -- --live                # Jev and a lead model, your keys
npm run demo:document-check -- --record <dir>        # keep the run as an agentrun.recording/1 directory for the viewer
```

## What you will see

1. **The job.** One agent writes its own code with the `code` tool (`bash` and `vision.judge`), following pi-vision's `verify` skill:
   - It renders every page through its crop box and asks Jev, one request a page, which kind of page it is and, for each mark, whether it is there and where.
   - It then cuts the two file numbers out at 300 dpi and asks whether they agree.
2. **The result.** An `agentrun.cited/1` result with one row a mark, its value yes or no.
   - Each row cites the look that saw the mark and its place: `#page=1&xywh=percent:38.862,82.783,13.27,10.109`, in percent of the page's crop box, which is the page PDF.js shows.
   - A mark that is not there cites the page it was looked for on, with no box.
   - The PDF is kept in the recording, so the viewer opens the page a row cites and draws the box over it.
3. **The TEST COPY.** The same pages with the marks painted white come back with every mark no. A box Jev gives for a thing that is not there is never drawn.

It checks whether each mark is there and where, not whether the document is genuine.

## Another kind of document

The checklist is data: [checklist/delaware-certified-copy.json](checklist/delaware-certified-copy.json). It has the kinds of page, and per mark:
- a short name;
- the yes-or-no question;
- the box to draw;
- what the mark looks like when it is there;
- the law or source it comes from.

To check another kind of document, write another checklist, put the PDF and the checklist in the workspace, and run with `--input '{"document":"<file>.pdf","checklist":"<file>.json"}'`. The code does not change. The checklist's shape is in pi-vision's verify skill (`packages/pi-vision/skills/verify/SKILL.md`).

## Keys and programs

| Name | For | Where |
|---|---|---|
| `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` for Jev through OpenRouter | `--live`: Jev, each page's kind and each mark's yes or no and box, about $0.0002 a page at its list price | console.typesafe.ai, or openrouter.ai/keys |
| one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `DEMO_MODEL_BASE_URL` with `DEMO_MODEL_API_KEY` | `--live`: the lead (`openai/gpt-6-luna` by default), which writes the code | your provider's console, or your gateway |
| `pdftoppm` (poppler-utils), `ffmpeg` and `ffprobe` | the agent's code renders the pages and cuts the file numbers out | your system's package manager |

## The sample

[sample/](sample) holds pages 1 to 4 of a public SEC EDGAR exhibit: AVEO Pharmaceuticals, Inc.'s 10-K for 2021, exhibit 3.1, accession 0001628280-22-006093. The pages are:
- pages 1 and 2: the Secretary of State's certification pages;
- page 3: the first page of the restated certificate, with its FILED stamp;
- page 4: a page of its text.

`aveo-ex3-1-pages-1-4.pdf` holds the four page images exactly as EDGAR serves them. `aveo-ex3-1-pages-1-4-TEST-COPY-marks-removed.pdf` is altered: every mark is painted white, and every page is labelled as a test copy that is not the filed document.

[sample/sample.json](sample/sample.json) names the filing, each page's URL and SHA-256, and where each mark is. [sample/build.mjs](sample/build.mjs) makes both files from the pages. [ASSETS.md](../../ASSETS.md) says where they come from and what was changed.

## How it is built

- `job.ts`: the workflow as data:
  - one `agent` with the `code` tool, whose instructions are the task and pi-vision's verify skill;
  - then a `call` to `cite`;
  - the default input (the filed pages) and the files the workspace starts with.
- `codeMode` in `demo.json`: the reference entry's `code` tool. Its sandbox has `tools.bash` (the run's workspace), `vision.see` and `vision.judge`.
- `tools.ts`: `cite`, which resolves each row's receipts to the looks the run filed and builds the cited result. `result.ts` keeps the PDF as a blob of the recording and names it in every cite.
- `fakes.ts`:
  - the scripted lead, which runs the skill's two steps as written;
  - the scripted Jev, which answers from `sample/sample.json` and never looks at a pixel.
- `models.ts`: the live lead and Jev.
- Everything else is the reference entry (`demo()`).
