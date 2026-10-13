# The reference assembly

One program that puts the open packages together and runs one job end to end on pi-durable. A host supplies seven
functions; `assemble.ts` wires them into a durable run, the recovery driver, the node runner, the browser and vision.
The defaults need no key and no network: a scripted model, an in-process tool, the browser's fake backend.

```sh
npm ci --ignore-scripts && npm run build && npm run demo:reference
```

It prints the record, the receipts it cites, what each package did and the usage, and exits 0. `-- --json` prints the
same as one JSON object. `-- --dir <path>` keeps the run's directory, so a second process resumes what the first left.
`-- --chrome` drives a local Chrome instead of the fake (`CHROME_PATH`, default `/usr/bin/google-chrome`): this
process serves the job's pages as Chrome's proxy, and every other host fails to resolve. `-- --box local` or
`-- --box docker` runs the job's tools in a box of `@parcha/pi-transport` (`boxEnv`) while the run's store stays on the
disk: a local box's workspace is the run's `work/`; a Docker box is a container (`debian:bookworm-slim`, which Docker
pulls if it is not there) that the job's files are uploaded to. The box is destroyed when the run ends.

## The job

`job.ts`, small and fixed so the output is a constant:

1. `call search`: the host's tool returns two URLs.
2. `agent investigate`: the lead opens the first result with `run`, reads it with `browser_read`, reads `filing.png`
   from the workspace with `read` (vision serves the image), and submits `{ answer, citations }` citing the two
   receipt paths its tools returned.
3. `judge verdict`: a scripted judge says whether the receipts support the answer.
4. `code finish`: the output.

## The host functions

`host.ts` declares them as one value, `Host`. `localHost()` gives the no-key defaults.

| # | Function | Who asks for it | `localHost()` passes |
|---|---|---|---|
| 1 | `models` | pi-durable's `models`, the node runner's agent | pi-ai's faux provider, answering from the job's script |
| 2 | `tools` | the workflow's `call` (`runEffect`), the agent's extensions, the browser's provider and driver | the job's `search`, no extra extensions, `FakeBackend` from `@parcha/pi-browser/testing` |
| 3 | `evidence` | the browser and vision, one sink for both record types | a JSON file per record under `<run>/evidence/<label>/`, named by its hash |
| 4 | `decisions` | the workflow's `judge` (`runJudge`) | the job's scripted answers |
| 5 | `status` | browser sessions and reconcile, vision looks and misses, workflow events | one JSON line per row in `<run>/events.jsonl` |
| 6 | `deliver` | the workflow's output | `<run>/out/record.json` |
| 7 | `credentials` | the browser's `redact`, the environment of a program vision starts | none; a started program sees only `PATH` |

Where the run lives (`RunPlace`) is the disk package's `AppContext`: `root`, `work`, `store`. The run opens on a claim
over a plain directory, with the disk package's own file and shell tools confined to `work/`. `run()` takes another
environment for the tools as `env`, the disk run's own option; `--box` passes a transport box there.

Extensions install in this order: file and shell tools, the host's extensions, vision, the browser, the node runner.
Then the run opens and pi resumes what a killed process left, the browser reconciles its sessions, the workflow runs,
the record is delivered, every open browser session is released, and the run is released.

## Swap a fake for a real part

Each fake is one member of `Host`. Build `localHost()`'s value and replace that member:

- Models: a pi-ai `Models` with a real provider, and its model as `models.lead`.
- Judge: `createJevRunner()` from `@parcha/agentrun-jev` as `decisions.runJudge` (it needs `TYPESAFE_API_KEY`).
- Browser: `browserbaseProvider()` from `@parcha/pi-browser/providers/browserbase` and `stagehandDriver()` from
  `@parcha/pi-browser/driver/stagehand` as `tools.browser`, with your prices.
- Tools: your own pi extensions in `tools.extensions`, and your tool server behind `tools.runEffect`.

## What it does not do yet

- Model tiers: one lead model.
- A cost fold: it prints pi's usage as it is.
- A tool gateway with grants: extensions pass straight through.
- Workspace custody: the disk package's confined tools, nothing more.
- The lead's own session runner: the workflow's LLM step runs on the node runner.
- A real browser by default. The fake backend opens on the first search result and returns `run`'s code unrun.

## Gaps it works around

Each is marked in the code with the package that owns it.

- Until the browser's pi range admits 1.1.0, one process loads pi-durable 1.0.4 and two 1.1.0 copies (three with
  `--box`). The values cross them unchanged; their branded types do not, so `assemble.ts` casts at four places and
  `run.ts` at one.
- The disk run's temporary directories are under `<root>/tmp`, which its confinement will not let a tool write, and
  vision writes the file it reads there. `assemble.ts` keeps them under `work/.tmp`.
- The browser's `release` returns before its background task runs, and `waitForIdle` does not wait for background
  tasks. `assemble.ts` waits for the release tasks before it closes the run.
