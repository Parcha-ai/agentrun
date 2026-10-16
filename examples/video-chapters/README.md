# A Film, in Chapters

One agent watches NASA's 1969 Apollo 11 film a minute at a time, sound included, writes its chapters with a keyframe each, survives a kill mid-film, and pays for each minute once.

```sh
npm ci --ignore-scripts && npm run build
npm run demo:video-chapters                    # on fakes, $0, no key, no network
npm run demo:video-chapters -- --live          # real models, your keys (SETUP-PROMPT.md)
npm run demo:video-chapters -- --serve         # a page to drop a film on, the run followed live, a Kill button
```

## What you will see

1. The job: one agent writes its own code (a `code` tool with `bash` and `vision.see`, following pi-vision's look skill): it probes the film, cuts it into windows of about a minute with their sound, asks the eyes about each, groups the windows into chapters, takes a keyframe for each, and you keep an `agentrun.cited/1` result: a summary, then one row a chapter (its title, its start and end, a one-line note), citing the looks it rests on (`#t=` of the film) and its keyframe.
2. A kill and resume (`--kill`, or the server's Kill button at any moment): the process dies with an answered look not yet filed; the next process runs the agent's script again, and every window already answered comes back kept, paid nothing: the recording's fold reads repeated 0.
3. Receipts with cost: every look is filed with the window's SHA-256, the question, the answer, the model and its price; the recording's cost is a number, or unknown where a failed request may have been billed, never an unearned 0.

| Flag | What it does |
|---|---|
| `--live` | real models, your keys; the eyes see each window as video with its sound when they take video (Google's), else the agent cuts frames for them |
| `--kill` | the demo's kill (`demo.json`), then the resume |
| `--record <dir>` | keep the run as an `agentrun.recording/1` directory |
| `--input <json\|file>` | `{ "film", "from_s", "to_s", "window_s" }`: `inputs/short.json` is three minutes of the film from the launch (about $0.03) |
| `--fetch-sources` | on fakes, fetch and check NASA's film (`sources.json`) instead of reading the clip |
| `--max-usd <n>` | stop a run past n dollars (default twice `expectedCost`) |
| `--serve [--host <address>] [--port <n>]` | the local server: the drop page at `/`, each run at `/runs/<id>/` with its Kill button and the viewer following its recording; loopback unless `--host` |

## Keys and programs

| Name | For | Where |
|---|---|---|
| one of `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY` | `--live`: the lead (`openai/gpt-6-luna` by default) and the eyes (`google/gemini-3.8-flash`, which takes a window as video with its sound) | your provider's console, or your gateway |
| `ffmpeg` and `ffprobe` | the agent's code cuts windows and keyframes with them | your system's package manager |

A `--live` run of the whole film (47 minutes, 47 windows) costs about $0.40 at the providers' list prices. `SETUP-PROMPT.md` sets all of this up for you.

## How it is built

- `job.ts`: the workflow as data: one `agent` with the `code` tool, whose instructions are the task and pi-vision's look skill, then a `call` to `cite`; its default input (NASA's film whole, what `--live` reads) and the clip a run on fakes reads.
- `codeMode` in `demo.json`: the reference entry's `code` tool, pi-codemode's sandbox with `tools.bash` (the run's workspace) and `vision.see` (the run's vision, bound to the call). A script a kill cut short is not run again; the agent's next script reads back the answers the first one kept in the workspace.
- `tools.ts`: `cite`, which resolves each chapter's receipts to the looks the run filed and builds the cited result. `result.ts` keeps each keyframe as a blob of the recording.
- `fakes.ts`: the scripted lead (it runs the script a model would write) and the scripted eyes. `models.ts`: the live lead and eyes.
- `sources.json`: NASA's film by URL, size and SHA-256. `clip/`: 24 s of it, cut by `clip/cut.sh`, what a run on fakes reads (`ASSETS.md` names the source).
- `serve.ts`: the local server. Everything else is the reference entry (`demo()`).
