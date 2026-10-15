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
`-- --record <dir>` keeps the run as an `agentrun.recording/1` directory the run viewer (`apps/viewer`) plays. Before
it finishes one, the recorder scans every line, every text blob and the manifest with `scan.ts`, the one scanner the
repository's recording validator and the hosted gallery's gate import: a credential's shape or a machine path stops
it with what it found and where, and the directory is left without a manifest, so it is never a finished recording.

## The job

`job.ts`, small and fixed so the output is a constant:

1. `call search`: the host's tool returns two URLs. The tool door keeps each answer in `<run>/answers/`, under the
   admitted effect's `argsHash` (its input, node and idempotency key, so two steps that call one tool alike are two
   answers), before the result is committed, so a run resumed after a kill between the two takes the answer
   instead of stopping on the unknown call, and never sends it again. A call that was admitted and never sent stays
   unknown: the resumed run is refused with `FROZEN_EFFECT_UNKNOWN`.
2. `agent investigate`: the lead opens the first result with `run`, reads it with `browser_read`, reads `filing.png`
   from the workspace with `read` (vision serves the image), and submits `{ answer, citations }` citing the two
   receipt paths its tools returned. Like a model, it asks a read that errs again, three attempts in all. A page action
   a crash cut, or one the browser will not send again (`effect_unknown`, read from its JSON answer), is never asked
   again before the lead looks: it takes a snapshot, as the browser asks, and decides from the browser's
   `pendingEffect` details (the page when the action was sent, and now): applied, it goes on; not applied, it runs it
   again, three runs in all; cannot tell, it asks no more. The browser does not send those details yet, so today a cut
   action is always `cannot tell`, and the page action is never applied twice. A page it did not open is not read: the record then cites only the
   scan and says whether the page could not be opened or its outcome is unknown.
3. `judge verdict`: a scripted judge says whether the receipts support the answer.
4. `code finish`: the output.

## The host functions

`host.ts` declares them as one value, `Host`. `localHost()` gives the no-key defaults.

| # | Function | Who asks for it | `localHost()` passes |
|---|---|---|---|
| 1 | `models` | pi-durable's `models`, the node runner's agent | pi-ai's faux provider, answering from the job's script |
| 2 | `tools` | the workflow's `call` (`runEffect`), a resumed run's lookup of a call a kill left unknown (`answered`), the agent's extensions, the browser's provider and driver | the job's `search` and the answers it kept, no extra extensions, `FakeBackend` from `@parcha/pi-browser/testing` |
| 3 | `evidence` | the browser and vision, one sink for both record types | a JSON file per record under `<run>/evidence/<label>/`, named by its hash |
| 4 | `decisions` | the workflow's `judge` (`runJudge`), the browser's page judge (`classifyPage`) | the job's scripted answers; a page judge only when the fakes give one. Each answer's receipt is a row in the run's store (`agentrun.decisions`) before it acts, and a resumed run replays it instead of asking again |
| 5 | `status` | browser sessions and reconcile, vision looks and misses, workflow events | one JSON line per row in `<run>/events.jsonl` |
| 6 | `deliver` | the workflow's output | `<run>/out/record.json` |
| 7 | `credentials` | the browser's `redact`, the environment of a program vision starts | none; a started program sees only `PATH` |

Where the run lives (`RunPlace`) is the disk package's `AppContext`: `root`, `work`, `store` (`<root>/store`, holding
`run.sqlite`, which the package's readers take as a file; a directory whose store is at `<root>/durable`, where the
version before kept it, is refused with both paths named, and nothing runs). The run opens on a claim
over a plain directory, with the disk package's own file and shell tools confined to `work/`. `run()` takes another
environment for the tools as `env`, the disk run's own option; `--box` passes a transport box there.

Extensions install in this order: file and shell tools, the host's extensions, vision, the browser, the node runner,
the workflow's task (`createWorkflowExtension` from `@parcha/agentrun-pi/durable`). Then the run opens and pi resumes
what a killed process left, the workflow's task among them. The driver opens the journal once and, in that open, hands the
host each call a killed process left unknown (`reconcile`): the example looks each up with `tools.answered` (kept by the effect's
id), or runs it again with `tools.rerun` when that is safe, and reports the applied call once in the receipt the driver appends to
the effect's own calls. A call neither settles stays unknown and is refused. Each process raises the journal's generation once,
which a recording reads as a process. The browser reconciles its sessions; the workflow's task is
started, or reached when the open resumed it, and waited on; the record is delivered; every open browser session is
released, and the run is released. `run()` returns the task's outcome: `complete` with the output, `escalated`,
`refused` with a code and message, or `stopped`.

## Gates and cases

`gates.ts` checks the files a run leaves, structurally: files exist, JSON parses, counts and cross-references hold.
None of them judges prose. What ran is read from the run's store through the packages' own readers (`readJournal`,
`durableDoc`); `events.jsonl` is best effort (a killed process may never write a row) and is for people.

| Gate | Holds when |
|---|---|
| `record-matches-output-schema` | `out/record.json` exists, parses, and its record validates against the workflow's output schema |
| `citations-name-filed-evidence` | every string in the record that names a path under `evidence/` is a file there that parses and has `tool`, `args` and `status` |
| `no-failed-evidence-cited` | no cited receipt was filed `failed` |
| `fakes-called-once` | in `ledger.jsonl`, every tool call happened once across the run's processes; each turn of a conversation and each judge was asked at most once in each process (each row names its process by an id drawn at start); and a judge was asked again only after a process that died at its ask, before the answer was recorded |
| `browser-ops-ran` | in `ledger.jsonl`, a record that cites a browser read rests on a `page.run` and a `page.read`, and no more pages were judged than read. The lead may ask the browser again, so these rows are not counted once |
| `nodes-end` | the run's journal holds no step started and never committed |
| `browser-sessions-released` | the browser's inventory in the run's store holds no session |

```sh
npm run demo:reference -- --dir /tmp/run && node examples/reference/gates.ts /tmp/run
```

It prints one line per gate and exits 1 when one fails. From code, `gates(runDir, job)` returns `{ id, ok, detail }[]`.
When `ledger.jsonl` or the store is missing or cannot be read, or a ledger line does not parse, the gates that read it
fail and say so, and the others still report.
`localHost()` creates the ledger empty when it starts, so a run that called nothing still has one.

`cases/` holds synthetic cases, each a way out the packages already have:

- `login-wall`: the browser's page judge calls the page a login wall; the read is filed `failed` and the lead cites
  only the scan.
- `no-vision-route`: the lead takes no images and vision has no eyes; reading the scan is vision's typed miss, filed
  `failed`, and the lead cites only the page.
- `search-fails`: the host's tool throws; the workflow's task ends `refused` (`WORKFLOW_FAILED`, with the tool's own
  message), nothing is delivered, and `record-matches-output-schema` and `nodes-end` fail: the journal holds the
  search started and never committed.

A case is a `Case` (`gates.ts`): a job, the fakes it runs on (usually `job.ts`'s with one member changed), and what
its run must show: its status, the gates that fail, the tools whose receipts are filed `failed`. To add one, write a
file in `cases/` and list it in `cases/index.ts`; `examples/reference-rig.test.mjs` runs every listed case and the
reference job, then checks each against the gates. It also kills a run of the reference job after the browser read,
resumes it in a second process, and checks that run passes every gate.

## Swap a fake for a real part

Each fake is one member of `Host`. Build `localHost()`'s value and replace that member:

- Models: a pi-ai `Models` with a real provider, and its model as `models.lead`.
- Judge: `createJevRunner()` from `@parcha/agentrun-jev` as `decisions.runJudge` (it needs `TYPESAFE_API_KEY`).
- Browser: `browserbaseProvider()` from `@parcha/pi-browser/providers/browserbase` and `stagehandDriver()` from
  `@parcha/pi-browser/driver/stagehand` as `tools.browser`, with your prices. Leave `createDeadlineMs` unset: the
  browser's default (60 s) waits that long for a create whose answer a kill lost. `localHost()` passes 3 s for its fake,
  which answers in the same process.
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

- The disk run's temporary directories are under `<root>/tmp`, which its confinement will not let a tool write, and a
  read that runs a program (a video through ffmpeg) writes there. `assemble.ts` keeps them under `work/.tmp` until the
  disk package's #380 lands. This example's PNG read writes no temporary file.
- The browser's `release` returns before its background task runs, and `waitForIdle` does not wait for background
  tasks. `assemble.ts` waits for the release tasks before it closes the run.
- The disk run's open resumes pi's pending tasks before the host can reconcile the browser, which asks to run first.
  A resumed workflow task would reach the browser before its sessions are reconciled. `assemble.ts` holds the task's
  steps until the reconcile has run, and until `start` has accepted this job's request: `start` refuses a request that is
  not the run's own with `RUN_STORE_BINDING_MISMATCH`, so a refused job never lets the saved task run.
