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

## The entry as a demo's platform: `demo()`

A demo's `run.ts` is about twenty lines: its spec, its job, its fakes and one call. The entry reads the standard flags and runs the job on the no-key host.

```ts
import { demo } from '../reference/index.ts';
import spec from './demo.json' with { type: 'json' };
import { fakes } from './fakes.ts';
import job from './job.ts';

await demo({ self: import.meta.url, spec, job, fakes });
```

| Flag | What it does |
|---|---|
| (none) | the job on fakes: $0, no key |
| `--live` | real models and services; refused unless the demo supplies them (`live`) |
| `--kill` | the spec's `kills`, in order, each ending one process; a fresh process resumes on the same directory |
| `--record <dir>` | an `agentrun.recording/1` directory, through the reference recorder |
| `--input <path\|json>` | the job's input; the job's own is the default |
| `--max-usd <n>` | stops the run past n dollars, metered on the recording's lines (default twice `expectedCost`); a run that finishes past it says so and exits 1 |
| `--provider <p>`, `--model <m>`, `--eyes-model <m>` | with `--live`: the models to use, handed to the demo's `live({ env, models })` as `{ provider, model, eyesModel }` (each absent when not given; the demo's sign-in plan decides what they mean). `--provider` needs `--model`; without `--live` they are refused |
| `--see-also <recording>` | links a finished recording of the same demo (a weak-eyes pass) in the manifest's `see_also`, by its directory's name and its manifest's title; repeat for more |
| `--local-chrome` | with `--live` and no Browserbase key pair: a Chrome on your own machine (`CHROME_PATH`). Browserbase is used only when `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` are both set, decided before anything starts (a half pair is named, never used); a local Chrome is never chosen for you |
| `--fetch-sources` | fetches the demo's `sources.json` into the run's `work/` before the job runs (always with `--live`) |
| `--cache <dir>` | where fetched sources are kept by hash, so a re-run does not fetch them again (default `agentrun-sources` in the OS temp dir) |
| `--dir <path>` | keeps the run's directory |
| `--json` | the result as one JSON object |

### The spec

The parts of `demo.json` the entry acts on:

- `kills`: a list. Each entry is a named crossing `{ point, why }` or a storm `{ storm: { kills, gapMs } }`. A crossing entry may add `kind: "box"` (the whole machine or sandbox was taken away; the supervisor destroys the process's boxes with it, and the kill line says `box`), `target` (`"run"`, the default: the process the run lives in dies; `"tool"`: a box a tool made is destroyed once at the crossing, the run's process lives, no kill line is written, and the transport box lines record the loss) `n` (the nth time the crossing is taken, default 1) and `where` (`{ field: value }`: only a crossing announced with those info fields counts, and `n` is the nth matching one; a crossing is announced by whatever takes it with `cross(point, { info })`, and the crossing log records the info; the entry's own taps (the model, the judge, the tools' dispatch and return, the boxes, the filing) announce none, so a point such as `transport.tool.started` fires only in a demo whose own adapter calls `cross` for it, with `{ tool }` in the info, and `{ point: "transport.tool.started", where: { tool: "install" } }` is then the install step). A storm kills `kills` times, each at the first crossing taken once the process has run `gapMs` and has opened the journal and begun its first node (a kill earlier leaves a generation the journal never recorded); a named point is taken as named. The template's single `kill` is a list of one.
- `expectedCost`: dollars a live run is expected to cost; `--max-usd` defaults to twice it.
- `sources`: `true` (the demo's `sources.json`), or a path (relative to the demo's directory, to the repository when it starts with `examples/`, or absolute): `sources.json` has two kinds of entry. `pages` are visited live by the agent (each with its URL, what it shows and its hand-check date): the entry passes them through untouched, never fetching or refusing them. `files` (or `items`) are the checked files `{ id, url, bytes, sha256, license }` the job reads. They are fetched into `work/` as `<id><extension of the URL's path>`, verified by size and hash (a file already there with the right hash is kept; one that is not the checked bytes is refused, naming what was checked and what came), on `--live` and with `--fetch-sources`. A no-key run uses the files the demo commits (`job.files`). A demo whose files depend on the input gives `sourcesFor(input)` instead (the same item shape, without `license`): only those items are fetched, and a no-key run that lacks their files is refused in one line naming `--fetch-sources`.
- `input`: `{ fixtures: { <name>: "examples/<demo>/fixtures/<file>.json" } }`: the demo's captures, each a name (`[a-z0-9-]`) and the JSON file that is the job's input for it. `--input <name>` runs the job on that capture. A path outside `examples/<demo>/fixtures/` is refused; on fakes a bare name that is not a capture (and not a file) is refused with the list of captures; `--live` reads the real thing.
- `boxes`: `{ kind: "local" | "docker", image?, runIn? }`. Docker is used only with `--live`: a no-key run uses a local box and starts no container. The provider is handed to the demo's tools as `context.boxes` (their second argument), with the crossings and transport lines below built in. A tool's `context` also carries `live` (false on a no-key run: one set of tools reads live or replays a capture) and the run's `place` (`{ root, work }`), where it reads the run's evidence files and the job's files. `runIn: true` also runs the job's own disk tools in a box of it.

### Crossings

A crossing is a named point the child takes; `kills[].point` names one, and the first time (or the nth) the child takes it, the child is killed with SIGKILL. A package adds its own through the same `cross` function (`vision.filing`).

| Point | Where |
|---|---|
| `model.request turn <n>` / `model.answered turn <n>` | the scripted model's request, and its answer, at the turn after n tool results |
| `judge.asked <label>` / `judge.answered <label>` | the judge's question and answer |
| `tool.dispatch <tool>` / `tool.returned <tool>` | a scripted tool is called and returns. Never a kill point: between the dispatch and the host keeping the answer nothing records what the tool did, and a kill there leaves the call unknown |
| `effect.kept <tool>` | the host has kept the tool's answer and the driver has not yet committed it. A kill point only when no other call is in that window. The resumed process settles the call from the kept answer: it is not sent again |
| `receipt.filing <tool>` / `receipt.filed <tool>` | an evidence receipt is about to be filed, and has been |
| `event <source>.<type>` | each row of events the run reports (`event workflow.node.start`, `event browser.launched`, `event vision.look`) |
| `deliver.writing` / `deliver.written` | the delivery |
| `transport.box.create` / `transport.box.created` | a box is about to be made, and exists |
| `transport.box.exec` | a box command is in flight: started, its answer not yet read |
| `transport.box.destroy` | a box is about to be destroyed |

A crossing taken inside a tool call (`transport.box.*` from a tool that makes its own box) is never a `target: "run"` kill point, for the reason `tool.dispatch` is not. It can be a `target: "tool"` kill.

The transport box lines are live lines of source `transport`: `box.created` `{ box, provider }`, `box.killed` `{ box, crossing }` (written before the box is destroyed) and `box.ended` `{ box, provider, killed }`.

### The judge seam

Every demo's typed questions pass through one seam that carries Jev's limits and Jev's price, whoever answers: at most 50 requests and 40,000 tokens (in and out) over the run. The next request after a cap is reached is refused with `JEV_CAP_REACHED` and is never sent; a failed request counts, a refused one does not. The count is kept in the run's directory, so a resumed process continues it. An answer that reports usage and no price of its own is priced at Jev's public list price, $0.042 per million input tokens and nothing for output (`jev-1.12`; source: the TypeSafe cookbook, 2026-07); a price the answer reports is kept.

### What a demo hands the entry, besides its job

`fakes.extensions` (pi extensions a no-key run installs beside the host's own) and `fakes.vision(host, running)` (the demo's vision lane on fakes: an eyes object, limits, an evidence sink; `running.harness` is undefined until the run is open). `DemoOptions.result(record, { dir, keep })` returns `{ json, title }`: the entry writes the run's result line and its blob from it (`agentrun.cited/1` for a payoff that cites what it read) instead of the raw delivered record; `keep` stores a file in the recording's blobs and returns its SHA-256.

### What a live child's environment holds

On `--live` the child is given exactly the environment names `demo.json` declares (every `env` in `keys`, the members of a `oneOf` group included, and in `programs`), plus the process basics (`PATH`, `HOME`, `TMPDIR`), and nothing else: an undeclared variable in the parent's environment never reaches it, so the spec and the child's environment cannot drift. A no-key run passes the demo's own `DEMO_*` settings (no secret). `LiveParts.vision(host, running)` is built the way `fakes.vision(host, running)` is: one seam for both.

### `manifest(context)` and `source.run`

A demo may pass `manifest({ dir, record, input, live })`: it returns fields the entry adds to the manifest (a demo's own sources, slice or models). A name the entry writes itself (`format`, `source`, `result`, `providers`, `see_also`, `job`, `store`, ...) is refused. `source.run` is the demo's name, plus the input file's name when `--input` named a file (`apollo-apollo-11`); a demo's `run.ts` reads `demo()`'s result for its own summary lines.
